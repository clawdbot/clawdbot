import type { Context, Model } from "@openclaw/llm-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdkState = vi.hoisted(() => ({
  clients: [] as Array<Record<string, unknown>>,
  post: vi.fn(),
}));

vi.mock("openai", () => {
  class MockOpenAI {
    constructor(options: Record<string, unknown>) {
      sdkState.clients.push(options);
    }

    post = sdkState.post;
  }
  return { default: MockOpenAI, AzureOpenAI: MockOpenAI };
});

import { resolveOpenAIResponsesCompactEndpointPlan } from "./openai-responses-payload-policy.js";
import {
  createOpenAIResponsesTransportStreamFn,
  requestPreparedOpenAIResponsesCompaction,
} from "./openai-responses-transport.js";

const model = {
  id: "grok-4.5",
  name: "Grok 4.5",
  api: "openai-responses",
  provider: "xai",
  baseUrl: "https://api.x.ai/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 256_000,
  maxTokens: 8_192,
} satisfies Model<"openai-responses">;

const context = {
  systemPrompt: "Retain the conversation.",
  messages: [{ role: "user", content: "Remember NORTH-COPPER-17.", timestamp: 1 }],
} satisfies Context;

describe("responses compact endpoint", () => {
  beforeEach(() => {
    sdkState.clients.length = 0;
    sdkState.post.mockReset();
  });

  it("posts the normal Responses input and returns the validated checkpoint with usage", async () => {
    sdkState.post.mockResolvedValue({
      object: "response.compaction",
      output: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Remember NORTH-COPPER-17." }],
        },
        { type: "compaction", id: "cmp_1", encrypted_content: "opaque" },
      ],
      usage: { input_tokens: 8_614, output_tokens: 736, dropped_message_count: 3 },
    });

    const result = await requestPreparedOpenAIResponsesCompaction(
      createOpenAIResponsesTransportStreamFn(),
      model,
      context,
      { apiKey: "test-key", sessionId: "session-1" },
    );

    expect(sdkState.clients[0]).toMatchObject({
      apiKey: "test-key",
      baseURL: "https://api.x.ai/v1",
    });
    expect(sdkState.post).toHaveBeenCalledWith(
      "/responses/compact",
      expect.objectContaining({
        body: {
          model: "grok-4.5",
          input: [
            expect.objectContaining({ role: "system", type: "message" }),
            expect.objectContaining({ role: "user", type: "message" }),
          ],
        },
      }),
    );
    expect(result).toMatchObject({
      item: { type: "compaction", id: "cmp_1", encrypted_content: "opaque" },
      usage: { input_tokens: 8_614, output_tokens: 736, dropped_message_count: 3 },
      model,
      replayMetadata: {
        source: "openai-responses",
        provider: "xai",
        model: "grok-4.5",
      },
    });
  });

  it.each([
    ["missing", [{ type: "message", role: "user", content: [] }]],
    [
      "duplicated",
      [
        { type: "compaction", id: "cmp_1", encrypted_content: "opaque-1" },
        { type: "compaction", id: "cmp_2", encrypted_content: "opaque-2" },
      ],
    ],
    [
      "non-trailing",
      [
        { type: "compaction", id: "cmp_1", encrypted_content: "opaque" },
        { type: "message", role: "user", content: [] },
      ],
    ],
  ])("rejects a %s compaction item", async (_case, output) => {
    sdkState.post.mockResolvedValue({
      object: "response.compaction",
      output,
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    await expect(
      requestPreparedOpenAIResponsesCompaction(
        createOpenAIResponsesTransportStreamFn(),
        model,
        context,
        { apiKey: "test-key" },
      ),
    ).rejects.toThrow("one trailing compaction item");
  });

  it.each([
    ["native xAI default", model, undefined, true],
    ["native xAI alias default", { ...model, provider: "x-ai" }, undefined, true],
    ["native xAI opt-out", model, { responsesCompactEndpoint: false }, false],
    [
      "custom Responses opt-in",
      { ...model, provider: "custom", baseUrl: "https://responses.example/v1" },
      { responsesCompactEndpoint: true },
      true,
    ],
    [
      "custom Responses default",
      { ...model, provider: "custom", baseUrl: "https://responses.example/v1" },
      undefined,
      false,
    ],
    [
      "non-Responses opt-in",
      { ...model, api: "openai-completions" },
      { responsesCompactEndpoint: true },
      false,
    ],
    [
      "OpenAI default",
      { ...model, provider: "openai", baseUrl: "https://api.openai.com/v1" },
      undefined,
      false,
    ],
  ] as const)("resolves the %s gate", (_name, route, extraParams, enabled) => {
    expect(resolveOpenAIResponsesCompactEndpointPlan(route, extraParams).enabled).toBe(enabled);
  });
});
