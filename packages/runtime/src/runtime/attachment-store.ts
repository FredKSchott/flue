import type { AttachmentRef } from '../conversation-records.ts';
import { AttachmentConflictError, AttachmentIntegrityError, InvalidRequestError } from '../errors.ts';

/** Unbound uploads are garbage-collectable after one day. */
export const ATTACHMENT_STAGE_TTL_MS = 24 * 60 * 60 * 1000;

export interface PutAttachmentInput {
	streamPath: string;
	attachment: AttachmentRef;
	bytes: Uint8Array;
	conversationId: string;
}

export interface GetAttachmentInput {
	streamPath: string;
	conversationId: string;
	attachmentId: string;
}

/** Bytes accepted before an agent instance has a root conversation. */
export interface StageAttachmentInput {
	streamPath: string;
	attachment: AttachmentRef;
	bytes: Uint8Array;
}

export interface ReserveAttachmentsInput {
	streamPath: string;
	submissionId: string;
	/** Ordered exactly as the incoming user/signal message. */
	attachmentIds: readonly string[];
}

export interface BindAttachmentsInput extends ReserveAttachmentsInput {
	conversationId: string;
}

/** Return a reservation to staging only after durable admission proved absent. */
export interface ReleaseAttachmentsInput extends ReserveAttachmentsInput {}

export interface StoredAttachment {
	attachment: AttachmentRef;
	bytes: Uint8Array;
}

export interface AttachmentStore {
	/** Atomically create a staged upload or identify an exact idempotent replay. */
	stage(input: StageAttachmentInput): Promise<{ replayed: boolean }>;
	/** Atomically claim the complete ordered input set before durable admission. */
	reserve(input: ReserveAttachmentsInput): Promise<readonly AttachmentRef[]>;
	/** Atomically make a reserved set visible to one canonical conversation. */
	bind(input: BindAttachmentsInput): Promise<readonly AttachmentRef[]>;
	release(input: ReleaseAttachmentsInput): Promise<void>;
	put(input: PutAttachmentInput): Promise<void>;
	get(input: GetAttachmentInput): Promise<StoredAttachment | null>;
}

interface InMemoryAttachmentRecord extends StoredAttachment {
	conversationId?: string;
	state: 'staged' | 'reserved' | 'bound';
	submissionId?: string;
	stagedAt: number;
}

export class InMemoryAttachmentStore implements AttachmentStore {
	private records = new Map<string, InMemoryAttachmentRecord>();

	async stage(input: StageAttachmentInput): Promise<{ replayed: boolean }> {
		await verifyAttachmentBytes(input.attachment, input.bytes);
		const key = attachmentKey(input.streamPath, input.attachment.id);
		const existing = this.records.get(key);
		if (existing) {
			if (
				!sameStagedAttachmentRef(existing.attachment, input.attachment) ||
				!attachmentBytesEqual(existing.bytes, input.bytes)
			) {
				throw attachmentConflict(input.streamPath, input.attachment.id);
			}
			return { replayed: true };
		}
		this.records.set(key, {
			attachment: { ...input.attachment },
			bytes: copyAttachmentBytes(input.bytes),
			state: 'staged',
			stagedAt: Date.now(),
		});
		return { replayed: false };
	}

	async reserve(input: ReserveAttachmentsInput): Promise<readonly AttachmentRef[]> {
		const records = this.recordsFor(input.streamPath, input.attachmentIds);
		for (const record of records) {
			if (
				(record.state !== 'staged' &&
					!(record.state === 'reserved' && record.submissionId === input.submissionId)) ||
				Date.now() - record.stagedAt > ATTACHMENT_STAGE_TTL_MS
			) {
				throw invalidAttachmentSet(input.attachmentIds);
			}
		}
		for (const record of records) {
			record.state = 'reserved';
			record.submissionId = input.submissionId;
		}
		return records.map((record) => ({ ...record.attachment }));
	}

	async bind(input: BindAttachmentsInput): Promise<readonly AttachmentRef[]> {
		const records = this.recordsFor(input.streamPath, input.attachmentIds);
		for (const record of records) {
			if (
				(record.state !== 'reserved' && record.state !== 'bound') ||
				record.submissionId !== input.submissionId ||
				(record.conversationId !== undefined && record.conversationId !== input.conversationId)
			) {
				throw invalidAttachmentSet(input.attachmentIds);
			}
		}
		for (const record of records) {
			record.state = 'bound';
			record.conversationId = input.conversationId;
		}
		return records.map((record) => ({ ...record.attachment }));
	}

	async release(input: ReleaseAttachmentsInput): Promise<void> {
		const records = this.recordsFor(input.streamPath, input.attachmentIds);
		for (const record of records) {
			if (record.state !== 'reserved' || record.submissionId !== input.submissionId) {
				throw invalidAttachmentSet(input.attachmentIds);
			}
		}
		for (const record of records) {
			record.state = 'staged';
			record.submissionId = undefined;
		}
	}

	async put(input: PutAttachmentInput): Promise<void> {
		await verifyAttachmentBytes(input.attachment, input.bytes);
		const key = attachmentKey(input.streamPath, input.attachment.id);
		const existing = this.records.get(key);
		if (existing) {
			if (
				!sameAttachmentRef(existing.attachment, input.attachment) ||
				existing.state !== 'bound' ||
				existing.conversationId !== input.conversationId ||
				!attachmentBytesEqual(existing.bytes, input.bytes)
			) {
				throw new AttachmentConflictError({
					path: input.streamPath,
					attachmentId: input.attachment.id,
				});
			}
			return;
		}
		this.records.set(key, {
			attachment: { ...input.attachment },
			bytes: copyAttachmentBytes(input.bytes),
			conversationId: input.conversationId,
			state: 'bound',
			stagedAt: Date.now(),
		});
	}

	async get(input: GetAttachmentInput): Promise<StoredAttachment | null> {
		const record = this.records.get(attachmentKey(input.streamPath, input.attachmentId));
		if (record?.state !== 'bound' || record.conversationId !== input.conversationId) {
			return null;
		}
		await verifyAttachmentBytes(record.attachment, record.bytes);
		return {
			attachment: { ...record.attachment },
			bytes: copyAttachmentBytes(record.bytes),
		};
	}

	private recordsFor(streamPath: string, ids: readonly string[]): InMemoryAttachmentRecord[] {
		const records = ids.map((id) => this.records.get(attachmentKey(streamPath, id)));
		if (records.some((record) => !record)) throw invalidAttachmentSet(ids);
		return records as InMemoryAttachmentRecord[];
	}
}

export async function createAttachmentRef(input: {
	id: string;
	mimeType: string;
	bytes: Uint8Array;
	filename?: string;
}): Promise<AttachmentRef> {
	return {
		id: input.id,
		mimeType: input.mimeType,
		size: input.bytes.byteLength,
		digest: await attachmentDigest(input.bytes),
		...(input.filename ? { filename: input.filename } : {}),
	};
}

export async function verifyAttachmentBytes(
	attachment: AttachmentRef,
	bytes: Uint8Array,
): Promise<void> {
	if (attachment.size !== bytes.byteLength) {
		throw new AttachmentIntegrityError({ attachmentId: attachment.id, reason: 'size' });
	}
	if (attachment.digest !== (await attachmentDigest(bytes))) {
		throw new AttachmentIntegrityError({ attachmentId: attachment.id, reason: 'digest' });
	}
}

export function copyAttachmentBytes(bytes: Uint8Array): Uint8Array {
	return Uint8Array.from(bytes);
}

export function attachmentBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

export function sameAttachmentRef(left: AttachmentRef, right: AttachmentRef): boolean {
	return (
		left.id === right.id &&
		left.mimeType === right.mimeType &&
		left.size === right.size &&
		left.digest === right.digest
	);
}

/** Upload idempotency includes every client-provided metadata field. */
export function sameStagedAttachmentRef(left: AttachmentRef, right: AttachmentRef): boolean {
	return sameAttachmentRef(left, right) && left.filename === right.filename;
}

function invalidAttachmentSet(attachmentIds: readonly string[]): InvalidRequestError {
	return new InvalidRequestError({
		reason: `Attachment references are unavailable: ${attachmentIds.join(', ')}.`,
	});
}

function attachmentConflict(path: string, attachmentId: string): AttachmentConflictError {
	return new AttachmentConflictError({ path, attachmentId });
}

async function attachmentDigest(bytes: Uint8Array): Promise<string> {
	const source = Uint8Array.from(bytes);
	const digest = await crypto.subtle.digest('SHA-256', source.buffer);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function attachmentKey(path: string, attachmentId: string): string {
	return JSON.stringify([path, attachmentId]);
}
