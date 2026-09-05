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

const officialOpenAIModel = {
  ...model,
  id: "gpt-5.6-luna",
  name: "GPT-5.6 Luna",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
} satisfies Model<"openai-responses">;

const context = {
  systemPrompt: "Retain the conversation.",
  messages: [{ role: "user", content: "Remember NORTH-COPPER-17.", timestamp: 1 }],
} satisfies Context;

function mockCompactResponse(body: unknown): void {
  sdkState.post.mockResolvedValue(body);
}

describe("responses compact endpoint", () => {
  beforeEach(() => {
    sdkState.clients.length = 0;
    sdkState.post.mockReset();
  });

  it("accepts retained-message prefixes from the official OpenAI endpoint", async () => {
    mockCompactResponse({
      object: "response.compaction",
      output: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "Retain the conversation." }],
        },
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
      officialOpenAIModel,
      context,
      { apiKey: "test-key", sessionId: "session-1" },
    );

    expect(sdkState.clients[0]).toMatchObject({
      apiKey: "test-key",
      baseURL: "https://api.openai.com/v1",
    });
    expect(sdkState.post).toHaveBeenCalledWith(
      "/responses/compact",
      expect.objectContaining({
        body: {
          model: "gpt-5.6-luna",
          input: [
            expect.objectContaining({ role: "developer", type: "message" }),
            expect.objectContaining({ role: "user", type: "message" }),
          ],
        },
      }),
    );
    expect(result).toMatchObject({
      output: [
        expect.objectContaining({ role: "developer" }),
        expect.objectContaining({ role: "user" }),
        { type: "compaction", id: "cmp_1", encrypted_content: "opaque" },
      ],
      item: { type: "compaction", id: "cmp_1", encrypted_content: "opaque" },
      historyMode: "retained-users",
      usage: { input_tokens: 8_614, output_tokens: 736, dropped_message_count: 3 },
      model: officialOpenAIModel,
      replayMetadata: {
        source: "openai-responses",
        provider: "openai",
        model: "gpt-5.6-luna",
      },
    });
  });

  it("rejects retained-message prefixes from native xAI", async () => {
    mockCompactResponse({
      object: "response.compaction",
      output: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Remember NORTH-COPPER-17." }],
        },
        { type: "compaction", id: "cmp_1", encrypted_content: "opaque" },
      ],
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
    ["missing", [{ type: "message", role: "user", content: [] }]],
    [
      "malformed retained-message",
      [
        { type: "message", role: "assistant", content: [] },
        { type: "compaction", id: "cmp_1", encrypted_content: "opaque" },
      ],
    ],
    [
      "retained tool-output",
      [
        { type: "function_call_output", call_id: "call_1", output: "result" },
        { type: "compaction", id: "cmp_1", encrypted_content: "opaque" },
      ],
    ],
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
    mockCompactResponse({
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

  it("keeps the checkpoint-only response shape distinct from retained user history", async () => {
    mockCompactResponse({
      object: "response.compaction",
      output: [{ type: "compaction", id: "cmp_1", encrypted_content: "opaque" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    await expect(
      requestPreparedOpenAIResponsesCompaction(
        createOpenAIResponsesTransportStreamFn(),
        model,
        context,
        { apiKey: "test-key" },
      ),
    ).resolves.toMatchObject({ historyMode: "compacted-prefix" });
  });

  it.each([
    { type: "input_text", text: 1 },
    { type: "input_image", detail: "auto" },
    { type: "input_image", detail: "invalid", image_url: "https://media.example/image.png" },
    { type: "input_file", file_id: 42 },
    { type: "output_text", text: "not supported input" },
  ])("rejects unsupported retained content without rewriting it: %j", async (block) => {
    mockCompactResponse({
      object: "response.compaction",
      output: [
        { type: "message", role: "user", content: [block] },
        { type: "compaction", encrypted_content: "opaque" },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await expect(
      requestPreparedOpenAIResponsesCompaction(
        createOpenAIResponsesTransportStreamFn(),
        officialOpenAIModel,
        context,
        { apiKey: "test-key" },
      ),
    ).rejects.toThrow("one trailing compaction item");
  });

  it.each([model, { ...model, provider: "custom", baseUrl: "https://responses.example/v1" }])(
    "rejects endpoint output altered by the $provider route's status policy",
    async (route) => {
      mockCompactResponse({
        object: "response.compaction",
        output: [{ type: "compaction", encrypted_content: "opaque", status: "completed" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      await expect(
        requestPreparedOpenAIResponsesCompaction(
          createOpenAIResponsesTransportStreamFn(),
          route,
          context,
          { apiKey: "test-key" },
        ),
      ).rejects.toThrow("one trailing compaction item");
    },
  );

  it.each([
    "data:image/png;base64,invalid",
    "data:image/bmp;base64,Qk0=",
    "data:image/png;base64,/9j/",
  ])("rejects canonical image output that the transport would change: %s", async (imageUrl) => {
    mockCompactResponse({
      object: "response.compaction",
      output: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_image", detail: "auto", image_url: imageUrl }],
        },
        { type: "compaction", encrypted_content: "opaque" },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await expect(
      requestPreparedOpenAIResponsesCompaction(
        createOpenAIResponsesTransportStreamFn(),
        officialOpenAIModel,
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
