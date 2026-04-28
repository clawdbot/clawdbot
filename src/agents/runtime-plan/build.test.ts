import { createParameterFreeTool } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { describe, expect, it, vi } from "vitest";
import { buildAgentRuntimePlan } from "./build.js";

vi.mock("../../plugins/provider-hook-runtime.js", () => ({
  __testing: {},
  clearProviderRuntimeHookCache: vi.fn(),
  prepareProviderExtraParams: vi.fn(() => undefined),
  resetProviderRuntimeHookCacheForTest: vi.fn(),
  resolveProviderAuthProfileId: vi.fn(() => undefined),
  resolveProviderExtraParamsForTransport: vi.fn(() => undefined),
  resolveProviderFollowupFallbackRoute: vi.fn(() => undefined),
  resolveProviderHookPlugin: vi.fn(() => undefined),
  resolveProviderPluginsForHooks: vi.fn(() => []),
  resolveProviderRuntimePlugin: vi.fn(() => undefined),
  wrapProviderStreamFn: vi.fn(() => undefined),
}));

describe("AgentRuntimePlan", () => {
  it("records resolved model, auth, transport, tool, delivery, and observability policy", () => {
    const plan = buildAgentRuntimePlan({
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      harnessId: "codex",
      harnessRuntime: "codex",
      authProfileProvider: "openai-codex",
      sessionAuthProfileId: "openai-codex:work",
      config: {},
      workspaceDir: "/tmp/openclaw-runtime-plan",
      model: {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8_192,
      },
    });

    expect(plan.auth).toMatchObject({
      providerForAuth: "openai",
      authProfileProviderForAuth: "openai-codex",
      harnessAuthProvider: "openai-codex",
      forwardedAuthProfileId: "openai-codex:work",
    });
    expect(plan.delivery.isSilentPayload({ text: '{"action":"NO_REPLY"}' })).toBe(true);
    expect(
      plan.delivery.isSilentPayload({
        text: '{"action":"NO_REPLY"}',
        mediaUrl: "file:///tmp/image.png",
      }),
    ).toBe(false);
    expect(plan.transport.extraParams).toMatchObject({
      parallel_tool_calls: true,
      text_verbosity: "low",
      openaiWsWarmup: false,
    });
    expect(
      plan.transport.resolveExtraParams({
        extraParamsOverride: { parallel_tool_calls: false },
        resolvedTransport: "websocket",
      }),
    ).toMatchObject({
      parallel_tool_calls: false,
      text_verbosity: "low",
      openaiWsWarmup: false,
    });
    expect(
      plan.prompt.resolveSystemPromptContribution({
        provider: "openai",
        modelId: "gpt-5.4",
        promptMode: "full",
      })?.stablePrefix,
    ).toContain("<persona_latch>");
    expect(plan.transcript.resolvePolicy()).toEqual(plan.transcript.policy);
    expect(
      plan.outcome.classifyRunResult({
        provider: "openai",
        model: "gpt-4.1",
        result: {},
      }),
    ).toBeNull();
    expect(plan.observability.resolvedRef).toBe("openai/gpt-5.4");
    expect(plan.observability.harnessId).toBe("codex");
  });

  it("keeps OpenClaw-owned tool-schema normalization reachable from the plan", () => {
    const plan = buildAgentRuntimePlan({
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      config: {},
      workspaceDir: "/tmp/openclaw-runtime-plan",
      model: {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8_192,
      },
    });

    const normalized = plan.tools.normalize([createParameterFreeTool()] as never);

    expect(normalized).toHaveLength(1);
    expect(normalized[0]?.name).toBe("ping");
    expect(normalized[0]?.parameters).toBeTypeOf("object");
  });
});
