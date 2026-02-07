import type { Part } from '@opencode-ai/sdk';
import * as v from 'valibot';
import { SkillOutputError } from './errors.ts';

/**
 * Extracts and validates a structured result from OpenCode response parts.
 *
 * Scans TextParts for the last ---RESULT_START--- / ---RESULT_END--- block,
 * parses the content, and validates it against the provided Valibot schema.
 *
 * @param parts - The response parts from OpenCode's session.prompt().
 * @param schema - The Valibot schema to validate against.
 * @param sessionId - The session ID (for error reporting).
 * @returns The validated, typed result.
 * @throws {SkillOutputError} If no result block is found or validation fails.
 */
export function extractResult<S extends v.GenericSchema>(
	parts: Part[],
	schema: S,
	sessionId: string,
): v.InferOutput<S> {
	// Collect all text content from TextParts
	const textParts = parts.filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text');

	// Find the last ---RESULT_START--- / ---RESULT_END--- block across all text parts
	const allText = textParts.map((p) => p.text).join('\n');
	const resultBlock = extractLastResultBlock(allText);

	if (resultBlock === null) {
		console.error(
			`[flue] extractResult: no RESULT_START/RESULT_END block found (session: ${sessionId}, text length: ${allText.length} chars)`,
		);
		console.error(`[flue] extractResult: response tail (last 500 chars): ${allText.slice(-500)}`);
		throw new SkillOutputError(
			'No ---RESULT_START--- / ---RESULT_END--- block found in the assistant response.',
			{
				sessionId,
				rawOutput: allText,
			},
		);
	}

	let result = resultBlock;
	if (schema.type === 'object' || schema.type === 'array') {
		try {
			result = JSON.parse(result);
		} catch {
			console.error('[flue] extractResult: schema validation failed', schema);
			console.error('[flue] extractResult: parsed value was:', JSON.stringify(resultBlock));
			throw new SkillOutputError('Result does not match the expected schema.', {
				sessionId,
				rawOutput: resultBlock,
				validationErrors: ['JSON.parse(result) failed'],
			});
		}
	}

	const parsedResult = v.safeParse(schema, result);
	if (!parsedResult.success) {
		console.error('[flue] extractResult: schema validation failed', parsedResult.issues);
		console.error('[flue] extractResult: parsed value was:', JSON.stringify(result));
		throw new SkillOutputError('Result does not match the expected schema.', {
			sessionId,
			rawOutput: result,
			validationErrors: parsedResult.issues,
		});
	}

	console.log('[flue] extractResult: validated result:', JSON.stringify(parsedResult.output));
	return parsedResult.output;
}

/**
 * Extracts the content of the last ---RESULT_START--- / ---RESULT_END--- block from text.
 * Returns null if no result block is found.
 */
function extractLastResultBlock(text: string): string | null {
	const regex = /---RESULT_START---\s*\n([\s\S]*?)---RESULT_END---/g;
	const matches = text.matchAll(regex);
	let lastMatch: string | null = null;

	for (const match of matches) {
		lastMatch = match[1]?.trim() ?? null;
	}

	return lastMatch;
}
