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
import { ulid } from 'ulidx';
import type { MongoOperations, MongoRunner } from './mongodb-runner.ts';
import { collectionName } from './schema.ts';

interface AttachmentRecord extends StoredAttachment {
	conversationId: string;
}

export class MongoAttachmentStore implements AttachmentStore {
	constructor(
		private runner: MongoRunner,
		private prefix: string,
	) {}

	async stage(input: StageAttachmentInput): Promise<{ replayed: boolean }> {
		await verifyAttachmentBytes(input.attachment, input.bytes);
		try {
			return await this.runner.transaction(async (tx) => {
				const collection = this.collection(tx);
				const existing = await collection.findOne({ path: input.streamPath, attachmentId: input.attachment.id });
				if (existing) {
					const parsed = parse(existing, input.attachment.id);
					if (parsed && sameStagedAttachmentRef({ ...parsed.attachment, ...(existing.filename ? { filename: String(existing.filename) } : {}) }, input.attachment) && attachmentBytesEqual(parsed.bytes, input.bytes)) return { replayed: true };
					conflict(input);
				}
				await collection.insertOne({ _id: `att_${ulid()}`, path: input.streamPath, attachmentId: input.attachment.id, mimeType: input.attachment.mimeType, byteSize: input.attachment.size, digest: input.attachment.digest, conversationId: STAGED, bytes: copyAttachmentBytes(input.bytes), filename: input.attachment.filename, state: 'staged', createdAt: Date.now(), stagedAt: Date.now() });
				return { replayed: false };
			});
		} catch (error) {
			if (!isDuplicate(error)) throw error;
			const existing = await this.collection(this.runner).findOne({ path: input.streamPath, attachmentId: input.attachment.id });
			if (!existing) throw error;
			const parsed = parse(existing, input.attachment.id);
			if (parsed && sameStagedAttachmentRef({ ...parsed.attachment, ...(existing.filename ? { filename: String(existing.filename) } : {}) }, input.attachment) && attachmentBytesEqual(parsed.bytes, input.bytes)) return { replayed: true };
			conflict(input);
		}
	}

	async reserve(input: ReserveAttachmentsInput): Promise<readonly AttachmentRef[]> {
		return this.runner.transaction(async (tx) => {
			const collection = this.collection(tx);
			const docs = await Promise.all(input.attachmentIds.map((id) => collection.findOne({ path: input.streamPath, attachmentId: id })));
			if (docs.some((doc) => !doc || (doc.state !== 'staged' && !(doc.state === 'reserved' && doc.submissionId === input.submissionId)) || Date.now() - Number(doc.stagedAt) > TTL)) unavailable(input.attachmentIds);
			for (const id of input.attachmentIds) await collection.updateOne({ path: input.streamPath, attachmentId: id }, { $set: { state: 'reserved', submissionId: input.submissionId } });
			return docs.map((doc, index) => attachmentFromDocument(doc, input.attachmentIds[index]));
		});
	}

	async bind(input: BindAttachmentsInput): Promise<readonly AttachmentRef[]> {
		return this.runner.transaction(async (tx) => {
			const collection = this.collection(tx);
			const docs = await Promise.all(input.attachmentIds.map((id) => collection.findOne({ path: input.streamPath, attachmentId: id })));
			if (docs.some((doc) => !doc || (doc.state !== 'reserved' && doc.state !== 'bound') || doc.submissionId !== input.submissionId || (doc.state === 'bound' && doc.conversationId !== input.conversationId))) unavailable(input.attachmentIds);
			for (const id of input.attachmentIds) await collection.updateOne({ path: input.streamPath, attachmentId: id }, { $set: { state: 'bound', conversationId: input.conversationId } });
			return docs.map((doc, index) => attachmentFromDocument(doc, input.attachmentIds[index]));
		});
	}

	async release(input: import('@flue/runtime/adapter').ReleaseAttachmentsInput): Promise<void> {
		await this.runner.transaction(async (tx) => {
			const collection = this.collection(tx);
			const docs = await Promise.all(input.attachmentIds.map((id) => collection.findOne({ path: input.streamPath, attachmentId: id })));
			if (docs.some((doc) => !doc || doc.state !== 'reserved' || doc.submissionId !== input.submissionId)) unavailable(input.attachmentIds);
			for (const id of input.attachmentIds) await collection.updateOne({ path: input.streamPath, attachmentId: id }, { $set: { state: 'staged' }, $unset: { submissionId: '' } });
		});
	}

	async put(input: PutAttachmentInput): Promise<void> {
		await verifyAttachmentBytes(input.attachment, input.bytes);
		try {
			await this.runner.transaction(async (tx) => {
				const collection = tx.collection(collectionName(this.prefix, 'attachments'));
				const existing = parse(
					await collection.findOne({ path: input.streamPath, attachmentId: input.attachment.id }),
					input.attachment.id,
				);
				if (existing) {
					if (!matchesInput(existing, input)) conflict(input);
					return;
				}
				await collection.insertOne({
					_id: `att_${ulid()}`,
					path: input.streamPath,
					attachmentId: input.attachment.id,
					mimeType: input.attachment.mimeType,
					byteSize: input.attachment.size,
					digest: input.attachment.digest,
					conversationId: input.conversationId,
					bytes: copyAttachmentBytes(input.bytes),
					createdAt: Date.now(),
				});
			});
		} catch (error) {
			if (!isDuplicate(error)) throw error;
			const accepted = parse(
				await this.collection(this.runner).findOne({
					path: input.streamPath,
					attachmentId: input.attachment.id,
				}),
				input.attachment.id,
			);
			if (!accepted || !matchesInput(accepted, input)) conflict(input);
		}
	}

	async get(input: GetAttachmentInput): Promise<StoredAttachment | null> {
		const record = parse(
			await this.collection(this.runner).findOne({
				path: input.streamPath,
				attachmentId: input.attachmentId,
				conversationId: input.conversationId,
			}),
			input.attachmentId,
		);
		if (!record) return null;
		await verifyAttachmentBytes(record.attachment, record.bytes);
		return { attachment: { ...record.attachment }, bytes: copyAttachmentBytes(record.bytes) };
	}

	private collection(operations: MongoOperations) {
		return operations.collection(collectionName(this.prefix, 'attachments'));
	}
}

const STAGED = '__flue_staged_attachment__';
const TTL = 24 * 60 * 60 * 1000;
function attachmentFromDocument(
	document: Record<string, unknown> | null,
	id: string | undefined,
): AttachmentRef {
	if (!document || !id) unavailable(id ? [id] : []);
	const record = parse(document, id);
	if (!record) unavailable([id]);
	return { ...record.attachment, ...(document.filename ? { filename: String(document.filename) } : {}) };
}
function unavailable(ids: readonly string[]): never {
	throw new InvalidRequestError({ reason: `Attachment references are unavailable: ${ids.join(', ')}.` });
}

function parse(document: Record<string, unknown> | null, id: string): AttachmentRecord | null {
	if (!document) return null;
	const bytes =
		document.bytes instanceof Uint8Array
			? copyAttachmentBytes(document.bytes)
			: document.bytes instanceof ArrayBuffer
				? new Uint8Array(document.bytes.slice(0))
				: binaryFromBson(document.bytes);
	return {
		attachment: {
			id,
			mimeType: String(document.mimeType),
			size: Number(document.byteSize),
			digest: String(document.digest),
		},
		bytes,
		conversationId: String(document.conversationId),
	};
}

function matchesInput(record: AttachmentRecord, input: PutAttachmentInput): boolean {
	return (
		sameAttachmentRef(record.attachment, input.attachment) &&
		record.conversationId === input.conversationId &&
		attachmentBytesEqual(record.bytes, input.bytes)
	);
}

function isDuplicate(error: unknown): boolean {
	return Boolean(
		error &&
		typeof error === 'object' &&
		'code' in error &&
		(error as { code: unknown }).code === 11000,
	);
}

function binaryFromBson(value: unknown): Uint8Array {
	if (value && typeof value === 'object' && 'buffer' in value) {
		const buffer = (value as { buffer: unknown }).buffer;
		if (buffer instanceof Uint8Array) return copyAttachmentBytes(buffer);
	}
	throw new TypeError('Persisted attachment bytes are not binary data.');
}

function conflict(input: { streamPath: string; attachment: AttachmentRef }): never {
	throw new AttachmentConflictError({ path: input.streamPath, attachmentId: input.attachment.id });
}
