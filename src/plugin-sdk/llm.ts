/**
 * Public SDK subpath for LLM streaming, model utils, and validation.
 */
export type { ApiProvider } from "@openclaw/ai";
export { resolveProviderContext } from "../../packages/ai/src/provider-types.js";
export type {
  ProviderContext,
  ProviderModel,
  ProviderStreamFunction,
  ProviderStreamOptions as ProviderCallStreamOptions,
  VideoContent,
} from "../../packages/ai/src/provider-types.js";
export {
  calculateCost,
  clampThinkingLevel,
  getApiProvider,
  getApiProviders,
  getEnvApiKey,
  parseStreamingJson,
  sanitizeSurrogates,
} from "@openclaw/ai/internal/runtime";
// Incremental streaming-preview helpers (`createStreamingJsonPreviewState`,
// `pushStreamingJsonPreview`, `finalizeStreamingJsonPreview`, and
// `StreamingJsonPreviewState`) intentionally stay OFF this public subpath.
// They are mutable/stateful internals for first-party stream adapters
// (Amazon Bedrock + Worker inference) and must be imported from
// `@openclaw/ai/internal/runtime` until a maintainer explicitly adopts them
// as a documented Plugin SDK contract.
export {
  adjustMaxTokensForThinking,
  buildBaseOptions,
  clampReasoning,
} from "@openclaw/ai/internal/shared";
export { transformMessages } from "@openclaw/ai/internal/shared";
export { complete, completeSimple, stream, streamSimple } from "../llm/stream.js";
export type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStreamContract,
  CacheRetention,
  Context,
  ImageContent,
  Message,
  Model,
  ModelThinkingLevel,
  ProviderResponse,
  ProviderStreamOptions,
  SimpleStreamOptions,
  StopReason,
  StreamFunction,
  StreamOptions,
  TextContent,
  ThinkingBudgets,
  ThinkingContent,
  ThinkingLevel,
  Tool,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "../llm/types.js";
export {
  AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from "../../packages/llm-core/src/utils/event-stream.js";
export { createHttpProxyAgentsForTarget } from "../llm/utils/node-http-proxy.js";
export { validateToolArguments, validateToolCall } from "../../packages/llm-core/src/validation.js";
