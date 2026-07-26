import type { Api } from "@openclaw/llm-core";
import type {
  FunctionTool,
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseOutputMessage,
  ResponseReasoningItem,
} from "openai/resources/responses/responses.js";
import type { OpenAIApiReasoningEffort, OpenAIReasoningEffort } from "../internal/openai.js";
import type { BaseOpenAIStreamOptions } from "./openai-transport-shared.js";

export const DEFAULT_AZURE_OPENAI_API_VERSION = "preview";
export const OPENAI_CODEX_RESPONSES_EMPTY_INPUT_TEXT = " ";
export const OPENAI_CODEX_RESPONSES_DEFAULT_INSTRUCTIONS = "Follow the user request.";
export const AZURE_RESPONSES_FIRST_EVENT_TIMEOUT_MS = 30_000;
export const RESPONSE_FAILED_NO_DETAILS_MESSAGE = "Unknown error (no error details in response)";
export const OPENAI_RESPONSES_REASONING_REPLAY_META_KEY = "__openclaw_replay";
export const OPENAI_RESPONSES_REASONING_REPLAY_BLOCK_META_KEY = "openclawReasoningReplay";
export const OPENAI_RESPONSES_REPLAY_ITEM_ID_MAX_LENGTH = 64;

export type ReplayableResponseOutputMessage = Omit<ResponseOutputMessage, "id"> & { id?: string };
export type OpenAIResponsesReasoningReplayMetadata = {
  v: 1;
  source: "openai-responses";
  provider: string;
  api: Api;
  model: string;
  baseUrlHash?: string;
  sessionHash?: string;
  authProfileHash?: string;
};
export type ReplayableResponseReasoningItem = Omit<ResponseReasoningItem, "id"> & {
  id?: string;
  [OPENAI_RESPONSES_REASONING_REPLAY_META_KEY]?: OpenAIResponsesReasoningReplayMetadata;
};

export type OpenAIResponsesOptions = BaseOpenAIStreamOptions & {
  reasoning?: OpenAIReasoningEffort;
  reasoningEffort?: OpenAIReasoningEffort;
  reasoningSummary?: "auto" | "detailed" | "concise" | null;
  replayResponsesItemIds?: boolean;
  serviceTier?: ResponseCreateParamsStreaming["service_tier"];
  toolChoice?: ResponseCreateParamsStreaming["tool_choice"];
};

export type OpenAIResponsesReplayContext = {
  provider: string;
  api: Api;
  model: string;
  baseUrlHash?: string;
  sessionHash?: string;
  authProfileHash?: string;
};

export type OpenAIResponsesRequestParams = {
  model: string;
  input: ResponseInput;
  stream: true;
  instructions?: string;
  prompt_cache_key?: string;
  prompt_cache_retention?: "24h";
  metadata?: Record<string, string>;
  store?: boolean;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  text?: ResponseCreateParamsStreaming["text"];
  service_tier?: ResponseCreateParamsStreaming["service_tier"];
  tools?: FunctionTool[];
  tool_choice?: ResponseCreateParamsStreaming["tool_choice"];
  reasoning?:
    | { effort: OpenAIApiReasoningEffort }
    | {
        effort: OpenAIApiReasoningEffort;
        summary: NonNullable<OpenAIResponsesOptions["reasoningSummary"]>;
      };
  include?: string[];
};
