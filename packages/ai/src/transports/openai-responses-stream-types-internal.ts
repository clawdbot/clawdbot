import type {
  ResponseCreateParamsStreaming,
  ResponseOutputMessage,
  ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import type {
  AzureResponsesTextContentPart,
  AzureResponsesTextDeltaEvent,
} from "../providers/openai-responses-stream-compat.js";
import type { Usage } from "../types.js";
import type { FirstStreamEventInternalOptions } from "../utils/stream-first-event-timeout.js";
import type { OpenAIResponsesReasoningReplayMetadata } from "./openai-responses-contracts.js";

type ResponsesConsumedEventType =
  | "error"
  | "response.completed"
  | "response.content_part.added"
  | "response.created"
  | "response.failed"
  | "response.function_call_arguments.delta"
  | "response.function_call_arguments.done"
  | "response.incomplete"
  | "response.output_item.added"
  | "response.output_item.done"
  | "response.output_text.delta"
  | "response.reasoning_summary_part.added"
  | "response.reasoning_summary_part.done"
  | "response.reasoning_summary_text.delta"
  | "response.reasoning_text.delta"
  | "response.refusal.delta";

type OpenAIResponsesConsumedEvent = Extract<
  ResponseStreamEvent,
  { type: ResponsesConsumedEventType }
>;
type OpenAIResponsesIgnoredSdkEvent = Exclude<ResponseStreamEvent, OpenAIResponsesConsumedEvent>;
type ResponsesTextContentPart =
  | ResponseOutputMessage["content"][number]
  | AzureResponsesTextContentPart;
type ResponsesContentPartAddedEvent = Extract<
  ResponseStreamEvent,
  { type: "response.content_part.added" }
>;
type ResponsesOutputItemDoneEvent = Extract<
  ResponseStreamEvent,
  { type: "response.output_item.done" }
>;

export type CompletedResponse = Extract<
  ResponseStreamEvent,
  { type: "response.completed" }
>["response"];

export type ResponsesStreamOutputMessage = Omit<ResponseOutputMessage, "content"> & {
  content: ResponsesTextContentPart[] | null;
};

export type OpenAIResponsesStreamEvent =
  | OpenAIResponsesConsumedEvent
  | OpenAIResponsesIgnoredSdkEvent
  | (Omit<ResponsesContentPartAddedEvent, "part"> & {
      part: Extract<ResponsesTextContentPart, { type: "text" }>;
    })
  | (Omit<ResponsesOutputItemDoneEvent, "item"> & {
      item: ResponsesStreamOutputMessage;
    })
  | AzureResponsesTextDeltaEvent;

export type ResponsesStreamOptions = FirstStreamEventInternalOptions & {
  asyncToolExecution?: boolean;
  serviceTier?: ResponseCreateParamsStreaming["service_tier"];
  resolveServiceTier?: (
    responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
    requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
  ) => ResponseCreateParamsStreaming["service_tier"] | undefined;
  applyServiceTierPricing?: (
    usage: Usage,
    serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
  ) => void;
  signal?: AbortSignal;
  reasoningReplayMetadata?: OpenAIResponsesReasoningReplayMetadata;
};
