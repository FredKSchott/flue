/**
 * Docker sandbox lifecycle management.
 *
 * Handles starting/stopping the credential-injecting proxy servers and the
 * Docker container that isolates the LLM execution environment from host secrets.
 */

import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_PORT = 4100;

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
 * Start one proxy-server.mjs child process per ProxyService.
 * TCP proxies get ports starting from BASE_PORT; socket proxies get
 * unix socket files in /tmp. Returns an array of handles for health
 * checking, container config, and cleanup.
 */
export function startProxyServers(proxies, workflowPath) {
	const proxyServerPath = path.join(
		path.dirname(fileURLToPath(import.meta.url)),
		'proxy-server.mjs',
	);
	let nextPort = BASE_PORT;
	const handles = [];

	for (let i = 0; i < proxies.length; i++) {
		const proxy = proxies[i];
		const args = ['--workflow', workflowPath, '--proxy-index', String(i)];

		let port;
		let socketPath;

		if (proxy.socket) {
			socketPath = `/tmp/flue-proxy-${proxy.name}.sock`;
			args.push('--socket', socketPath);
		} else {
			port = nextPort++;
			args.push('--port', String(port));
		}

		const child = spawn('node', [proxyServerPath, ...args], {
			stdio: ['ignore', 'inherit', 'inherit'],
			env: process.env,
		});

		child.on('error', (err) => {
			console.error(`[flue] Failed to start proxy '${proxy.name}': ${err.message}`);
		});
		child.on('exit', (code, signal) => {
			if (code !== 0 && code !== null) {
				console.error(`[flue] proxy '${proxy.name}' exited with code ${code}`);
			} else if (signal) {
				console.error(`[flue] proxy '${proxy.name}' killed by signal ${signal}`);
			}
		});

		handles.push({ proxy, port, socketPath, child });
	}

	return handles;
}

/**
 * Wait for all proxy servers to become healthy.
 * TCP proxies: polls /health endpoint. Socket proxies: checks file existence.
 */
export async function waitForProxies(handles, timeoutMs = 10000) {
	const start = Date.now();

	for (const handle of handles) {
		while (Date.now() - start < timeoutMs) {
			if (handle.port !== undefined) {
				try {
					const controller = new AbortController();
					const timeout = setTimeout(() => controller.abort(), 1000);
					const res = await fetch(`http://127.0.0.1:${handle.port}/health`, {
						signal: controller.signal,
					});
					clearTimeout(timeout);
					if (res.ok) break;
				} catch {
					// not ready yet
				}
			} else if (handle.socketPath) {
				if (existsSync(handle.socketPath)) break;
			}

			await new Promise((resolve) => setTimeout(resolve, 200));
		}

		if (Date.now() - start >= timeoutMs) {
			console.error(`[flue] proxy '${handle.proxy.name}' did not become ready`);
			return false;
		}
	}

	return true;
}

/**
 * Replace {{proxyUrl}}, {{socketPath}}, and {{port}} in a template string
 * with values from a proxy handle.
 */
function resolveTemplate(template, handle) {
	let result = template;
	if (handle.port !== undefined) {
		result = result.replace(/\{\{proxyUrl\}\}/g, `http://host.docker.internal:${handle.port}`);
		result = result.replace(/\{\{port\}\}/g, String(handle.port));
	}
	if (handle.socketPath) {
		result = result.replace(/\{\{socketPath\}\}/g, handle.socketPath);
		if (handle.port === undefined) {
			result = result.replace(/\{\{proxyUrl\}\}/g, `http://unix:${handle.socketPath}:`);
		}
	}
	return result;
}

/**
 * Start the sandbox Docker container with security hardening.
 * Returns the container name (used for cleanup).
 */
export function startSandboxContainer(workdir, image, handles) {
	const name = `flue-sandbox-${randomBytes(4).toString('hex')}`;

	// Build OpenCode config dynamically from model provider proxies
	const providerConfig = {};
	for (const handle of handles) {
		if (handle.proxy.isModelProvider && handle.proxy.providerConfig) {
			const { providerKey, options = {} } = handle.proxy.providerConfig;
			const baseURL =
				handle.port !== undefined ? `http://host.docker.internal:${handle.port}/v1` : undefined;
			providerConfig[providerKey] = {
				options: {
					...(baseURL ? { baseURL } : {}),
					...options,
				},
			};
		}
	}
	const opencodeConfig = JSON.stringify({ provider: providerConfig });

	// Run as the same UID:GID that owns the workspace on the host.
	// This avoids file ownership mismatches on the bind mount — the container
	// can read/write workspace files without chown/chmod workarounds.
	const stat = statSync(workdir);
	const userFlag = `${stat.uid}:${stat.gid}`;

	const dockerArgs = [
		'run',
		'-d',
		'--name',
		name,
		'--user',
		userFlag,
		// Security hardening: drop all capabilities since we run as the
		// workspace owner (no need for CHOWN/SETUID/SETGID).
		'--security-opt=no-new-privileges',
		'--cap-drop=ALL',
		// Port mapping: OpenCode server accessible from localhost only
		'-p',
		'127.0.0.1:48765:48765',
		// Allow container to reach host (for the API proxies)
		'--add-host=host.docker.internal:host-gateway',
		// Bind mount the workspace at the same path as on the host.
		// This avoids needing a separate "container workdir" concept — the same
		// path works everywhere (host shell, OpenCode API, LLM tools).
		'-v',
		`${workdir}:${workdir}`,
	];

	// Bind mount unix sockets for socket-based proxies
	for (const handle of handles) {
		if (handle.socketPath) {
			dockerArgs.push('-v', `${handle.socketPath}:${handle.socketPath}`);
		}
	}

	// Set HOME to /tmp so tools (npm, pnpm, git) that write to $HOME
	// work when running as a non-root user via --user.
	dockerArgs.push('-e', 'HOME=/tmp');

	// Environment: auto-approve all permissions (headless CI)
	dockerArgs.push(
		'-e',
		`OPENCODE_PERMISSION=${JSON.stringify({
			'*': 'allow',
			question: 'deny',
			task: 'deny',
		})}`,
	);

	// Environment: OpenCode config with proxy-based providers
	dockerArgs.push('-e', `OPENCODE_CONFIG_CONTENT=${opencodeConfig}`);

	// Environment variables from all proxy services (templates resolved)
	for (const handle of handles) {
		if (handle.proxy.env) {
			for (const [key, value] of Object.entries(handle.proxy.env)) {
				dockerArgs.push('-e', `${key}=${resolveTemplate(value, handle)}`);
			}
		}
	}

	// The image to run
	dockerArgs.push(image);

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
 * Run setup commands from all proxy services inside the container.
 * Failures are logged as warnings — some commands may legitimately fail
 * (e.g., `gh config set` when `gh` isn't installed in the image).
 */
export function runSetupCommands(containerName, handles) {
	for (const handle of handles) {
		if (!handle.proxy.setup || handle.proxy.setup.length === 0) continue;

		for (const cmd of handle.proxy.setup) {
			const resolvedCmd = resolveTemplate(cmd, handle);
			try {
				execFileSync('docker', ['exec', containerName, 'sh', '-c', resolvedCmd], {
					stdio: ['ignore', 'inherit', 'inherit'],
					timeout: 10000,
				});
			} catch (err) {
				console.error(
					`[flue] Warning: setup command for '${handle.proxy.name}' failed: ${resolvedCmd}`,
				);
			}
		}
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
 * Stop all proxy child processes and clean up socket files.
 */
export function stopProxies(handles) {
	if (!handles) return;
	for (const handle of handles) {
		if (handle.child && !handle.child.killed) {
			handle.child.kill('SIGTERM');
		}
		if (handle.socketPath) {
			try {
				unlinkSync(handle.socketPath);
			} catch {
				// Socket may already be cleaned up
			}
		}
	}
}
