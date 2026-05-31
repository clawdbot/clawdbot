//#region packages/normalization-core/src/string-coerce.ts
function readStringValue(value) {
	return typeof value === "string" ? value : void 0;
}
function normalizeNullableString(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}
function normalizeOptionalString(value) {
	return normalizeNullableString(value) ?? void 0;
}
function normalizeStringifiedOptionalString(value) {
	if (typeof value === "string") return normalizeOptionalString(value);
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return normalizeOptionalString(String(value));
}
function normalizeStringifiedEntries(values) {
	return (values ?? []).map((entry) => normalizeStringifiedOptionalString(entry)).filter((entry) => Boolean(entry));
}
function normalizeOptionalLowercaseString(value) {
	return normalizeOptionalString(value)?.toLowerCase();
}
function normalizeLowercaseStringOrEmpty(value) {
	return normalizeOptionalLowercaseString(value) ?? "";
}
function normalizeFastMode(raw) {
	if (typeof raw === "boolean") return raw;
	if (!raw) return;
	const key = normalizeLowercaseStringOrEmpty(raw);
	if ([
		"off",
		"false",
		"no",
		"0",
		"disable",
		"disabled",
		"normal"
	].includes(key)) return false;
	if ([
		"on",
		"true",
		"yes",
		"1",
		"enable",
		"enabled",
		"fast"
	].includes(key)) return true;
}
function lowercasePreservingWhitespace(value) {
	return value.toLowerCase();
}
function localeLowercasePreservingWhitespace(value) {
	return value.toLocaleLowerCase();
}
function resolvePrimaryStringValue(value) {
	if (typeof value === "string") return normalizeOptionalString(value);
	if (!value || typeof value !== "object") return;
	return normalizeOptionalString(value.primary);
}
function normalizeOptionalThreadValue(value) {
	if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : void 0;
	return normalizeOptionalString(value);
}
function normalizeOptionalStringifiedId(value) {
	const normalized = normalizeOptionalThreadValue(value);
	return normalized == null ? void 0 : String(normalized);
}
function hasNonEmptyString(value) {
	return normalizeOptionalString(value) !== void 0;
}
//#endregion
export { hasNonEmptyString, localeLowercasePreservingWhitespace, lowercasePreservingWhitespace, normalizeFastMode, normalizeLowercaseStringOrEmpty, normalizeNullableString, normalizeOptionalLowercaseString, normalizeOptionalString, normalizeOptionalStringifiedId, normalizeOptionalThreadValue, normalizeStringifiedEntries, normalizeStringifiedOptionalString, readStringValue, resolvePrimaryStringValue };
