import {
	AttachmentConflictError,
	type AttachmentRef,
	type AttachmentStore,
	attachmentBytesEqual,
	type BindAttachmentsInput,
	copyAttachmentBytes,
	type GetAttachmentInput,
	InvalidRequestError,
	type PutAttachmentInput,
	type ReserveAttachmentsInput,
	type StageAttachmentInput,
	type StoredAttachment,
	sameAttachmentRef,
	sameStagedAttachmentRef,
	verifyAttachmentBytes,
} from '@flue/runtime/adapter';
import type { PostgresQuery, PostgresRunner } from './postgres-adapter.ts';

interface AttachmentRecord extends StoredAttachment {
	conversationId: string;
}

export class PgAttachmentStore implements AttachmentStore {
	constructor(private runner: PostgresRunner) {}

	async stage(input: StageAttachmentInput): Promise<{ replayed: boolean }> {
		await verifyAttachmentBytes(input.attachment, input.bytes);
		return this.runner.transaction(async (tx) => {
			const inserted = await tx.query(
				`INSERT INTO flue_attachments (stream_path, attachment_id, mime_type, byte_size, digest, conversation_id, bytes, created_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (stream_path, attachment_id) DO NOTHING RETURNING attachment_id`,
				[input.streamPath, input.attachment.id, input.attachment.mimeType, input.attachment.size, input.attachment.digest, STAGED, copyAttachmentBytes(input.bytes), Date.now()],
			);
			if (inserted.length > 0) {
				await tx.query(
					`INSERT INTO flue_attachment_staging (stream_path, attachment_id, filename, state, staged_at) VALUES ($1, $2, $3, 'staged', $4)`,
					[input.streamPath, input.attachment.id, input.attachment.filename ?? null, Date.now()],
				);
				return { replayed: false };
			}
			const existing = await readAttachment(tx.query, input.streamPath, input.attachment.id, true);
			const staged = await readStaging(tx.query, input.streamPath, input.attachment.id, true);
			if (!existing || !staged || !sameStagedAttachmentRef({ ...existing.attachment, ...(staged.filename ? { filename: staged.filename } : {}) }, input.attachment) || !attachmentBytesEqual(existing.bytes, input.bytes)) conflict(input);
			return { replayed: true };
		});
	}

	async reserve(input: ReserveAttachmentsInput): Promise<readonly AttachmentRef[]> {
		return this.runner.transaction(async (tx) => {
			const staged = await Promise.all(input.attachmentIds.map((id) => readStaging(tx.query, input.streamPath, id, true)));
			if (staged.some((row) => !row || (row.state !== 'staged' && !(row.state === 'reserved' && row.submissionId === input.submissionId)) || Date.now() - row.stagedAt > TTL)) unavailable(input.attachmentIds);
			for (const id of input.attachmentIds) await tx.query(`UPDATE flue_attachment_staging SET state = 'reserved', submission_id = $1 WHERE stream_path = $2 AND attachment_id = $3`, [input.submissionId, input.streamPath, id]);
			return Promise.all(input.attachmentIds.map((id) => stagedAttachment(tx.query, input.streamPath, id)));
		});
	}

	async bind(input: BindAttachmentsInput): Promise<readonly AttachmentRef[]> {
		return this.runner.transaction(async (tx) => {
			const staged = await Promise.all(input.attachmentIds.map((id) => readStaging(tx.query, input.streamPath, id, true)));
			const records = await Promise.all(input.attachmentIds.map((id) => readAttachment(tx.query, input.streamPath, id, true)));
			if (staged.some((row, index) => !row || !records[index] || (row.state !== 'reserved' && row.state !== 'bound') || row.submissionId !== input.submissionId || (row.state === 'bound' && records[index]!.conversationId !== input.conversationId))) unavailable(input.attachmentIds);
			for (const id of input.attachmentIds) {
				await tx.query(`UPDATE flue_attachments SET conversation_id = $1 WHERE stream_path = $2 AND attachment_id = $3`, [input.conversationId, input.streamPath, id]);
				await tx.query(`UPDATE flue_attachment_staging SET state = 'bound' WHERE stream_path = $1 AND attachment_id = $2`, [input.streamPath, id]);
			}
			return Promise.all(input.attachmentIds.map((id) => stagedAttachment(tx.query, input.streamPath, id)));
		});
	}

	async release(input: import('@flue/runtime/adapter').ReleaseAttachmentsInput): Promise<void> {
		await this.runner.transaction(async (tx) => {
			const rows = await Promise.all(input.attachmentIds.map((id) => readStaging(tx.query, input.streamPath, id, true)));
			if (rows.some((row) => !row || row.state !== 'reserved' || row.submissionId !== input.submissionId)) unavailable(input.attachmentIds);
			for (const id of input.attachmentIds) await tx.query(`UPDATE flue_attachment_staging SET state = 'staged', submission_id = NULL WHERE stream_path = $1 AND attachment_id = $2`, [input.streamPath, id]);
		});
	}

	async put(input: PutAttachmentInput): Promise<void> {
		await verifyAttachmentBytes(input.attachment, input.bytes);
		await this.runner.transaction(async (tx) => {
			await tx.query(
				`INSERT INTO flue_attachments
				 (stream_path, attachment_id, mime_type, byte_size, digest, conversation_id, bytes, created_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
				 ON CONFLICT (stream_path, attachment_id) DO NOTHING`,
				[
					input.streamPath,
					input.attachment.id,
					input.attachment.mimeType,
					input.attachment.size,
					input.attachment.digest,
					input.conversationId,
					copyAttachmentBytes(input.bytes),
					Date.now(),
				],
			);
			const accepted = await readAttachment(tx.query, input.streamPath, input.attachment.id, true);
			if (!accepted || !matchesInput(accepted, input)) conflict(input);
		});
	}

	async get(input: GetAttachmentInput): Promise<StoredAttachment | null> {
		const record = await readAttachment(
			this.runner.query,
			input.streamPath,
			input.attachmentId,
			false,
		);
		if (!record || record.conversationId !== input.conversationId) return null;
		await verifyAttachmentBytes(record.attachment, record.bytes);
		return { attachment: { ...record.attachment }, bytes: copyAttachmentBytes(record.bytes) };
	}
}

interface StagingRow { filename?: string; state: string; submissionId?: string; stagedAt: number }
const STAGED = '__flue_staged_attachment__';
const TTL = 24 * 60 * 60 * 1000;

async function readStaging(query: PostgresQuery, path: string, id: string, lock: boolean): Promise<StagingRow | null> {
	const row = (await query(`SELECT filename, state, submission_id, staged_at FROM flue_attachment_staging WHERE stream_path = $1 AND attachment_id = $2${lock ? ' FOR UPDATE' : ''}`, [path, id]))[0];
	return row ? { filename: row.filename == null ? undefined : String(row.filename), state: String(row.state), submissionId: row.submission_id == null ? undefined : String(row.submission_id), stagedAt: Number(row.staged_at) } : null;
}

async function stagedAttachment(query: PostgresQuery, path: string, id: string): Promise<AttachmentRef> {
	const [record, staged] = await Promise.all([readAttachment(query, path, id, false), readStaging(query, path, id, false)]);
	if (!record || !staged) unavailable([id]);
	return { ...record.attachment, ...(staged.filename ? { filename: staged.filename } : {}) };
}

function unavailable(ids: readonly string[]): never {
	throw new InvalidRequestError({ reason: `Attachment references are unavailable: ${ids.join(', ')}.` });
}

async function readAttachment(
	query: PostgresQuery,
	path: string,
	attachmentId: string,
	lock: boolean,
): Promise<AttachmentRecord | null> {
	const rows = await query(
		`SELECT mime_type, byte_size, digest, conversation_id, bytes
		 FROM flue_attachments WHERE stream_path = $1 AND attachment_id = $2${lock ? ' FOR UPDATE' : ''}`,
		[path, attachmentId],
	);
	const row = rows[0];
	if (!row) return null;
	return {
		attachment: {
			id: attachmentId,
			mimeType: String(row.mime_type),
			size: Number(row.byte_size),
			digest: String(row.digest),
		},
		bytes: binary(row.bytes),
		conversationId: String(row.conversation_id),
	};
}

function binary(value: unknown): Uint8Array {
	if (value instanceof Uint8Array) return copyAttachmentBytes(value);
	if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
	throw new TypeError('Persisted attachment bytes are not binary data.');
}

function matchesInput(record: AttachmentRecord, input: PutAttachmentInput): boolean {
	return (
		sameAttachmentRef(record.attachment, input.attachment) &&
		record.conversationId === input.conversationId &&
		attachmentBytesEqual(record.bytes, input.bytes)
	);
}

function conflict(input: { streamPath: string; attachment: AttachmentRef }): never {
	throw new AttachmentConflictError({ path: input.streamPath, attachmentId: input.attachment.id });
}
