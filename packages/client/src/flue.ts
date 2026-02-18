import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';
import type * as v from 'valibot';
import { buildProxyInstructions, buildResultInstructions, HEADLESS_PREAMBLE } from './prompt.ts';
import { runShell } from './shell.ts';
import { runPrompt, runSkill } from './skill.ts';
import type {
	FlueClientOptions,
	PromptOptions,
	ShellOptions,
	ShellResult,
	SkillOptions,
} from './types.ts';

export class FlueClient {
	/** Workflow arguments passed by the runner. */
	readonly args: Record<string, unknown>;

	private readonly workdir: string;
	private readonly proxyInstructions: string[];
	private readonly model?: { providerID: string; modelID: string };
	private readonly client: OpencodeClient;
	private readonly shellFn?: FlueClientOptions['shell'];

	constructor(options: FlueClientOptions) {
		this.args = options.args ?? {};
		this.proxyInstructions =
			options.proxyInstructions ??
			options.proxies?.map((p) => p.instructions).filter((i): i is string => !!i) ??
			[];
		this.workdir = options.workdir;
		this.model = options.model;
		this.shellFn = options.shell;
		this.client = createOpencodeClient({
			baseUrl: options.opencodeUrl ?? 'http://localhost:48765',
			directory: this.workdir,
			...(options.fetch ? { fetch: options.fetch } : {}),
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
		return runSkill(this.client, this.workdir, name, mergedOptions, this.proxyInstructions);
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
		const schema = options?.result as v.GenericSchema | undefined;
		const parts: string[] = [HEADLESS_PREAMBLE, '', promptText];
		if (this.proxyInstructions.length > 0) {
			parts.push(buildProxyInstructions(this.proxyInstructions));
		}
		if (schema) {
			parts.push(buildResultInstructions(schema));
		}
		const fullPrompt = parts.join('\n');
		const label = `prompt("${promptText.length > 40 ? promptText.slice(0, 40) + '…' : promptText}")`;
		return runPrompt(this.client, this.workdir, label, fullPrompt, {
			result: options?.result,
			model: options?.model ?? this.model,
		});
	}

	/** Execute a shell command with scoped environment variables. */
	async shell(command: string, options?: ShellOptions): Promise<ShellResult> {
		const mergedOptions = { ...options, cwd: options?.cwd ?? this.workdir };
		if (this.shellFn) {
			return this.shellFn(command, mergedOptions);
		}
		return runShell(command, mergedOptions);
	}

	/** Close the OpenCode client connection. */
	async close(): Promise<void> {
		return;
	}
}
