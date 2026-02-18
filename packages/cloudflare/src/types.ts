import type { Sandbox } from '@cloudflare/sandbox';
import type { ProxyService } from '@flue/client/proxies';

/** Minimal KV interface — avoids depending on @cloudflare/workers-types. */
export interface KV {
	get<T = unknown>(key: string, format: 'json'): Promise<T | null>;
	put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
	delete(key: string): Promise<void>;
}

export interface GatewayOptions {
	/** Resolved proxy configs. Accepts a mix of single services and arrays
	 *  (e.g., github() returns ProxyService[]). Flattened internally. */
	proxies: (ProxyService | ProxyService[])[];
	/** The Worker's public URL (e.g., 'https://astro-triage.workers.dev'). */
	url: string;
	/** Secret used to generate per-session HMAC proxy tokens. */
	secret: string;
	/** KV namespace for storing proxy configs. */
	kv: KV;
}

export interface FlueRuntimeOptions {
	/** A Sandbox instance from getSandbox(). */
	sandbox: Sandbox;
	/** Session ID for this sandbox (must match the ID passed to getSandbox). */
	sessionId: string;
	/** Working directory inside the container (e.g., '/home/user/astro'). */
	workdir: string;
	/** Config passed to createOpencode() for provider/model setup. */
	opencodeConfig?: object;
	/** Proxy gateway configuration. Omit if no proxies needed. */
	gateway?: GatewayOptions;
	/** Workflow arguments available as flue.client.args. */
	args?: Record<string, unknown>;
	/** Default model for skill/prompt invocations. */
	model?: { providerID: string; modelID: string };
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
