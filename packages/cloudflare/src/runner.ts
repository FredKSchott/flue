import type { Sandbox } from '@cloudflare/sandbox';
import { createOpencode, type OpencodeServer } from '@cloudflare/sandbox/opencode';
import { FlueClient } from '@flue/client';
import type { ProxyService } from '@flue/client/proxies';
import { bootstrapScript } from './bootstrap.ts';
import type { FlueRuntimeOptions, StartOptions, WorkflowHandle, WorkflowStatus } from './types.ts';
import { generateProxyToken, type SerializedProxyConfig } from './worker.ts';

const STATUS_DIR = '/tmp/flue-workflow';
const CONFIG_PATH = `${STATUS_DIR}/config.json`;
const BOOTSTRAP_PATH = `${STATUS_DIR}/bootstrap.mjs`;

/** TTL for proxy configs in KV (2 hours). Auto-cleanup even if teardown fails. */
const PROXY_KV_TTL = 7200;

export class FlueRuntime {
	readonly sandbox: Sandbox;
	private readonly options: FlueRuntimeOptions;
	readonly workdir: string;
	private readonly sessionId: string;
	private opencodeServer: OpencodeServer | null = null;
	private resolvedProxies: ProxyService[] = [];
	private _client: FlueClient | null = null;
	private setupComplete = false;

	constructor(options: FlueRuntimeOptions) {
		this.sandbox = options.sandbox;
		this.options = options;
		this.workdir = options.workdir;
		this.sessionId = options.sessionId;
	}

	/**
	 * Lazily-created FlueClient wired to this sandbox. Throws if called before setup().
	 */
	get client(): FlueClient {
		if (!this.setupComplete) {
			throw new Error('[flue] Cannot access .client before setup() completes');
		}
		if (!this._client) {
			this._client = new FlueClient({
				workdir: this.workdir,
				args: this.options.args,
				model: this.options.model,
				proxies: this.resolvedProxies,
				fetch: (req: Request) => this.sandbox.containerFetch(req, 48765),
				shell: async (
					cmd: string,
					opts?: { cwd?: string; env?: Record<string, string>; timeout?: number },
				) => {
					const result = await this.sandbox.exec(cmd, {
						cwd: opts?.cwd,
						env: opts?.env,
						timeout: opts?.timeout,
					});
					return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
				},
			});
		}
		return this._client;
	}

	/**
	 * Initialize the runtime: configure proxies, start the OpenCode server,
	 * and verify providers. Must be called before accessing .client.
	 *
	 * Repo-specific setup (clone, install, build, branch checkout) is the
	 * caller's responsibility — use flue.client.shell() after setup().
	 */
	async setup(): Promise<void> {
		// Flatten gateway proxies
		if (this.options.gateway) {
			this.resolvedProxies = this.options.gateway.proxies.flat();
		}

		if (this.resolvedProxies.length > 0) {
			await this.setupProxies();
		}

		const opencodeConfig = this.buildOpencodeConfig();
		console.log(`[flue] setup: starting OpenCode server (workdir: ${this.workdir})`);
		const result = await createOpencode(this.sandbox, {
			directory: this.workdir,
			config: {
				...opencodeConfig,
				// Headless agent — no human to approve permission prompts.
				permission: { '*': 'allow', question: 'deny', task: 'deny' } as Record<string, string>,
			},
		});
		this.opencodeServer = result.server;
		console.log('[flue] setup: OpenCode server started');
		await this.preflight();
		this.setupComplete = true;
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
					'Pass an API key via opencodeConfig in FlueRuntimeOptions.\n',
			);
		}
		console.log(`[flue] preflight: ${providers.length} provider(s) configured`);
	}

	/**
	 * Register proxy configs in KV and configure the container environment.
	 */
	private async setupProxies(): Promise<void> {
		const gateway = this.options.gateway;
		const proxies = this.resolvedProxies;
		if (proxies.length === 0 || !gateway) return;

		const { url, secret, kv } = gateway;
		if (!url) throw new Error('[flue] gateway.url is required when proxies are configured');
		if (!secret) throw new Error('[flue] gateway.secret is required when proxies are configured');
		if (!kv) throw new Error('[flue] gateway.kv is required when proxies are configured');

		const proxyToken = await generateProxyToken(secret, this.sessionId);
		const envVars: Record<string, string> = {};

		for (const proxy of proxies) {
			const proxyUrl = `${url}/proxy/${this.sessionId}/${proxy.name}`;

			// Store serialized config in KV for the proxy route handler
			const serialized: SerializedProxyConfig = {
				name: proxy.name,
				target: proxy.target,
				headers: proxy.headers ?? {},
				policy: serializePolicy(proxy.policy),
				stripApiV3Prefix: proxy.name === 'github-api',
			};
			await kv.put(`proxy:${this.sessionId}:${proxy.name}`, JSON.stringify(serialized), {
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
						await this.sandbox.exec(resolved, { cwd: this.workdir });
					} catch {
						console.log(`[flue] Warning: setup for '${proxy.name}' failed: ${resolved}`);
					}
				}
			}
		}

		if (Object.keys(envVars).length > 0) {
			await this.sandbox.setEnvVars(envVars);
		}

		console.log(
			`[flue] setup: ${proxies.length} proxy(ies) configured for session ${this.sessionId}`,
		);
	}

	/**
	 * Set env vars for gh CLI enterprise mode routing.
	 */
	private setupGithubApiEnvVars(envVars: Record<string, string>, proxyToken: string): void {
		const workerDomain = new URL(this.options.gateway!.url).hostname;
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
		const workerDomain = new URL(this.options.gateway!.url).hostname;
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
		const gateway = this.options.gateway;
		const proxies = this.resolvedProxies;

		if (proxies.length === 0 || !gateway) {
			return this.options.opencodeConfig ?? {};
		}

		const providerConfig: Record<string, object> = {};
		for (const proxy of proxies) {
			if (proxy.isModelProvider && proxy.providerConfig) {
				const { providerKey, options = {} } = proxy.providerConfig;
				const proxyUrl = `${gateway.url}/proxy/${this.sessionId}/${proxy.name}`;
				providerConfig[providerKey] = {
					options: {
						baseURL: `${proxyUrl}/v1`,
						...options,
					},
				};
			}
		}

		if (Object.keys(providerConfig).length === 0) {
			return this.options.opencodeConfig ?? {};
		}

		return {
			...(this.options.opencodeConfig as Record<string, unknown> | undefined),
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
