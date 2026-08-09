import type { Api, ProviderReplayState } from "@openclaw/llm-core";
import type {
  FunctionTool,
  ResponseCreateParamsStreaming,
  ResponseCompactionItem,
  ResponseInput,
  ResponseOutputMessage,
  ResponseReasoningItem,
} from "openai/resources/responses/responses.js";
import type { BaseOpenAIStreamOptions } from "../provider-options.js";
import type {
  OpenAIApiReasoningEffort,
  OpenAIReasoningEffort,
} from "../providers/openai-reasoning-effort.js";

export const DEFAULT_AZURE_OPENAI_API_VERSION = "preview";
export const OPENAI_CODEX_RESPONSES_EMPTY_INPUT_TEXT = " ";
export const OPENAI_CODEX_RESPONSES_DEFAULT_INSTRUCTIONS = "Follow the user request.";
export const AZURE_RESPONSES_FIRST_EVENT_TIMEOUT_MS = 30_000;
export const RESPONSE_FAILED_NO_DETAILS_MESSAGE = "Unknown error (no error details in response)";
export const OPENAI_RESPONSES_REASONING_REPLAY_META_KEY = "__openclaw_replay";
export const OPENAI_RESPONSES_REASONING_REPLAY_BLOCK_META_KEY = "openclawReasoningReplay";
export const OPENAI_RESPONSES_REPLAY_ITEM_ID_MAX_LENGTH = 64;
export const OPENAI_RESPONSES_COMPACTION_REPLAY_TYPE = "openai-responses-compaction";

export type ReplayableResponseOutputMessage = Omit<ResponseOutputMessage, "id"> & { id?: string };
export type ReplayableResponseCompactionItem = Omit<ResponseCompactionItem, "id"> & { id?: string };
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
export type OpenAIResponsesCompactionReplayState = ProviderReplayState & {
  type: typeof OPENAI_RESPONSES_COMPACTION_REPLAY_TYPE;
  baseUrlHash: string;
};

export type OpenAIResponsesOptions = BaseOpenAIStreamOptions & {
  reasoning?: OpenAIReasoningEffort;
  reasoningEffort?: OpenAIReasoningEffort;
  reasoningSummary?: "auto" | "detailed" | "concise" | null;
  replayResponsesItemIds?: boolean;
  serviceTier?: ResponseCreateParamsStreaming["service_tier"];
  toolChoice?: ResponseCreateParamsStreaming["tool_choice"];
};

const PROMPT_OBSERVER = Symbol("openaiResponsesPromptObserver");
export type ResponsesPromptObservation = {
  egress: "responses-sdk" | "native-codex-websocket" | "native-codex-sse";
  payloadVariant: "initial" | "reasoning-stripped" | "compaction-stripped";
  promptSource: "instructions" | "input.developer" | "input.system" | "missing";
  expectedChars: number;
  observedChars: number;
  matchesAssembledPrompt: boolean;
};
type ResponsesPromptObserver = (observation: ResponsesPromptObservation) => void;

export const responsesPromptObserver = {
  set(options: object, observer: ResponsesPromptObserver): void {
    Reflect.set(options, PROMPT_OBSERVER, observer);
  },
  get(options: object) {
    return Reflect.get(options, PROMPT_OBSERVER) as ResponsesPromptObserver | undefined;
  },
  copy(source: object | undefined, target: object): void {
    const observer = source && responsesPromptObserver.get(source);
    if (observer) {
      responsesPromptObserver.set(target, observer);
    }
  },
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
