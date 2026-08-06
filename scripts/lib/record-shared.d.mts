/** Return whether a value is a non-array object record. */
export function isRecord(value: unknown): value is Record<string, unknown>;

/** Trim string values while converting non-strings to an empty string. */
export function trimString(value: unknown): string;
