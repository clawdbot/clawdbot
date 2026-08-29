/** Embedded-agent helper barrel for bootstrap, provider error, media, and turn sanitizers. */

export {
  buildBootstrapContextFiles,
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
} from "./embedded-agent-helpers/bootstrap.js";
export {
  classifyAssistantFailoverReason,
  isAuthAssistantError,
  isBillingAssistantError,
  isFailoverAssistantError,
  isRateLimitAssistantError,
} from "./embedded-agent-helpers/assistant-message-failures.js";
export {
  extractObservedOverflowTokenCount,
  isCompactionFailureError,
} from "./embedded-agent-helpers/context-overflow-observation.js";
export type { EmbeddedContextFile } from "./embedded-agent-helpers/context-file.js";
export {
  formatAssistantErrorText,
  formatUserFacingAssistantErrorText,
  GENERIC_ASSISTANT_ERROR_TEXT,
} from "./embedded-agent-helpers/error-text.js";
export {
  parseImageDimensionError,
  parseImageSizeError,
} from "./embedded-agent-helpers/image-errors.js";
export { classifyProviderRuntimeFailureKind } from "./embedded-agent-helpers/provider-runtime-failure.js";
export type { ProviderRuntimeFailureKind } from "./embedded-agent-helpers/provider-runtime-failure.js";
export {
  BILLING_ERROR_USER_MESSAGE,
  formatBillingErrorMessage,
  getApiErrorPayloadFingerprint,
  isRawApiErrorPayload,
} from "./failover/user-copy.js";
export {
  formatRawAssistantErrorForUi,
  parseApiErrorInfo,
} from "../shared/assistant-error-format.js";
export {
  classifyFailoverReason,
  isAuthErrorMessage,
  isCloudCodeAssistFormatError,
  isContextOverflowError,
  isFailoverErrorMessage,
  isGenericUnknownStreamErrorMessage,
  isLikelyContextOverflowError,
  isProviderRequestSizeCeilingError,
  isTransientHttpError,
  isTimeoutErrorMessage,
} from "./failover/classify.js";
export type { FailoverReason } from "./failover/signal.js";
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
