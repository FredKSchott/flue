#!/usr/bin/env -S node --experimental-strip-types
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	assertDockerAvailable,
	runSetupCommands,
	startProxyServers,
	startSandboxContainer,
	stopProxies,
	stopSandboxContainer,
	waitForProxies,
} from '../src/sandbox/sandbox.mjs';

const OPENCODE_URL = 'http://localhost:48765';

let openCodeProcess = null;
let eventStreamAbort = null;
let sandboxContainerName = null;
let proxyHandles = null;

function printUsage() {
	console.error(
		'Usage: flue run <workflowPath> [--args <json>] [--branch <name>] [--model <provider/model>] [--sandbox <image>]',
	);
}

function parseArgs(argv) {
	const [command, workflowPath, ...rest] = argv;
	if (command !== 'run' || !workflowPath) {
		printUsage();
		process.exit(1);
	}

	let argsJson;
	let branch;
	let model;
	let sandbox;

	for (let i = 0; i < rest.length; i += 1) {
		const arg = rest[i];
		if (arg === '--args') {
			argsJson = rest[i + 1];
			if (!argsJson) {
				console.error('Missing value for --args');
				process.exit(1);
			}
			i += 1;
			continue;
		}
		if (arg === '--branch') {
			branch = rest[i + 1];
			if (!branch) {
				console.error('Missing value for --branch');
				process.exit(1);
			}
			i += 1;
			continue;
		}
		if (arg === '--model') {
			model = rest[i + 1];
			if (!model) {
				console.error('Missing value for --model');
				process.exit(1);
			}
			i += 1;
			continue;
		}
		if (arg === '--sandbox') {
			sandbox = rest[i + 1];
			if (!sandbox) {
				console.error('Missing value for --sandbox');
				process.exit(1);
			}
			i += 1;
			continue;
		}
		console.error(`Unknown argument: ${arg}`);
		printUsage();
		process.exit(1);
	}

	return { workflowPath, argsJson, branch, model, sandbox };
}

/** Parse "provider/model" string into { providerID, modelID }. */
function parseModel(modelStr) {
	const slashIndex = modelStr.indexOf('/');
	if (slashIndex === -1) {
		console.error(
			`Invalid --model format: "${modelStr}". Expected "provider/model" (e.g. "anthropic/claude-sonnet-4-5").`,
		);
		process.exit(1);
	}
	return {
		providerID: modelStr.slice(0, slashIndex),
		modelID: modelStr.slice(slashIndex + 1),
	};
}

// -- Event Stream: SSE log streaming from OpenCode ---------------------------

/**
 * Connect to OpenCode's SSE /event endpoint and log events to stderr.
 * Returns an object with an abort() method to close the connection.
 */
function startEventStream(workdir) {
	const controller = new AbortController();
	const sessionNames = new Map(); // sessionId -> title
	const textBuffers = new Map(); // sessionId -> accumulated text
	const runningTools = new Map(); // sessionId -> "tool:input" key of last logged tool:running

	// Fire-and-forget: runs in background, logs to stderr
	_consumeEventStream(controller.signal, workdir, sessionNames, textBuffers, runningTools).catch(
		(err) => {
			// AbortError is expected on shutdown
			if (err.name !== 'AbortError') {
				console.error(`[opencode] event stream error: ${err.message}`);
			}
		},
	);

	return {
		abort() {
			// Flush any remaining text buffers
			for (const [sessionId, text] of textBuffers) {
				if (text) {
					const name = sessionNames.get(sessionId) ?? sessionId.slice(0, 12);
					for (const line of text.split('\n')) {
						if (line) console.error(`[opencode] (${name}) > ${line}`);
					}
				}
			}
			controller.abort();
		},
	};
}

async function _consumeEventStream(signal, workdir, sessionNames, textBuffers, runningTools) {
	const { transformEvent } = await import('@flue/client');
	const url = `${OPENCODE_URL}/event?directory=${encodeURIComponent(workdir)}`;
	const res = await fetch(url, { signal });

	if (!res.ok || !res.body) {
		console.error(`[opencode] failed to connect to event stream (HTTP ${res.status})`);
		return;
	}

	const decoder = new TextDecoder();
	let buffer = '';

	for await (const chunk of res.body) {
		if (signal.aborted) break;

		buffer += decoder.decode(chunk, { stream: true });
		const parts = buffer.split('\n\n');
		buffer = parts.pop() ?? '';

		for (const part of parts) {
			if (!part.trim()) continue;

			const dataLines = [];
			for (const line of part.split('\n')) {
				if (line.startsWith('data: ')) {
					dataLines.push(line.slice(6));
				} else if (line.startsWith('data:')) {
					dataLines.push(line.slice(5));
				}
			}
			if (dataLines.length === 0) continue;

			let raw;
			try {
				raw = JSON.parse(dataLines.join('\n'));
			} catch {
				continue;
			}

			// Track session names from session.created / session.updated events
			if (raw.type === 'session.created' || raw.type === 'session.updated') {
				const info = raw.properties?.info;
				if (info?.id && info?.title) {
					sessionNames.set(info.id, info.title);
				}
				continue;
			}

			const event = transformEvent(raw);
			if (!event) continue;

			const name = sessionNames.get(event.sessionId) ?? event.sessionId.slice(0, 12);
			logEvent(event, name, textBuffers, runningTools);
		}
	}
}

/**
 * Format and log a single FlueEvent to stderr.
 */
function logEvent(event, sessionName, textBuffers, runningTools) {
	const prefix = `[opencode] (${sessionName})`;

	switch (event.type) {
		case 'tool.pending':
			console.error(`${prefix} tool:pending  ${event.tool} — ${event.input}`);
			break;

		case 'tool.running': {
			// Deduplicate: only log the first tool:running per unique (session, tool, input).
			// Subsequent SSE updates for the same running tool are suppressed.
			const runKey = `${event.tool}\0${event.input}`;
			if (runningTools.get(event.sessionId) === runKey) break;
			runningTools.set(event.sessionId, runKey);
			// Flush any buffered text before tool output
			flushTextBuffer(textBuffers, event.sessionId, sessionName);
			console.error(`${prefix} tool:running  ${event.tool} — ${event.input}`);
			break;
		}

		case 'tool.complete': {
			runningTools.delete(event.sessionId);
			const dur = event.duration ? ` (${(event.duration / 1000).toFixed(1)}s)` : '';
			const output = event.output ? ` → ${event.output.slice(0, 200)}` : '';
			console.error(`${prefix} tool:complete ${event.tool}${dur} — ${event.input}${output}`);
			break;
		}

		case 'tool.error': {
			runningTools.delete(event.sessionId);
			const dur = event.duration ? ` (${(event.duration / 1000).toFixed(1)}s)` : '';
			console.error(
				`${prefix} tool:error    ${event.tool}${dur} — ${event.input} — ${event.error}`,
			);
			break;
		}

		case 'text': {
			// Buffer text deltas and flush on newlines for readability
			const existing = textBuffers.get(event.sessionId) ?? '';
			const combined = existing + event.text;
			const lines = combined.split('\n');
			// Keep the last (possibly incomplete) line in the buffer
			textBuffers.set(event.sessionId, lines.pop() ?? '');
			// Print all complete lines
			for (const line of lines) {
				console.error(`${prefix} > ${line}`);
			}
			break;
		}

		case 'status':
			// Flush text buffer on status change (especially idle)
			flushTextBuffer(textBuffers, event.sessionId, sessionName);
			// Suppress busy/idle — tool lifecycle (pending/running/complete) and
			// step:start/step:finish already convey this. Only log meaningful
			// statuses like retry or compacted.
			if (event.status === 'busy' || event.status === 'idle') break;
			if (event.message) {
				console.error(`${prefix} status:${event.status} — ${event.message}`);
			} else {
				console.error(`${prefix} status:${event.status}`);
			}
			break;

		case 'step.start':
			console.error(`${prefix} step:start`);
			break;

		case 'step.finish': {
			const tokens = `${event.tokens.input} in / ${event.tokens.output} out`;
			const cost = event.cost > 0 ? `, $${event.cost.toFixed(4)}` : '';
			console.error(`${prefix} step:finish — ${tokens}${cost} — ${event.reason}`);
			break;
		}

		case 'error':
			console.error(`${prefix} ERROR: ${event.message}`);
			break;
	}
}

/**
 * Flush any remaining buffered text for a session.
 */
function flushTextBuffer(textBuffers, sessionId, sessionName) {
	const remaining = textBuffers.get(sessionId);
	if (remaining) {
		const prefix = `[opencode] (${sessionName})`;
		console.error(`${prefix} > ${remaining}`);
		textBuffers.set(sessionId, '');
	}
}

// -- Main --------------------------------------------------------------------

async function run() {
	const {
		workflowPath,
		argsJson,
		branch,
		model: modelStr,
		sandbox,
	} = parseArgs(process.argv.slice(2));
	const workdir = process.cwd();
	let startedOpenCode = null;

	if (branch) {
		execFileSync('git', ['checkout', '-B', branch], { stdio: 'inherit' });
	}

	let args = {};
	if (argsJson) {
		try {
			args = JSON.parse(argsJson);
		} catch (error) {
			console.error(
				'Failed to parse --args JSON:',
				error instanceof Error ? error.message : String(error),
			);
			process.exit(1);
		}
	}

	const resolvedPath = path.isAbsolute(workflowPath)
		? workflowPath
		: path.resolve(workdir, workflowPath);
	const workflowUrl = pathToFileURL(resolvedPath).href;

	const { Flue } = await import('@flue/client');

	// Import workflow early to read exports.proxies before starting sandbox
	const workflow = await import(workflowUrl);
	if (typeof workflow.default !== 'function') {
		console.error('Workflow must export a default function.');
		process.exit(1);
	}

	// Read and flatten proxy declarations.
	// Supports both the legacy array format and the new object format (ProxyFactory).
	let proxies;
	const proxyExport = workflow.proxies;
	if (proxyExport && !Array.isArray(proxyExport) && typeof proxyExport === 'object') {
		proxies = Object.values(proxyExport).flatMap((factory) => {
			if (typeof factory !== 'function' || !factory.secretsMap) return [factory];
			const secrets = {};
			for (const [param, envVar] of Object.entries(factory.secretsMap)) {
				secrets[param] = process.env[envVar];
				if (!secrets[param]) {
					console.error(
						`[flue] Missing env var ${envVar} for proxy '${factory.proxyName}'.\n` +
							`Set it in your environment before running in sandbox mode.\n`,
					);
					process.exit(1);
				}
			}
			const result = factory(secrets);
			return Array.isArray(result) ? result : [result];
		});
	} else {
		proxies = Array.isArray(proxyExport) ? proxyExport.flat() : [];
	}
	const proxyInstructions = proxies.map((p) => p.instructions).filter(Boolean);

	if (sandbox) {
		// -- Sandbox mode: run OpenCode inside a Docker container --
		assertDockerAvailable();

		// Validate: at least one model provider proxy must exist
		if (!workflow.proxies) {
			console.error(
				'[flue] Error: No proxies configured.\n' +
					'\n' +
					'In sandbox mode, the workflow must export a `proxies` definition.\n' +
					'Add `export const proxies = { anthropic: anthropic() }` to your workflow file.\n',
			);
			process.exit(1);
		}
		if (!proxies.some((p) => p.isModelProvider)) {
			console.error(
				'[flue] Error: No model provider proxy configured.\n' +
					'\n' +
					'In sandbox mode, the LLM cannot reach the API without a proxy.\n' +
					'Add `anthropic()` (or another provider) to your `export const proxies` array.\n',
			);
			process.exit(1);
		}

		// 1. Start proxy servers on the host
		const handles = startProxyServers(proxies, workflowUrl);
		proxyHandles = handles;
		const proxiesReady = await waitForProxies(handles);
		if (!proxiesReady) {
			console.error('[flue] One or more proxy servers did not become ready');
			stopProxies(handles);
			process.exit(1);
		}
		console.error(`[flue] All ${handles.length} proxy servers ready`);

		// 2. Start the Docker container with proxy configuration
		// NOTE: This must come after waitForProxies() completes. Socket-based proxies
		// (e.g. github-api) create their unix socket files during startup, and Docker
		// resolves bind-mount paths (-v host:container) at `docker run` time. If the
		// socket file doesn't exist yet, the mount silently creates a directory instead.
		const containerName = startSandboxContainer(workdir, sandbox, handles);
		sandboxContainerName = containerName;

		// 3. Run setup commands from proxy services inside the container
		runSetupCommands(containerName, handles);

		// 4. Wait for OpenCode health check inside the container
		const ready = await waitForOpenCode(30000);
		if (!ready) {
			console.error(
				'[flue] OpenCode server in sandbox container did not become ready on http://localhost:48765',
			);
			stopSandboxContainer(containerName);
			stopProxies(handles);
			process.exit(1);
		}
		console.error('[flue] OpenCode server ready inside sandbox container');
	} else {
		// -- Standard mode: run OpenCode directly on the host --
		const isRunning = await isOpenCodeRunning();
		if (!isRunning) {
			startedOpenCode = startOpenCodeServer();
			openCodeProcess = startedOpenCode;
			const ready = await waitForOpenCode();
			if (!ready) {
				console.error('OpenCode server did not become ready on http://localhost:48765');
				stopOpenCodeServer(startedOpenCode);
				process.exit(1);
			}
		}
	}

	// Preflight: check that OpenCode has providers and a default model
	await preflight(workdir, modelStr);

	// Start streaming events from OpenCode (background, logs to stderr)
	const eventStream = startEventStream(workdir);
	eventStreamAbort = eventStream;

	const model = modelStr ? parseModel(modelStr) : undefined;
	const flue = new Flue({
		workdir,
		args,
		branch,
		proxyInstructions: proxyInstructions.length > 0 ? proxyInstructions : undefined,
		model,
	});

	try {
		await workflow.default(flue);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	} finally {
		eventStream.abort();
		eventStreamAbort = null;
		await flue.close();
		if (sandbox) {
			stopSandboxContainer(sandboxContainerName);
			sandboxContainerName = null;
			stopProxies(proxyHandles);
			proxyHandles = null;
		} else {
			if (startedOpenCode) {
				stopOpenCodeServer(startedOpenCode);
			}
			openCodeProcess = null;
		}
	}
}

run();

async function preflight(workdir, modelOverride) {
	const res = await fetch(
		`${OPENCODE_URL}/config/providers?directory=${encodeURIComponent(workdir)}`,
	);
	if (!res.ok) {
		console.error(`[flue] preflight: failed to fetch providers (HTTP ${res.status})`);
		process.exit(1);
	}
	const data = await res.json();
	const providers = data.providers || [];

	if (providers.length === 0) {
		console.error(
			`[flue] Error: No LLM providers configured.\n` +
				`\n` +
				`OpenCode needs at least one provider with an API key to run workflows.\n` +
				`\n` +
				`  - Set an API key env var (e.g. ANTHROPIC_API_KEY)\n` +
				`  - Or run "opencode auth login" to configure a provider\n`,
		);
		process.exit(1);
	}

	// If --model was passed, we're good — it will be sent with each prompt.
	if (modelOverride) return;

	// Otherwise check if OpenCode has a default model configured.
	const configRes = await fetch(`${OPENCODE_URL}/config?directory=${encodeURIComponent(workdir)}`);
	if (!configRes.ok) {
		console.error(`[flue] preflight: failed to fetch config (HTTP ${configRes.status})`);
		process.exit(1);
	}
	const config = await configRes.json();

	if (!config.model) {
		console.error(
			`[flue] Error: No default model configured.\n` +
				`\n` +
				`OpenCode needs a default model to run workflows. Either:\n` +
				`\n` +
				`  - Pass --model to the flue CLI:\n` +
				`    flue run workflow.ts --model anthropic/claude-sonnet-4-5\n` +
				`\n` +
				`  - Or set "model" in your project's opencode.json:\n` +
				`    { "model": "anthropic/claude-sonnet-4-5" }\n`,
		);
		process.exit(1);
	}
}

async function isOpenCodeRunning() {
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 1000);
		await fetch(`${OPENCODE_URL}/health`, { signal: controller.signal });
		clearTimeout(timeout);
		return true;
	} catch {
		return false;
	}
}

function startOpenCodeServer() {
	const child = spawn('opencode', ['serve', '--port', '48765'], {
		stdio: 'inherit',
		env: {
			...process.env,
			// Headless/CI — no human to approve permission prompts.
			// OPENCODE_PERMISSION is read at startup and merged into the config
			// before the permission ruleset is built, so all "ask" rules become "allow".
			OPENCODE_PERMISSION: JSON.stringify({
				// Allow all permissions, by default.
				'*': 'allow',
				// Disable questions, they can block the session
				question: 'deny',
				// Disable tasks, they are problematic for multi-step workflows
				task: 'deny',
			}),
		},
	});
	child.on('error', (error) => {
		console.error(
			'Failed to start OpenCode server:',
			error instanceof Error ? error.message : error,
		);
	});
	return child;
}

async function waitForOpenCode(timeoutMs = 15000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await isOpenCodeRunning()) return true;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	return false;
}

function stopOpenCodeServer(child) {
	child.kill('SIGTERM');
}

function cleanup() {
	if (eventStreamAbort) eventStreamAbort.abort();
	if (openCodeProcess) stopOpenCodeServer(openCodeProcess);
	if (sandboxContainerName) stopSandboxContainer(sandboxContainerName);
	if (proxyHandles) stopProxies(proxyHandles);
}

process.on('SIGINT', () => {
	cleanup();
	process.exit(130);
});

process.on('SIGTERM', () => {
	cleanup();
	process.exit(143);
});

process.on('uncaughtException', (err) => {
	console.error(`[flue] uncaught exception: ${err.message}`);
	cleanup();
	process.exit(1);
});

process.on('unhandledRejection', (reason) => {
	console.error(`[flue] unhandled rejection: ${reason}`);
	cleanup();
	process.exit(1);
});
