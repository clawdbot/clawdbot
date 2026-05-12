import { createParameterFreeTool } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  resolveProviderRuntimePluginHandle,
  prepareProviderExtraParams,
  resolveProviderFollowupFallbackRoute,
  type ProviderRuntimePluginHandle,
} from "../../plugins/provider-hook-runtime.js";
import { buildAgentRuntimeDeliveryPlan, buildAgentRuntimePlan } from "./build.js";

const manifestMocks = vi.hoisted(() => ({
  loadManifestMetadataSnapshot: vi.fn(() => ({}) as never),
}));

vi.mock("../../plugins/manifest-contract-eligibility.js", () => ({
  loadManifestMetadataSnapshot: manifestMocks.loadManifestMetadataSnapshot,
}));

vi.mock("../../plugins/provider-hook-runtime.js", () => ({
  __testing: {},
  ensureProviderRuntimePluginHandle: vi.fn(
    (params) => params.runtimeHandle ?? { provider: "openai" },
  ),
  prepareProviderExtraParams: vi.fn(() => undefined),
  resolveProviderAuthProfileId: vi.fn(() => undefined),
  resolveProviderExtraParamsForTransport: vi.fn(() => undefined),
  resolveProviderFollowupFallbackRoute: vi.fn(() => undefined),
  resolveProviderPluginsForHooks: vi.fn(() => []),
  resolveProviderRuntimePlugin: vi.fn(() => undefined),
  resolveProviderRuntimePluginHandle: vi.fn(() => ({ provider: "openai" })),
  wrapProviderStreamFn: vi.fn(() => undefined),
}));

const gpt54Model = {
  id: "gpt-5.4",
  name: "GPT-5.4",
  api: "openai-responses",
  provider: "openai",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_192,
} as const;

function expectExtraParams(
  extraParams: Record<string, unknown> | undefined,
  expected: {
    parallelToolCalls: boolean;
    textVerbosity: string;
  },
): void {
  expect(extraParams?.parallel_tool_calls).toBe(expected.parallelToolCalls);
  expect(extraParams?.text_verbosity).toBe(expected.textVerbosity);
}

function latestFollowupRouteCall(): {
  provider?: unknown;
  runtimeHandle?: Record<string, unknown>;
  context?: Record<string, unknown>;
} {
  const call = vi.mocked(resolveProviderFollowupFallbackRoute).mock.calls.at(-1)?.[0];
  if (!call || typeof call !== "object") {
    throw new Error("expected follow-up route call");
  }
  const record = call as {
    provider?: unknown;
    runtimeHandle?: unknown;
    context?: unknown;
  };
  return {
    provider: record.provider,
    runtimeHandle:
      record.runtimeHandle && typeof record.runtimeHandle === "object"
        ? (record.runtimeHandle as Record<string, unknown>)
        : undefined,
    context:
      record.context && typeof record.context === "object"
        ? (record.context as Record<string, unknown>)
        : undefined,
  };
}

describe("AgentRuntimePlan", () => {
  afterEach(() => {
    resetConfigRuntimeState();
    manifestMocks.loadManifestMetadataSnapshot.mockClear();
    vi.mocked(resolveProviderRuntimePluginHandle).mockClear();
  });

  it("defers default transport extra params until they are read", () => {
    const prepareProviderExtraParamsMock = vi.mocked(prepareProviderExtraParams);
    prepareProviderExtraParamsMock.mockClear();

    const plan = buildAgentRuntimePlan({
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      config: {},
      workspaceDir: "/tmp/openclaw-runtime-plan",
      model: gpt54Model,
    });

    expect(prepareProviderExtraParamsMock).not.toHaveBeenCalled();
    expectExtraParams(plan.transport.extraParams, {
      parallelToolCalls: true,
      textVerbosity: "low",
    });
    expect(prepareProviderExtraParamsMock).toHaveBeenCalledTimes(1);
    void plan.transport.extraParams;
    expect(prepareProviderExtraParamsMock).toHaveBeenCalledTimes(1);
  });

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
        ...gpt54Model,
        baseUrl: "https://api.openai.com/v1",
      },
    });

    expect(plan.auth.providerForAuth).toBe("openai");
    expect(plan.auth.authProfileProviderForAuth).toBe("openai-codex");
    expect(plan.auth.harnessAuthProvider).toBe("openai-codex");
    expect(plan.auth.forwardedAuthProfileId).toBe("openai-codex:work");
    expect(plan.delivery.isSilentPayload({ text: '{"action":"NO_REPLY"}' })).toBe(true);
    expect(
      plan.delivery.isSilentPayload({
        text: '{"action":"NO_REPLY"}',
        mediaUrl: "file:///tmp/image.png",
      }),
    ).toBe(false);
    expectExtraParams(plan.transport.extraParams, {
      parallelToolCalls: true,
      textVerbosity: "low",
    });
    const resolvedExtraParams = plan.transport.resolveExtraParams({
      extraParamsOverride: { parallel_tool_calls: false },
      resolvedTransport: "websocket",
    });
    expectExtraParams(resolvedExtraParams, {
      parallelToolCalls: false,
      textVerbosity: "low",
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
        ...gpt54Model,
        baseUrl: "https://api.openai.com/v1",
      },
    });

    const normalized = plan.tools.normalize([createParameterFreeTool()] as never);

    expect(normalized).toHaveLength(1);
    expect(normalized[0]?.name).toBe("ping");
    expect(normalized[0]?.parameters).toStrictEqual({});
  });

  it("forwards OpenAI API-key backup profiles into the Codex harness auth slot", () => {
    const plan = buildAgentRuntimePlan({
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      harnessId: "codex",
      harnessRuntime: "codex",
      authProfileProvider: "openai",
      authProfileMode: "api_key",
      sessionAuthProfileId: "openai:work",
      config: {},
      workspaceDir: "/tmp/openclaw-runtime-plan",
    });

    expect(plan.auth.providerForAuth).toBe("openai");
    expect(plan.auth.authProfileProviderForAuth).toBe("openai");
    expect(plan.auth.harnessAuthProvider).toBe("openai-codex");
    expect(plan.auth.forwardedAuthProfileId).toBe("openai:work");
  });

  it("carries forwarded Codex harness auth candidates", () => {
    const plan = buildAgentRuntimePlan({
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      harnessId: "codex",
      harnessRuntime: "codex",
      authProfileProvider: "openai-codex",
      authProfileMode: "oauth",
      sessionAuthProfileId: "openai-codex:work",
      sessionAuthProfileCandidateIds: ["openai-codex:work", "openai:backup"],
      config: {},
      workspaceDir: "/tmp/openclaw-runtime-plan",
    });

    expect(plan.auth.forwardedAuthProfileId).toBe("openai-codex:work");
    expect(plan.auth.forwardedAuthProfileCandidateIds).toEqual([
      "openai-codex:work",
      "openai:backup",
    ]);
  });

  it("does not forward non-api-key OpenAI profiles into the Codex harness auth slot", () => {
    const plan = buildAgentRuntimePlan({
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      harnessId: "codex",
      harnessRuntime: "codex",
      authProfileProvider: "openai",
      authProfileMode: "oauth",
      sessionAuthProfileId: "openai:work",
      config: {},
      workspaceDir: "/tmp/openclaw-runtime-plan",
    });

    expect(plan.auth.forwardedAuthProfileId).toBeUndefined();
  });

  it("forwards OpenAI Codex profiles for explicit OpenAI PI runs", () => {
    const plan = buildAgentRuntimePlan({
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      harnessId: "pi",
      harnessRuntime: "pi",
      authProfileProvider: "openai-codex",
      sessionAuthProfileId: "openai-codex:work",
      config: {},
      workspaceDir: "/tmp/openclaw-runtime-plan",
    });

    expect(plan.auth.providerForAuth).toBe("openai");
    expect(plan.auth.authProfileProviderForAuth).toBe("openai-codex");
    expect(plan.auth.forwardedAuthProfileId).toBe("openai-codex:work");
  });

  it("resolves follow-up routes with the prepared provider handle", () => {
    const resolveProviderFollowupFallbackRouteMock = vi.mocked(
      resolveProviderFollowupFallbackRoute,
    );
    resolveProviderFollowupFallbackRouteMock.mockClear();
    resolveProviderFollowupFallbackRouteMock.mockReturnValueOnce({
      route: "dispatcher" as const,
      reason: "prepared-route",
    });
    const providerRuntimeHandle: ProviderRuntimePluginHandle = {
      provider: "openai",
    };

    const plan = buildAgentRuntimePlan({
      provider: "openai",
      modelId: "gpt-5.4",
      config: {},
      workspaceDir: "/tmp/openclaw-runtime-plan",
      providerRuntimeHandle,
    });

    expect(
      plan.delivery.resolveFollowupRoute({
        payload: { text: "hello" },
        originRoutable: false,
        dispatcherAvailable: true,
      }),
    ).toEqual({
      route: "dispatcher",
      reason: "prepared-route",
    });
    const followupCall = latestFollowupRouteCall();
    expect(followupCall.provider).toBe("openai");
    expect(followupCall.runtimeHandle?.provider).toBe(providerRuntimeHandle.provider);
    expect(followupCall.context?.provider).toBe("openai");
    expect(followupCall.context?.modelId).toBe("gpt-5.4");
    expect(followupCall.context?.originRoutable).toBe(false);
    expect(followupCall.context?.dispatcherAvailable).toBe(true);
  });

  it("resolves incomplete supplied provider handles before invoking runtime hooks", () => {
    const resolveProviderRuntimePluginHandleMock = vi.mocked(resolveProviderRuntimePluginHandle);
    const resolveProviderFollowupFallbackRouteMock = vi.mocked(
      resolveProviderFollowupFallbackRoute,
    );
    resolveProviderRuntimePluginHandleMock.mockClear();
    resolveProviderFollowupFallbackRouteMock.mockClear();

    const suppliedHandle = {
      provider: "openai",
      config: { plugins: { allow: ["openai"] } },
    };
    const resolvedHandle: ProviderRuntimePluginHandle = {
      ...suppliedHandle,
      workspaceDir: "/tmp/openclaw-runtime-plan",
      env: process.env,
      plugin: {} as never,
    };

    resolveProviderRuntimePluginHandleMock.mockReturnValueOnce(resolvedHandle);

    const plan = buildAgentRuntimePlan({
      provider: "openai",
      modelId: "gpt-5.4",
      config: {},
      workspaceDir: "/tmp/openclaw-runtime-plan",
      providerRuntimeHandle: suppliedHandle,
    });

    expect(plan.providerRuntimeHandle).toBe(resolvedHandle);

    plan.delivery.resolveFollowupRoute({
      payload: { text: "hello" },
      originRoutable: false,
      dispatcherAvailable: true,
    });

    expect(resolveProviderRuntimePluginHandleMock).toHaveBeenCalledWith({
      provider: "openai",
      config: suppliedHandle.config,
      workspaceDir: "/tmp/openclaw-runtime-plan",
      env: process.env,
      applyAutoEnable: undefined,
      bundledProviderAllowlistCompat: undefined,
      bundledProviderVitestCompat: undefined,
    });
    const followupCall = latestFollowupRouteCall();
    expect(followupCall.runtimeHandle).toBe(resolvedHandle);
  });

  it("resolves incomplete supplied delivery handles before follow-up routing", () => {
    const resolveProviderRuntimePluginHandleMock = vi.mocked(resolveProviderRuntimePluginHandle);
    const resolveProviderFollowupFallbackRouteMock = vi.mocked(
      resolveProviderFollowupFallbackRoute,
    );
    resolveProviderRuntimePluginHandleMock.mockClear();
    resolveProviderFollowupFallbackRouteMock.mockClear();

    const suppliedHandle = {
      provider: "openai",
    };
    const resolvedHandle: ProviderRuntimePluginHandle = {
      provider: "openai",
      workspaceDir: "/tmp/openclaw-runtime-plan",
      env: process.env,
      plugin: {} as never,
    };

    resolveProviderRuntimePluginHandleMock.mockReturnValueOnce(resolvedHandle);

    const delivery = buildAgentRuntimeDeliveryPlan({
      provider: "openai",
      modelId: "gpt-5.4",
      config: {},
      workspaceDir: "/tmp/openclaw-runtime-plan",
      providerRuntimeHandle: suppliedHandle,
    });

    delivery.resolveFollowupRoute({
      payload: { text: "hello" },
      originRoutable: false,
      dispatcherAvailable: true,
    });

    expect(resolveProviderRuntimePluginHandleMock).toHaveBeenCalledWith({
      provider: "openai",
      config: {},
      workspaceDir: "/tmp/openclaw-runtime-plan",
      env: process.env,
      applyAutoEnable: undefined,
      bundledProviderAllowlistCompat: undefined,
      bundledProviderVitestCompat: undefined,
    });
    const followupCall = latestFollowupRouteCall();
    expect(followupCall.runtimeHandle).toBe(resolvedHandle);
  });

  it("plans tool metadata against the runtime source snapshot lazily", () => {
    const sourceConfig = { channels: { telegram: { botToken: "token" } } };
    const runtimeConfig = {
      ...sourceConfig,
      plugins: { allow: ["telegram"] },
    };
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

    const plan = buildAgentRuntimePlan({
      provider: "openai",
      modelId: "gpt-5.4",
      config: runtimeConfig,
      workspaceDir: "/tmp/openclaw-runtime-plan",
    });

    expect(manifestMocks.loadManifestMetadataSnapshot).not.toHaveBeenCalled();

    plan.tools.preparedPlanning?.loadMetadataSnapshot?.();

    expect(manifestMocks.loadManifestMetadataSnapshot).toHaveBeenCalledWith({
      config: sourceConfig,
      workspaceDir: "/tmp/openclaw-runtime-plan",
      env: process.env,
    });
  });
});
