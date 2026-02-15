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
		'When complete, you MUST output your result between these exact delimiters conforming to this schema:',
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
 * Build the prompt text for a skill invocation.
 *
 * If `name` looks like a file path (contains '/' or ends with '.md'), the
 * prompt instructs the agent to read and follow that file under
 * `.agents/skills/`. Otherwise, it instructs the agent to use the named
 * skill.
 *
 * @param name - A skill name or a file path relative to .agents/skills/.
 * @param args - Key-value arguments to include in the prompt.
 * @param schema - Optional Valibot schema for result extraction.
 * @returns The complete prompt string.
 */
export function buildSkillPrompt(
	name: string,
	args?: Record<string, unknown>,
	schema?: v.GenericSchema,
): string {
	const instruction = isFilePath(name)
		? `Read the file .agents/skills/${name} directly from disk (do not use the skill tool) and follow it as your skill instructions.`
		: `Use the ${name} skill.`;
	const parts: string[] = [HEADLESS_PREAMBLE, '', instruction];

	if (args && Object.keys(args).length > 0) {
		parts.push(`\nArguments:\n${JSON.stringify(args, null, 2)}`);
	}

	if (schema) {
		parts.push(buildResultInstructions(schema));
	}

	return parts.join('\n');
}
