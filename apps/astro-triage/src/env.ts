// Secrets and bindings that wrangler can't auto-detect.
export interface AppEnv extends Env {
	ANTHROPIC_API_KEY: string;
	/** Read-only token passed to the container for git push via proxy. */
	GITHUB_TOKEN: string;
	/** Write token (comments, labels). Worker-side only — must not be shared with the sandbox. */
	GITHUB_TOKEN_BOT: string;
	GITHUB_WEBHOOK_SECRET: string;
	TURBO_REMOTE_CACHE_URL: string;
	TURBO_REMOTE_CACHE_TEAM: string;
	TURBO_REMOTE_CACHE_TOKEN: string;
	TRIAGE_WORKFLOW: Workflow;
	TRIAGE_KV: KVNamespace;
}
