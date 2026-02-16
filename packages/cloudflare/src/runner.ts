import type { Sandbox } from '@cloudflare/sandbox';
import { createOpencode, type OpencodeServer } from '@cloudflare/sandbox/opencode';
import { bootstrapScript } from './bootstrap.ts';
import { deriveWorkdir, setup as runSetup } from './setup.ts';
import type { FlueRunnerOptions, StartOptions, WorkflowHandle, WorkflowStatus } from './types.ts';

const STATUS_DIR = '/tmp/flue-workflow';
const CONFIG_PATH = `${STATUS_DIR}/config.json`;
const BOOTSTRAP_PATH = `${STATUS_DIR}/bootstrap.mjs`;

export class FlueRunner {
	readonly sandbox: Sandbox;
	private readonly options: FlueRunnerOptions;
	private readonly workdir: string;
	private opencodeServer: OpencodeServer | null = null;

	constructor(options: FlueRunnerOptions) {
		this.sandbox = options.sandbox;
		this.options = options;
		this.workdir = options.workdir ?? deriveWorkdir(options.repo);
	}

	/**
	 * Setup the container: git fetch/clone, install dependencies, build,
	 * start the OpenCode server. Must be called before start().
	 */
	async setup(): Promise<void> {
		await runSetup(this.sandbox, this.options, this.workdir);
		// Headless agent — no human to approve permission prompts.
		// Must come last so it overrides any project-level config.
		const permission: Record<string, string> = {
			// Allow all permissions, by default.
			'*': 'allow',
			// Disable questions, they can block the session
			question: 'deny',
			// Disable tasks, they are problematic for multi-step workflows
			task: 'deny',
		};
		console.log(`[flue] setup: starting OpenCode server (workdir: ${this.workdir})`);
		const result = await createOpencode(this.sandbox, {
			directory: this.workdir,
			config: {
				...this.options.opencodeConfig,
				permission,
			},
		});
		this.opencodeServer = result.server;
		console.log('[flue] setup: OpenCode server started');
		await this.preflight();
	}

	/**
	 * Verify that OpenCode has at least one configured provider.
	 * Catches misconfiguration early with a clear error message.
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
	 * Start a workflow script as a background process in the container.
	 */
	async start(workflowPath: string, options: StartOptions = {}): Promise<WorkflowHandle> {
		const resolvedWorkflowPath = workflowPath.startsWith('/')
			? workflowPath
			: `${this.workdir}/${workflowPath}`;

		// Create/checkout working branch before the workflow runs.
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
