import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { WorkflowEntrypoint } from 'cloudflare:workers';
import { getSandbox } from '@cloudflare/sandbox';
import { FlueRuntime } from '@flue/cloudflare';
import type { AppEnv } from './env.ts';
import triage, { proxies } from './issue-triage.ts';

interface TriageParams {
	issueNumber: number;
	repo: string;
}

export class TriageWorkflow extends WorkflowEntrypoint<AppEnv, TriageParams> {
	async run(event: WorkflowEvent<TriageParams>, step: WorkflowStep) {
		const { issueNumber } = event.payload;
		const branch = `flue/fix-${issueNumber}`;
		const sandbox = getSandbox(this.env.Sandbox, event.instanceId, { sleepAfter: '90m' });

		const flue = new FlueRuntime({
			sandbox,
			sessionId: event.instanceId,
			workdir: '/home/user/astro',
			args: { issueNumber, branch, triageDir: `triage/issue-${issueNumber}` },
			model: { providerID: 'anthropic', modelID: 'claude-opus-4-6' },
			gateway: {
				proxies: [
					proxies.anthropic({ apiKey: this.env.ANTHROPIC_API_KEY }),
					proxies.github({ token: this.env.GITHUB_TOKEN_BOT }),
				],
				url: this.env.GATEWAY_URL,
				secret: this.env.GATEWAY_SECRET,
				kv: this.env.GATEWAY_KV,
			},
		});

		await step.do(
			'setup',
			{ timeout: '20 minutes', retries: { limit: 1, delay: '30 seconds' } },
			async () => {
				await sandbox.setEnvVars({
					NODE_OPTIONS: '--max-old-space-size=4096',
					ASTRO_TELEMETRY_DISABLED: 'true',
					TURBO_API: this.env.TURBO_REMOTE_CACHE_URL,
					TURBO_TEAM: this.env.TURBO_REMOTE_CACHE_TEAM,
					TURBO_TOKEN: this.env.TURBO_REMOTE_CACHE_TOKEN,
				});
				await flue.setup();
				await flue.client.shell('git fetch origin main');
				await flue.client.shell('git reset --hard origin/main');
				await flue.client.shell('pnpm install --frozen-lockfile');
				await flue.client.shell('pnpm run build');
				await flue.client.shell(`git checkout -B ${branch}`);
			},
		);

		return step.do('triage', { timeout: '60 minutes', retries: { limit: 0, delay: 0 } }, async () =>
			triage(flue.client),
		);
	}
}
