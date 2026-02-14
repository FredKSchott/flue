/**
 * Docker sandbox lifecycle management.
 *
 * Handles starting/stopping the API proxy and Docker container that isolate
 * the LLM execution environment from host secrets. This module is the future
 * boundary for extracting into a standalone `@flue/docker` package.
 */

import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROXY_PORT = 4100;

/**
 * Check that Docker is available on the host.
 * Throws a descriptive error message and exits if not.
 */
export function assertDockerAvailable() {
	try {
		execFileSync('docker', ['info'], { stdio: 'ignore' });
	} catch {
		console.error(
			`[flue] Error: Docker is not available.\n` +
				`\n` +
				`The --sandbox flag requires Docker to isolate the LLM execution environment.\n` +
				`\n` +
				`  - Install Docker: https://docs.docker.com/get-docker/\n` +
				`  - On GitHub Actions, Docker is pre-installed on ubuntu-latest runners.\n`,
		);
		process.exit(1);
	}
}

/**
 * Start the API proxy as a background child process.
 * The proxy listens on 127.0.0.1:PROXY_PORT, adds the ANTHROPIC_API_KEY
 * header, and forwards requests to api.anthropic.com.
 * Returns the child process handle.
 */
export function startProxyServer() {
	const proxyPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'proxy.mjs');
	const child = spawn('node', [proxyPath, '--port', String(PROXY_PORT)], {
		stdio: ['ignore', 'inherit', 'inherit'],
		env: process.env,
	});
	child.on('error', (err) => {
		console.error(`[flue] Failed to start API proxy: ${err.message}`);
	});
	return child;
}

/**
 * Wait for the API proxy to become healthy.
 */
export async function waitForProxy() {
	const start = Date.now();
	const timeoutMs = 10000;
	while (Date.now() - start < timeoutMs) {
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 1000);
			const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/health`, {
				signal: controller.signal,
			});
			clearTimeout(timeout);
			if (res.ok) return true;
		} catch {
			// not ready yet
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	return false;
}

/**
 * Start the sandbox Docker container with security hardening.
 * Returns the container name (used for cleanup).
 */
export function startSandboxContainer(workdir, image) {
	const name = `flue-sandbox-${randomBytes(4).toString('hex')}`;

	// OpenCode config that routes Anthropic requests through the host proxy.
	// The container never sees the real API key.
	const opencodeConfig = JSON.stringify({
		provider: {
			anthropic: {
				options: {
					baseURL: `http://host.docker.internal:${PROXY_PORT}`,
				},
			},
		},
	});

	const dockerArgs = [
		'run',
		'-d',
		'--name',
		name,
		// Security hardening
		'--security-opt=no-new-privileges',
		'--cap-drop=ALL',
		'--cap-add=CHOWN',
		'--cap-add=SETUID',
		'--cap-add=SETGID',
		// Port mapping: OpenCode server accessible from localhost only
		'-p',
		'127.0.0.1:48765:48765',
		// Allow container to reach host (for the API proxy)
		'--add-host=host.docker.internal:host-gateway',
		// Bind mount the workspace
		'-v',
		`${workdir}:/workspace`,
		'-w',
		'/workspace',
		// Environment: auto-approve all permissions (headless CI)
		'-e',
		`OPENCODE_PERMISSION=${JSON.stringify({ '*': 'allow' })}`,
		// Environment: OpenCode config with proxy-based provider
		'-e',
		`OPENCODE_CONFIG_CONTENT=${opencodeConfig}`,
		// The image to run
		image,
	];

	try {
		const containerId = execFileSync('docker', dockerArgs, { encoding: 'utf8' }).trim();
		console.error(`[flue] sandbox container started: ${name} (${containerId.slice(0, 12)})`);
		return name;
	} catch (err) {
		console.error(
			`[flue] Failed to start sandbox container: ${err instanceof Error ? err.message : String(err)}`,
		);
		process.exit(1);
	}
}

/**
 * Stop and remove the sandbox container.
 */
export function stopSandboxContainer(name) {
	if (!name) return;
	try {
		execFileSync('docker', ['stop', '-t', '5', name], { stdio: 'ignore' });
	} catch {
		// container may already be stopped
	}
	try {
		execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
	} catch {
		// container may already be removed
	}
	console.error(`[flue] sandbox container stopped: ${name}`);
}

/**
 * Stop the proxy child process.
 */
export function stopProxy(child) {
	if (!child || child.killed) return;
	child.kill('SIGTERM');
}

export { PROXY_PORT };
