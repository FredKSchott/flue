import { AttachmentConflictError, AttachmentIntegrityError, InvalidRequestError } from './errors.ts';
import { migrateFlueSqlSchema } from './format-version.ts';
import {
	type AttachmentStore,
	attachmentBytesEqual,
	type BindAttachmentsInput,
	copyAttachmentBytes,
	type GetAttachmentInput,
	type PutAttachmentInput,
	type ReserveAttachmentsInput,
	type StageAttachmentInput,
	type StoredAttachment,
	sameAttachmentRef,
	sameStagedAttachmentRef,
	verifyAttachmentBytes,
} from './runtime/attachment-store.ts';
import type { SqlStorage } from './sql-storage.ts';

export const ATTACHMENT_CHUNK_BYTE_LENGTH = 512 * 1024;

interface SqlAttachmentRow {
	mime_type: unknown;
	byte_size: unknown;
	digest: unknown;
	conversation_id: unknown;
	chunk_count: unknown;
}

interface SqlAttachmentChunkRow {
	chunk_index: unknown;
	bytes: unknown;
}

export function ensureSqlAttachmentTable(sql: SqlStorage): void {
	// DDL must stay behind the format-version fence like its two siblings
	// (ensureSqlAgentExecutionTables, ensureSqlConversationStreamTables): a
	// store recorded with an unknown version must reject before any write.
	migrateFlueSqlSchema(sql, () => {
		sql.exec(
			`CREATE TABLE IF NOT EXISTS flue_attachments (
			stream_path TEXT NOT NULL,
			attachment_id TEXT NOT NULL,
			mime_type TEXT NOT NULL,
			byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
			digest TEXT NOT NULL,
			conversation_id TEXT NOT NULL,
			chunk_count INTEGER NOT NULL CHECK (chunk_count > 0),
			created_at INTEGER NOT NULL,
			PRIMARY KEY (stream_path, attachment_id)
		)`,
		);
		sql.exec(
			`CREATE TABLE IF NOT EXISTS flue_attachment_chunks (
			stream_path TEXT NOT NULL,
			attachment_id TEXT NOT NULL,
			chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
			bytes BLOB NOT NULL,
			PRIMARY KEY (stream_path, attachment_id, chunk_index),
			FOREIGN KEY (stream_path, attachment_id)
				REFERENCES flue_attachments (stream_path, attachment_id) ON DELETE CASCADE
		)`,
		);
		sql.exec(
			`CREATE TABLE IF NOT EXISTS flue_attachment_staging (
			stream_path TEXT NOT NULL,
			attachment_id TEXT NOT NULL,
			filename TEXT,
			state TEXT NOT NULL CHECK (state IN ('staged', 'reserved', 'bound')),
			submission_id TEXT,
			staged_at INTEGER NOT NULL,
			PRIMARY KEY (stream_path, attachment_id)
		)`,
		);
	});
}

export class SqliteAttachmentStore implements AttachmentStore {
	constructor(
		private readonly sql: SqlStorage,
		private readonly runTransaction: <T>(closure: () => T) => T,
	) {
		ensureSqlAttachmentTable(sql);
	}

	async stage(input: StageAttachmentInput): Promise<{ replayed: boolean }> {
		await verifyAttachmentBytes(input.attachment, input.bytes);
		return this.runTransaction(() => {
			const existing = this.read(input.streamPath, input.attachment.id);
			const staged = this.readStaging(input.streamPath, input.attachment.id);
			if (existing || staged) {
				if (
					existing &&
					staged !== null &&
					sameStagedAttachmentRef({ ...existing.attachment, ...(staged.filename ? { filename: staged.filename } : {}) }, input.attachment) &&
					attachmentBytesEqual(existing.bytes, input.bytes)
				)
					return { replayed: true };
				this.conflict(input.streamPath, input.attachment.id);
			}
			this.insert(input.streamPath, input.attachment, input.bytes, STAGED_CONVERSATION_ID);
			this.sql.exec(
				`INSERT INTO flue_attachment_staging
				 (stream_path, attachment_id, filename, state, submission_id, staged_at)
				 VALUES (?, ?, ?, 'staged', NULL, ?)`,
				input.streamPath,
				input.attachment.id,
				input.attachment.filename ?? null,
				Date.now(),
			);
			return { replayed: false };
		});
	}

	async reserve(input: ReserveAttachmentsInput): Promise<readonly import('./conversation-records.ts').AttachmentRef[]> {
		return this.runTransaction(() => {
			const rows = input.attachmentIds.map((id) => ({ id, row: this.readStaging(input.streamPath, id) }));
			if (
				rows.some(
					({ row }) =>
						!row ||
						(row.state !== 'staged' && !(row.state === 'reserved' && row.submissionId === input.submissionId)) ||
						Date.now() - row.stagedAt > 24 * 60 * 60 * 1000,
				)
			)
				throw unavailable(input.attachmentIds);
			for (const { id } of rows) {
				this.sql.exec(
					`UPDATE flue_attachment_staging SET state = 'reserved', submission_id = ?
					 WHERE stream_path = ? AND attachment_id = ?`,
					input.submissionId,
					input.streamPath,
					id,
				);
			}
			return input.attachmentIds.map((id) => this.stagedAttachment(input.streamPath, id));
		});
	}

	async bind(input: BindAttachmentsInput): Promise<readonly import('./conversation-records.ts').AttachmentRef[]> {
		return this.runTransaction(() => {
			const rows = input.attachmentIds.map((id) => ({ id, row: this.readStaging(input.streamPath, id) }));
			if (
				rows.some(
					({ id, row }) =>
						!row ||
						(row.state !== 'reserved' && row.state !== 'bound') ||
						row.submissionId !== input.submissionId ||
						(row.state === 'bound' && this.read(input.streamPath, id)?.conversationId !== input.conversationId),
				)
			)
				throw unavailable(input.attachmentIds);
			for (const { id } of rows) {
				this.sql.exec(
					`UPDATE flue_attachments SET conversation_id = ? WHERE stream_path = ? AND attachment_id = ?`,
					input.conversationId,
					input.streamPath,
					id,
				);
				this.sql.exec(
					`UPDATE flue_attachment_staging SET state = 'bound' WHERE stream_path = ? AND attachment_id = ?`,
					input.streamPath,
					id,
				);
			}
			return input.attachmentIds.map((id) => this.stagedAttachment(input.streamPath, id));
		});
	}

	async release(input: import('./runtime/attachment-store.ts').ReleaseAttachmentsInput): Promise<void> {
		this.runTransaction(() => {
			const rows = input.attachmentIds.map((id) => this.readStaging(input.streamPath, id));
			if (rows.some((row) => row?.state !== 'reserved' || row.submissionId !== input.submissionId)) throw unavailable(input.attachmentIds);
			for (const id of input.attachmentIds) this.sql.exec(`UPDATE flue_attachment_staging SET state = 'staged', submission_id = NULL WHERE stream_path = ? AND attachment_id = ?`, input.streamPath, id);
		});
	}

	async put(input: PutAttachmentInput): Promise<void> {
		await verifyAttachmentBytes(input.attachment, input.bytes);
		this.runTransaction(() => {
			const existing = this.read(input.streamPath, input.attachment.id);
			if (existing) {
				if (!matchesInput(existing, input)) this.conflict(input.streamPath, input.attachment.id);
				return;
			}
			this.insert(input.streamPath, input.attachment, input.bytes, input.conversationId);
		});
	}

	async get(input: GetAttachmentInput): Promise<StoredAttachment | null> {
		const row = this.read(input.streamPath, input.attachmentId);
		if (!row || row.conversationId !== input.conversationId) {
			return null;
		}
		await verifyAttachmentBytes(row.attachment, row.bytes);
		return { attachment: { ...row.attachment }, bytes: copyAttachmentBytes(row.bytes) };
	}

	private read(
		streamPath: string,
		attachmentId: string,
	): (StoredAttachment & { conversationId: string }) | null {
		const value = this.sql
			.exec(
				`SELECT mime_type, byte_size, digest, conversation_id, chunk_count
				 FROM flue_attachments WHERE stream_path = ? AND attachment_id = ?`,
				streamPath,
				attachmentId,
			)
			.toArray()[0] as SqlAttachmentRow | undefined;
		if (!value) return null;
		const chunkCount = parseChunkCount(value.chunk_count, attachmentId);
		const chunks = this.sql
			.exec(
				`SELECT chunk_index, bytes FROM flue_attachment_chunks
			 WHERE stream_path = ? AND attachment_id = ? ORDER BY chunk_index`,
				streamPath,
				attachmentId,
			)
			.toArray() as unknown as SqlAttachmentChunkRow[];
		return {
			attachment: {
				id: attachmentId,
				mimeType: String(value.mime_type),
				size: Number(value.byte_size),
				digest: String(value.digest),
			},
			bytes: reassembleAttachmentBytes(attachmentId, chunkCount, chunks),
			conversationId: String(value.conversation_id),
		};
	}

	private insert(
		streamPath: string,
		attachment: import('./conversation-records.ts').AttachmentRef,
		bytes: Uint8Array,
		conversationId: string,
	): void {
		const chunks = splitAttachmentBytes(bytes);
		this.sql.exec(
			`INSERT INTO flue_attachments
			 (stream_path, attachment_id, mime_type, byte_size, digest, conversation_id, chunk_count, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			streamPath,
			attachment.id,
			attachment.mimeType,
			attachment.size,
			attachment.digest,
			conversationId,
			chunks.length,
			Date.now(),
		);
		for (const [index, chunk] of chunks.entries()) {
			this.sql.exec(
				`INSERT INTO flue_attachment_chunks
				 (stream_path, attachment_id, chunk_index, bytes) VALUES (?, ?, ?, ?)`,
				streamPath,
				attachment.id,
				index,
				chunk,
			);
		}
	}

	private readStaging(streamPath: string, attachmentId: string): StagingRow | null {
		const row = this.sql
			.exec(
				`SELECT filename, state, submission_id, staged_at FROM flue_attachment_staging
				 WHERE stream_path = ? AND attachment_id = ?`,
				streamPath,
				attachmentId,
			)
			.toArray()[0] as Record<string, unknown> | undefined;
		return row
			? { filename: row.filename == null ? undefined : String(row.filename), state: String(row.state), submissionId: row.submission_id == null ? undefined : String(row.submission_id), stagedAt: Number(row.staged_at) }
			: null;
	}

	private stagedAttachment(streamPath: string, attachmentId: string): import('./conversation-records.ts').AttachmentRef {
		const record = this.read(streamPath, attachmentId);
		const staging = this.readStaging(streamPath, attachmentId);
		if (!record || !staging) throw unavailable([attachmentId]);
		return { ...record.attachment, ...(staging.filename ? { filename: staging.filename } : {}) };
	}

	private conflict(path: string, attachmentId: string): never {
		throw new AttachmentConflictError({ path, attachmentId });
	}
}

interface StagingRow {
	filename?: string;
	state: string;
	submissionId?: string;
	stagedAt: number;
}

const STAGED_CONVERSATION_ID = '__flue_staged_attachment__';

function unavailable(ids: readonly string[]): InvalidRequestError {
	return new InvalidRequestError({ reason: `Attachment references are unavailable: ${ids.join(', ')}.` });
}

function matchesInput(
	existing: StoredAttachment & { conversationId: string },
	input: PutAttachmentInput,
): boolean {
	return (
		sameAttachmentRef(existing.attachment, input.attachment) &&
		existing.conversationId === input.conversationId &&
		attachmentBytesEqual(existing.bytes, input.bytes)
	);
}

function splitAttachmentBytes(bytes: Uint8Array): Uint8Array[] {
	const count = Math.max(1, Math.ceil(bytes.byteLength / ATTACHMENT_CHUNK_BYTE_LENGTH));
	return Array.from({ length: count }, (_, index) =>
		copyAttachmentBytes(
			bytes.subarray(
				index * ATTACHMENT_CHUNK_BYTE_LENGTH,
				Math.min(bytes.byteLength, (index + 1) * ATTACHMENT_CHUNK_BYTE_LENGTH),
			),
		),
	);
}

function parseChunkCount(value: unknown, attachmentId: string): number {
	const count = Number(value);
	if (!Number.isSafeInteger(count) || count <= 0) {
		throw new AttachmentIntegrityError({ attachmentId, reason: 'chunks' });
	}
	return count;
}

function reassembleAttachmentBytes(
	attachmentId: string,
	chunkCount: number,
	rows: readonly SqlAttachmentChunkRow[],
): Uint8Array {
	if (rows.length !== chunkCount) {
		throw new AttachmentIntegrityError({ attachmentId, reason: 'chunks' });
	}
	const chunks = rows.map((row, index) => {
		if (Number(row.chunk_index) !== index) {
			throw new AttachmentIntegrityError({ attachmentId, reason: 'chunks' });
		}
		const bytes = sqlBytes(row.bytes);
		if (
			bytes.byteLength > ATTACHMENT_CHUNK_BYTE_LENGTH ||
			(index < chunkCount - 1 && bytes.byteLength === 0)
		) {
			throw new AttachmentIntegrityError({ attachmentId, reason: 'chunks' });
		}
		return bytes;
	});
	const byteLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
	const bytes = new Uint8Array(byteLength);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

function sqlBytes(value: unknown): Uint8Array {
	if (value instanceof Uint8Array) return copyAttachmentBytes(value);
	if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
	throw new TypeError('Persisted attachment bytes are not binary data.');
}
