/**
 * Flue event types and transform utilities.
 *
 * Converts raw OpenCode SSE events into a stable, simplified Flue event
 * format suitable for logging and streaming to external consumers.
 */

// -- Flue Event Types --------------------------------------------------------

export type FlueEvent = {
	timestamp: number;
	sessionId: string;
} & (
	| { type: 'tool.pending'; tool: string; input: string }
	| { type: 'tool.running'; tool: string; input: string }
	| { type: 'tool.complete'; tool: string; input: string; output: string; duration: number }
	| { type: 'tool.error'; tool: string; input: string; error: string; duration: number }
	| { type: 'text'; text: string }
	| { type: 'status'; status: 'busy' | 'idle' | 'compacted' | 'retry'; message?: string }
	| { type: 'step.start' }
	| { type: 'step.finish'; reason: string; tokens: { input: number; output: number }; cost: number }
	| { type: 'error'; message: string }
);

// -- Transform raw OpenCode SSE -> FlueEvent ---------------------------------

/**
 * Summarize tool input into a short human-readable string.
 */
function summarizeInput(tool: string, input: Record<string, unknown>): string {
	if (input.command) return String(input.command).slice(0, 500);
	if (input.filePath) return String(input.filePath);
	if (input.pattern) return String(input.pattern);
	if (input.url) return String(input.url);
	if (input.name) return String(input.name);
	return tool;
}

/**
 * Attempt to parse a raw OpenCode SSE event and convert it to a FlueEvent.
 * Returns null if the event should be filtered out (not relevant for logs).
 */
// biome-ignore lint/suspicious/noExplicitAny: OpenCode event types are complex unions, runtime parsing is simpler
export function transformEvent(raw: any): FlueEvent | null {
	const type = raw?.type as string | undefined;
	if (!type) return null;

	const now = Date.now();

	if (type === 'message.part.updated') {
		const part = raw.properties?.part;
		if (!part) return null;
		const sessionId = part.sessionID ?? '';

		if (part.type === 'tool') {
			const tool: string = part.tool ?? '?';
			const state = part.state;
			if (!state) return null;
			const input = summarizeInput(tool, state.input ?? {});

			switch (state.status) {
				case 'pending':
					return { timestamp: now, sessionId, type: 'tool.pending', tool, input };
				case 'running':
					return { timestamp: now, sessionId, type: 'tool.running', tool, input };
				case 'completed': {
					const output = (state.output ?? '').slice(0, 1000);
					const duration =
						state.time?.end && state.time?.start ? state.time.end - state.time.start : 0;
					return {
						timestamp: now,
						sessionId,
						type: 'tool.complete',
						tool,
						input,
						output,
						duration,
					};
				}
				case 'error': {
					const duration =
						state.time?.end && state.time?.start ? state.time.end - state.time.start : 0;
					return {
						timestamp: now,
						sessionId,
						type: 'tool.error',
						tool,
						input,
						error: state.error ?? 'unknown error',
						duration,
					};
				}
			}
			return null;
		}

		if (part.type === 'text') {
			const delta = raw.properties?.delta;
			if (delta) {
				return { timestamp: now, sessionId, type: 'text', text: delta };
			}
			return null;
		}

		if (part.type === 'step-start') {
			return { timestamp: now, sessionId: part.sessionID ?? '', type: 'step.start' };
		}

		if (part.type === 'step-finish') {
			return {
				timestamp: now,
				sessionId: part.sessionID ?? '',
				type: 'step.finish',
				reason: part.reason ?? '',
				tokens: {
					input: part.tokens?.input ?? 0,
					output: part.tokens?.output ?? 0,
				},
				cost: part.cost ?? 0,
			};
		}

		return null;
	}

	if (type === 'session.status') {
		const sessionId = raw.properties?.sessionID ?? '';
		const status = raw.properties?.status;
		if (status?.type === 'busy') {
			return { timestamp: now, sessionId, type: 'status', status: 'busy' };
		}
		if (status?.type === 'idle') {
			return { timestamp: now, sessionId, type: 'status', status: 'idle' };
		}
		if (status?.type === 'retry') {
			return {
				timestamp: now,
				sessionId,
				type: 'status',
				status: 'retry',
				message: status.message,
			};
		}
		return null;
	}

	if (type === 'session.idle') {
		return {
			timestamp: now,
			sessionId: raw.properties?.sessionID ?? '',
			type: 'status',
			status: 'idle',
		};
	}

	if (type === 'session.compacted') {
		return {
			timestamp: now,
			sessionId: raw.properties?.sessionID ?? '',
			type: 'status',
			status: 'compacted',
		};
	}

	if (type === 'session.error') {
		return {
			timestamp: now,
			sessionId: raw.properties?.sessionID ?? '',
			type: 'error',
			message:
				typeof raw.properties?.error === 'string'
					? raw.properties.error
					: raw.properties?.error
						? JSON.stringify(raw.properties.error)
						: 'unknown error',
		};
	}

	return null;
}
