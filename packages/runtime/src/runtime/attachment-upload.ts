import { InvalidRequestError } from '../errors.ts';

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export async function readAttachmentBytes(request: Request): Promise<Uint8Array> {
	if (!request.body) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			size += next.value.byteLength;
			if (size > MAX_ATTACHMENT_BYTES) {
				throw new InvalidRequestError({
					reason: `Attachment exceeds the ${MAX_ATTACHMENT_BYTES}-byte limit.`,
				});
			}
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

export function attachmentUploadMetadata(headers: Headers): {
	idempotencyKey: string;
	mimeType: string;
	filename?: string;
} {
	const idempotencyKey = headers.get('idempotency-key')?.trim();
	if (!idempotencyKey) {
		throw new InvalidRequestError({ reason: 'Attachment uploads require an Idempotency-Key header.' });
	}
	const mimeType = headers.get('content-type')?.split(';', 1)[0]?.trim() || 'application/octet-stream';
	const filename = filenameFromContentDisposition(headers.get('content-disposition'));
	return { idempotencyKey, mimeType, ...(filename ? { filename } : {}) };
}

export async function deriveAttachmentId(input: {
	streamPath: string;
	idempotencyKey: string;
}): Promise<string> {
	const value = new TextEncoder().encode(
		`flue-attachment-key\n${input.streamPath}\n${input.idempotencyKey}`,
	);
	const digest = await crypto.subtle.digest('SHA-256', value);
	return `att_ik_${[...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
		.slice(0, 32)}`;
}

function filenameFromContentDisposition(value: string | null): string | undefined {
	const match = value?.match(/(?:^|;)\s*filename="?([^";]+)"?/i);
	return match?.[1]?.trim() || undefined;
}
