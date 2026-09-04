import {
  PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE,
  type Api,
  type ProviderReplayState,
} from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
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
import type { OpenAIResponsesCompactedWindow } from "./openai-responses-compaction-window.js";

export const DEFAULT_AZURE_OPENAI_API_VERSION = "preview";
export const OPENAI_CODEX_RESPONSES_EMPTY_INPUT_TEXT = " ";
export const OPENAI_CODEX_RESPONSES_DEFAULT_INSTRUCTIONS = "Follow the user request.";
export const AZURE_RESPONSES_FIRST_EVENT_TIMEOUT_MS = 30_000;
export const RESPONSE_FAILED_NO_DETAILS_MESSAGE = "Unknown error (no error details in response)";
export const OPENAI_RESPONSES_REASONING_REPLAY_META_KEY = "__openclaw_replay";
export const OPENAI_RESPONSES_REASONING_REPLAY_BLOCK_META_KEY = "openclawReasoningReplay";
export const OPENAI_RESPONSES_REPLAY_ITEM_ID_MAX_LENGTH = 64;
export const OPENAI_RESPONSES_COMPACTION_REPLAY_TYPE = "openai-responses-compaction";
export const OPENAI_RESPONSES_RETAINED_COMPACTION_REPLAY_TYPE =
  "openai-responses-retained-compaction";
export const OPENAI_RESPONSES_APIS: ReadonlySet<Api> = new Set([
  "openai-responses",
  "azure-openai-responses",
  "openai-chatgpt-responses",
  "openclaw-openai-responses-transport",
  "openclaw-openai-chatgpt-responses-transport",
  "openclaw-azure-openai-responses-transport",
]);

export class OpenAIResponsesWebSocketPreDispatchError extends Error {
  constructor(cause: unknown) {
    super("OpenAI Responses WebSocket failed before request dispatch", { cause });
    this.name = "OpenAIResponsesWebSocketPreDispatchError";
  }
}

export class OpenAIResponsesWebSocketPostDispatchError extends Error {
  readonly code = PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE;

  constructor(cause: unknown) {
    super("OpenAI Responses WebSocket failed after request dispatch; outcome is unknown", {
      cause,
    });
    this.name = "OpenAIResponsesWebSocketPostDispatchError";
  }
}

class OpenAIResponsesWebSocketServerError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | undefined,
    readonly param: string | null,
    message: string,
    cause: unknown,
  ) {
    super(message, { cause });
    this.name = "OpenAIResponsesWebSocketServerError";
  }
}

export class OpenAIResponsesWebSocketSafeRetryError extends OpenAIResponsesWebSocketServerError {}

function readWebSocketServerError(value: unknown) {
  if (!isRecord(value) || value.type !== "error") {
    return undefined;
  }
  const details = isRecord(value.error) ? value.error : value;
  if (typeof details.code !== "string" || typeof details.message !== "string") {
    return undefined;
  }
  const rawStatus = value.status ?? value.status_code;
  return {
    code: details.code,
    message: details.message,
    param: typeof details.param === "string" ? details.param : null,
    status: typeof rawStatus === "number" ? rawStatus : undefined,
  };
}

export function parseOpenAIResponsesWebSocketServerError(cause: unknown) {
  if (!isRecord(cause)) {
    return undefined;
  }
  let details = readWebSocketServerError(cause.error) ?? readWebSocketServerError(cause);
  if (!details && typeof cause.message === "string") {
    try {
      details = readWebSocketServerError(JSON.parse(cause.message));
    } catch {}
  }
  if (!details) {
    return undefined;
  }
  const ErrorClass =
    details.code === "previous_response_not_found" ||
    details.code === "websocket_connection_limit_reached" ||
    details.code === "invalid_encrypted_content" ||
    details.code === "thinking_signature_invalid"
      ? OpenAIResponsesWebSocketSafeRetryError
      : OpenAIResponsesWebSocketServerError;
  return new ErrorClass(details.code, details.status, details.param, details.message, cause);
}

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
  compactedWindow?: OpenAIResponsesCompactedWindow;
} & (
    | { type: typeof OPENAI_RESPONSES_COMPACTION_REPLAY_TYPE; baseUrlHash: string }
    | {
        type: typeof OPENAI_RESPONSES_RETAINED_COMPACTION_REPLAY_TYPE;
        baseUrlHash: string;
        replayIndex?: never;
      }
  );

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
  egress: "responses-sdk" | "responses-websocket" | "native-codex-websocket" | "native-codex-sse";
  payloadVariant:
    | "initial"
    | "reasoning-stripped"
    | "compaction-stripped"
    | "continuation-rejected";
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
  prompt_cache_options?: { ttl: "30m" };
  metadata?: Record<string, string>;
  previous_response_id?: string;
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
