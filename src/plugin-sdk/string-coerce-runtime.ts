// Browser-safe primitive coercion, normalization, and UTF-16 helpers for plugins.

export {
  hasNonEmptyString,
  localeLowercasePreservingWhitespace,
  lowercasePreservingWhitespace,
  normalizeFastMode,
  normalizeBoundedOptionalString,
  normalizeLowercaseStringOrEmpty,
  normalizeNullableString,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
  normalizeStringifiedEntries,
  normalizeStringifiedOptionalString,
  readNonBlankString,
  readNonEmptyStringPreservingWhitespace,
  readStringValue,
} from "../../packages/normalization-core/src/string-coerce.js";
export {
  asDateTimestampMs,
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
  asNonArrayRecord,
  asNullableObjectRecord,
  asNullableRecord,
  asOptionalObjectRecord,
  asOptionalRecord,
  filterStringRecord,
  isRecord,
  readStringField,
} from "../../packages/normalization-core/src/record-coerce.js";
export {
  filterStringEntries,
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
export { truncateUtf16Safe } from "../../packages/normalization-core/src/utf16-slice.js";
export { summarizeStringEntries } from "../shared/string-sample.js";
