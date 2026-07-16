// Anthropic tests cover stream wrappers plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
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
}): StreamFn {
  return (model, _context, options) => {
    captured.headers = options?.headers;
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

  it("skips unsupported service_tier for Claude Sonnet 5", () => {
    const captured = runComposedAnthropicProviderStream("sk-ant-api-123", "claude-sonnet-5");
    expect(captured.payload?.service_tier).toBeUndefined();
  });

  it("composes the anthropic provider stream chain from extra params", () => {
    const captured = runComposedAnthropicProviderStream("sk-ant-api-123");
    expect(captured.headers?.["anthropic-beta"]).not.toContain(CONTEXT_1M_BETA);
    expect(captured.payload).toMatchObject({ service_tier: "auto" });
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
