export {
  buildBootstrapContextFiles,
  DEFAULT_BOOTSTRAP_MAX_CHARS,
  ensureSessionHeader,
  resolveBootstrapMaxChars,
  stripThoughtSignatures,
} from "./pi-embedded-helpers/bootstrap.js";
export {
  classifyFailoverReason,
  formatRawAssistantErrorForUi,
  formatAssistantErrorText,
  getApiErrorPayloadFingerprint,
  isAuthAssistantError,
  isAuthErrorMessage,
  isBillingAssistantError,
  parseApiErrorInfo,
  sanitizeUserFacingText,
  isBillingErrorMessage,
  isCloudCodeAssistFormatError,
  isCompactionFailureError,
  isContextOverflowError,
  isLikelyContextOverflowError,
  isFailoverAssistantError,
  isFailoverErrorMessage,
  isImageDimensionErrorMessage,
  isOverloadedErrorMessage,
  isRawApiErrorPayload,
  isRateLimitAssistantError,
  isRateLimitErrorMessage,
  isTimeoutErrorMessage,
  parseImageDimensionError,
} from "./pi-embedded-helpers/errors.js";
export { isGoogleModelApi, sanitizeGoogleTurnOrdering } from "./pi-embedded-helpers/google.js";

export { downgradeOpenAIReasoningBlocks } from "./pi-embedded-helpers/openai.js";
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
export type { EmbeddedContextFile, FailoverReason } from "./pi-embedded-helpers/types.js";

export type { ToolCallIdMode } from "./tool-call-id.js";
export { isValidCloudCodeAssistToolId, sanitizeToolCallId } from "./tool-call-id.js";
