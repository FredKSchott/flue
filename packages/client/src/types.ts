import type * as v from 'valibot';

export interface FlueOptions {
	/** OpenCode server URL (default: 'http://localhost:48765'). */
	opencodeUrl?: string;
	/** Working directory (the repo root on the host). */
	workdir: string;
	/** Override working directory for OpenCode API calls (e.g. /workspace inside a Docker container). */
	containerWorkdir?: string;
	/** Working branch for commits. */
	branch?: string;
	/** Workflow arguments. */
	args?: Record<string, unknown>;
	/** Scoped secrets. */
	secrets?: Record<string, string>;
	/** Default model for skill/prompt invocations. */
	model?: { providerID: string; modelID: string };
}

export interface SkillOptions<S extends v.GenericSchema | undefined = undefined> {
	/** Key-value args serialized into the prompt. */
	args?: Record<string, unknown>;
	/** Valibot schema for structured result extraction. */
	result?: S;
	/** Override model for this skill. */
	model?: { providerID: string; modelID: string };
	/** Advanced: override the entire prompt. */
	prompt?: string;
}

export interface PromptOptions<S extends v.GenericSchema | undefined = undefined> {
	/** Valibot schema for structured result extraction. */
	result?: S;
	/** Override model for this prompt. */
	model?: { providerID: string; modelID: string };
}

export interface ShellOptions {
	/** Environment variables scoped to this subprocess only. */
	env?: Record<string, string>;
	/** Text to pipe to the command's stdin. */
	stdin?: string;
	/** Working directory (default: Flue's workdir). */
	cwd?: string;
	/** Timeout in milliseconds. */
	timeout?: number;
}

export interface ShellResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}
