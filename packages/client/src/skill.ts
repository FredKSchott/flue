import type { OpencodeClient, Part } from '@opencode-ai/sdk';
import type * as v from 'valibot';
import { buildSkillPrompt } from './prompt.ts';
import { extractResult } from './result.ts';
import type { SkillOptions } from './types.ts';

/** How often to poll and log progress (ms). */
const POLL_INTERVAL = 5_000;

/** Max times we'll see 0 assistant messages before giving up. */
const MAX_EMPTY_POLLS = 60; // 60 polls * 5s = 5 minutes

/** Max time to poll before timing out (ms) - 45 minutes. */
const MAX_POLL_TIME = 45 * 60 * 1000;

/**
 * Run a named skill via the OpenCode client and optionally extract a typed result.
 */
export async function runSkill<S extends v.GenericSchema | undefined = undefined>(
	client: OpencodeClient,
	workdir: string,
	name: string,
	options?: SkillOptions<S>,
): Promise<S extends v.GenericSchema ? v.InferOutput<S> : void> {
	const { args, result: schema, model, prompt: promptOverride } = options ?? {};

	const prompt =
		promptOverride ?? buildSkillPrompt(name, args, schema as v.GenericSchema | undefined);

	console.log(`[flue] skill("${name}"): starting`);

	console.log(`[flue] skill("${name}"): creating session`);
	const session = await client.session.create({
		body: { title: name },
		query: { directory: workdir },
	});
	console.log(`[flue] skill("${name}"): session created`, {
		hasData: !!session.data,
		sessionId: session.data?.id,
		error: session.error,
	});

	if (!session.data) {
		throw new Error(`Failed to create OpenCode session for skill "${name}".`);
	}

	const sessionId = session.data.id;
	const promptStart = Date.now();

	console.log(`[flue] skill("${name}"): sending prompt async`);
	const asyncResult = await client.session.promptAsync({
		path: { id: sessionId },
		query: { directory: workdir },
		body: {
			...(model ? { model } : {}),
			parts: [{ type: 'text', text: prompt }],
		},
	});

	console.log(`[flue] skill("${name}"): prompt sent`, {
		hasError: !!asyncResult.error,
		error: asyncResult.error,
		data: asyncResult.data,
	});

	if (asyncResult.error) {
		throw new Error(
			`Failed to send prompt for skill "${name}" (session ${sessionId}): ${JSON.stringify(asyncResult.error)}`,
		);
	}

	// Confirm the session actually started processing
	await confirmSessionStarted(client, sessionId, workdir, name);

	console.log(`[flue] skill("${name}"): starting polling`);
	const parts = await pollUntilIdle(client, sessionId, workdir, name, promptStart);
	const promptElapsed = ((Date.now() - promptStart) / 1000).toFixed(1);

	console.log(`[flue] skill("${name}"): completed (${promptElapsed}s)`);

	if (!schema) {
		return undefined as S extends v.GenericSchema ? v.InferOutput<S> : undefined;
	}

	return extractResult(parts, schema as v.GenericSchema, sessionId) as S extends v.GenericSchema
		? v.InferOutput<S>
		: undefined;
}

/**
 * After promptAsync, confirm that OpenCode actually started processing the session.
 * Polls quickly (1s) to detect the session appearing as "busy" or a user message being recorded.
 * Fails fast (~15s) instead of letting the poll loop run for 5 minutes.
 */
async function confirmSessionStarted(
	client: OpencodeClient,
	sessionId: string,
	workdir: string,
	skillName: string,
): Promise<void> {
	const maxAttempts = 15; // 15 * 1s = 15s
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		await sleep(1_000);

		// Check if session appears in status (busy means it's running)
		const statusResult = await client.session.status({ query: { directory: workdir } });
		const sessionStatus = statusResult.data?.[sessionId];
		if (sessionStatus?.type === 'busy') {
			console.log(`[flue] skill("${skillName}"): session confirmed running`);
			return;
		}

		// Check if at least a user message was recorded (prompt was accepted)
		const messagesResult = await client.session.messages({
			path: { id: sessionId },
			query: { directory: workdir },
		});
		const messages = messagesResult.data as Array<{ info: { role: string } }> | undefined;
		if (messages && messages.length > 0) {
			console.log(`[flue] skill("${skillName}"): session confirmed (${messages.length} messages)`);
			return;
		}
	}

	throw new Error(
		`Skill "${skillName}" failed to start: session ${sessionId} has no messages after 15s.\n` +
			`The prompt was accepted but OpenCode never began processing it.\n` +
			`This usually means no model is configured. Pass --model to the flue CLI or set "model" in opencode.json.`,
	);
}

async function pollUntilIdle(
	client: OpencodeClient,
	sessionId: string,
	workdir: string,
	skillName: string,
	startTime: number,
): Promise<Part[]> {
	let emptyPolls = 0;
	let pollCount = 0;

	for (;;) {
		await sleep(POLL_INTERVAL);
		pollCount++;

		const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

		if (Date.now() - startTime > MAX_POLL_TIME) {
			throw new Error(
				`Skill "${skillName}" timed out after ${elapsed}s. Session never went idle. This may indicate a stuck session or OpenCode bug.`,
			);
		}

		const statusResult = await client.session.status({ query: { directory: workdir } });
		const sessionStatus = statusResult.data?.[sessionId];

		if (!sessionStatus || sessionStatus.type === 'idle') {
			const parts = await fetchAllAssistantParts(client, sessionId, workdir);

			if (parts.length === 0) {
				emptyPolls++;
				// Log every 60s while waiting for first output
				if (emptyPolls % 12 === 0) {
					console.log(
						`[flue] skill("${skillName}"): status result: ${JSON.stringify({ hasData: !!statusResult.data, sessionIds: statusResult.data ? Object.keys(statusResult.data) : [], error: statusResult.error })}`,
					);
					console.log(
						`[flue] skill("${skillName}"): sessionStatus for ${sessionId}: ${JSON.stringify(sessionStatus)}`,
					);
				}
				if (emptyPolls >= MAX_EMPTY_POLLS) {
					// Dump diagnostic info before failing
					const allMessages = await client.session.messages({
						path: { id: sessionId },
						query: { directory: workdir },
					});
					console.error(
						`[flue] skill("${skillName}"): TIMEOUT DIAGNOSTICS`,
						JSON.stringify(
							{
								sessionId,
								statusData: statusResult.data,
								messageCount: Array.isArray(allMessages.data) ? allMessages.data.length : 0,
								messages: allMessages.data,
							},
							null,
							2,
						),
					);
					throw new Error(
						`Skill "${skillName}" produced no output after ${elapsed}s and ${emptyPolls} empty polls. ` +
							`The agent may have failed to start — check model ID and API key.`,
					);
				}
				continue;
			}

			return parts;
		}

		// Log every 60s while session is running
		if (pollCount % 12 === 0) {
			console.log(`[flue] skill("${skillName}"): running (${elapsed}s)`);
		}
	}
}

/**
 * Fetch ALL parts from every assistant message in the session.
 */
async function fetchAllAssistantParts(
	client: OpencodeClient,
	sessionId: string,
	workdir: string,
): Promise<Part[]> {
	const messagesResult = await client.session.messages({
		path: { id: sessionId },
		query: { directory: workdir },
	});

	if (!messagesResult.data) {
		throw new Error(`Failed to fetch messages for session ${sessionId}.`);
	}

	const messages = messagesResult.data as Array<{ info: { role: string }; parts?: Part[] }>;
	const assistantMessages = messages.filter((m) => m.info.role === 'assistant');

	const allParts: Part[] = [];
	for (const msg of assistantMessages) {
		allParts.push(...(msg.parts ?? []));
	}

	return allParts;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
