/**
 * Possible states for a triage job.
 */
export type JobStatus =
	| 'queued'
	| 'cloning'
	| 'reproducing'
	| 'diagnosing'
	| 'fixing'
	| 'completed'
	| 'failed';

/**
 * Where the feedback originated from.
 */
export type FeedbackSource = 'github' | 'discord' | 'twitter' | 'reddit';

/**
 * The full state of a triage job.
 */
export interface JobState {
	id: string;
	issueNumber: number;
	issueUrl: string;
	source: FeedbackSource;
	status: JobStatus;
	createdAt: string;
	updatedAt: string;
	workdir?: string;
	triageDir?: string;
	error?: string;
	reproduction?: ReproductionResult;
	diagnosis?: DiagnosisResult;
	fix?: FixResult;
	reportPath?: string;
}

/**
 * Where the reproduction came from.
 */
export type ReproductionSource = 'stackblitz' | 'gist' | 'example-template' | 'manual';

/**
 * Result of the reproduce skill.
 */
export interface ReproductionResult {
	issueNumber: number;
	reproducible: boolean | 'partial';
	skipped: boolean;
	skipReason?:
		| 'host-specific'
		| 'unsupported-version'
		| 'unsupported-runtime'
		| 'no-repro-provided';
	hostProvider?: string;
	triageDir: string;
	reproductionSource: ReproductionSource;
	astroVersion?: string;
	errorMessage?: string;
	stepsToReproduce?: string[];
	notes?: string;
}

/**
 * Confidence level for a diagnosis.
 */
export type DiagnosisConfidence = 'high' | 'medium' | 'low';

/**
 * Result of the diagnose skill.
 */
export interface DiagnosisResult {
	rootCause: string;
	files: string[];
	explanation: string;
	confidence: DiagnosisConfidence;
	suggestedApproach?: string;
}

/**
 * Result of the fix skill.
 */
export interface FixResult {
	fixed: boolean;
	files: string[];
	description: string;
	gitDiff: string;
	verificationSteps: string[];
	notes?: string;
	branchPushed?: string | null;
}
