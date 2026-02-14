#!/usr/bin/env node

/**
 * Minimal reverse proxy that adds the Anthropic API key to forwarded requests.
 *
 * Runs on the host, listens on a configurable port (default 4100).
 * The Docker container sends Anthropic-format requests here; the proxy injects
 * the `x-api-key` header and pipes everything to api.anthropic.com:443.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... node proxy.mjs [--port 4100]
 *
 * Supports streaming (SSE) — Node streams handle chunked transfer naturally.
 * Zero npm dependencies — stdlib only (node:http, node:https).
 */

import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';

const PORT = parseInt(
	process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : '4100',
	10,
);
const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) {
	console.error('[proxy] ANTHROPIC_API_KEY is not set');
	process.exit(1);
}

// Headers safe to forward to Anthropic. Everything else is stripped.
const ALLOWED_HEADERS = new Set([
	'content-type',
	'content-length',
	'accept',
	'anthropic-version',
	'anthropic-beta',
	'user-agent',
]);

const server = createServer((req, res) => {
	// Health check endpoint
	if (req.method === 'GET' && req.url === '/health') {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end('{"status":"ok"}');
		return;
	}

	// Build headers: only forward allowed headers, then inject the API key.
	const headers = {};
	for (const key of Object.keys(req.headers)) {
		if (ALLOWED_HEADERS.has(key.toLowerCase())) {
			headers[key] = req.headers[key];
		}
	}
	headers['x-api-key'] = API_KEY;

	const proxyReq = httpsRequest(
		{
			hostname: 'api.anthropic.com',
			port: 443,
			path: req.url,
			method: req.method,
			headers,
		},
		(proxyRes) => {
			res.writeHead(proxyRes.statusCode, proxyRes.headers);
			proxyRes.pipe(res);
		},
	);

	proxyReq.on('error', (err) => {
		console.error(`[proxy] upstream error: ${err.message}`);
		if (!res.headersSent) {
			res.writeHead(502, { 'Content-Type': 'application/json' });
		}
		res.end('{"error":"proxy_error","message":"upstream request failed"}');
	});

	// Pipe the incoming request body to the upstream request (supports streaming)
	req.pipe(proxyReq);
});

// Disable server timeout — Anthropic streaming responses can take minutes
server.timeout = 0;

// Bind to 0.0.0.0 so the Docker container can reach the proxy via
// host.docker.internal (which resolves to the Docker bridge gateway IP,
// not 127.0.0.1). On CI runners the host is already network-isolated.
server.listen(PORT, '0.0.0.0', () => {
	console.error(`[proxy] listening on 0.0.0.0:${PORT}, forwarding to api.anthropic.com`);
});
