// Narrow primitive coercion helpers for plugins that do not need the full text-runtime barrel.

export {
  hasNonEmptyString,
  localeLowercasePreservingWhitespace,
  lowercasePreservingWhitespace,
  normalizeFastMode,
  normalizeLowercaseStringOrEmpty,
  normalizeNullableString,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
  normalizeStringifiedEntries,
  normalizeStringifiedOptionalString,
  readStringValue,
} from "../shared/string-coerce.js";
export {
  asFiniteNumber,
  asPositiveSafeInteger,
  parseFiniteNumber,
} from "../shared/number-coercion.js";
export { asBoolean, parseBooleanValue } from "../utils/boolean.js";
export {
  asRecord,
  asNullableRecord,
  asOptionalRecord,
  readStringField,
} from "../shared/record-coerce.js";
export { isRecord } from "../utils.js";
export {
  normalizeAtHashSlug,
  normalizeHyphenSlug,
  normalizeOptionalTrimmedStringList,
  normalizeSortedUniqueTrimmedStringList,
  normalizeSingleOrTrimmedStringList,
  normalizeStringEntries,
  normalizeStringEntriesLower,
  normalizeUniqueStringEntries,
  normalizeUniqueTrimmedStringList,
  normalizeTrimmedStringList,
  sortUniqueStrings,
  uniqueStrings,
  uniqueValues,
} from "../shared/string-normalization.js";
export { summarizeStringEntries } from "../shared/string-sample.js";
