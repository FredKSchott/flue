import type { Sandbox } from '@cloudflare/sandbox';
import type { ProxyFactory, ProxyService } from '@flue/client/proxies';

/** Minimal KV interface — avoids depending on @cloudflare/workers-types. */
export interface KV {
	get<T = unknown>(key: string, format: 'json'): Promise<T | null>;
	put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
	delete(key: string): Promise<void>;
}

export interface FlueRunnerOptions {
	/** A Sandbox instance from getSandbox(). */
	sandbox: Sandbox;
	/** Session ID for this sandbox (must match the ID passed to getSandbox). */
	sessionId: string;
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
	/** Unresolved proxy definitions from the workflow module. */
	proxyDefinitions?: Record<string, ProxyFactory<any>>;
	/** Secrets for each proxy, keyed by the proxy definition key. */
	proxySecrets?: Record<string, Record<string, string>>;
	/** Pre-resolved proxy configs (alternative to proxyDefinitions + proxySecrets). */
	proxies?: ProxyService[];
	/** The Worker's public URL (e.g., 'https://astro-triage.workers.dev'). Required when proxies are configured. */
	workerUrl?: string;
	/** Secret used to generate per-session HMAC proxy tokens. Required when proxies are configured. */
	proxySecret?: string;
	/** KV namespace for storing proxy configs across Worker invocations. Required when proxies are configured. */
	proxyKV?: KV;
}

export interface StartOptions {
	/** Workflow arguments (available as flue.args in the script). */
	args?: Record<string, unknown>;
	/** Working branch for commits. */
	branch?: string;
	/** Default model for skill invocations. */
	model?: { providerID: string; modelID: string };
	/** Proxy instructions appended to every skill/prompt call. */
	proxyInstructions?: string[];
}

export interface WorkflowHandle {
	/** Process ID for polling across DO resets. */
	processId: string;
}

export type WorkflowStatus =
	| { status: 'running' }
	| { status: 'completed'; result: unknown }
	| { status: 'failed'; error: string };
