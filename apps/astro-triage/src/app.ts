import { FlueWorker } from '@flue/cloudflare/worker';
import type { AppEnv } from './env.ts';

const app = new FlueWorker<AppEnv>();

app.post('/webhooks/github', async (c) => {
	const body = await c.req.json();
	if (body.action !== 'opened') return c.text('ignored', 200);

	const issueNumber = body.issue.number;
	const sessionId = `triage-${issueNumber}-${Date.now()}`;
	const id = c.env.TriageRunner.idFromName(sessionId);
	const runner = c.env.TriageRunner.get(id);

	// Fire-and-forget — the DO handles everything via alarms
	runner.run({
		issueNumber,
		repo: body.repository.full_name,
		branch: 'main',
	});

	return c.json({ sessionId });
});

export { Sandbox } from '@cloudflare/sandbox';
export { TriageRunner } from './workflow.ts';
export default app;
