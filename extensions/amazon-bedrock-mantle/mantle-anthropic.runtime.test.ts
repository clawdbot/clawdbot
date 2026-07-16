// Amazon Bedrock Mantle tests cover mantle anthropic plugin behavior.
import type { Model } from "openclaw/plugin-sdk/llm";
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

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

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
  it("uses authToken bearer auth for Mantle Anthropic requests", () => {
    const stream = { kind: "anthropic-stream" };
    const model = createTestModel();
    const context = { messages: [] };
    const deps = createTestDeps();
    deps.stream.mockReturnValue(stream as never);

    const result = createMantleAnthropicStreamFn(deps)(model, context, {
      apiKey: "bedrock-bearer-token",
      headers: {
        "X-Caller": "caller-header",
      },
    });

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
