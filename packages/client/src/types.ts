import type * as v from 'valibot';
import type { ProxyService } from './proxies/types.ts';

export interface FlueClientOptions {
	/** OpenCode server URL (default: 'http://localhost:48765'). */
	opencodeUrl?: string;
	/** Working directory (the repo root). */
	workdir: string;
	/** Workflow arguments. */
	args?: Record<string, unknown>;
	/** Proxy configs — instructions are extracted and appended to every skill/prompt call. */
	proxies?: ProxyService[];
	/** @deprecated Use `proxies` instead. Proxy instructions to append to every skill/prompt call. */
	proxyInstructions?: string[];
	/** Default model for skill/prompt invocations. */
	model?: { providerID: string; modelID: string };
	/**
	 * Custom fetch implementation for reaching the OpenCode server.
	 * Use this when the OpenCode server is not reachable via global fetch
	 * (e.g. from a Cloudflare Worker, route through sandbox.containerFetch).
	 *
	 * When omitted, the SDK's default fetch (globalThis.fetch) is used.
	 */
	fetch?: (request: Request) => Promise<Response>;
	/**
	 * Custom shell implementation for executing commands.
	 * Use this when child_process is not available (e.g. Cloudflare Workers)
	 * and commands should be routed through sandbox.exec() instead.
	 *
	 * When omitted, commands run via Node.js child_process.exec.
	 */
	shell?: (command: string, options?: ShellOptions) => Promise<ShellResult>;
}

export interface SkillOptions<S extends v.GenericSchema | undefined = undefined> {
	/** Key-value args serialized into the prompt. */
	args?: Record<string, unknown>;
	/** Valibot schema for structured result extraction. */
	result?: S;
	/** Override model for this skill. */
	model?: { providerID: string; modelID: string };
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
