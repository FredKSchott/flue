import type { Sandbox } from '@cloudflare/sandbox';
import type { FlueRunnerOptions } from './types.ts';

/**
 * Derives the default working directory from a repo name.
 * e.g., 'withastro/astro' → '/home/user/astro'
 */
export function deriveWorkdir(repo: string): string {
	const repoName = repo.split('/').pop() ?? repo;
	return `/home/user/${repoName}`;
}

/**
 * Run heavy one-time setup: clone the repo, install deps, build.
 *
 * Two modes:
 * - **prebaked** (`config.prebaked: true`): Repo is pre-baked into the Docker
 *   image. Asserts it exists, then `git fetch` + `git reset --hard` to pull
 *   the latest changes. Install and build run from cache (fast/no-op).
 * - **cold** (default): Full clone from scratch, then install + build.
 *
 * Idempotent in cold mode — checks if the repo is already cloned by looking
 * for package.json in the workdir. Safe to call multiple times.
 */
export async function setup(
	sandbox: Sandbox,
	config: FlueRunnerOptions,
	workdir: string,
): Promise<void> {
	if (config.prebaked) {
		await setupPrebaked(sandbox, config, workdir);
	} else {
		await setupCold(sandbox, config, workdir);
	}

	// Install dependencies
	await runSetupCommand(sandbox, 'pnpm install --frozen-lockfile', workdir, 'install');

	// Build the project
	await runSetupCommand(sandbox, 'pnpm run build', workdir, 'build');
}

/**
 * Prebaked setup: repo is already in the Docker image.
 * Assert it exists, then fetch + reset to latest.
 */
async function setupPrebaked(
	sandbox: Sandbox,
	config: FlueRunnerOptions,
	workdir: string,
): Promise<void> {
	const branch = config.baseBranch ?? 'main';

	const exists = await isRepoCloned(sandbox, workdir);
	if (!exists) {
		throw new Error(
			`prebaked: true but no repo found at ${workdir}. Fix your Dockerfile to pre-bake the repo.`,
		);
	}

	const hasGit = await hasGitDir(sandbox, workdir);
	if (!hasGit) {
		throw new Error(
			`prebaked: true but no .git directory at ${workdir}. Clone with git (not a tarball) in your Dockerfile.`,
		);
	}

	console.log(`[flue] Prebaked repo at ${workdir}, updating to latest ${branch}`);
	await runSetupCommand(sandbox, `git fetch origin ${branch}`, workdir, 'install');
	await runSetupCommand(sandbox, `git reset --hard origin/${branch}`, workdir, 'install');
	console.log('[flue] Repo updated to latest');
}

/**
 * Cold setup: full clone from scratch if not already cloned.
 */
async function setupCold(
	sandbox: Sandbox,
	config: FlueRunnerOptions,
	workdir: string,
): Promise<void> {
	const alreadyCloned = await isRepoCloned(sandbox, workdir);

	if (!alreadyCloned) {
		const repoUrl = `https://github.com/${config.repo}`;
		const branch = config.baseBranch ?? 'main';
		console.log(`[flue] Cloning ${repoUrl} (branch: ${branch}) → ${workdir}`);
		try {
			await sandbox.gitCheckout(repoUrl, {
				branch,
				targetDir: workdir,
			});
			console.log('[flue] Clone complete');
		} catch (err) {
			console.error('[flue] Clone failed:', err instanceof Error ? err.message : String(err));
			throw new Error(err instanceof Error ? err.message : String(err));
		}
	} else {
		console.log(`[flue] Repo already cloned at ${workdir}, skipping clone`);
	}
}

/**
 * Check if a repo has already been cloned by looking for package.json.
 */
async function isRepoCloned(sandbox: Sandbox, workdir: string): Promise<boolean> {
	try {
		await sandbox.readFile(`${workdir}/package.json`);
		return true;
	} catch {
		return false;
	}
}

/**
 * Check if the repo has a .git directory (needed for fetch + reset).
 */
async function hasGitDir(sandbox: Sandbox, workdir: string): Promise<boolean> {
	try {
		await sandbox.readFile(`${workdir}/.git/HEAD`);
		return true;
	} catch {
		return false;
	}
}

/**
 * Run a setup command and wrap errors.
 */
async function runSetupCommand(
	sandbox: Sandbox,
	command: string,
	workdir: string,
	phase: 'install' | 'build',
): Promise<void> {
	console.log(`[flue] Running: ${command} (phase: ${phase})`);
	const start = Date.now();
	try {
		const result = await sandbox.exec(command, { cwd: workdir });
		const elapsed = ((Date.now() - start) / 1000).toFixed(1);
		if (!result.success) {
			console.error(
				`[flue] ${phase} failed (exit ${result.exitCode}, ${elapsed}s):\n${result.stderr?.slice(0, 2000)}`,
			);
			throw new Error(`Command "${command}" failed (exit ${result.exitCode}):\n${result.stderr}`);
		}
		console.log(`[flue] ${phase} complete (exit ${result.exitCode}, ${elapsed}s)`);
	} catch (err) {
		const elapsed = ((Date.now() - start) / 1000).toFixed(1);
		console.error(
			`[flue] ${phase} errored after ${elapsed}s:`,
			err instanceof Error ? err.message : String(err),
		);
		throw err;
	}
}
