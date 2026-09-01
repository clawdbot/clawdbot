/**
 * Runtime SDK subpath for provider transport helpers and stream primitives.
 */
export { buildGuardedModelFetch } from "../agents/provider-transport-fetch.js";
export { buildOpenAICompletionsParams } from "../agents/openai-transport-stream.js";
export {
  sortPromptCacheToolsByName,
  stripSystemPromptCacheBoundary,
} from "@openclaw/ai/internal/shared";
export { transformTransportMessages } from "../agents/transport-message-transform.js";
export {
  describeToolResultMediaPlaceholder,
  describeUnsupportedToolResultMedia,
  extractToolResultText,
  formatToolResultText,
  isImageWithMediaPayload,
} from "@openclaw/ai/internal/shared";
export {
  coerceTransportToolCallArguments,
  copyProviderAcceptanceObserver,
  createEmptyTransportUsage,
  createWritableTransportEventStream,
  failTransportStream,
  finalizeTerminalToolCallArguments,
  finalizeTransportStream,
  MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE,
  mergeTransportHeaders,
  notifyProviderHttpMetadata,
  notifyProviderHttpResponse,
  notifyProviderStreamOpened,
  parseTerminalToolCallArguments,
  sanitizeTransportPayloadText,
  withProviderAcceptanceObserver,
  type ProviderAcceptance,
  type WritableTransportStream,
} from "@openclaw/ai/transports";
