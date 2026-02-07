/**
 * SSE transform utilities for the Cloudflare worker.
 *
 * The core event types and transform logic live in @flue/client.
 * This module re-exports them and provides the Cloudflare-specific
 * TransformStream wrapper for piping raw OpenCode SSE bytes.
 */

export { type FlueEvent, transformEvent } from '@flue/client';

import { transformEvent } from '@flue/client';

// -- SSE TransformStream (Cloudflare Workers / Web Streams API) --------------

/**
 * Create a TransformStream that converts raw OpenCode SSE byte stream
 * into Flue-formatted SSE events.
 *
 * Input: raw SSE bytes from the OpenCode `/event` endpoint.
 * Output: SSE bytes with `data: <FlueEvent JSON>\n\n` lines.
 */
export function createFlueEventTransform(): TransformStream<Uint8Array, Uint8Array> {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffer = '';

	return new TransformStream({
		transform(chunk, controller) {
			buffer += decoder.decode(chunk, { stream: true });

			const parts = buffer.split('\n\n');
			buffer = parts.pop() ?? '';

			for (const part of parts) {
				if (!part.trim()) continue;

				const dataLines: string[] = [];
				for (const line of part.split('\n')) {
					if (line.startsWith('data: ')) {
						dataLines.push(line.slice(6));
					} else if (line.startsWith('data:')) {
						dataLines.push(line.slice(5));
					}
				}

				if (dataLines.length === 0) continue;

				const rawJson = dataLines.join('\n');
				try {
					const raw = JSON.parse(rawJson);
					const event = transformEvent(raw);
					if (event) {
						controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
					}
				} catch {
					// Skip malformed events
				}
			}
		},

		flush(controller) {
			if (buffer.trim()) {
				const dataLines: string[] = [];
				for (const line of buffer.split('\n')) {
					if (line.startsWith('data: ')) {
						dataLines.push(line.slice(6));
					} else if (line.startsWith('data:')) {
						dataLines.push(line.slice(5));
					}
				}
				if (dataLines.length > 0) {
					try {
						const raw = JSON.parse(dataLines.join('\n'));
						const event = transformEvent(raw);
						if (event) {
							controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
						}
					} catch {
						// Skip
					}
				}
			}
		},
	});
}
