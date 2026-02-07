import type { Sandbox } from '@cloudflare/sandbox';

export interface FlueRunnerOptions {
	/** A Sandbox instance from getSandbox(). */
	sandbox: Sandbox;
	/** GitHub repo in 'owner/repo' format. */
	repo: string;
	/** Base branch to fetch from (default: 'main'). */
	baseBranch?: string;
	/** If true, repo is pre-baked in the Docker image (skip clone). */
	prebaked?: boolean;
	/** Override working directory (default: /home/user/{repo-name}). */
	workdir?: string;
	/** Config passed to createOpencode() for provider/model setup. */
	opencodeConfig?: object;
}

export interface StartOptions {
	/** Workflow arguments (available as flue.args in the script). */
	args?: Record<string, unknown>;
	/** Scoped secrets (available as flue.secrets in the script). */
	secrets?: Record<string, string>;
	/** Working branch for commits. */
	branch?: string;
	/** Default model for skill invocations. */
	model?: { providerID: string; modelID: string };
}

export interface WorkflowHandle {
	/** Process ID for polling across DO resets. */
	processId: string;
}

export type WorkflowStatus =
	| { status: 'running' }
	| { status: 'completed'; result: unknown }
	| { status: 'failed'; error: string };
