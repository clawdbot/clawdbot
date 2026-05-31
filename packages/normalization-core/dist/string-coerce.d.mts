//#region packages/normalization-core/src/string-coerce.d.ts
declare function readStringValue(value: unknown): string | undefined;
declare function normalizeNullableString(value: unknown): string | null;
declare function normalizeOptionalString(value: unknown): string | undefined;
declare function normalizeStringifiedOptionalString(value: unknown): string | undefined;
declare function normalizeStringifiedEntries(values?: ReadonlyArray<unknown>): string[];
declare function normalizeOptionalLowercaseString(value: unknown): string | undefined;
declare function normalizeLowercaseStringOrEmpty(value: unknown): string;
declare function normalizeFastMode(raw?: string | boolean | null): boolean | undefined;
declare function lowercasePreservingWhitespace(value: string): string;
declare function localeLowercasePreservingWhitespace(value: string): string;
declare function resolvePrimaryStringValue(value: unknown): string | undefined;
declare function normalizeOptionalThreadValue(value: unknown): string | number | undefined;
declare function normalizeOptionalStringifiedId(value: unknown): string | undefined;
declare function hasNonEmptyString(value: unknown): value is string;
//#endregion
export { hasNonEmptyString, localeLowercasePreservingWhitespace, lowercasePreservingWhitespace, normalizeFastMode, normalizeLowercaseStringOrEmpty, normalizeNullableString, normalizeOptionalLowercaseString, normalizeOptionalString, normalizeOptionalStringifiedId, normalizeOptionalThreadValue, normalizeStringifiedEntries, normalizeStringifiedOptionalString, readStringValue, resolvePrimaryStringValue };