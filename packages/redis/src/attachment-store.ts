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
import type { RedisKeys } from './redis-keys.ts';
import type { RedisRunner } from './redis-runner.ts';

interface AttachmentRecord extends StoredAttachment {
	conversationId: string;
}

export class RedisAttachmentStore implements AttachmentStore {
	constructor(
		private runner: RedisRunner,
		private keys: RedisKeys,
	) {}

	async stage(input: StageAttachmentInput): Promise<{ replayed: boolean }> {
		await verifyAttachmentBytes(input.attachment, input.bytes);
		const key = this.keys.attachment(input.streamPath, input.attachment.id);
		const result = await this.runner.eval(STAGE, [key, this.keys.attachments(input.streamPath)], [input.attachment.mimeType, input.attachment.size, input.attachment.digest, STAGED, encodeBytes(input.bytes), Date.now(), input.attachment.id, input.attachment.filename ?? '']);
		if (Number(result) === 1) return { replayed: false };
		const existing = await this.readRaw(input.streamPath, input.attachment.id);
		if (
			(existing?.state !== 'staged' && existing?.state !== 'reserved' && existing?.state !== 'bound') ||
			!sameStagedAttachmentRef(existing.attachment, input.attachment) ||
			!attachmentBytesEqual(existing.bytes, input.bytes)
		)
			conflict(input);
		return { replayed: true };
	}

	async reserve(input: ReserveAttachmentsInput): Promise<readonly AttachmentRef[]> {
		const keys = input.attachmentIds.map((id) => this.keys.attachment(input.streamPath, id));
		const result = await this.runner.eval(RESERVE, keys, [input.submissionId, Date.now(), TTL]);
		if (Number(result) !== 1) unavailable(input.attachmentIds);
		return Promise.all(input.attachmentIds.map((id) => this.required(input.streamPath, id)));
	}

	async bind(input: BindAttachmentsInput): Promise<readonly AttachmentRef[]> {
		const keys = input.attachmentIds.map((id) => this.keys.attachment(input.streamPath, id));
		const result = await this.runner.eval(BIND, keys, [input.submissionId, input.conversationId]);
		if (Number(result) !== 1) unavailable(input.attachmentIds);
		return Promise.all(input.attachmentIds.map((id) => this.required(input.streamPath, id)));
	}

	async release(input: import('@flue/runtime/adapter').ReleaseAttachmentsInput): Promise<void> {
		const result = await this.runner.eval(RELEASE, input.attachmentIds.map((id) => this.keys.attachment(input.streamPath, id)), [input.submissionId]);
		if (Number(result) !== 1) unavailable(input.attachmentIds);
	}

	async put(input: PutAttachmentInput): Promise<void> {
		await verifyAttachmentBytes(input.attachment, input.bytes);
		const existing = await this.read(input.streamPath, input.attachment.id);
		if (existing) {
			if (
				!sameAttachmentRef(existing.attachment, input.attachment) ||
				existing.conversationId !== input.conversationId ||
				!attachmentBytesEqual(existing.bytes, input.bytes)
			)
				conflict(input);
			return;
		}
		const result = await this.runner.eval(
			PUT,
			[
				this.keys.attachment(input.streamPath, input.attachment.id),
				this.keys.attachments(input.streamPath),
			],
			[
				input.attachment.mimeType,
				input.attachment.size,
				input.attachment.digest,
				input.conversationId,
				encodeBytes(input.bytes),
				Date.now(),
				input.attachment.id,
			],
		);
		if (Number(result) !== 1) {
			const accepted = await this.read(input.streamPath, input.attachment.id);
			if (
				!accepted ||
				!sameAttachmentRef(accepted.attachment, input.attachment) ||
				accepted.conversationId !== input.conversationId ||
				!attachmentBytesEqual(accepted.bytes, input.bytes)
			)
				conflict(input);
		}
	}

	async get(input: GetAttachmentInput): Promise<StoredAttachment | null> {
		const record = await this.read(input.streamPath, input.attachmentId);
		if (!record || record.conversationId !== input.conversationId) return null;
		await verifyAttachmentBytes(record.attachment, record.bytes);
		return { attachment: { ...record.attachment }, bytes: copyAttachmentBytes(record.bytes) };
	}

	private async read(path: string, id: string): Promise<AttachmentRecord | null> {
		const record = await this.readRaw(path, id);
		return record ? { attachment: record.attachment, conversationId: record.conversationId, bytes: record.bytes } : null;
	}

	private async required(path: string, id: string): Promise<AttachmentRef> {
		const record = await this.readRaw(path, id);
		if (!record) unavailable([id]);
		return record.attachment;
	}

	private async readRaw(
		path: string,
		id: string,
	): Promise<(AttachmentRecord & { state?: string; submissionId?: string }) | null> {
		const value = await this.runner.command('HMGET', [
			this.keys.attachment(path, id),
			'mimeType',
			'byteSize',
			'digest',
			'conversationId',
			'bytes',
			'filename',
			'state',
			'submissionId',
		]);
		if (!Array.isArray(value) || value[0] == null) return null;
		return {
			attachment: {
				id,
				mimeType: string(value[0]),
				size: Number(string(value[1])),
				digest: string(value[2]),
				...(value[5] ? { filename: string(value[5]) } : {}),
			},
			conversationId: string(value[3]),
			bytes: decodeBytes(string(value[4])),
			...(value[6] ? { state: string(value[6]) } : {}),
			...(value[7] ? { submissionId: string(value[7]) } : {}),
		};
	}
}

const PUT = `if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end redis.call('HSET', KEYS[1], 'mimeType', ARGV[1], 'byteSize', ARGV[2], 'digest', ARGV[3], 'conversationId', ARGV[4], 'bytes', ARGV[5], 'createdAt', ARGV[6]) redis.call('SADD',KEYS[2],ARGV[7]) return 1`;
const STAGE = `if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end redis.call('HSET', KEYS[1], 'mimeType', ARGV[1], 'byteSize', ARGV[2], 'digest', ARGV[3], 'conversationId', ARGV[4], 'bytes', ARGV[5], 'createdAt', ARGV[6], 'stagedAt', ARGV[6], 'state', 'staged', 'filename', ARGV[8]) redis.call('SADD',KEYS[2],ARGV[7]) return 1`;
const RESERVE = `for i,key in ipairs(KEYS) do local value=redis.call('HMGET',key,'state','submissionId','stagedAt'); if not value[1] or (value[1] ~= 'staged' and not (value[1] == 'reserved' and value[2] == ARGV[1])) or tonumber(ARGV[2])-tonumber(value[3]) > tonumber(ARGV[3]) then return 0 end end for i,key in ipairs(KEYS) do redis.call('HSET',key,'state','reserved','submissionId',ARGV[1]) end return 1`;
const BIND = `for i,key in ipairs(KEYS) do local value=redis.call('HMGET',key,'state','submissionId','conversationId'); if not value[1] or (value[1] ~= 'reserved' and value[1] ~= 'bound') or value[2] ~= ARGV[1] or (value[1] == 'bound' and value[3] ~= ARGV[2]) then return 0 end end for i,key in ipairs(KEYS) do redis.call('HSET',key,'state','bound','conversationId',ARGV[2]) end return 1`;
const RELEASE = `for i,key in ipairs(KEYS) do local value=redis.call('HMGET',key,'state','submissionId'); if value[1] ~= 'reserved' or value[2] ~= ARGV[1] then return 0 end end for i,key in ipairs(KEYS) do redis.call('HSET',key,'state','staged'); redis.call('HDEL',key,'submissionId') end return 1`;
const STAGED = '__flue_staged_attachment__';
const TTL = 24 * 60 * 60 * 1000;

function string(value: unknown): string {
	return value instanceof Uint8Array ? new TextDecoder().decode(value) : String(value);
}
// Attachment bytes cross the RedisRunner seam as base64 text so that runners
// which coerce arguments/replies through strings (the blueprint runners)
// round-trip them losslessly. Digest verification on read still catches any
// value that was corrupted at rest.
function encodeBytes(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64');
}
function decodeBytes(value: string): Uint8Array {
	return new Uint8Array(Buffer.from(value, 'base64'));
}
function conflict(input: { streamPath: string; attachment: AttachmentRef }): never {
	throw new AttachmentConflictError({ path: input.streamPath, attachmentId: input.attachment.id });
}
function unavailable(ids: readonly string[]): never {
	throw new InvalidRequestError({ reason: `Attachment references are unavailable: ${ids.join(', ')}.` });
}
