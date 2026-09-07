import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import type { Model } from "openclaw/plugin-sdk/llm";
// Amazon Bedrock Mantle tests cover mantle anthropic plugin behavior.
import {
  notifyProviderStreamOpened,
  withProviderAcceptanceObserver,
} from "openclaw/plugin-sdk/provider-transport-runtime";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { createMantleAnthropicStreamFn } from "./mantle-anthropic.runtime.js";

function createTestModel(overrides: Partial<Model> = {}): Model {
  return {
    id: "anthropic.claude-opus-4-7",
    name: "Claude Opus 4.7",
    provider: "amazon-bedrock-mantle",
    api: "anthropic-messages",
    baseUrl: "https://bedrock-mantle.us-east-1.api.aws/v1",
    headers: {
      "X-Test": "model-header",
    },
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    ...overrides,
  } as Model;
}

function createTestDeps() {
  return {
    createClient: vi.fn((options: unknown) => ({ options }) as never),
    stream: vi.fn(),
  };
}

const requireRecord = createRequireRecord("record", "expected-label-object-capitalized");

function mockCallArg(mock: { mock: { calls: unknown[][] } }, index = 0, argIndex = 0): unknown {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`expected mock call ${index}`);
  }
  return call[argIndex];
}

function expectFirstStreamCall(
  deps: ReturnType<typeof createTestDeps>,
  model: Model,
  context: unknown,
) {
  expect(mockCallArg(deps.stream, 0, 0)).toBe(model);
  expect(mockCallArg(deps.stream, 0, 1)).toBe(context);
}

function firstStreamOptions(deps: ReturnType<typeof createTestDeps>): Record<string, unknown> {
  return requireRecord(mockCallArg(deps.stream, 0, 2), "stream options");
}

describe("createMantleAnthropicStreamFn", () => {
  it.each(["short", "long", "none"] as const)(
    "keeps the stable system prefix independently cacheable across suffix changes (%s)",
    async (cacheRetention) => {
      const systems: unknown[] = [];
      for (const suffix of ["Today: Monday", "Today: Tuesday"]) {
        let payload: unknown;
        const events = await createMantleAnthropicStreamFn()(
          createTestModel(),
          {
            systemPrompt: `Stable workspace${SYSTEM_PROMPT_CACHE_BOUNDARY}${suffix}`,
            messages: [{ role: "user", content: "Hello", timestamp: 0 }],
          },
          {
            apiKey: "synthetic-test-key",
            cacheRetention,
            onPayload: (request) => {
              payload = request;
              throw new Error("payload captured before network");
            },
          },
        );
        await events.result();
        const request = requireRecord(payload, "Mantle payload");
        systems.push(request.system);
        expect(JSON.stringify(request)).not.toContain("OPENCLAW_CACHE_BOUNDARY");
        if (cacheRetention === "none") {
          expect(request.system).toEqual([{ type: "text", text: `Stable workspace\n${suffix}` }]);
          expect(JSON.stringify(request)).not.toContain("cache_control");
        } else {
          expect(request.system).toEqual([
            {
              type: "text",
              text: "Stable workspace",
              cache_control: {
                type: "ephemeral",
                ...(cacheRetention === "long" ? { ttl: "1h" } : {}),
              },
            },
            { type: "text", text: suffix },
          ]);
          expect(JSON.stringify(request).match(/"cache_control"/g)?.length).toBeLessThanOrEqual(4);
        }
      }
      if (cacheRetention !== "none") {
        expect(Array.isArray(systems[0]) && systems[0][0]).toEqual(
          Array.isArray(systems[1]) && systems[1][0],
        );
      }
    },
  );

  it("uses authToken bearer auth for Mantle Anthropic requests", async () => {
    const stream = { kind: "anthropic-stream" };
    const model = createTestModel();
    const context = { messages: [] };
    const deps = createTestDeps();
    deps.stream.mockReturnValue(stream as never);
    const acceptanceObserver = vi.fn();
    const onResponse = vi.fn();
    const options = withProviderAcceptanceObserver(
      {
        apiKey: "bedrock-bearer-token",
        onResponse,
        headers: {
          "X-Caller": "caller-header",
        },
      },
      acceptanceObserver,
    );

    const result = createMantleAnthropicStreamFn(deps)(model, context, options);

    expect(result).toBe(stream);
    const clientOptions = requireRecord(mockCallArg(deps.createClient), "client options");
    expect(clientOptions.apiKey).toBeNull();
    expect(clientOptions.authToken).toBe("bedrock-bearer-token");
    expect(clientOptions.baseURL).toBe("https://bedrock-mantle.us-east-1.api.aws/anthropic");
    const defaultHeaders = requireRecord(clientOptions.defaultHeaders, "default headers");
    expect(defaultHeaders.accept).toBe("application/json");
    expect(defaultHeaders["anthropic-beta"]).toBe("fine-grained-tool-streaming-2025-05-14");
    expect(defaultHeaders["X-Test"]).toBe("model-header");
    expect(defaultHeaders["X-Caller"]).toBe("caller-header");
    expect(clientOptions.fetch).toEqual(expect.any(Function));

    expectFirstStreamCall(deps, model, context);
    const streamOptions = firstStreamOptions(deps);
    const client = requireRecord(streamOptions.client, "stream client");
    expect(requireRecord(client.options, "stream client options").authToken).toBe(
      "bedrock-bearer-token",
    );
    expect(streamOptions.thinkingEnabled).toBe(false);
    expect(streamOptions.onResponse).toBe(onResponse);
    await notifyProviderStreamOpened({ options: streamOptions, cancelStream: vi.fn() });
    expect(acceptanceObserver).toHaveBeenCalledWith({ kind: "provider_stream_opened" });
  });

  it("omits unsupported Opus 4.7 sampling and reasoning overrides", () => {
    const model = createTestModel();
    const context = { messages: [] };
    const deps = createTestDeps();
    deps.stream.mockReturnValue({ kind: "anthropic-stream" } as never);

    void createMantleAnthropicStreamFn(deps)(model, context, {
      apiKey: "bedrock-bearer-token",
      temperature: 0.2,
      reasoning: "high",
    });

    expectFirstStreamCall(deps, model, context);
    const streamOptions = firstStreamOptions(deps);
    expect(streamOptions.temperature).toBeUndefined();
    expect(streamOptions.thinkingEnabled).toBe(false);
  });

  it("defaults Mythos Preview to adaptive high effort", () => {
    const model = createTestModel({
      id: "anthropic.claude-mythos-preview",
      name: "Claude Mythos Preview",
      reasoning: true,
      params: { canonicalModelId: "claude-mythos-preview" },
    });
    const context = { messages: [] };
    const deps = createTestDeps();
    deps.stream.mockReturnValue({ kind: "anthropic-stream" } as never);

    void createMantleAnthropicStreamFn(deps)(model, context, {
      apiKey: "bedrock-bearer-token",
    });

    expectFirstStreamCall(deps, model, context);
    const streamOptions = firstStreamOptions(deps);
    expect(streamOptions.thinkingEnabled).toBe(true);
    expect(streamOptions.effort).toBe("high");
  });

  it.each([
    { reasoning: undefined, thinkingEnabled: true, effort: "high" },
    { reasoning: "off" as const, thinkingEnabled: false, effort: undefined },
    { reasoning: "max" as const, thinkingEnabled: true, effort: "max" },
  ])(
    "uses the Opus 5 contract for reasoning=$reasoning",
    ({ reasoning, thinkingEnabled, effort }) => {
      const model = createTestModel({
        id: "anthropic.claude-opus-5",
        name: "Claude Opus 5",
        reasoning: true,
        params: { canonicalModelId: "claude-opus-5" },
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        maxTokens: 128_000,
      });
      const deps = createTestDeps();
      deps.stream.mockReturnValue({ kind: "anthropic-stream" } as never);

      void createMantleAnthropicStreamFn(deps)(
        model,
        { messages: [] },
        {
          apiKey: "bedrock-bearer-token",
          reasoning,
          temperature: 0.2,
        },
      );

      expect(firstStreamOptions(deps)).toMatchObject({
        thinkingEnabled,
        maxTokens: 128_000,
      });
      if (effort) {
        expect(firstStreamOptions(deps).effort).toBe(effort);
      } else {
        expect(firstStreamOptions(deps)).not.toHaveProperty("effort");
      }
      expect(firstStreamOptions(deps)).not.toHaveProperty("temperature");
    },
  );

  it.each([
    { reasoning: undefined, effort: "high" },
    { reasoning: "off" as const, effort: "low" },
  ])("keeps Sonnet 5 adaptive for reasoning=$reasoning", ({ reasoning, effort }) => {
    const model = createTestModel({
      id: "anthropic.claude-sonnet-5",
      name: "Claude Sonnet 5",
      reasoning: true,
      params: { canonicalModelId: "claude-sonnet-5" },
      cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      maxTokens: 128_000,
    });
    const deps = createTestDeps();
    deps.stream.mockReturnValue({ kind: "anthropic-stream" } as never);

    void createMantleAnthropicStreamFn(deps)(
      model,
      { messages: [] },
      {
        apiKey: "bedrock-bearer-token",
        reasoning,
        temperature: 0.2,
      },
    );

    expect(firstStreamOptions(deps)).toMatchObject({
      thinkingEnabled: true,
      effort,
      maxTokens: 128_000,
    });
    expect(firstStreamOptions(deps)).not.toHaveProperty("temperature");
  });

  it("clamps unsupported Mythos Preview max effort to high", () => {
    const model = createTestModel({
      id: "anthropic.claude-mythos-preview",
      name: "Claude Mythos Preview",
      reasoning: true,
      params: { canonicalModelId: "claude-mythos-preview" },
    });
    const context = { messages: [] };
    const deps = createTestDeps();
    deps.stream.mockReturnValue({ kind: "anthropic-stream" } as never);

    void createMantleAnthropicStreamFn(deps)(model, context, {
      apiKey: "bedrock-bearer-token",
      reasoning: "max",
    });

    expectFirstStreamCall(deps, model, context);
    const streamOptions = firstStreamOptions(deps);
    expect(streamOptions.thinkingEnabled).toBe(true);
    expect(streamOptions.effort).toBe("high");
  });

  it("maps Mythos Preview minimal reasoning to low effort", () => {
    const model = createTestModel({
      id: "anthropic.claude-mythos-preview",
      name: "Claude Mythos Preview",
      reasoning: true,
      params: { canonicalModelId: "claude-mythos-preview" },
    });
    const deps = createTestDeps();
    deps.stream.mockReturnValue({ kind: "anthropic-stream" } as never);

    void createMantleAnthropicStreamFn(deps)(
      model,
      { messages: [] },
      {
        apiKey: "bedrock-bearer-token",
        reasoning: "minimal",
      },
    );

    const streamOptions = firstStreamOptions(deps);
    expect(streamOptions.thinkingEnabled).toBe(true);
    expect(streamOptions.effort).toBe("low");
  });

  it("disables legacy thinking when the adjusted budget is below 1024", () => {
    const model = createTestModel({
      id: "anthropic.claude-haiku-4-5",
      name: "Claude Haiku 4.5",
      reasoning: true,
      maxTokens: 1500,
    });
    const deps = createTestDeps();
    deps.stream.mockReturnValue({ kind: "anthropic-stream" } as never);

    void createMantleAnthropicStreamFn(deps)(
      model,
      { messages: [] },
      { apiKey: "bedrock-bearer-token", reasoning: "low" },
    );

    expect(firstStreamOptions(deps)).toMatchObject({ maxTokens: 1500, thinkingEnabled: false });
    expect(firstStreamOptions(deps)).not.toHaveProperty("thinkingBudgetTokens");
  });

  it.each([
    { reasoning: undefined, effort: "high" },
    { reasoning: "off" as const, effort: "low" },
    { reasoning: "max" as const, effort: "max" },
  ])("maps Mythos 5 $reasoning reasoning to adaptive $effort", ({ reasoning, effort }) => {
    const model = createTestModel({
      id: "anthropic.claude-mythos-5",
      name: "Claude Mythos 5",
      reasoning: true,
      params: { canonicalModelId: "claude-mythos-5" },
      thinkingLevelMap: { off: "low", minimal: "low", xhigh: "xhigh", max: "max" },
    });
    const deps = createTestDeps();
    deps.stream.mockReturnValue({ kind: "anthropic-stream" } as never);

    void createMantleAnthropicStreamFn(deps)(
      model,
      { messages: [] },
      {
        apiKey: "bedrock-bearer-token",
        maxTokens: 1_000,
        temperature: 0.2,
        ...(reasoning ? { reasoning } : {}),
      },
    );

    const streamOptions = firstStreamOptions(deps);
    expect(streamOptions.thinkingEnabled).toBe(true);
    expect(streamOptions.effort).toBe(effort);
    expect(streamOptions.maxTokens).toBe(1_000);
    expect(streamOptions).not.toHaveProperty("thinkingBudgetTokens");
    expect(streamOptions.temperature).toBeUndefined();
  });
});
