import { formatModelTransportDebugBaseUrl } from "./model-transport-url.js";
/** OpenAI Responses transport facade. */
import {
  createAzureOpenAIResponsesTransportStreamFn,
  createAzureOpenAIClient,
  createOpenAIResponsesClient,
  createOpenAIResponsesTransportStreamFn,
} from "./openai-responses-client.js";
import { buildOpenAIResponsesReasoningReplayMetadata } from "./openai-responses-compaction-replay.js";
import {
  buildResponsesFailedNoDetailsObservation,
  normalizeResponsesFailedEvent,
  summarizeResponsesFailedNoDetailsObservation,
  summarizeResponsesPayload,
  summarizeResponsesTools,
  stringifyRedactedEvent,
  stringifyRedactedPayload,
} from "./openai-responses-debug.js";
import {
  buildOpenAIResponsesParams,
  sanitizeOpenAICodexResponsesParams,
} from "./openai-responses-params-internal.js";
import {
  createResponsesStreamWithEncryptedContentRetry,
  isInvalidEncryptedContentError,
  resolveAzureOpenAIApiVersion,
} from "./openai-responses-replay-internal.js";
import { processResponsesStream } from "./openai-responses-stream-internal.js";
import {
  assertCodeModeResponsesToolSurface,
  buildOpenAIClientHeaders,
  buildOpenAISdkClientOptions,
  buildOpenAISdkRequestOptions,
  enforceCodeModeResponsesToolSurface,
  getCompat,
} from "./openai-transport-params.js";

export { createAzureOpenAIResponsesTransportStreamFn, createOpenAIResponsesTransportStreamFn };
export { requestPreparedOpenAIResponsesCompaction } from "./openai-responses-compact-request.js";
export { captureOpenAIResponsesCompaction } from "./openai-responses-compaction-replay.js";

const responsesTesting = {
  getCompat,
  assertCodeModeResponsesToolSurface,
  buildOpenAIResponsesParams,
  buildOpenAIClientHeaders,
  buildOpenAISdkClientOptions,
  buildOpenAISdkRequestOptions,
  createAzureOpenAIClient,
  createOpenAIResponsesClient,
  enforceCodeModeResponsesToolSurface,
  sanitizeOpenAICodexResponsesParams,
  processResponsesStream,
  formatModelTransportDebugBaseUrl,
  buildResponsesFailedNoDetailsObservation,
  buildOpenAIResponsesReasoningReplayMetadata,
  isInvalidEncryptedContentError,
  normalizeResponsesFailedEvent,
  createResponsesStreamWithEncryptedContentRetry,
  resolveAzureOpenAIApiVersion,
  summarizeResponsesFailedNoDetailsObservation,
  summarizeResponsesPayload,
  summarizeResponsesTools,
  stringifyRedactedEvent,
  stringifyRedactedPayload,
};

declare global {
  var openclawOpenAIResponsesTransportTestApi: typeof responsesTesting | undefined;
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  globalThis.openclawOpenAIResponsesTransportTestApi = responsesTesting;
}
