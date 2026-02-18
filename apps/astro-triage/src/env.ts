// Secrets and bindings that wrangler can't auto-detect.
// GATEWAY_URL is a plain var — auto-detected by wrangler types into Env.
export interface AppEnv extends Env {
	ANTHROPIC_API_KEY: string;
	GITHUB_TOKEN_BOT: string;
	GITHUB_WEBHOOK_SECRET: string;
	GATEWAY_SECRET: string;
	TURBO_REMOTE_CACHE_URL: string;
	TURBO_REMOTE_CACHE_TEAM: string;
	TURBO_REMOTE_CACHE_TOKEN: string;
	TRIAGE_WORKFLOW: Workflow;
	GATEWAY_KV: KVNamespace;
}
