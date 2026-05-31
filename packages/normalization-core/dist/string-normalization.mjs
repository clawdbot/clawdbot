import { normalizeOptionalLowercaseString, normalizeOptionalString } from "./string-coerce.mjs";
//#region packages/normalization-core/src/string-normalization.ts
function normalizeStringEntries(list) {
	return (list ?? []).map((entry) => normalizeOptionalString(String(entry)) ?? "").filter(Boolean);
}
function normalizeStringEntriesLower(list) {
	return normalizeStringEntries(list).map((entry) => normalizeOptionalLowercaseString(entry) ?? "");
}
function uniqueValues(values) {
	return [...new Set(values)];
}
function uniqueStrings(values) {
	return uniqueValues(values);
}
function sortUniqueStrings(values) {
	return uniqueStrings(values).toSorted((left, right) => left < right ? -1 : left > right ? 1 : 0);
}
function normalizeUniqueStringEntries(values) {
	return uniqueStrings(normalizeStringEntries(values ? [...values] : void 0));
}
function normalizeUniqueStringEntriesLower(values) {
	return uniqueStrings(normalizeStringEntriesLower(values ? [...values] : void 0).filter(Boolean));
}
function normalizeSortedUniqueStringEntries(values) {
	return sortUniqueStrings(normalizeUniqueStringEntries(values));
}
function normalizeTrimmedStringList(value) {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		const normalized = normalizeOptionalString(entry);
		return normalized ? [normalized] : [];
	});
}
function normalizeUniqueTrimmedStringList(value) {
	return uniqueStrings(normalizeTrimmedStringList(value));
}
function normalizeSortedUniqueTrimmedStringList(value) {
	return sortUniqueStrings(normalizeTrimmedStringList(value));
}
function normalizeOptionalTrimmedStringList(value) {
	const normalized = normalizeTrimmedStringList(value);
	return normalized.length > 0 ? normalized : void 0;
}
function normalizeArrayBackedTrimmedStringList(value) {
	if (!Array.isArray(value)) return;
	return normalizeTrimmedStringList(value);
}
function normalizeSingleOrTrimmedStringList(value) {
	if (Array.isArray(value)) return normalizeTrimmedStringList(value);
	const normalized = normalizeOptionalString(value);
	return normalized ? [normalized] : [];
}
function normalizeUniqueSingleOrTrimmedStringList(value) {
	return uniqueStrings(normalizeSingleOrTrimmedStringList(value));
}
function normalizeCsvOrLooseStringList(value) {
	if (Array.isArray(value)) return normalizeStringEntries(value);
	if (typeof value === "string") return value.split(",").map((entry) => entry.trim()).filter(Boolean);
	return [];
}
function normalizeSlugInput(raw) {
	return (normalizeOptionalLowercaseString(raw) ?? "").normalize("NFC");
}
function normalizeHyphenSlug(raw) {
	const trimmed = normalizeSlugInput(raw);
	if (!trimmed) return "";
	return trimmed.replace(/\s+/g, "-").replace(/[^\p{L}\p{M}\p{N}#@._+-]+/gu, "-").replace(/-{2,}/g, "-").replace(/^[-.]+|[-.]+$/g, "");
}
function normalizeAtHashSlug(raw) {
	const trimmed = normalizeSlugInput(raw);
	if (!trimmed) return "";
	return trimmed.replace(/^[@#]+/, "").replace(/[\s_]+/g, "-").replace(/[^\p{L}\p{M}\p{N}-]+/gu, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
}
//#endregion
export { normalizeArrayBackedTrimmedStringList, normalizeAtHashSlug, normalizeCsvOrLooseStringList, normalizeHyphenSlug, normalizeOptionalTrimmedStringList, normalizeSingleOrTrimmedStringList, normalizeSortedUniqueStringEntries, normalizeSortedUniqueTrimmedStringList, normalizeStringEntries, normalizeStringEntriesLower, normalizeTrimmedStringList, normalizeUniqueSingleOrTrimmedStringList, normalizeUniqueStringEntries, normalizeUniqueStringEntriesLower, normalizeUniqueTrimmedStringList, sortUniqueStrings, uniqueStrings, uniqueValues };
