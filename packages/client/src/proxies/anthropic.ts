import type { ProxyFactory, ProxyPolicy, ProxyService } from './types.ts';

/**
 * Anthropic model provider proxy preset.
 *
 * Returns a ProxyFactory that, when called with { apiKey }, produces a
 * ProxyService proxying requests to api.anthropic.com with the key injected.
 * Strips all non-allowlisted headers for security.
 */
export function anthropic(opts?: {
	policy?: string | ProxyPolicy;
}): ProxyFactory<{ apiKey: string }> {
	const factory = (({ apiKey }: { apiKey: string }): ProxyService => ({
		name: 'anthropic',
		target: 'https://api.anthropic.com',
		headers: {
			'x-api-key': apiKey,
			host: 'api.anthropic.com',
		},
		transform: (req) => {
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
	})) as ProxyFactory<{ apiKey: string }>;
	factory.secretsMap = { apiKey: 'ANTHROPIC_API_KEY' };
	factory.proxyName = 'anthropic';
	return factory;
}
