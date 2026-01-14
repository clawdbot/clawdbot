export {
  buildBootstrapContextFiles,
  DEFAULT_BOOTSTRAP_MAX_CHARS,
  ensureSessionHeader,
  resolveBootstrapMaxChars,
  stripThoughtSignatures,
} from "./pi-embedded-helpers/bootstrap.js";
export {
  classifyFailoverReason,
  formatAssistantErrorText,
  isAuthAssistantError,
  isAuthErrorMessage,
  isBillingAssistantError,
  isBillingErrorMessage,
  isCloudCodeAssistFormatError,
  isCompactionFailureError,
  isContextOverflowError,
  isFailoverAssistantError,
  isFailoverErrorMessage,
  isOverloadedErrorMessage,
  isRateLimitAssistantError,
  isRateLimitErrorMessage,
  isTimeoutErrorMessage,
} from "./pi-embedded-helpers/errors.js";
export {
  downgradeGeminiHistory,
  isGoogleModelApi,
  sanitizeGoogleTurnOrdering,
} from "./pi-embedded-helpers/google.js";
export {
  isEmptyAssistantMessageContent,
  sanitizeSessionMessagesImages,
} from "./pi-embedded-helpers/images.js";
export {
  isMessagingToolDuplicate,
  isMessagingToolDuplicateNormalized,
  normalizeTextForComparison,
} from "./pi-embedded-helpers/messaging-dedupe.js";

export { pickFallbackThinkingLevel } from "./pi-embedded-helpers/thinking.js";

export {
  mergeConsecutiveUserTurns,
  validateAnthropicTurns,
  validateGeminiTurns,
} from "./pi-embedded-helpers/turns.js";
export type {
  EmbeddedContextFile,
  FailoverReason,
} from "./pi-embedded-helpers/types.js";

export {
  isValidCloudCodeAssistToolId,
  sanitizeToolCallId,
} from "./tool-call-id.js";
