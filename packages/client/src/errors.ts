/**
 * Error thrown when skill result extraction or validation fails.
 */
export class SkillOutputError extends Error {
	sessionId: string;
	rawOutput: string;
	validationErrors?: unknown;

	constructor(
		message: string,
		opts: { sessionId: string; rawOutput: string; validationErrors?: unknown },
	) {
		super(message);
		this.name = 'SkillOutputError';
		this.sessionId = opts.sessionId;
		this.rawOutput = opts.rawOutput;
		this.validationErrors = opts.validationErrors;
	}
}
