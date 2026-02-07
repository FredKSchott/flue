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
		const permission: { question: string } = {
			// @ts-expect-error: allow wildcard permission config
			'*': 'allow',
			question: 'deny',
		};
		console.log(`[flue] setup: starting OpenCode server (workdir: ${this.workdir})`);
		const result = await createOpencode(this.sandbox, {
			directory: this.workdir,
			config: {
				...this.options.opencodeConfig,
				// Headless agent — no human to approve permission prompts.
				// Must come last so it overrides any project-level config.
				permission: permission as unknown as Record<string, string>,
			},
		});
		this.opencodeServer = result.server;
		console.log('[flue] setup: OpenCode server started');
	}

	/**
	 * Start a workflow script as a background process in the container.
	 */
	async start(workflowPath: string, options: StartOptions = {}): Promise<WorkflowHandle> {
		const resolvedWorkflowPath = workflowPath.startsWith('/')
			? workflowPath
			: `${this.workdir}/${workflowPath}`;

		await this.sandbox.mkdir(STATUS_DIR, { recursive: true });
		await this.sandbox.writeFile(
			CONFIG_PATH,
			JSON.stringify({
				workflowPath: resolvedWorkflowPath,
				workdir: this.workdir,
				branch: options.branch,
				args: options.args ?? {},
				secrets: options.secrets ?? {},
				model: options.model,
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
