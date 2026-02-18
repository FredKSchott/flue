import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { WorkflowEntrypoint } from 'cloudflare:workers';
import { getSandbox } from '@cloudflare/sandbox';
import { FlueRunner } from '@flue/cloudflare';
import type { AppEnv } from './env.ts';
import triage, { proxies } from './issue-triage.ts';

interface TriageParams {
	issueNumber: number;
	repo: string;
	baseBranch: string;
}

export class TriageWorkflow extends WorkflowEntrypoint<AppEnv, TriageParams> {
	async run(event: WorkflowEvent<TriageParams>, step: WorkflowStep) {
		const { issueNumber, repo, baseBranch } = event.payload;
		const sessionId = event.instanceId;
		const branch = `flue/fix-${issueNumber}`;

		const sandbox = getSandbox(this.env.Sandbox, sessionId, { sleepAfter: '90m' });

		const runner = new FlueRunner({
			sandbox,
			sessionId,
			repo,
			baseBranch,
			prebaked: true,
			proxyDefinitions: proxies,
			proxySecrets: {
				anthropic: { apiKey: this.env.ANTHROPIC_API_KEY },
				github: { token: this.env.GITHUB_TOKEN_BOT },
			},
			workerUrl: this.env.WORKER_URL,
			proxySecret: this.env.PROXY_SECRET,
			proxyKV: this.env.TRIAGE_KV,
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

				await runner.setup();

				await sandbox.exec(`git checkout -B ${branch}`, { cwd: runner.workdir });
			},
		);

		const result = await step.do(
			'triage',
			{ timeout: '60 minutes', retries: { limit: 0, delay: 0 } },
			async () => {
				const flue = runner.createFlue({
					branch,
					args: { issueNumber, triageDir: `triage/issue-${issueNumber}` },
					model: { providerID: 'anthropic', modelID: 'claude-opus-4-6' },
				});
				return triage(flue);
			},
		);

		return result;
	}
}
