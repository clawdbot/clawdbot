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
} from "../../packages/normalization-core/src/string-coerce.js";
export {
  asFiniteNumberInRange,
  asFiniteNumber,
  asPositiveSafeInteger,
  asSafeIntegerInRange,
  parseFiniteNumber,
  parseStrictFiniteNumber,
  parseStrictInteger,
  parseStrictNonNegativeInteger,
  parseStrictPositiveInteger,
} from "../../packages/normalization-core/src/number-coercion.js";
export { asBoolean, parseBooleanValue } from "../utils/boolean.js";
export {
  asRecord,
  asNullableRecord,
  asOptionalRecord,
  readStringField,
} from "../../packages/normalization-core/src/record-coerce.js";
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
} from "../../packages/normalization-core/src/string-normalization.js";
export { summarizeStringEntries } from "../shared/string-sample.js";
