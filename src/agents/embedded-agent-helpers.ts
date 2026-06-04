/** Embedded-agent helper barrel for bootstrap, provider error, media, and turn sanitizers. */
export {
  buildBootstrapContextFiles,
  DEFAULT_BOOTSTRAP_MAX_CHARS,
  DEFAULT_BOOTSTRAP_PROMPT_TRUNCATION_WARNING_MODE,
  DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS,
  ensureSessionHeader,
  resolveBootstrapMaxChars,
  resolveBootstrapPromptTruncationWarningMode,
  resolveBootstrapTotalMaxChars,
  stripThoughtSignatures,
} from "./embedded-agent-helpers/bootstrap.js";
export {
  BILLING_ERROR_USER_MESSAGE,
  classifyProviderRuntimeFailureKind,
  formatBillingErrorMessage,
  formatRateLimitOrOverloadedErrorCopy,
  classifyFailoverReason,
  classifyFailoverReasonFromHttpStatus,
  formatRawAssistantErrorForUi,
  formatAssistantErrorText,
  formatUserFacingAssistantErrorText,
  GENERIC_ASSISTANT_ERROR_TEXT,
  getApiErrorPayloadFingerprint,
  isAuthAssistantError,
  isAuthErrorMessage,
  isAuthPermanentErrorMessage,
  isModelNotFoundErrorMessage,
  isBillingAssistantError,
  extractObservedOverflowTokenCount,
  parseApiErrorInfo,
  isBillingErrorMessage,
  isCloudflareOrHtmlErrorPage,
  isCloudCodeAssistFormatError,
  isCompactionFailureError,
  isContextOverflowError,
  isLikelyContextOverflowError,
  isFailoverAssistantError,
  isFailoverErrorMessage,
  isImageDimensionErrorMessage,
  isImageSizeError,
  isOverloadedErrorMessage,
  isRawApiErrorPayload,
  isRateLimitAssistantError,
  isRateLimitErrorMessage,
  isTransientHttpError,
  isTimeoutErrorMessage,
  parseImageDimensionError,
  parseImageSizeError,
} from "./embedded-agent-helpers/errors.js";
export type { ProviderRuntimeFailureKind } from "./embedded-agent-helpers/errors.js";
export { sanitizeUserFacingText } from "./embedded-agent-helpers/sanitize-user-facing-text.js";
export { isGoogleModelApi, sanitizeGoogleTurnOrdering } from "./embedded-agent-helpers/google.js";

export {
  downgradeOpenAIFunctionCallReasoningPairs,
  downgradeOpenAIReasoningBlocks,
  normalizeOpenAIResponsesToolCallIds,
} from "./embedded-agent-helpers/openai.js";
export {
  isEmptyAssistantMessageContent,
  sanitizeSessionMessagesImages,
} from "./embedded-agent-helpers/images.js";
export {
  isMessagingToolDuplicate,
  isMessagingToolDuplicateNormalized,
  normalizeTextForComparison,
} from "./embedded-agent-helpers/messaging-dedupe.js";

export { pickFallbackThinkingLevel } from "./embedded-agent-helpers/thinking.js";

export {
  mergeConsecutiveUserTurns,
  validateAnthropicTurns,
  validateGeminiTurns,
} from "./embedded-agent-helpers/turns.js";
export type { EmbeddedContextFile, FailoverReason } from "./embedded-agent-helpers/types.js";

export type { ToolCallIdMode } from "./tool-call-id.js";
export { isValidCloudCodeAssistToolId, sanitizeToolCallId } from "./tool-call-id.js";
