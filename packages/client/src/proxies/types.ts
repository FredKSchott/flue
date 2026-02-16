export interface ProxyService {
	/**
	 * Human-readable name for logging and debugging.
	 * Examples: 'anthropic', 'github-api', 'github-git', 'internal-api'
	 */
	name: string;

	/**
	 * Upstream URL to forward requests to.
	 * Examples: 'https://api.anthropic.com', 'https://api.github.com'
	 */
	target: string;

	/**
	 * Headers to inject/override on every proxied request.
	 * Existing request headers with the same key are replaced.
	 * This is the simple path — for most proxies, this is all you need.
	 */
	headers?: Record<string, string>;

	/**
	 * Advanced: custom request transformation function.
	 * Receives the incoming request info, returns modified headers.
	 * Runs AFTER `headers` are applied (if both are set).
	 * Use this when you need to inspect the request before deciding
	 * what headers to set (e.g., different auth for different paths).
	 */
	transform?: (req: { method: string; url: string; headers: Record<string, string> }) => {
		headers: Record<string, string>;
	};

	/**
	 * Shell commands to run inside the container during setup.
	 * Executed in order after the container starts, before any skills run.
	 *
	 * Template variables (resolved by the runner at startup):
	 *   {{proxyUrl}}    - HTTP URL reachable from inside the container
	 *                     e.g., http://host.docker.internal:4101
	 *   {{socketPath}}  - Path to the unix socket inside the container
	 *                     (only available when socket: true)
	 *   {{port}}        - TCP port number the proxy listens on
	 */
	setup?: string[];

	/**
	 * Environment variables to set in the container.
	 * Template variables ({{proxyUrl}}, {{socketPath}}, {{port}}) are resolved.
	 */
	env?: Record<string, string>;

	/**
	 * Instructions appended to every skill/prompt call.
	 * Used when the proxy can't be made fully transparent and the LLM
	 * needs guidance (e.g., "prefer `gh api` over raw `curl`").
	 */
	instructions?: string;

	/**
	 * Listen on a unix socket instead of a TCP port.
	 * The socket file is created on the host and bind-mounted into the container.
	 * Useful for tools like the GitHub CLI that support unix socket routing.
	 * Default: false (TCP port).
	 */
	socket?: boolean;

	/**
	 * Access control policy for this proxy.
	 *
	 * String shorthand: a named policy level defined by the preset.
	 * Object form: full control with default level + allow/deny rules.
	 *
	 * When a string is provided, it is equivalent to { default: theString }.
	 *
	 * If omitted, defaults to 'read-only' (GET/HEAD only).
	 * Each preset defines what its policy levels mean — see the preset
	 * documentation for available levels.
	 */
	policy?: string | ProxyPolicy;

	/**
	 * Marks this proxy as a model provider (Anthropic, Google, etc.).
	 * The CLI validates that at least one model provider proxy is present
	 * in sandbox mode. Model provider proxies also configure OpenCode's
	 * provider settings automatically.
	 */
	isModelProvider?: boolean;

	/**
	 * Provider-specific config for OpenCode integration.
	 * Only relevant when isModelProvider is true.
	 * Used to generate OPENCODE_CONFIG_CONTENT for the container.
	 */
	providerConfig?: {
		/** Provider key in OpenCode config (e.g., 'anthropic', 'google') */
		providerKey: string;
		/** Additional options merged into the provider config */
		options?: Record<string, unknown>;
	};

	/**
	 * Generate the deny response body for this proxy's API format.
	 * Called when a request is blocked by policy. The preset knows whether
	 * the upstream API uses JSON, plain text, etc.
	 *
	 * If not provided, the proxy returns a generic JSON error body.
	 */
	denyResponse?: (info: { method: string; path: string; reason: string }) => {
		status: number;
		headers: Record<string, string>;
		body: string;
	};
}

export interface ProxyPolicy {
	/**
	 * The base policy level. Preset-defined string that maps to a set of rules.
	 * Common levels: 'read-only', 'allow-all', 'deny-all'.
	 * Presets may define additional levels (e.g., 'read-only+clone' for GitHub).
	 */
	default: string;

	/**
	 * Explicit allow rules. Evaluated after deny rules.
	 * A request matching an allow rule is permitted (subject to rate limits).
	 * If a request matches method + path but fails body validation, the rule
	 * does not match and evaluation continues to the next rule or default.
	 */
	allow?: PolicyRule[];

	/**
	 * Explicit deny rules. Evaluated first — a matching deny always wins.
	 * Use for hard restrictions that should never be overridden.
	 */
	deny?: PolicyRule[];
}

export interface PolicyRule {
	/**
	 * HTTP method(s) to match. '*' matches any method.
	 * Examples: 'GET', 'POST', ['GET', 'HEAD'], '*'
	 */
	method: string | string[];

	/**
	 * URL path pattern to match. Uses glob-style wildcards:
	 * a single `*` matches exactly one path segment, and `**`
	 * matches any number of path segments.
	 */
	path: string;

	/**
	 * Maximum number of times this rule can be matched per workflow run.
	 * After the limit is hit, subsequent matching requests are denied.
	 * Omit for unlimited.
	 *
	 * The counter lives in-memory in the proxy process. Since each proxy
	 * process maps to one workflow run, counters reset naturally when the
	 * workflow ends.
	 */
	limit?: number;

	/**
	 * Validate the parsed JSON request body.
	 * Return true to allow, false to deny.
	 *
	 * Only called for requests with a JSON Content-Type.
	 * If the body isn't JSON or can't be parsed, the validator receives null.
	 *
	 * This is a plain JavaScript function — presets can provide helper
	 * functions for common patterns (see githubBody helpers).
	 */
	body?: (parsedBody: unknown) => boolean;
}

/**
 * Return type for preset functions. A preset may return a single
 * ProxyService or an array (e.g., github() returns two proxies).
 * The CLI auto-flattens with proxies.flat().
 */
export type ProxyPresetResult = ProxyService | ProxyService[];
