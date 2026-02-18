// Secrets and bindings that wrangler can't auto-detect.
export interface AppEnv extends Env {
	ANTHROPIC_API_KEY: string;
	/** GitHub token injected into the container via proxy. Handles all reads and writes. */
	GITHUB_TOKEN_BOT: string;
	GITHUB_WEBHOOK_SECRET: string;
	/** Secret for generating per-session HMAC proxy tokens. */
	PROXY_SECRET: string;
	TURBO_REMOTE_CACHE_URL: string;
	TURBO_REMOTE_CACHE_TEAM: string;
	TURBO_REMOTE_CACHE_TOKEN: string;
	TRIAGE_WORKFLOW: Workflow;
	TRIAGE_KV: KVNamespace;
}
