import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';
import type * as v from 'valibot';
import { runShell } from './shell.ts';
import { runSkill } from './skill.ts';
import type {
	FlueOptions,
	PromptOptions,
	ShellOptions,
	ShellResult,
	SkillOptions,
} from './types.ts';

export class Flue {
	/** Working branch for commits. */
	readonly branch: string;
	/** Workflow arguments passed by the runner. */
	readonly args: Record<string, unknown>;
	/** Scoped secrets passed by the runner. */
	readonly secrets: Record<string, string>;

	private readonly workdir: string;
	private readonly shellWorkdir: string;
	private readonly model?: { providerID: string; modelID: string };
	private readonly client: OpencodeClient;

	constructor(options: FlueOptions) {
		this.branch = options.branch ?? 'main';
		this.args = options.args ?? {};
		this.secrets = options.secrets ?? {};
		this.workdir = options.workdir;
		this.shellWorkdir = options.shellWorkdir ?? options.workdir;
		this.model = options.model;
		this.client = createOpencodeClient({
			baseUrl: options.opencodeUrl ?? 'http://localhost:48765',
			directory: options.workdir,
		});
	}

	/** Run a named skill with a result schema. */
	async skill<S extends v.GenericSchema>(
		name: string,
		options: SkillOptions<S> & { result: S },
	): Promise<v.InferOutput<S>>;
	/** Run a named skill without a result schema (fire-and-forget). */
	async skill(name: string, options?: SkillOptions): Promise<void>;
	// biome-ignore lint/suspicious/noExplicitAny: runtime implementation of overloaded interface
	async skill(name: string, options?: SkillOptions<v.GenericSchema | undefined>): Promise<any> {
		const mergedOptions: SkillOptions<v.GenericSchema | undefined> = {
			...options,
			args: this.args || options?.args ? { ...this.args, ...options?.args } : undefined,
			model: options?.model ?? this.model,
		};
		return runSkill(this.client, this.workdir, name, mergedOptions);
	}

	/** Run an inline prompt in a new OpenCode session. */
	async prompt<S extends v.GenericSchema>(
		promptText: string,
		options: PromptOptions<S> & { result: S },
	): Promise<v.InferOutput<S>>;
	/** Run an inline prompt without a result schema. */
	async prompt(promptText: string, options?: PromptOptions): Promise<void>;
	// biome-ignore lint/suspicious/noExplicitAny: runtime implementation of overloaded interface
	async prompt(
		promptText: string,
		options?: PromptOptions<v.GenericSchema | undefined>,
	): Promise<any> {
		const mergedOptions: SkillOptions<v.GenericSchema | undefined> = {
			result: options?.result,
			model: options?.model ?? this.model,
			prompt: promptText,
		};
		return runSkill(this.client, this.workdir, '__inline__', mergedOptions);
	}

	/** Execute a shell command with scoped environment variables. */
	async shell(command: string, options?: ShellOptions): Promise<ShellResult> {
		return runShell(command, { ...options, cwd: options?.cwd ?? this.shellWorkdir });
	}

	/** Close the OpenCode client connection. */
	async close(): Promise<void> {
		return;
	}
}
