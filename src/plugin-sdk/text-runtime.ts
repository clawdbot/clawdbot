/**
 * @deprecated Broad public SDK barrel. Prefer focused text/chunking/logging
 * subpaths and avoid adding new imports here.
 */

export * from "../logger.js";
export * from "../logging/diagnostic.js";
export * from "../logging/logger.js";
export * from "../logging/redact.js";
export * from "../logging/redact-identifier.js";
export * from "../markdown/ir.js";
export * from "../markdown/render-aware-chunking.js";
export * from "../markdown/render.js";
export * from "../markdown/tables.js";
export * from "../shared/global-singleton.js";
export * from "../shared/record-coerce.js";
export * from "../shared/scoped-expiring-id-cache.js";
export * from "../shared/string-coerce.js";
export * from "../shared/string-normalization.js";
export * from "../shared/string-sample.js";
export * from "../shared/text/assistant-visible-text.js";
export * from "../shared/text/auto-linked-file-ref.js";
export * from "../shared/text/code-regions.js";
export * from "../shared/text/reasoning-tags.js";
export * from "../shared/text/strip-markdown.js";
export * from "../terminal/safe-text.js";
export * from "../infra/system-message.ts";
export * from "../utils/directive-tags.js";
export * from "../utils/chunk-items.js";
export * from "../utils/fetch-timeout.js";
export * from "../utils/reaction-level.js";
export * from "../utils/with-timeout.js";
export {
  hasNonEmptyString,
  localeLowercasePreservingWhitespace,
  lowercasePreservingWhitespace,
  normalizeLowercaseStringOrEmpty,
  normalizeNullableString,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
  readStringValue,
} from "../shared/string-coerce.js";
export {
  CONFIG_DIR,
  clamp,
  clampInt,
  clampNumber,
  displayPath,
  displayString,
  ensureDir,
  escapeRegExp,
  isRecord,
  normalizeE164,
  pathExists,
  resolveConfigDir,
  resolveHomeDir,
  resolveUserPath,
  safeParseJson,
  shortenHomeInString,
  shortenHomePath,
  sleep,
  sliceUtf16Safe,
  truncateUtf16Safe,
} from "../utils.js";
