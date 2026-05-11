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
  normalizeStringifiedOptionalString,
  readStringValue,
} from "../shared/string-coerce.js";
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
  normalizeSingleOrTrimmedStringList,
  normalizeStringEntries,
  normalizeStringEntriesLower,
} from "../shared/string-normalization.js";
export { summarizeStringEntries } from "../shared/string-sample.js";
