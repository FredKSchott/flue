import type { ProxyPolicy, ProxyService } from './types.ts';

/**
 * GitHub proxy preset.
 *
 * Returns two `ProxyService` objects:
 * - `github-api`: unix socket proxy for REST/GraphQL API (api.github.com),
 *   used by the `gh` CLI and `curl`.
 * - `github-git`: TCP port proxy for git smart HTTP (github.com),
 *   used by `git clone`, `git fetch`, `git push`.
 *
 * Both share the same token and policy.
 */
export function github(opts: { token: string; policy?: string | ProxyPolicy }): ProxyService[] {
	const resolvedPolicy = resolveGitHubPolicy(opts.policy);

	const denyResponse = ({
		method,
		path,
		reason,
	}: {
		method: string;
		path: string;
		reason: string;
	}) => ({
		status: 403,
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			message: `Blocked by flue proxy policy: ${method} ${path} — ${reason}`,
			documentation_url: 'https://flue.dev/docs/proxy-policy',
		}),
	});

	const apiProxy: ProxyService = {
		name: 'github-api',
		target: 'https://api.github.com',
		headers: {
			authorization: `token ${opts.token}`,
			host: 'api.github.com',
			'user-agent': 'flue-proxy',
		},
		policy: resolvedPolicy,
		socket: true,
		env: {
			GH_TOKEN: 'proxy-placeholder',
		},
		setup: [
			// Route gh CLI traffic through the proxy unix socket.
			'gh config set http_unix_socket {{socketPath}} 2>/dev/null || true',
		],
		instructions: [
			'The `gh` CLI is pre-configured with authentication.',
			'For GitHub API calls, prefer `gh api` over raw `curl`.',
		].join(' '),
		denyResponse,
	};

	const gitProxy: ProxyService = {
		name: 'github-git',
		target: 'https://github.com',
		headers: {
			authorization: `Basic ${Buffer.from(`x-access-token:${opts.token}`).toString('base64')}`,
			'user-agent': 'flue-proxy',
		},
		policy: resolvedPolicy,
		setup: [
			// Route git clone/fetch/push through the proxy HTTP endpoint.
			'git config --global url."{{proxyUrl}}/".insteadOf "https://github.com/"',
			'git config --global http.{{proxyUrl}}/.extraheader "Authorization: Bearer proxy-placeholder"',
		],
		denyResponse,
	};

	return [apiProxy, gitProxy];
}

/**
 * Resolve a GitHub policy into a concrete ProxyPolicy.
 *
 * Accepts a core policy level string ('allow-read', 'allow-all', 'deny-all')
 * or a ProxyPolicy object. Defaults to 'allow-read' if omitted.
 *
 * When the base is 'allow-read', GitHub-specific allow rules are prepended
 * so that the gh CLI (GraphQL queries) and git clone/fetch work out of the box.
 * Other base levels are used as-is.
 */
function resolveGitHubPolicy(policy?: string | ProxyPolicy): ProxyPolicy {
	const base = typeof policy === 'string' ? policy : (policy?.base ?? 'allow-read');
	const userAllow = typeof policy === 'object' ? (policy.allow ?? []) : [];
	const userDeny = typeof policy === 'object' ? (policy.deny ?? []) : [];

	switch (base) {
		case 'allow-all':
		case 'deny-all':
			return { base, allow: userAllow, deny: userDeny };

		case 'allow-read':
		default:
			return {
				base: 'allow-read',
				allow: [
					// gh CLI uses POST /graphql for most read operations
					{ method: 'POST', path: '/graphql', body: githubBody.graphql() },
					// git clone / fetch
					{ method: 'POST', path: '/*/git-upload-pack' },
					{ method: 'GET', path: '/*/info/refs' },
					...userAllow,
				],
				deny: userDeny,
			};
	}
}

/**
 * Body validation helpers for GitHub API requests.
 *
 * These return validator functions suitable for `PolicyRule.body`.
 */
export const githubBody = {
	/** Validate an issue creation body. */
	issue(opts: { titleMatch?: RegExp; requiredLabels?: string[] }) {
		return (body: unknown): boolean => {
			const b = body as { title?: string; labels?: (string | { name: string })[] };
			if (opts.titleMatch && !opts.titleMatch.test(b?.title ?? '')) return false;
			if (opts.requiredLabels) {
				const labels = (b?.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name));
				if (!opts.requiredLabels.every((r) => labels.includes(r))) return false;
			}
			return true;
		};
	},

	/** Validate a comment body. */
	comment(opts: { maxLength?: number; pattern?: RegExp }) {
		return (body: unknown): boolean => {
			const b = body as { body?: string };
			if (typeof b?.body !== 'string') return false;
			if (opts.maxLength && b.body.length > opts.maxLength) return false;
			if (opts.pattern && !opts.pattern.test(b.body)) return false;
			return true;
		};
	},

	/** Validate a GraphQL request — restrict to queries only, or specific operations. */
	graphql(opts?: { allowedOperations?: string[]; denyMutations?: boolean }) {
		return (body: unknown): boolean => {
			const b = body as { query?: string; operationName?: string };
			if (typeof b?.query !== 'string') return false;

			if (opts?.denyMutations !== false) {
				// Default: deny mutations
				const trimmed = b.query.replace(/\s+/g, ' ').trim();
				if (trimmed.startsWith('mutation') || /^\s*mutation\b/.test(trimmed)) {
					return false;
				}
			}

			if (opts?.allowedOperations) {
				if (!b.operationName || !opts.allowedOperations.includes(b.operationName)) {
					return false;
				}
			}

			return true;
		};
	},
};
