// Responses streams must report every SSE event as request activity so the
// embedded-runner idle watchdog stays quiet while bookkeeping-only events
// (in_progress, *.done echoes) arrive, matching the completions and anthropic
// transports.
import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage, Model } from "../types.js";
import { createZeroUsage } from "../usage.test-support.js";
import { onLlmRequestActivity } from "../utils/llm-request-activity.js";
import {
  processResponsesStream,
  type OpenAIResponsesStreamEvent,
} from "./openai-responses-stream-internal.js";

const model = {
  id: "gpt-5.6-luna",
  name: "GPT-5.6 Luna",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
} satisfies Model<"openai-responses">;

function createOutput(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createZeroUsage(),
    stopReason: "stop",
    timestamp: 0,
  };
}

async function* eventStream(
  events: readonly Record<string, unknown>[],
): AsyncGenerator<OpenAIResponsesStreamEvent> {
  for (const event of events) {
    yield event as OpenAIResponsesStreamEvent;
  }
}

describe("processResponsesStream request activity", () => {
  it("notifies request activity for every SSE event, including ignored ones", async () => {
    const abortController = new AbortController();
    const onActivity = vi.fn();
    const unsubscribe = onLlmRequestActivity(abortController.signal, onActivity);
    try {
      const events: Record<string, unknown>[] = [
        { type: "response.created", response: { id: "resp_activity" } },
        // Ignored bookkeeping event: no consumer-visible event is pushed.
        { type: "response.in_progress", response: { id: "resp_activity" } },
        {
          type: "response.completed",
          response: { id: "resp_activity", status: "completed", output: [] },
        },
      ];
      await processResponsesStream(eventStream(events), createOutput(), { push: () => {} }, model, {
        signal: abortController.signal,
      });
      expect(onActivity).toHaveBeenCalledTimes(events.length);
    } finally {
      unsubscribe();
    }
  });
});
