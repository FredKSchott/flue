import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { WorkflowEntrypoint } from 'cloudflare:workers';
import { getSandbox } from '@cloudflare/sandbox';
import { FlueRunner } from '@flue/cloudflare';
import type { AppEnv } from './env.ts';

interface TriageParams {
	issueNumber: number;
	repo: string;
	baseBranch: string;
}

export class TriageWorkflow extends WorkflowEntrypoint<AppEnv, TriageParams> {
	async run(event: WorkflowEvent<TriageParams>, step: WorkflowStep) {
		const { issueNumber, repo, baseBranch } = event.payload;
		const sessionId = event.instanceId;

		const result = await step.do(
			'triage',
			{ timeout: '90 minutes', retries: { limit: 0, delay: 0 } },
			async () => {
				const sandbox = getSandbox(this.env.Sandbox, sessionId, {
					sleepAfter: '60m',
				});

				const runner = new FlueRunner({
					sandbox,
					repo,
					baseBranch,
					prebaked: true,
					opencodeConfig: {
						provider: {
							anthropic: {
								options: { apiKey: this.env.ANTHROPIC_API_KEY },
							},
						},
					},
				});

				await sandbox.setEnvVars({
					NODE_OPTIONS: '--max-old-space-size=4096',
					ASTRO_TELEMETRY_DISABLED: 'true',
					GITHUB_TOKEN: this.env.GITHUB_TOKEN,
					TURBO_API: this.env.TURBO_REMOTE_CACHE_URL,
					TURBO_TEAM: this.env.TURBO_REMOTE_CACHE_TEAM,
					TURBO_TOKEN: this.env.TURBO_REMOTE_CACHE_TOKEN,
				});

				await runner.setup();

				const handle = await runner.start('.flue/workflows/issue-triage.ts', {
					args: {
						issueNumber,
						triageDir: `triage/issue-${issueNumber}`,
					},
					branch: `flue/fix-${issueNumber}`,
					model: { providerID: 'anthropic', modelID: 'claude-opus-4-6' },
				});

				// Poll until the workflow completes or fails.
				// biome-ignore lint/correctness/noConstantCondition: intentional polling loop
				while (true) {
					await new Promise((resolve) => setTimeout(resolve, 15_000));
					const status = await FlueRunner.poll(sandbox, handle.processId);

					if (status.status === 'completed') {
						console.log('[triage] Workflow completed:', JSON.stringify(status.result));
						// Cast: the bootstrap writes JSON-serializable results to the status file.
						return status.result as string;
					}
					if (status.status === 'failed') {
						console.error('[triage] Workflow failed:', status.error);
						throw new Error(status.error ?? 'Workflow failed');
					}
				}
			},
		);

		return result;
	}
}
