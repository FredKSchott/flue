#!/usr/bin/env node

/**
 * Generic reverse proxy server for flue sandbox mode.
 *
 * Each ProxyService runs as a separate instance of this script. The proxy
 * imports the workflow module to get the full ProxyService config, including
 * JavaScript functions (transform, body validators, denyResponse).
 *
 * Usage:
 *   node proxy-server.mjs --workflow <path> --proxy-index <n> --port <n>
 *   node proxy-server.mjs --workflow <path> --proxy-index <n> --socket <path>
 *
 * Zero npm dependencies — Node.js stdlib only.
 */

import { unlinkSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

function parseArgs() {
	const args = process.argv.slice(2);
	let workflow, proxyIndex, port, socket;

	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case '--workflow':
				workflow = args[++i];
				break;
			case '--proxy-index':
				proxyIndex = parseInt(args[++i], 10);
				break;
			case '--port':
				port = parseInt(args[++i], 10);
				break;
			case '--socket':
				socket = args[++i];
				break;
		}
	}

	if (!workflow || proxyIndex === undefined) {
		console.error('[proxy-server] Missing required arguments: --workflow and --proxy-index');
		process.exit(1);
	}
	if (port === undefined && !socket) {
		console.error('[proxy-server] Must specify either --port or --socket');
		process.exit(1);
	}

	return { workflow, proxyIndex, port, socket };
}

/**
 * Match a URL path against a glob-style pattern.
 * `*` matches one path segment, `**` matches zero or more.
 */
function matchPath(pattern, path) {
	const patternParts = pattern.split('/').filter(Boolean);
	const pathParts = path.split('/').filter(Boolean);
	return matchParts(patternParts, 0, pathParts, 0);
}

function matchParts(pattern, pi, path, pai) {
	while (pi < pattern.length && pai < path.length) {
		if (pattern[pi] === '**') {
			// ** matches zero or more segments — try all remaining lengths
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
	// Consume trailing ** patterns (they can match zero segments)
	while (pi < pattern.length && pattern[pi] === '**') pi++;
	return pi === pattern.length && pai === path.length;
}

function matchMethod(ruleMethod, requestMethod) {
	if (ruleMethod === '*') return true;
	if (Array.isArray(ruleMethod)) {
		return ruleMethod.some((m) => m.toUpperCase() === requestMethod.toUpperCase());
	}
	return ruleMethod.toUpperCase() === requestMethod.toUpperCase();
}

/**
 * Evaluate the proxy policy for a request.
 * Order: deny rules -> allow rules (with body + rate limits) -> base level.
 */
function evaluatePolicy(method, path, parsedBody, policy, ruleCounts) {
	if (!policy) {
		// No policy = allow-read default
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
			const rule = policy.allow[i];
			if (matchMethod(rule.method, method) && matchPath(rule.path, path)) {
				if (rule.body !== undefined && rule.body(parsedBody) === false) {
					continue;
				}
				if (rule.limit !== undefined) {
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

function collectBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on('data', (chunk) => chunks.push(chunk));
		req.on('end', () => resolve(Buffer.concat(chunks)));
		req.on('error', reject);
	});
}

function tryParseJson(body, contentType) {
	if (!contentType || !contentType.includes('json')) return null;
	try {
		return JSON.parse(body.toString('utf8'));
	} catch {
		return null;
	}
}

const { workflow: workflowPath, proxyIndex, port, socket } = parseArgs();

const workflowModule = await import(workflowPath);
const allProxies = (workflowModule.proxies || []).flat();
const config = allProxies[proxyIndex];

if (!config) {
	console.error(`[proxy-server] No proxy found at index ${proxyIndex}`);
	process.exit(1);
}

const proxyName = config.name || `proxy-${proxyIndex}`;
const targetUrl = new URL(config.target);
const isTargetHttps = targetUrl.protocol === 'https:';

const policy = typeof config.policy === 'string' ? { base: config.policy } : config.policy || null;
const ruleCounts = new Map();

const server = createServer(async (req, res) => {
	// Health check endpoint
	if (req.method === 'GET' && req.url === '/health') {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end('{"status":"ok"}');
		return;
	}

	try {
		const bodyBuffer = await collectBody(req);
		const contentType = req.headers['content-type'] || '';
		const parsedBody = tryParseJson(bodyBuffer, contentType);
		const reqPath = req.url || '/';

		const { allowed, reason } = evaluatePolicy(req.method, reqPath, parsedBody, policy, ruleCounts);

		if (!allowed) {
			console.error(
				`[proxy:${proxyName}] DENIED: ${req.method} ${reqPath}\n` +
					`  Reason: ${reason}\n` +
					`  To allow: add a policy.allow rule for ${req.method} to this path, or use policy: 'allow-all'`,
			);

			if (config.denyResponse) {
				const deny = config.denyResponse({
					method: req.method,
					path: reqPath,
					reason,
				});
				res.writeHead(deny.status, deny.headers);
				res.end(deny.body);
			} else {
				res.writeHead(403, { 'Content-Type': 'application/json' });
				res.end(
					JSON.stringify({
						error: 'proxy_policy_denied',
						message: `Blocked by flue proxy policy: ${req.method} ${reqPath} — ${reason}`,
					}),
				);
			}
			return;
		}

		let headers = { ...req.headers };
		delete headers.connection;
		delete headers['transfer-encoding'];

		if (config.headers) {
			for (const [key, value] of Object.entries(config.headers)) {
				headers[key.toLowerCase()] = value;
			}
		}

		if (config.transform) {
			const transformed = config.transform({
				method: req.method,
				url: reqPath,
				headers,
			});
			headers = transformed.headers;
		}

		if (!config.headers?.host && !config.transform) {
			headers.host = targetUrl.host;
		}

		const requestFn = isTargetHttps ? httpsRequest : httpRequest;
		const proxyReq = requestFn(
			{
				hostname: targetUrl.hostname,
				port: targetUrl.port || (isTargetHttps ? 443 : 80),
				path: reqPath,
				method: req.method,
				headers,
			},
			(proxyRes) => {
				if (proxyRes.statusCode >= 400) {
					console.error(`[proxy:${proxyName}] ${req.method} ${reqPath} -> ${proxyRes.statusCode}`);
				}
				res.writeHead(proxyRes.statusCode, proxyRes.headers);
				proxyRes.pipe(res);
			},
		);

		proxyReq.on('error', (err) => {
			console.error(`[proxy:${proxyName}] upstream error: ${err.message}`);
			if (!res.headersSent) {
				res.writeHead(502, { 'Content-Type': 'application/json' });
			}
			res.end('{"error":"proxy_error","message":"upstream request failed"}');
		});

		if (bodyBuffer.length > 0) {
			proxyReq.end(bodyBuffer);
		} else {
			proxyReq.end();
		}
	} catch (err) {
		console.error(`[proxy:${proxyName}] internal error: ${err.message}`);
		if (!res.headersSent) {
			res.writeHead(500, { 'Content-Type': 'application/json' });
		}
		res.end('{"error":"proxy_internal_error","message":"internal proxy error"}');
	}
});

// Disable server timeout — streaming responses can take minutes
server.timeout = 0;

if (socket) {
	try {
		unlinkSync(socket);
	} catch {
		// stale socket file doesn't exist, that's fine
	}
	server.listen(socket, () => {
		console.error(
			`[proxy:${proxyName}] listening on socket ${socket}, forwarding to ${config.target}`,
		);
	});
} else {
	// Bind to 0.0.0.0 so the Docker container can reach via host.docker.internal
	server.listen(port, '0.0.0.0', () => {
		console.error(
			`[proxy:${proxyName}] listening on 0.0.0.0:${port}, forwarding to ${config.target}`,
		);
	});
}
