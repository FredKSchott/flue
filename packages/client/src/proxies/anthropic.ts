import type { ProxyPolicy, ProxyService } from './types.ts';

/**
 * Anthropic model provider proxy preset.
 *
 * Proxies requests to api.anthropic.com with the API key injected.
 * Reads ANTHROPIC_API_KEY from the environment by default.
 * Strips all non-allowlisted headers for security.
 */
export function anthropic(opts?: { apiKey?: string; policy?: string | ProxyPolicy }): ProxyService {
	const apiKey = opts?.apiKey || process.env.ANTHROPIC_API_KEY;
	if (!apiKey) {
		throw new Error(
			'anthropic() proxy requires ANTHROPIC_API_KEY. ' +
				'Set it in your environment or pass { apiKey } explicitly.',
		);
	}
	return {
		name: 'anthropic',
		target: 'https://api.anthropic.com',
		headers: {
			'x-api-key': apiKey,
			host: 'api.anthropic.com',
		},
		transform: (req) => {
			// Only forward Anthropic-safe headers. Strip everything else.
			const safe = [
				'content-type',
				'content-length',
				'accept',
				'anthropic-version',
				'anthropic-beta',
				'user-agent',
			];
			const filtered: Record<string, string> = {};
			for (const key of safe) {
				if (req.headers[key]) filtered[key] = req.headers[key];
			}
			filtered['x-api-key'] = apiKey;
			return { headers: filtered };
		},
		policy: opts?.policy ?? 'allow-all',
		isModelProvider: true,
		providerConfig: {
			providerKey: 'anthropic',
			options: {
				apiKey: 'sk-dummy-value-real-key-injected-by-proxy',
			},
		},
	};
}
