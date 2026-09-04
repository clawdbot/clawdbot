import type { Model } from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { emitModelTransportDebug, resolveModelSseDebugMode } from "./model-transport-debug.js";
import { stringifyRedactedEvent } from "./openai-responses-debug.js";
import type { OpenAIResponsesStreamEvent } from "./openai-responses-stream-internal.js";
import { createModelStreamCooperativeScheduler, log } from "./openai-transport-shared.js";
import { transportAbortError } from "./transport-stream-shared.js";

const STRING_DELTA_EVENTS = new Set([
  "response.function_call_arguments.delta",
  "response.output_text.delta",
  "response.reasoning_summary_text.delta",
  "response.reasoning_text.delta",
  "response.refusal.delta",
  "response.text.delta",
]);

export async function* adaptResponsesStream(
  stream: AsyncIterable<unknown>,
  signal?: AbortSignal,
): AsyncGenerator<OpenAIResponsesStreamEvent> {
  const scheduler = createModelStreamCooperativeScheduler(signal);
  for await (const event of stream) {
    if (signal?.aborted) {
      throw transportAbortError(signal);
    }
    if (!isRecord(event) || typeof event.type !== "string") {
      throw new Error("Responses stream delivered a malformed event without a string type");
    }
    if (STRING_DELTA_EVENTS.has(event.type) && typeof event.delta !== "string") {
      throw new Error(`Responses stream delivered malformed ${event.type} delta`);
    }
    if (
      (event.type === "response.output_item.added" || event.type === "response.output_item.done") &&
      !isRecord(event.item)
    ) {
      throw new Error(`Responses stream delivered malformed ${event.type} item`);
    }
    if (
      (event.type === "response.created" ||
        event.type === "response.completed" ||
        event.type === "response.incomplete" ||
        event.type === "response.failed") &&
      !isRecord(event.response)
    ) {
      throw new Error(`Responses stream delivered malformed ${event.type} response`);
    }
    yield event as OpenAIResponsesStreamEvent;
    await scheduler.afterEvent();
  }
}

export async function* observeResponsesStream<TEvent>(
  stream: AsyncIterable<TEvent>,
  model: Model,
  requestStartedAt?: number,
): AsyncGenerator<TEvent> {
  const startedAt = Date.now();
  const eventTypes = new Map<string, number>();
  const debugMode = resolveModelSseDebugMode();
  let eventCount = 0;
  try {
    for await (const event of stream) {
      const type = isRecord(event) && typeof event.type === "string" ? event.type : "unknown";
      eventCount += 1;
      eventTypes.set(type, (eventTypes.get(type) ?? 0) + 1);
      if (eventCount === 1) {
        emitModelTransportDebug(
          log,
          `[responses] first_event provider=${model.provider} api=${model.api} model=${model.id} ` +
            `elapsedMs=${Date.now() - (requestStartedAt ?? startedAt)} ` +
            `headersToEventMs=${Date.now() - startedAt} type=${type}`,
        );
      }
      if (debugMode === "peek" && eventCount <= 5) {
        emitModelTransportDebug(
          log,
          `[responses] event_peek provider=${model.provider} api=${model.api} model=${model.id} index=${eventCount} type=${type} event=${stringifyRedactedEvent(event)}`,
        );
      }
      yield event;
    }
  } finally {
    const types = [...eventTypes].map(([type, count]) => `${type}:${count}`).join(",");
    emitModelTransportDebug(
      log,
      `[responses] stream_done provider=${model.provider} api=${model.api} model=${model.id} elapsedMs=${Date.now() - startedAt} events=${eventCount} types=${types}`,
    );
  }
}
