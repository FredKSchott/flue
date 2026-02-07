import { DurableObject } from 'cloudflare:workers';
import { getSandbox } from '@cloudflare/sandbox';
import { FlueRunner } from '@flue/cloudflare';
import type { AppEnv } from './env.ts';

interface TriageState {
	sessionId: string;
	processId: string;
	params: { issueNumber: number; repo: string; branch: string };
	retries: number;
}

export class TriageRunner extends DurableObject<AppEnv> {
	async run(params: { issueNumber: number; repo: string; branch: string }) {
		const { issueNumber, repo, branch } = params;
		const sessionId = `triage-${issueNumber}-${Date.now()}`;
		const sandbox = getSandbox(this.env.Sandbox, sessionId, {
			sleepAfter: '60m',
		});

		const runner = new FlueRunner({
			sandbox,
			repo,
			baseBranch: branch,
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
			TURBO_API: this.env.TURBO_REMOTE_CACHE_URL,
			TURBO_TEAM: this.env.TURBO_REMOTE_CACHE_TEAM,
			TURBO_TOKEN: this.env.TURBO_REMOTE_CACHE_TOKEN,
		});
		await runner.setup();

		const handle = await runner.start('.flue/workflows/triage.ts', {
			args: { issueNumber },
			secrets: {
				GITHUB_TOKEN: this.env.GITHUB_TOKEN,
				ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY,
			},
			branch: `flue/fix-${issueNumber}`,
			model: { providerID: 'anthropic', modelID: 'claude-opus-4-6' },
		});

		await this.ctx.storage.put<TriageState>('state', {
			sessionId,
			processId: handle.processId,
			params,
			retries: 0,
		});
		await this.ctx.storage.setAlarm(Date.now() + 60_000);
	}

	async alarm() {
		const state = await this.ctx.storage.get<TriageState>('state');
		if (!state) return;

		const sandbox = getSandbox(this.env.Sandbox, state.sessionId, {
			sleepAfter: '60m',
		});

		try {
			const status = await FlueRunner.poll(sandbox, state.processId);

			if (status.status === 'running') {
				await this.ctx.storage.setAlarm(Date.now() + 60_000);
				return;
			}

			if (status.status === 'completed') {
				console.log('[triage] Workflow completed:', JSON.stringify(status.result));
			} else {
				console.error('[triage] Workflow failed:', status.error);
			}
		} catch (error) {
			console.error('[triage] Poll error:', error);
			const retries = state.retries + 1;
			if (retries < 5) {
				await this.ctx.storage.put<TriageState>('state', { ...state, retries });
				await this.ctx.storage.setAlarm(Date.now() + 60_000);
				return;
			}
			console.error('[triage] Max retries reached, giving up');
		}

		await this.ctx.storage.deleteAll();
	}
}
