import { ulid } from 'ulidx';

/**
 * Generate a new ULID (Universally Unique Lexicographically Sortable Identifier).
 * ULIDs are time-sortable and work well as database primary keys.
 */
export function createId(): string {
	return ulid();
}

/**
 * Generate a short ID suitable for directory names.
 * Format: first 8 characters of a ULID (lowercase).
 */
export function createShortId(): string {
	return ulid().slice(0, 8).toLowerCase();
}
