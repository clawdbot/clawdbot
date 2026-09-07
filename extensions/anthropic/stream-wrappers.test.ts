import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { calculateUsageCost } from "@openclaw/llm-core";
// Anthropic tests cover stream wrappers plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { resolveProviderEndpoint } from "openclaw/plugin-sdk/provider-model-shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createAnthropicBetaHeadersWrapper,
  createAnthropicFastModeWrapper,
  createAnthropicServiceTierWrapper,
  resolveAnthropicBetas,
  resolveAnthropicFastMode,
  wrapAnthropicProviderStream,
} from "./stream-wrappers.js";

const CONTEXT_1M_BETA = "context-1m-2025-08-07";
const OAUTH_BETA = "oauth-2025-04-20";
const DEFAULT_BETA_HEADER =
  "fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14";
const OAUTH_BETA_HEADER = `claude-code-20250219,${OAUTH_BETA},${DEFAULT_BETA_HEADER}`;
const initialTransportHost = getAiTransportHost();

beforeAll(() => {
  configureAiTransportHost({
    ...initialTransportHost,
    resolveProviderRequestCapabilities: (input) => ({
      ...initialTransportHost.resolveProviderRequestCapabilities(input),
      endpointClass: resolveProviderEndpoint(input.baseUrl).endpointClass,
      allowsAnthropicServiceTier: input.provider === "anthropic",
    }),
  });
});

afterAll(() => {
  configureAiTransportHost(initialTransportHost);
});

function runWrapper(apiKey: string | undefined): Record<string, string> | undefined {
  const captured: { headers?: Record<string, string> } = {};
  const base: StreamFn = (_model, _context, options) => {
    captured.headers = options?.headers;
    return {} as never;
  };
  const wrapper = createAnthropicBetaHeadersWrapper(base, [CONTEXT_1M_BETA]);
  void wrapper(
    { provider: "anthropic", id: "claude-opus-4-6" } as never,
    {} as never,
    { apiKey } as never,
  );
  return captured.headers;
}

function createPayloadCapturingBaseStream(captured: {
  headers?: Record<string, string>;
  payload?: Record<string, unknown>;
  options?: Parameters<StreamFn>[2];
}): StreamFn {
  return (model, _context, options) => {
    captured.headers = options?.headers;
    captured.options = options;
    const payload = {} as Record<string, unknown>;
    options?.onPayload?.(payload as never, model as never);
    captured.payload = payload;
    return {} as never;
  };
}

function runComposedAnthropicProviderStream(apiKey: string, modelId = "claude-sonnet-4-6") {
  const captured: { headers?: Record<string, string>; payload?: Record<string, unknown> } = {};
  const wrapped = wrapAnthropicProviderStream({
    streamFn: createPayloadCapturingBaseStream(captured),
    modelId,
    extraParams: { context1m: true, serviceTier: "auto" },
  } as never);

  void wrapped?.(
    { provider: "anthropic", api: "anthropic-messages", id: modelId } as never,
    {} as never,
    { apiKey } as never,
  );
  return captured;
}

function runPayloadWrapper(
  params: {
    apiKey?: string;
    provider?: string;
    api?: string;
    baseUrl?: string;
  },
  createWrapper: (base: StreamFn) => StreamFn,
): Record<string, unknown> | undefined {
  const captured: { payload?: Record<string, unknown> } = {};
  const wrapper = createWrapper(createPayloadCapturingBaseStream(captured));
  void wrapper(
    {
      provider: params.provider ?? "anthropic",
      api: params.api ?? "anthropic-messages",
      baseUrl: params.baseUrl,
      id: "claude-sonnet-4-6",
    } as never,
    {} as never,
    { apiKey: params.apiKey } as never,
  );
  return captured.payload;
}

function runNativeFastModeWrapper(params?: {
  apiKey?: string;
  provider?: string;
  api?: string;
  baseUrl?: string;
  enabled?: boolean;
  headers?: Record<string, string>;
  modelId?: string;
  cost?: Parameters<StreamFn>[0]["cost"];
}) {
  const captured: {
    headers?: Record<string, string>;
    model?: Parameters<StreamFn>[0];
    payload?: Record<string, unknown>;
  } = {};
  const base: StreamFn = (model, _context, options) => {
    captured.headers = options?.headers;
    captured.model = model;
    const payload = {} as Record<string, unknown>;
    options?.onPayload?.(payload as never, model as never);
    captured.payload = payload;
    return {} as never;
  };
  const wrapper = createAnthropicFastModeWrapper(base, params?.enabled ?? true);
  void wrapper(
    {
      provider: params?.provider ?? "anthropic",
      api: params?.api ?? "anthropic-messages",
      baseUrl: params?.baseUrl,
      id: params?.modelId ?? "claude-opus-5",
      cost: params?.cost ?? { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    } as never,
    {} as never,
    {
      apiKey: params?.apiKey ?? "sk-ant-api03-test-key",
      headers: params?.headers,
    } as never,
  );
  return captured;
}

function runCompactionProviderWrapper(params?: {
  apiKey?: string;
  provider?: string;
  api?: string;
  baseUrl?: string;
  extraParams?: Record<string, unknown>;
  headers?: Record<string, string>;
  payload?: Record<string, unknown>;
}) {
  const captured: {
    headers?: Record<string, string>;
    payload?: Record<string, unknown>;
    options?: Parameters<StreamFn>[2];
  } = {};
  const wrapped = wrapAnthropicProviderStream({
    streamFn: createPayloadCapturingBaseStream(captured),
    modelId: "claude-sonnet-4-6",
    extraParams: params?.extraParams ?? { anthropicServerCompaction: true },
  } as never);
  const payload = params?.payload ?? {};
  void wrapped?.(
    {
      provider: params?.provider ?? "anthropic",
      api: params?.api ?? "anthropic-messages",
      baseUrl: params?.baseUrl ?? "https://api.anthropic.com/v1",
      id: "claude-sonnet-4-6",
      contextWindow: 200_000,
    } as never,
    {} as never,
    {
      apiKey: params?.apiKey ?? "sk-ant-api03-test-key",
      headers: params?.headers,
      onPayload: (generated: unknown) =>
        Object.assign(generated as Record<string, unknown>, payload),
    } as never,
  );
  return captured;
}

describe("anthropic stream wrappers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("strips legacy context-1m betas for Claude CLI or legacy token auth", () => {
    const headers = runWrapper("sk-ant-oat01-123");
    expect(headers?.["anthropic-beta"]).toBeDefined();
    expect(headers?.["anthropic-beta"]).toContain(OAUTH_BETA);
    expect(headers?.["anthropic-beta"]).not.toContain(CONTEXT_1M_BETA);
  });

  it("strips legacy context-1m betas for API key auth", () => {
    const headers = runWrapper("sk-ant-api-123");
    expect(headers?.["anthropic-beta"]).toBeDefined();
    expect(headers?.["anthropic-beta"]).not.toContain(CONTEXT_1M_BETA);
  });

  it("skips service_tier for OAuth token in composed stream chain", () => {
    const captured = runComposedAnthropicProviderStream("sk-ant-oat01-oauth-token");
    expect(captured.headers?.["anthropic-beta"]).toBe(OAUTH_BETA_HEADER);
    expect(captured.payload?.service_tier).toBeUndefined();
  });

  it("skips unsupported service_tier for Claude Opus 5", () => {
    const captured = runComposedAnthropicProviderStream("sk-ant-api-123", "claude-opus-5");
    expect(captured.payload?.service_tier).toBeUndefined();
  });

  it("skips unsupported service_tier for Claude Sonnet 5", () => {
    const captured = runComposedAnthropicProviderStream("sk-ant-api-123", "claude-sonnet-5");
    expect(captured.payload?.service_tier).toBeUndefined();
  });

  it("composes the anthropic provider stream chain from extra params", () => {
    const captured = runComposedAnthropicProviderStream("sk-ant-api-123");
    expect(captured.headers?.["anthropic-beta"]).not.toContain(CONTEXT_1M_BETA);
    expect(captured.payload).toMatchObject({ service_tier: "auto" });
  });

  it("passes opt-in server compaction to the direct API-key transport", () => {
    const captured = runCompactionProviderWrapper({
      headers: { "Anthropic-Beta": "files-api-2025-04-14" },
    });

    expect(captured.headers?.["Anthropic-Beta"]).toBe("files-api-2025-04-14,compact-2026-01-12");
    expect(captured.options).toMatchObject({
      anthropicServerCompaction: true,
      anthropicCompactThreshold: 140_000,
    });
  });

  it("preserves existing context management under the compaction wrapper", () => {
    const existing = { edits: [{ type: "clear_tool_uses_20250919" }] };
    const captured = runCompactionProviderWrapper({ payload: { context_management: existing } });

    expect(captured.payload?.context_management).toBe(existing);
  });

  it.each([
    {
      name: "the feature is not enabled",
      extraParams: {},
    },
    {
      name: "OAuth auth is used",
      apiKey: "sk-ant-oat01-test-token",
    },
    {
      name: "a proxy endpoint is used",
      baseUrl: "https://proxy.example.test/v1",
    },
    {
      name: "a non-Anthropic API is used",
      api: "openai-completions",
    },
  ])("skips server compaction when $name", (params) => {
    const captured = runCompactionProviderWrapper(params);

    expect(captured.headers?.["anthropic-beta"] ?? "").not.toContain("compact-2026-01-12");
    expect(captured.payload).not.toHaveProperty("context_management");
  });

  it("does not emit the legacy context-1m beta from context1m or explicit config", () => {
    expect(
      resolveAnthropicBetas(
        { context1m: true, anthropicBeta: [CONTEXT_1M_BETA, "files-api-2025-04-14"] },
        "claude-sonnet-4-6",
      ),
    ).toEqual(["files-api-2025-04-14"]);
  });

  it("strips legacy context-1m beta from comma-separated string config", () => {
    expect(
      resolveAnthropicBetas(
        { anthropicBeta: `${CONTEXT_1M_BETA},files-api-2025-04-14` },
        "claude-sonnet-4-6",
      ),
    ).toEqual(["files-api-2025-04-14"]);
  });

  it("preserves OAuth-required betas when context1m is the only configured beta trigger", () => {
    const captured: { headers?: Record<string, string> } = {};
    const wrapped = wrapAnthropicProviderStream({
      streamFn: createPayloadCapturingBaseStream(captured),
      modelId: "claude-sonnet-4-6",
      extraParams: { context1m: true },
    } as never);

    void wrapped?.(
      { provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet-4-6" } as never,
      {} as never,
      { apiKey: "sk-ant-oat01-oauth-token" } as never,
    );

    expect(captured.headers?.["anthropic-beta"]).toContain(OAUTH_BETA);
    expect(captured.headers?.["anthropic-beta"]).not.toContain(CONTEXT_1M_BETA);
  });

  it("uses Opus 5 identity boundaries for context1m beta wrapper activation", () => {
    const opus5 = runComposedAnthropicProviderStream("sk-ant-oat01-oauth-token", "claude-opus-5");
    const opus50 = runComposedAnthropicProviderStream("sk-ant-oat01-oauth-token", "claude-opus-50");

    expect(opus5.headers?.["anthropic-beta"]).toBe(OAUTH_BETA_HEADER);
    expect(opus50.headers?.["anthropic-beta"]).toBeUndefined();
  });

  it("uses Fable 5 identity boundaries for context1m beta wrapper activation", () => {
    const fable5 = runComposedAnthropicProviderStream("sk-ant-oat01-oauth-token", "claude-fable-5");
    const fable50 = runComposedAnthropicProviderStream(
      "sk-ant-oat01-oauth-token",
      "claude-fable-50",
    );

    expect(fable5.headers?.["anthropic-beta"]).toBe(OAUTH_BETA_HEADER);
    expect(fable50.headers?.["anthropic-beta"]).toBeUndefined();
  });

  it("preserves OAuth-required betas when legacy context-1m is the only configured beta", () => {
    const captured: { headers?: Record<string, string> } = {};
    const wrapped = wrapAnthropicProviderStream({
      streamFn: createPayloadCapturingBaseStream(captured),
      modelId: "claude-sonnet-4-6",
      extraParams: { anthropicBeta: [CONTEXT_1M_BETA] },
    } as never);

    void wrapped?.(
      { provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet-4-6" } as never,
      {} as never,
      { apiKey: "sk-ant-oat01-oauth-token" } as never,
    );

    expect(captured.headers?.["anthropic-beta"]).toContain(OAUTH_BETA);
    expect(captured.headers?.["anthropic-beta"]).not.toContain(CONTEXT_1M_BETA);
  });

  it("ignores unresolved auto fast mode at the provider boundary", () => {
    expect(resolveAnthropicFastMode({ fastMode: "auto" })).toBeUndefined();
  });

  it("uses native fast mode and premium pricing for Claude Opus 5", () => {
    const captured = runNativeFastModeWrapper({
      headers: { "anthropic-beta": "files-api-2025-04-14" },
    });

    expect(captured.headers?.["anthropic-beta"]).toBe("files-api-2025-04-14,fast-mode-2026-02-01");
    expect(captured.payload).toEqual({ speed: "fast" });
    expect(captured.model?.cost).toEqual({
      input: 10,
      output: 50,
      cacheRead: 1,
      cacheWrite: 12.5,
    });
  });

  it.each([
    {
      cacheRead: 100_000,
      expected: { input: 0.01, output: 0.005, cacheRead: 0.1, cacheWrite: 0.2875, total: 0.4025 },
    },
    {
      cacheRead: 250_000,
      expected: { input: 0.02, output: 0.01, cacheRead: 0.5, cacheWrite: 0.575, total: 1.105 },
    },
  ])(
    "prices fast-mode tiers and mixed cache writes with $cacheRead cached tokens",
    ({ cacheRead, expected }) => {
      const cost: Parameters<StreamFn>[0]["cost"] = {
        input: 5,
        output: 25,
        cacheRead: 0.5,
        cacheWrite: 6.25,
        tieredPricing: [
          { range: [0, 200_000], input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
          { range: [200_000, Infinity], input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
        ],
      };
      const original = structuredClone(cost);
      const captured = runNativeFastModeWrapper({ cost });
      const pricedModel = expectDefined(captured.model, "fast-mode model");
      const usageCost = calculateUsageCost(
        { input: 1_000, output: 100, cacheRead, cacheWrite: 20_000, cacheWrite1h: 5_000 },
        pricedModel.cost,
      );
      expect(usageCost).toEqual({ ...expected, total: expect.closeTo(expected.total, 10) });
      expect(cost).toEqual(original);
    },
  );

  it("uses native fast mode for Claude Opus 4.8", () => {
    const captured = runNativeFastModeWrapper({ modelId: "claude-opus-4.8" });

    expect(captured.payload).toEqual({ speed: "fast" });
    expect(captured.model?.cost.output).toBe(50);
  });

  it.each(["opus", "opus-5"])("uses native fast mode for the %s alias", (modelId) => {
    const captured = runNativeFastModeWrapper({ modelId });

    expect(captured.headers?.["anthropic-beta"]).toContain("fast-mode-2026-02-01");
    expect(captured.payload).toEqual({ speed: "fast" });
    expect(captured.model?.cost.output).toBe(50);
  });

  it("keeps standard Opus 5 payload and pricing when fast mode is disabled", () => {
    const captured = runNativeFastModeWrapper({ enabled: false });

    expect(captured.headers).toBeUndefined();
    expect(captured.payload).toEqual({});
    expect(captured.model?.cost).toEqual({
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite: 6.25,
    });
  });

  it.each([
    {
      label: "OAuth",
      params: { apiKey: "sk-ant-oat01-test-token" },
    },
    {
      label: "proxy",
      params: { baseUrl: "https://proxy.example.com/v1" },
    },
    {
      label: "Vertex",
      params: {
        provider: "anthropic-vertex",
        baseUrl: "https://us-east5-aiplatform.googleapis.com",
      },
    },
  ])("does not send native fast mode over $label routes", ({ params }) => {
    const captured = runNativeFastModeWrapper(params);

    expect(captured.headers).toBeUndefined();
    expect(captured.payload).toEqual({});
    expect(captured.model?.cost.input).toBe(5);
  });

  it("lets explicit service tier configuration override fast mode", () => {
    const captured: { headers?: Record<string, string>; payload?: Record<string, unknown> } = {};
    const wrapped = wrapAnthropicProviderStream({
      streamFn: createPayloadCapturingBaseStream(captured),
      modelId: "claude-opus-5",
      extraParams: { fastMode: true, serviceTier: "standard_only" },
    } as never);

    void wrapped?.(
      {
        provider: "anthropic",
        api: "anthropic-messages",
        id: "claude-opus-5",
      } as never,
      {} as never,
      { apiKey: "sk-ant-api03-test-key" } as never,
    );

    expect(captured.headers).toBeUndefined();
    expect(captured.payload).toEqual({});
  });
});

describe("createAnthropicThinkingPrefillWrapper", () => {
  function runThinkingPrefillWrapper(payload: Record<string, unknown>): Record<string, unknown> {
    const wrapper = wrapAnthropicProviderStream({
      streamFn: ((_model, _context, options) => {
        options?.onPayload?.(payload as never, {} as never);
        return {} as never;
      }) as StreamFn,
      modelId: "claude-sonnet-4-6",
      extraParams: {},
    } as never);
    void wrapper?.({ provider: "anthropic", api: "anthropic-messages" } as never, {} as never, {});
    return payload;
  }

  it("removes trailing assistant prefill when extended thinking is enabled", () => {
    const payload = runThinkingPrefillWrapper({
      thinking: { type: "enabled", budget_tokens: 1024 },
      messages: [
        { role: "user", content: "Return JSON." },
        { role: "assistant", content: "{" },
      ],
    });

    expect(payload.messages).toEqual([{ role: "user", content: "Return JSON." }]);
  });

  it("keeps assistant prefill when thinking is disabled", () => {
    const payload = runThinkingPrefillWrapper({
      thinking: { type: "disabled" },
      messages: [
        { role: "user", content: "Return JSON." },
        { role: "assistant", content: "{" },
      ],
    });

    expect(payload.messages).toHaveLength(2);
  });

  it("keeps trailing assistant tool use turns", () => {
    const payload = runThinkingPrefillWrapper({
      thinking: { type: "adaptive" },
      messages: [
        { role: "user", content: "Read a file." },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read" }] },
      ],
    });

    expect(payload.messages).toHaveLength(2);
  });
});

type ServiceTierWrapperParams = {
  apiKey?: string;
  provider?: string;
  api?: string;
  enabled?: boolean;
  serviceTier?: "auto" | "standard_only";
};

const serviceTierWrapperCases: Array<{
  name: string;
  run: (params: ServiceTierWrapperParams) => Record<string, unknown> | undefined;
}> = [
  {
    name: "fast mode",
    run: (params) =>
      runPayloadWrapper(params, (base) =>
        createAnthropicFastModeWrapper(base, params.enabled ?? true),
      ),
  },
  {
    name: "explicit service tier",
    run: (params) =>
      runPayloadWrapper(params, (base) =>
        createAnthropicServiceTierWrapper(base, params.serviceTier ?? "auto"),
      ),
  },
];

describe("Anthropic service_tier payload wrappers", () => {
  it.each(serviceTierWrapperCases)("$name skips service_tier for OAuth token", ({ run }) => {
    const payload = run({ apiKey: "sk-ant-oat01-test-token" });
    expect(payload?.service_tier).toBeUndefined();
  });

  it.each(serviceTierWrapperCases)("$name injects service_tier for regular API keys", ({ run }) => {
    const payload = run({ apiKey: "sk-ant-api03-test-key" });
    expect(payload?.service_tier).toBe("auto");
  });

  it.each(serviceTierWrapperCases)(
    "$name does not inject service_tier for non-anthropic provider",
    ({ run }) => {
      const payload = run({
        apiKey: "sk-ant-api03-test-key",
        provider: "openai",
        api: "openai-completions",
      });
      expect(payload?.service_tier).toBeUndefined();
    },
  );

  it("fast mode injects service_tier=standard_only when disabled for API keys", () => {
    const payload = expectDefined(serviceTierWrapperCases[0], "disabled fast-mode case").run({
      apiKey: "sk-ant-api03-test-key",
      enabled: false,
    });
    expect(payload?.service_tier).toBe("standard_only");
  });

  it("fast mode resolves dynamic service_tier for each stream call", () => {
    let enabled = true;
    const first = runPayloadWrapper({ apiKey: "sk-ant-api03-test-key" }, (base) =>
      createAnthropicFastModeWrapper(base, () => enabled),
    );
    enabled = false;
    const second = runPayloadWrapper({ apiKey: "sk-ant-api03-test-key" }, (base) =>
      createAnthropicFastModeWrapper(base, () => enabled),
    );
    expect(first?.service_tier).toBe("auto");
    expect(second?.service_tier).toBe("standard_only");
  });

  it("explicit service tier injects service_tier=standard_only for regular API keys", () => {
    const payload = expectDefined(serviceTierWrapperCases[1], "explicit service-tier case").run({
      apiKey: "sk-ant-api03-test-key",
      serviceTier: "standard_only",
    });
    expect(payload?.service_tier).toBe("standard_only");
  });
});
