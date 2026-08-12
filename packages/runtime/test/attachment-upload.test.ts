import { describe, expect, it } from 'vitest';
import {
	createAttachmentRef,
	InMemoryAttachmentStore,
} from '../src/runtime/attachment-store.ts';
import {
	attachmentUploadMetadata,
	deriveAttachmentId,
	readAttachmentBytes,
} from '../src/runtime/attachment-upload.ts';

describe('attachment uploads', () => {
	it('derives an instance-scoped stable id and preserves arbitrary bytes', async () => {
		const bytes = new Uint8Array([0x30, 0x82, 0x01, 0x02]);
		const request = new Request('http://flue.test/agents/Atlas/1/attachments', {
			method: 'POST',
			headers: {
				'Idempotency-Key': 'certificate-1',
				'Content-Type': 'application/octet-stream',
				'Content-Disposition': 'attachment; filename="certificate.crt"',
			},
			body: bytes,
		});

		expect(await readAttachmentBytes(request)).toEqual(bytes);
		expect(attachmentUploadMetadata(request.headers)).toEqual({
			idempotencyKey: 'certificate-1',
			mimeType: 'application/octet-stream',
			filename: 'certificate.crt',
		});
		expect(
			await deriveAttachmentId({ streamPath: 'agent/Atlas/1', idempotencyKey: 'certificate-1' }),
		).toBe(await deriveAttachmentId({ streamPath: 'agent/Atlas/1', idempotencyKey: 'certificate-1' }));
	});

	it('stages atomically, reserves an entire ordered set, then binds it', async () => {
		const store = new InMemoryAttachmentStore();
		const streamPath = 'agent/Atlas/new';
		const certificate = new Uint8Array([1, 2, 3]);
		const attachment = await createAttachmentRef({
			id: 'att_certificate',
			mimeType: 'application/pkix-cert',
			filename: 'certificate.der',
			bytes: certificate,
		});

		expect(await store.stage({ streamPath, attachment, bytes: certificate })).toEqual({ replayed: false });
		expect(await store.stage({ streamPath, attachment, bytes: certificate })).toEqual({ replayed: true });
		await expect(
			store.stage({
				streamPath,
				attachment: { ...attachment, filename: 'other.der' },
				bytes: certificate,
			}),
		).rejects.toMatchObject({ name: 'AttachmentConflictError' });
		await expect(
			store.reserve({ streamPath, submissionId: 'sub_1', attachmentIds: ['missing'] }),
		).rejects.toMatchObject({ status: 400 });
		await expect(
			store.get({ streamPath, conversationId: 'conv_1', attachmentId: attachment.id }),
		).resolves.toBeNull();
		await store.reserve({ streamPath, submissionId: 'sub_1', attachmentIds: [attachment.id] });
		await store.bind({
			streamPath,
			submissionId: 'sub_1',
			conversationId: 'conv_1',
			attachmentIds: [attachment.id],
		});
		expect(await store.get({ streamPath, conversationId: 'conv_1', attachmentId: attachment.id })).toMatchObject({
			attachment,
			bytes: certificate,
		});
	});
});
