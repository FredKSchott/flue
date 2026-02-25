import type { ProxyPolicy } from './types.ts';

/**
 * Shared policy evaluation for proxy requests.
 *
 * This is the canonical TypeScript implementation. The CLI's proxy-server.mjs
 * has an identical zero-dependency copy (see packages/cli/src/sandbox/proxy-server.mjs).
 */

export interface PolicyResult {
	allowed: boolean;
	reason: string;
}

/**
 * Match a URL path against a glob-style pattern.
 * `*` matches one path segment, `**` matches zero or more.
 */
export function matchPath(pattern: string, path: string): boolean {
	const patternParts = pattern.split('/').filter(Boolean);
	const pathParts = path.split('/').filter(Boolean);
	return matchParts(patternParts, 0, pathParts, 0);
}

function matchParts(pattern: string[], pi: number, path: string[], pai: number): boolean {
	while (pi < pattern.length && pai < path.length) {
		if (pattern[pi] === '**') {
			for (let skip = pai; skip <= path.length; skip++) {
				if (matchParts(pattern, pi + 1, path, skip)) return true;
			}
			return false;
		}
		if (pattern[pi] === '*' || pattern[pi] === path[pai]) {
			pi++;
			pai++;
		} else {
			return false;
		}
	}
	while (pi < pattern.length && pattern[pi] === '**') pi++;
	return pi === pattern.length && pai === path.length;
}

export function matchMethod(ruleMethod: string | string[], requestMethod: string): boolean {
	if (ruleMethod === '*') return true;
	if (Array.isArray(ruleMethod)) {
		return ruleMethod.some((m) => m.toUpperCase() === requestMethod.toUpperCase());
	}
	return ruleMethod.toUpperCase() === requestMethod.toUpperCase();
}

/**
 * Evaluate the proxy policy for a request.
 * Order: deny rules -> allow rules (with optional body + rate limits) -> base level.
 *
 * `ruleCounts` is optional — omit on Cloudflare where rate limits are not enforced.
 * `body` validators on rules are skipped when not present (Cloudflare v1 stores
 * policies without functions).
 */
export function evaluatePolicy(
	method: string,
	path: string,
	parsedBody: unknown,
	policy: ProxyPolicy | null,
	ruleCounts?: Map<string, number>,
): PolicyResult {
	if (!policy) {
		if (['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) {
			return { allowed: true, reason: '' };
		}
		return { allowed: false, reason: 'not allowed by default allow-read policy' };
	}

	// 1. Check deny rules
	if (policy.deny) {
		for (const rule of policy.deny) {
			if (matchMethod(rule.method, method) && matchPath(rule.path, path)) {
				if (rule.body === undefined || rule.body(parsedBody) === true) {
					return { allowed: false, reason: 'matched deny rule' };
				}
			}
		}
	}

	// 2. Check allow rules
	if (policy.allow) {
		for (let i = 0; i < policy.allow.length; i++) {
			const rule = policy.allow[i]!;
			if (matchMethod(rule.method, method) && matchPath(rule.path, path)) {
				if (rule.body !== undefined && rule.body(parsedBody) === false) {
					continue;
				}
				if (rule.limit !== undefined && ruleCounts) {
					const key = `allow:${i}`;
					const count = ruleCounts.get(key) || 0;
					if (count >= rule.limit) {
						return { allowed: false, reason: `limit reached (${count}/${rule.limit})` };
					}
					ruleCounts.set(key, count + 1);
				}
				return { allowed: true, reason: '' };
			}
		}
	}

	// 3. Apply base policy level
	const base = policy.base || 'allow-read';
	switch (base) {
		case 'allow-all':
			return { allowed: true, reason: '' };
		case 'deny-all':
			return { allowed: false, reason: 'base policy: deny-all' };
		case 'allow-read':
		default:
			if (['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) {
				return { allowed: true, reason: '' };
			}
			return { allowed: false, reason: 'not allowed by allow-read policy' };
	}
}
