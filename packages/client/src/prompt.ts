import { toJsonSchema } from '@valibot/to-json-schema';
import type * as v from 'valibot';

/**
 * Preamble instructing the LLM to operate autonomously without user interaction.
 */
export const HEADLESS_PREAMBLE =
	'You are running in headless mode with no human operator. Work autonomously — never ask questions, never wait for user input, never use the question tool. Make your best judgment and proceed independently.';

/**
 * Checks if a skill name is a file path (contains '/' or ends with '.md').
 */
function isFilePath(name: string): boolean {
	return name.includes('/') || name.endsWith('.md');
}

/**
 * Build the ---RESULT_START--- / ---RESULT_END--- extraction instructions
 * for a given Valibot schema.
 */
export function buildResultInstructions(schema: v.GenericSchema): string {
	const jsonSchema = toJsonSchema(schema, { errorMode: 'ignore' });
	// Remove the $schema meta-property — it's noise in the prompt
	const { $schema: _, ...schemaWithoutMeta } = jsonSchema;
	return [
		'',
		'```json',
		JSON.stringify(schemaWithoutMeta, null, 2),
		'```',
		'',
		'Example: (Object)',
		'---RESULT_START---',
		'{"key": "value"}',
		'---RESULT_END---',
		'',
		'Example: (String)',
		'---RESULT_START---',
		'Hello, world!',
		'---RESULT_END---',
	].join('\n');
}

/**
 * Build a single string from proxy instructions to append to prompts.
 */
export function buildProxyInstructions(instructions: string[]): string {
	if (instructions.length === 0) return '';
	return '\n\n' + instructions.join('\n');
}

/**
 * Build a standalone follow-up prompt that asks the LLM to return its result.
 *
 * Used when the initial response is missing the ---RESULT_START--- /
 * ---RESULT_END--- block. Sent as a second message in the same session so the
 * format instructions are fresh in context.
 */
export function buildResultExtractionPrompt(schema: v.GenericSchema): string {
	return [
		'Your task is complete. Now respond with ONLY your final result.',
		'No explanation, no preamble — just the result in the following format, conforming to this schema:',
		buildResultInstructions(schema),
	].join('\n');
}

/**
 * Build the prompt text for a skill invocation.
 *
 * If `name` looks like a file path (contains '/' or ends with '.md'), the
 * prompt instructs the agent to read and follow that file under
 * `.agents/skills/`. Otherwise, it instructs the agent to use the named
 * skill.
 */
export function buildSkillPrompt(
	name: string,
	args?: Record<string, unknown>,
	schema?: v.GenericSchema,
	proxyInstructions?: string[],
): string {
	const instruction = isFilePath(name)
		? `Read the file .agents/skills/${name} directly from disk (do not use the skill tool) and follow it as your skill instructions.`
		: `Use the ${name} skill.`;
	const parts: string[] = [HEADLESS_PREAMBLE, '', instruction];

	if (args && Object.keys(args).length > 0) {
		parts.push(`\nArguments:\n${JSON.stringify(args, null, 2)}`);
	}

	if (proxyInstructions && proxyInstructions.length > 0) {
		parts.push(buildProxyInstructions(proxyInstructions));
	}

	if (schema) {
		parts.push(
			'When complete, you MUST output your result between these exact delimiters conforming to this schema:',
		);
		parts.push(buildResultInstructions(schema));
	}

	return parts.join('\n');
}
