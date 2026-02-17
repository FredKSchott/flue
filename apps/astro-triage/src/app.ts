import { FlueWorker } from '@flue/cloudflare/worker';
import type { AppEnv } from './env.ts';

const app = new FlueWorker<AppEnv>({ proxyKVBinding: 'TRIAGE_KV' });

app.post('/webhooks/github', async (c) => {
	const body = await c.req.json();
	const issue = body.issue;
	if (!issue) return c.text('ignored: no issue', 200);

	// Skip pull requests
	if (issue.pull_request) return c.text('ignored: pull request', 200);

	const labels: string[] = (issue.labels ?? []).map((l: { name: string }) => l.name);

	// Skip issues with "auto triage skipped" label
	if (labels.includes('auto triage skipped')) {
		return c.text('ignored: auto triage skipped', 200);
	}

	// Accept issue opened events
	const isOpened = body.action === 'opened';
	// Accept new comments on issues that still have "needs triage" label
	const isRetriageComment = body.action === 'created' && labels.includes('needs triage');

	if (!isOpened && !isRetriageComment) {
		return c.text('ignored', 200);
	}

	const issueNumber: number = issue.number;
	const instanceId = `triage-${issueNumber}-${Date.now()}`;

	await c.env.TRIAGE_WORKFLOW.create({
		id: instanceId,
		params: {
			issueNumber,
			repo: body.repository.full_name,
			baseBranch: 'main',
		},
	});

	return c.json({ instanceId });
});

export { Sandbox } from '@cloudflare/sandbox';
export { TriageWorkflow } from './workflow.ts';
export default app;
