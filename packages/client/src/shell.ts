import { exec } from 'node:child_process';
import type { ShellOptions, ShellResult } from './types.ts';

export async function runShell(command: string, options?: ShellOptions): Promise<ShellResult> {
	console.log('[flue] shell: running', {
		command,
		cwd: options?.cwd,
		env: options?.env ? Object.keys(options.env) : undefined,
		stdin: options?.stdin ? `${options.stdin.length} chars` : undefined,
		timeout: options?.timeout,
	});
	return new Promise((resolve) => {
		const child = exec(
			command,
			{
				cwd: options?.cwd,
				env: options?.env ? { ...process.env, ...options.env } : process.env,
				timeout: options?.timeout,
			},
			(error, stdout, stderr) => {
				const rawCode =
					error && typeof (error as { code?: number }).code === 'number'
						? (error as { code?: number }).code
						: 0;
				const exitCode = error ? rawCode || 1 : 0;
				const result = { stdout: stdout ?? '', stderr: stderr ?? '', exitCode };
				console.log('[flue] shell: completed', {
					command,
					exitCode: result.exitCode,
					stdout:
						result.stdout.length > 200
							? `${result.stdout.slice(0, 200)}... (${result.stdout.length} chars)`
							: result.stdout,
					stderr:
						result.stderr.length > 200
							? `${result.stderr.slice(0, 200)}... (${result.stderr.length} chars)`
							: result.stderr,
				});
				resolve(result);
			},
		);

		if (options?.stdin) {
			child.stdin?.write(options.stdin);
			child.stdin?.end();
		}
	});
}
