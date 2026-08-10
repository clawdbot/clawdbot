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
  createStreamingJsonPreview,
  getApiProvider,
  getApiProviders,
  getEnvApiKey,
  parseStreamingJson,
  sanitizeSurrogates,
  type StreamingJsonPreview,
} from "@openclaw/ai/internal/runtime";
// `createStreamingJsonPreview` is the supported seam for provider plugins that
// stream tool-call arguments (see docs/plugins/sdk-provider-plugins.md). It is
// deliberately the only streaming-preview export here: the underlying
// `*StreamingJsonPreviewState` helpers are mutable host internals whose fields
// must stay free to change, so they remain importable only from
// `@openclaw/ai/internal/runtime`, by first-party core code (Worker inference)
// that ships in lockstep with them - never across the plugin boundary.
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
