import type { Sandbox } from '@cloudflare/sandbox';
import { createOpencode, type OpencodeServer } from '@cloudflare/sandbox/opencode';
import type { ProxyService } from '@flue/client/proxies';
import { bootstrapScript } from './bootstrap.ts';
import { deriveWorkdir, setup as runSetup } from './setup.ts';
import type { FlueRunnerOptions, StartOptions, WorkflowHandle, WorkflowStatus } from './types.ts';
import { generateProxyToken, type SerializedProxyConfig } from './worker.ts';

const STATUS_DIR = '/tmp/flue-workflow';
const CONFIG_PATH = `${STATUS_DIR}/config.json`;
const BOOTSTRAP_PATH = `${STATUS_DIR}/bootstrap.mjs`;

/** TTL for proxy configs in KV (2 hours). Auto-cleanup even if teardown fails. */
const PROXY_KV_TTL = 7200;

export class FlueRunner {
	readonly sandbox: Sandbox;
	private readonly options: FlueRunnerOptions;
	private readonly workdir: string;
	private readonly sessionId: string;
	private opencodeServer: OpencodeServer | null = null;

	constructor(options: FlueRunnerOptions) {
		this.sandbox = options.sandbox;
		this.options = options;
		this.workdir = options.workdir ?? deriveWorkdir(options.repo);
		this.sessionId = options.sessionId;
	}

	/**
	 * Setup the container: git fetch/clone, install dependencies, build,
	 * configure proxies, start the OpenCode server. Must be called before start().
	 */
	async setup(): Promise<void> {
		await runSetup(this.sandbox, this.options, this.workdir);

		if (this.options.proxies && this.options.proxies.length > 0) {
			await this.setupProxies();
		}

		// Headless agent — no human to approve permission prompts.
		// Must come last so it overrides any project-level config.
		const permission: Record<string, string> = {
			'*': 'allow',
			question: 'deny',
			task: 'deny',
		};

		const opencodeConfig = this.buildOpencodeConfig();
		console.log(`[flue] setup: starting OpenCode server (workdir: ${this.workdir})`);
		const result = await createOpencode(this.sandbox, {
			directory: this.workdir,
			config: {
				...opencodeConfig,
				permission,
			},
		});
		this.opencodeServer = result.server;
		console.log('[flue] setup: OpenCode server started');
		await this.preflight();
	}

	/**
	 * Verify that OpenCode has at least one configured provider.
	 */
	private async preflight(): Promise<void> {
		const url = `http://localhost:48765/config/providers?directory=${encodeURIComponent(this.workdir)}`;
		const res = await this.sandbox.containerFetch(new Request(url), 48765);
		if (!res.ok) {
			throw new Error(`[flue] preflight: failed to fetch providers (HTTP ${res.status})`);
		}
		const data = (await res.json()) as { providers?: unknown[] };
		const providers = data.providers ?? [];
		if (providers.length === 0) {
			throw new Error(
				'[flue] No LLM providers configured.\n' +
					'\n' +
					'OpenCode needs at least one provider with an API key to run workflows.\n' +
					'Pass an API key via opencodeConfig in FlueRunnerOptions.\n',
			);
		}
		console.log(`[flue] preflight: ${providers.length} provider(s) configured`);
	}

	/**
	 * Register proxy configs in KV and configure the container environment.
	 */
	private async setupProxies(): Promise<void> {
		const { proxies, workerUrl, proxySecret, proxyKV, sandbox } = this.options;
		if (!proxies || proxies.length === 0) return;
		if (!workerUrl) throw new Error('[flue] workerUrl is required when proxies are configured');
		if (!proxySecret) throw new Error('[flue] proxySecret is required when proxies are configured');
		if (!proxyKV) throw new Error('[flue] proxyKV is required when proxies are configured');

		const proxyToken = await generateProxyToken(proxySecret, this.sessionId);
		const envVars: Record<string, string> = {};

		for (const proxy of proxies) {
			const proxyUrl = `${workerUrl}/proxy/${this.sessionId}/${proxy.name}`;

			// Store serialized config in KV for the proxy route handler
			const serialized: SerializedProxyConfig = {
				name: proxy.name,
				target: proxy.target,
				headers: proxy.headers ?? {},
				policy: serializePolicy(proxy.policy),
				stripApiV3Prefix: proxy.name === 'github-api',
			};
			await proxyKV.put(`proxy:${this.sessionId}:${proxy.name}`, JSON.stringify(serialized), {
				expirationTtl: PROXY_KV_TTL,
			});

			// github-api: use GH_HOST enterprise mode instead of unix sockets
			if (proxy.name === 'github-api') {
				this.setupGithubApiEnvVars(envVars, proxyToken);
				await this.setupGithubApiCommands();
				continue; // skip preset's setup commands (they're socket-based)
			}

			// Resolve template variables in env vars
			if (proxy.env) {
				for (const [key, value] of Object.entries(proxy.env)) {
					envVars[key] = resolveTemplates(value, proxyUrl, proxyToken);
				}
			}

			// Run setup commands (skip any socket-based commands)
			if (proxy.setup) {
				for (const cmd of proxy.setup) {
					if (cmd.includes('{{socketPath}}')) continue;
					const resolved = resolveTemplates(cmd, proxyUrl, proxyToken);
					try {
						await sandbox.exec(resolved, { cwd: this.workdir });
					} catch {
						console.log(`[flue] Warning: setup for '${proxy.name}' failed: ${resolved}`);
					}
				}
			}
		}

		if (Object.keys(envVars).length > 0) {
			await sandbox.setEnvVars(envVars);
		}

		console.log(
			`[flue] setup: ${proxies.length} proxy(ies) configured for session ${this.sessionId}`,
		);
	}

	/**
	 * Set env vars for gh CLI enterprise mode routing.
	 */
	private setupGithubApiEnvVars(envVars: Record<string, string>, proxyToken: string): void {
		const workerDomain = new URL(this.options.workerUrl!).hostname;
		const compoundToken = `${this.sessionId}:${proxyToken}`;
		envVars['GH_HOST'] = workerDomain;
		envVars['GH_ENTERPRISE_TOKEN'] = compoundToken;
		// Unset GH_TOKEN so gh doesn't prefer it over the enterprise token
		envVars['GH_TOKEN'] = '';
	}

	/**
	 * Run gh CLI config commands for enterprise host.
	 */
	private async setupGithubApiCommands(): Promise<void> {
		const workerDomain = new URL(this.options.workerUrl!).hostname;
		try {
			await this.sandbox.exec(`gh config set -h ${workerDomain} git_protocol https`, {
				cwd: this.workdir,
			});
		} catch {
			console.log('[flue] Warning: gh config set failed (gh may not be installed)');
		}
	}

	/**
	 * Build OpenCode config, routing model providers through proxies when available.
	 */
	private buildOpencodeConfig(): object {
		const { proxies, workerUrl, opencodeConfig } = this.options;

		if (!proxies || proxies.length === 0 || !workerUrl) {
			return opencodeConfig ?? {};
		}

		const providerConfig: Record<string, object> = {};
		for (const proxy of proxies) {
			if (proxy.isModelProvider && proxy.providerConfig) {
				const { providerKey, options = {} } = proxy.providerConfig;
				const proxyUrl = `${workerUrl}/proxy/${this.sessionId}/${proxy.name}`;
				providerConfig[providerKey] = {
					options: {
						baseURL: `${proxyUrl}/v1`,
						...options,
					},
				};
			}
		}

		if (Object.keys(providerConfig).length === 0) {
			return opencodeConfig ?? {};
		}

		return {
			...(opencodeConfig as Record<string, unknown> | undefined),
			provider: providerConfig,
		};
	}

	/**
	 * Start a workflow script as a background process in the container.
	 */
	async start(workflowPath: string, options: StartOptions = {}): Promise<WorkflowHandle> {
		const resolvedWorkflowPath = workflowPath.startsWith('/')
			? workflowPath
			: `${this.workdir}/${workflowPath}`;

		if (options.branch) {
			console.log(`[flue] start: checking out branch ${options.branch}`);
			const result = await this.sandbox.exec(`git checkout -B ${options.branch}`, {
				cwd: this.workdir,
			});
			if (!result.success) {
				throw new Error(
					`[flue] Failed to checkout branch "${options.branch}" (exit ${result.exitCode}):\n${result.stderr}`,
				);
			}
		}

		await this.sandbox.mkdir(STATUS_DIR, { recursive: true });
		await this.sandbox.writeFile(
			CONFIG_PATH,
			JSON.stringify({
				workflowPath: resolvedWorkflowPath,
				workdir: this.workdir,
				branch: options.branch,
				args: options.args ?? {},
				model: options.model,
				proxyInstructions: options.proxyInstructions,
			}),
		);
		await this.sandbox.writeFile(BOOTSTRAP_PATH, bootstrapScript);

		const process = await this.sandbox.startProcess(
			'node --experimental-strip-types /tmp/flue-workflow/bootstrap.mjs',
			{ cwd: this.workdir },
		);

		return { processId: process.id };
	}

	/**
	 * Poll a running workflow's status.
	 */
	static async poll(sandbox: Sandbox, processId: string): Promise<WorkflowStatus> {
		const process = await sandbox.getProcess(processId);
		if (!process) {
			return { status: 'failed', error: 'Process not found' };
		}

		try {
			const content = await sandbox.readFile('/tmp/flue-workflow/status.json');
			const raw =
				typeof content === 'string'
					? content
					: 'content' in content
						? content.content
						: ((content as { text?: string }).text ?? '');
			return JSON.parse(raw) as WorkflowStatus;
		} catch {
			if (process.status === 'running' || process.status === 'starting') {
				return { status: 'running' };
			}
			return { status: 'failed', error: `Process exited with status: ${process.status}` };
		}
	}
}

// -- Helpers -----------------------------------------------------------------

function resolveTemplates(str: string, proxyUrl: string, proxyToken: string): string {
	return str.replace(/\{\{proxyUrl\}\}/g, proxyUrl).replace(/\{\{proxyToken\}\}/g, proxyToken);
}

/**
 * Serialize a ProxyPolicy for KV storage, stripping non-serializable fields
 * (body validators). Method/path matching still works on Cloudflare v1.
 */
function serializePolicy(policy: ProxyService['policy']): SerializedProxyConfig['policy'] {
	if (!policy) return null;
	if (typeof policy === 'string') return { base: policy };

	return {
		base: policy.base,
		allow: policy.allow?.map((r) => ({
			method: r.method,
			path: r.path,
			limit: r.limit,
			// body validators are not serializable — skipped on CF v1
		})),
		deny: policy.deny?.map((r) => ({
			method: r.method,
			path: r.path,
			// body validators are not serializable — skipped on CF v1
		})),
	};
}
