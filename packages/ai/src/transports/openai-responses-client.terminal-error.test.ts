// The managed Responses transport must surface the provider's terminal error
// fact (e.g. content_filter) instead of collapsing it into a generic message;
// the generic string is classified as a transient timeout by failover and
// triggers pointless model rotation.
import type { Model } from "@openclaw/llm-core";
import { describe, expect, it, vi } from "vitest";

type SdkResponse = { data: AsyncIterable<unknown>; response: Response };

const sseState = vi.hoisted(() => ({
  outcomes: [] as Array<Error | SdkResponse>,
}));

vi.mock("openai", () => {
  class MockOpenAI {
    responses = {
      create: () => {
        const outcome = sseState.outcomes.shift() ?? new Error("Unexpected SSE request");
        return {
          withResponse: async () => {
            if (outcome instanceof Error) {
              throw outcome;
            }
            return outcome;
          },
        };
      },
    };
  }
  return { default: MockOpenAI, AzureOpenAI: MockOpenAI };
});

vi.mock("openai/resources/responses/ws.js", () => ({
  ResponsesWS: function UnexpectedResponsesWS() {
    throw new Error("terminal error tests must not construct a WebSocket");
  },
}));

import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";

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

describe("managed Responses transport terminal errors", () => {
  it("preserves the provider incomplete_reason instead of a generic message", async () => {
    sseState.outcomes.push({
      data: (async function* () {
        yield {
          type: "response.incomplete",
          response: {
            id: "resp_filtered",
            status: "incomplete",
            incomplete_details: { reason: "content_filter" },
          },
        };
      })(),
      response: new Response(null, { status: 200 }),
    });
    const stream = await createOpenAIResponsesTransportStreamFn()(
      model,
      { messages: [], tools: [] },
      {
        apiKey: "test-key",
        sessionId: "session-terminal-error",
        transport: "sse",
      } as never,
    );
    const result = await stream.result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("Provider incomplete_reason: content_filter");
  });
});
