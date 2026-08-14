// The managed Responses transport must price usage through the canonical
// model-aware service-tier helper. A transport-local flat table previously
// drifted (2x while gpt-5.5 priority bills 2.5x) and understated UI cost.
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
    throw new Error("pricing tests must not construct a WebSocket");
  },
}));

import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";

// Cost figures are per million tokens; usage below uses 1M input + 1M output
// so the expected totals read directly off the multiplied unit prices.
const model = {
  id: "gpt-5.5",
  name: "GPT 5.5",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 2, output: 10, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
} satisfies Model<"openai-responses">;

function completedResponse(serviceTier: string): SdkResponse {
  return {
    data: (async function* () {
      yield {
        type: "response.completed",
        response: {
          id: "resp_priced",
          status: "completed",
          service_tier: serviceTier,
          output: [
            {
              id: "msg_priced",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: "ok", annotations: [] }],
            },
          ],
          usage: { input_tokens: 1_000_000, output_tokens: 1_000_000, total_tokens: 2_000_000 },
        },
      };
    })(),
    response: new Response(null, { status: 200 }),
  };
}

describe("managed Responses transport service-tier pricing", () => {
  it("applies the canonical 2.5x gpt-5.5 priority multiplier to usage cost", async () => {
    sseState.outcomes.push(completedResponse("priority"));
    const stream = await createOpenAIResponsesTransportStreamFn()(
      model,
      { messages: [], tools: [] },
      { apiKey: "test-key", sessionId: "session-pricing", transport: "sse" } as never,
    );
    const result = await stream.result();
    // Base cost 2 + 10 = 12; gpt-5.5 priority is 2.5x = 30 (flat 2x would be 24).
    expect(result.usage.cost.total).toBeCloseTo(30, 6);
  });
});
