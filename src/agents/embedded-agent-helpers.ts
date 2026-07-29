/** Embedded-agent helper barrel for bootstrap, provider error, media, and turn sanitizers. */

export {
  buildBootstrapContextFiles,
  resolveBootstrapMaxChars,
  resolveBootstrapPromptTruncationWarningMode,
  resolveBootstrapTotalMaxChars,
} from "./embedded-agent-helpers/bootstrap.js";
export {
  BILLING_ERROR_USER_MESSAGE,
  classifyAssistantFailoverReason,
  classifyProviderRuntimeFailureKind,
  formatBillingErrorMessage,
  formatRateLimitOrOverloadedErrorCopy,
  classifyFailoverReason,
  formatRawAssistantErrorForUi,
  formatAssistantErrorText,
  formatUserFacingAssistantErrorText,
  GENERIC_ASSISTANT_ERROR_TEXT,
  getApiErrorPayloadFingerprint,
  isAuthAssistantError,
  isAuthErrorMessage,
  isBillingAssistantError,
  extractObservedOverflowTokenCount,
  parseApiErrorInfo,
  isBillingErrorMessage,
  isCloudCodeAssistFormatError,
  isCompactionFailureError,
  isContextOverflowError,
  isLikelyContextOverflowError,
  isFailoverAssistantError,
  isFailoverErrorMessage,
  isGenericUnknownStreamErrorMessage,
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
export { sanitizeGoogleTurnOrdering } from "./embedded-agent-helpers/google.js";

export {
  downgradeOpenAIFunctionCallReasoningPairs,
  downgradeOpenAIReasoningBlocks,
  normalizeOpenAIResponsesToolCallIds,
} from "./embedded-agent-helpers/openai.js";
export { sanitizeSessionMessagesImages } from "./embedded-agent-helpers/images.js";
export {
  isMessagingToolDuplicate,
  isMessagingToolDuplicateNormalized,
  normalizeTextForComparison,
} from "./embedded-agent-helpers/messaging-dedupe.js";

export { pickFallbackThinkingLevel } from "./embedded-agent-helpers/thinking.js";

export { validateAnthropicTurns, validateGeminiTurns } from "./embedded-agent-helpers/turns.js";
export type { EmbeddedContextFile, FailoverReason } from "./embedded-agent-helpers/types.js";
