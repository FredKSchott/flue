import { getSandbox } from '@cloudflare/sandbox';
import { Hono } from 'hono';
import { createFlueEventTransform } from './events.ts';

export interface FlueWorkerOptions {
	/** Name of the Sandbox binding in env (default: 'Sandbox'). */
	sandboxBinding?: string;
}

/**
 * Cloudflare Worker with built-in Flue infrastructure routes.
 *
 * Extends Hono — add your own routes on top of the built-in ones:
 *
 * - `GET  /health`               — `{ ok: true }`
 * - `POST /kill/:sessionId`      — Destroy a sandbox instance
 * - `ALL  /opencode/:sessionId/*` — Proxy to OpenCode server inside a container
 */
// biome-ignore lint/suspicious/noExplicitAny: env bindings are inherently dynamic
export class FlueWorker<E extends Record<string, any>> extends Hono<{ Bindings: E }> {
	constructor(options?: FlueWorkerOptions) {
		super();
		const bindingName = options?.sandboxBinding ?? 'Sandbox';

		this.get('/health', (c) => c.json({ ok: true }));

		this.post('/kill/:sessionId', async (c) => {
			const sessionId = c.req.param('sessionId');
			try {
				const sandbox = getSandbox(c.env[bindingName], sessionId);
				await sandbox.destroy();
				return c.json({ ok: true, destroyed: sessionId });
			} catch (e) {
				return c.json({ error: String(e) }, 500);
			}
		});

		// Proxy to OpenCode server running inside the container on port 48765.
		// Usage: opencode attach https://<worker>/opencode/<sandboxSessionId>
		// Matches both /opencode/<sessionId> and /opencode/<sessionId>/sub/path
		this.all('/opencode/*', async (c) => {
			const url = new URL(c.req.url);
			const rest = url.pathname.slice('/opencode/'.length);
			const slashIdx = rest.indexOf('/');
			const sessionId = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
			const forwardPath = slashIdx === -1 ? '/' : rest.slice(slashIdx);
			if (!sessionId) return c.json({ error: 'missing sandbox session id' }, 400);
			try {
				const sandbox = getSandbox(c.env[bindingName], sessionId);
				const target = new URL(forwardPath + url.search, 'http://container');
				const proxyReq = new Request(target.toString(), c.req.raw);
				return await sandbox.containerFetch(proxyReq, 48765);
			} catch (e) {
				return c.json({ error: String(e) }, 502);
			}
		});

		// Stream structured log events from the OpenCode server.
		// Connects to the container's SSE event stream and transforms raw
		// OpenCode events into a stable Flue event format.
		// Usage: curl -N https://<worker>/logs/<sandboxSessionId>
		this.get('/logs/:sessionId', async (c) => {
			const sessionId = c.req.param('sessionId');
			try {
				const sandbox = getSandbox(c.env[bindingName], sessionId);
				const target = new URL('/event', 'http://container');
				const response = await sandbox.containerFetch(new Request(target.toString()), 48765);
				if (!response.body) {
					return c.json({ error: 'no event stream available' }, 502);
				}
				const transformed = response.body.pipeThrough(createFlueEventTransform());
				return new Response(transformed, {
					headers: {
						'Content-Type': 'text/event-stream',
						'Cache-Control': 'no-cache',
						Connection: 'keep-alive',
					},
				});
			} catch (e) {
				return c.json({ error: String(e) }, 502);
			}
		});
	}
}
