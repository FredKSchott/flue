import { describe, expect, it } from 'vitest';

import { parseDeliveredMessage } from '../src/runtime/schemas.ts';

describe('reference attachments', () => {
	it('accepts opaque file references on user and signal deliveries', () => {
		const attachment = { type: 'file', id: 'att_certificate' };

		expect(parseDeliveredMessage({ kind: 'user', body: '', attachments: [attachment] })).toEqual({
			kind: 'user',
			body: '',
			attachments: [attachment],
		});
		expect(
			parseDeliveredMessage({
				kind: 'signal',
				type: 'atlas.message',
				body: '',
				attachments: [attachment],
			}),
		).toEqual({ kind: 'signal', type: 'atlas.message', body: '', attachments: [attachment] });
	});
});
