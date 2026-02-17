import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { WorkflowEntrypoint } from 'cloudflare:workers';
import { getSandbox } from '@cloudflare/sandbox';
import { Flue } from '@flue/client';
import { anthropic, github } from '@flue/client/proxies';
import { FlueRunner } from '@flue/cloudflare';
import * as v from 'valibot';
import type { AppEnv } from './env.ts';
import {
	addLabels,
	fetchIssue,
	fetchRepoLabels,
	type IssueDetails,
	postComment,
	type RepoLabel,
	removeLabel,
} from './github.ts';

interface TriageParams {
	issueNumber: number;
	repo: string;
	baseBranch: string;
}

interface TriagePipelineResult {
	completedStage: 'reproduce' | 'verify' | 'fix';
	reproducible: boolean;
	skipped: boolean;
	verdict: 'bug' | 'intended-behavior' | 'unclear' | null;
	diagnosisConfidence: 'high' | 'medium' | 'low' | null;
	fixed: boolean;
	commitMessage: string | null;
}

interface TriageStepResult {
	triageResult: TriagePipelineResult | null;
	skippedRetriage: boolean;
	comment: string | null;
	selectedLabels: string[];
	isPushed: boolean;
}

async function shouldRetriage(flue: Flue, issue: IssueDetails): Promise<'yes' | 'no'> {
	return flue.prompt(
		`You are reviewing a GitHub issue conversation to decide whether a triage re-run is warranted.

## Issue
**${issue.title}**

${issue.body}

## Conversation
${issue.comments.map((c) => `**@${c.author.login}:**\n${c.body}`).join('\n\n---\n\n')}

## Your Task
Look at the messages since the last comment from astrobot-houston (or github-actions[bot]).
Consider comments from the original poster, maintainers, or other users who may have provided:
- New reproduction steps or environment details
- Corrections to a previously attempted reproduction
- Additional context about when/how the bug occurs
- Different configurations or versions to try

Then decide how to respond:
1. If there is new, actionable information that could lead to a different reproduction result
than what was already attempted, respond with "yes".
2. If someone is intentionally asking you to retry triage, respond with "yes".
3. If the new comments are just acknowledgments, thanks, unrelated discussion, or do not add
meaningful reproduction information, respond with "no".

Return only "yes" or "no" inside the ---RESULT_START--- / ---RESULT_END--- block.`,
		{ result: v.picklist(['yes', 'no']) },
	);
}

async function runTriagePipeline(
	flue: Flue,
	issueNumber: number,
	issueDetails: IssueDetails,
): Promise<TriagePipelineResult> {
	const reproduceResult = await flue.skill('triage/reproduce.md', {
		args: { issueNumber, issueDetails },
		result: v.object({
			reproducible: v.pipe(
				v.boolean(),
				v.description('true if the bug was successfully reproduced, false otherwise'),
			),
			skipped: v.pipe(
				v.boolean(),
				v.description(
					'true if reproduction was intentionally skipped (host-specific, unsupported version, etc.)',
				),
			),
		}),
	});

	if (reproduceResult.skipped || !reproduceResult.reproducible) {
		return {
			completedStage: 'reproduce',
			reproducible: reproduceResult.reproducible,
			skipped: reproduceResult.skipped,
			verdict: null,
			diagnosisConfidence: null,
			fixed: false,
			commitMessage: null,
		};
	}

	const diagnoseResult = await flue.skill('triage/diagnose.md', {
		args: { issueDetails },
		result: v.object({
			confidence: v.pipe(
				v.nullable(v.picklist(['high', 'medium', 'low'])),
				v.description('Diagnosis confidence level, null if not attempted'),
			),
		}),
	});
	const verifyResult = await flue.skill('triage/verify.md', {
		args: { issueDetails },
		result: v.object({
			verdict: v.pipe(
				v.picklist(['bug', 'intended-behavior', 'unclear']),
				v.description('Whether the reported behavior is a bug, intended behavior, or unclear'),
			),
			confidence: v.pipe(
				v.picklist(['high', 'medium', 'low']),
				v.description('Confidence level in the verdict'),
			),
		}),
	});

	if (verifyResult.verdict === 'intended-behavior') {
		return {
			completedStage: 'verify',
			reproducible: true,
			skipped: false,
			verdict: verifyResult.verdict,
			diagnosisConfidence: diagnoseResult.confidence,
			fixed: false,
			commitMessage: null,
		};
	}

	const fixResult = await flue.skill('triage/fix.md', {
		args: { issueDetails },
		result: v.object({
			fixed: v.pipe(
				v.boolean(),
				v.description('true if the bug was successfully fixed and verified'),
			),
			commitMessage: v.pipe(
				v.nullable(v.string()),
				v.description(
					'A short commit message describing the fix, e.g. "fix(auto-triage): prevent crash when rendering client:only components". null if not fixed.',
				),
			),
		}),
	});

	return {
		completedStage: 'fix',
		reproducible: true,
		skipped: false,
		verdict: verifyResult.verdict,
		diagnosisConfidence: diagnoseResult.confidence,
		fixed: fixResult.fixed,
		commitMessage: fixResult.commitMessage,
	};
}

async function selectTriageLabels(
	flue: Flue,
	{
		comment,
		priorityLabels,
		packageLabels,
	}: { comment: string; priorityLabels: RepoLabel[]; packageLabels: RepoLabel[] },
): Promise<string[]> {
	const priorityLabelNames = priorityLabels.map((l) => l.name);
	const packageLabelNames = packageLabels.map((l) => l.name);

	const labelResult = await flue.prompt(
		`Label the following GitHub issue based on the triage report that was already posted.

Select labels for this issue from the lists below based on the triage report. Select exactly one priority label (the report's **Priority** section is a strong hint) and 0-3 package labels based on where the issue lives in the monorepo and how it manifests.

### Priority Labels (select exactly one)
${priorityLabels.map((l) => `- "${l.name}": ${l.description || '(no description)'}`).join('\n')}

### Package Labels (select zero or more)
${packageLabels.map((l) => `- "${l.name}": ${l.description || '(no description)'}`).join('\n')}

--- 

<triage-report format="md">
${comment}
</triage-report>
`,
		{
			result: v.object({
				priority: v.pipe(
					v.picklist(priorityLabelNames),
					v.description(
						'The priority label to apply. Must be one of the exact priority label names listed above.',
					),
				),
				packages: v.pipe(
					v.array(v.picklist(packageLabelNames)),
					v.description(
						'Package labels to apply (0-3). Each must be one of the exact package label names listed above.',
					),
				),
			}),
		},
	);

	return [labelResult.priority, ...labelResult.packages];
}

export class TriageWorkflow extends WorkflowEntrypoint<AppEnv, TriageParams> {
	async run(event: WorkflowEvent<TriageParams>, step: WorkflowStep) {
		const { issueNumber, repo, baseBranch } = event.payload;
		const sessionId = event.instanceId;
		const workdir = `/home/user/${repo.split('/').pop()}`;
		const branch = `flue/fix-${issueNumber}`;
		const kvKey = `triage:${sessionId}:issue`;

		const sandbox = getSandbox(this.env.Sandbox, sessionId, { sleepAfter: '90m' });

		const proxies = [
			anthropic({ apiKey: this.env.ANTHROPIC_API_KEY }),
			...github({ token: this.env.GITHUB_TOKEN }),
		];

		const runner = new FlueRunner({
			sandbox,
			sessionId,
			repo,
			baseBranch,
			prebaked: true,
			proxies,
			workerUrl: this.env.WORKER_URL,
			proxySecret: this.env.PROXY_SECRET,
			proxyKV: this.env.TRIAGE_KV,
		});

		const flue = new Flue({
			workdir,
			branch,
			args: { issueNumber, triageDir: `triage/issue-${issueNumber}` },
			model: { providerID: 'anthropic', modelID: 'claude-opus-4-6' },
			proxies,
			fetch: (req) => sandbox.containerFetch(req, 48765),
			shell: async (cmd, opts) => {
				const result = await sandbox.exec(cmd, {
					cwd: opts?.cwd,
					env: opts?.env,
					timeout: opts?.timeout,
				});
				return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
			},
		});

		await step.do(
			'setup',
			{ timeout: '20 minutes', retries: { limit: 1, delay: '30 seconds' } },
			async () => {
				await sandbox.setEnvVars({
					NODE_OPTIONS: '--max-old-space-size=4096',
					ASTRO_TELEMETRY_DISABLED: 'true',
					// GITHUB_TOKEN and ANTHROPIC_API_KEY no longer passed to container — proxies handle credentials
					TURBO_API: this.env.TURBO_REMOTE_CACHE_URL,
					TURBO_TEAM: this.env.TURBO_REMOTE_CACHE_TEAM,
					TURBO_TOKEN: this.env.TURBO_REMOTE_CACHE_TOKEN,
				});

				await runner.setup();

				await sandbox.exec(`git checkout -B ${branch}`, { cwd: workdir });
			},
		);

		// Issue details are stored in KV to avoid the 1 MiB step return limit.
		const { priorityLabels, packageLabels } = await step.do(
			'fetch-issue',
			{ retries: { limit: 2, delay: '5 seconds' } },
			async () => {
				const [issueDetails, labels] = await Promise.all([
					fetchIssue(this.env.GITHUB_TOKEN_BOT, repo, issueNumber),
					fetchRepoLabels(this.env.GITHUB_TOKEN_BOT, repo),
				]);

				await this.env.TRIAGE_KV.put(kvKey, JSON.stringify(issueDetails), {
					expirationTtl: 3600,
				});

				return { priorityLabels: labels.priorityLabels, packageLabels: labels.packageLabels };
			},
		);

		const triageStepResult = await step.do(
			'triage',
			{ timeout: '60 minutes', retries: { limit: 0, delay: 0 } },
			async () => {
				const issueDetails = await this.env.TRIAGE_KV.get<IssueDetails>(kvKey, 'json');
				if (!issueDetails) {
					throw new Error(
						`Issue details not found in KV (key: ${kvKey}). The data may have expired.`,
					);
				}

				if (issueDetails.comments.length > 0) {
					const shouldRetriageResult = await shouldRetriage(flue, issueDetails);
					if (shouldRetriageResult === 'no') {
						return {
							triageResult: null,
							skippedRetriage: true,
							comment: null,
							selectedLabels: [],
							isPushed: false,
						} satisfies TriageStepResult;
					}
				}

				const triageResult = await runTriagePipeline(flue, issueNumber, issueDetails);
				let isPushed = false;

				if (triageResult.fixed) {
					const diff = await flue.shell('git diff main --stat');
					if (diff.stdout.trim()) {
						const status = await flue.shell('git status --porcelain');
						if (status.stdout.trim()) {
							await flue.shell('git add -A');
							await flue.shell(
								`git commit -m ${JSON.stringify(triageResult.commitMessage ?? 'fix(auto-triage): automated fix')}`,
							);
						}
						const pushResult = await flue.shell(`git push -f origin ${branch}`);
						console.info('[triage] push result:', pushResult);
						isPushed = pushResult.exitCode === 0;
					}
				}

				const branchName = isPushed ? branch : null;
				const comment = await flue.skill('triage/comment.md', {
					args: { branchName, priorityLabels, issueDetails },
					result: v.pipe(
						v.string(),
						v.description(
							'Return only the GitHub comment body generated from the template, following the included template directly. This returned comment must start with "**I was able to reproduce this issue.**" or "**I was unable to reproduce this issue.**"',
						),
					),
				});

				let selectedLabels: string[] = [];
				if (triageResult.reproducible) {
					selectedLabels = await selectTriageLabels(flue, {
						comment,
						priorityLabels,
						packageLabels,
					});
				}

				return {
					triageResult,
					skippedRetriage: false,
					comment,
					selectedLabels,
					isPushed,
				} satisfies TriageStepResult;
			},
		);

		if (triageStepResult.skippedRetriage) {
			return { skipped: true, reason: 'No new actionable information' };
		}

		await step.do('post-results', { retries: { limit: 0, delay: 0 } }, async () => {
			const botToken = this.env.GITHUB_TOKEN_BOT;

			if (triageStepResult.comment) {
				await postComment(botToken, repo, issueNumber, triageStepResult.comment);
			}

			const triageResult = triageStepResult.triageResult;
			if (!triageResult) return;

			if (triageResult.reproducible) {
				await removeLabel(botToken, repo, issueNumber, 'needs triage');
				if (triageStepResult.selectedLabels.length > 0) {
					await addLabels(botToken, repo, issueNumber, triageStepResult.selectedLabels);
				}
			} else if (triageResult.skipped) {
				await addLabels(botToken, repo, issueNumber, ['auto triage skipped']);
			}
		});

		return { ...triageStepResult.triageResult, isPushed: triageStepResult.isPushed };
	}
}
