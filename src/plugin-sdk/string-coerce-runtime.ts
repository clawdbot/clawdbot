// Narrow primitive coercion helpers for plugins that do not need the full text-runtime barrel.

export {
  hasNonEmptyString,
  localeLowercasePreservingWhitespace,
  lowercasePreservingWhitespace,
  normalizeLowercaseStringOrEmpty,
  normalizeNullableString,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
  normalizeStringifiedOptionalString,
  readStringValue,
} from "../shared/string-coerce.js";
export { isRecord } from "../utils.js";
