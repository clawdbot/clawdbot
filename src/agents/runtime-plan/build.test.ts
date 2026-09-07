// Runtime plan build tests cover the assembled agent runtime policy object:
// auth, transport, tools, prompt, delivery, transcript, and observability.
import { createParameterFreeTool } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetConfigRuntimeState } from "../../config/config.js";
import {
  resolveProviderFollowupFallbackRoute,
  resolveProviderRuntimePluginHandle,
  type ProviderRuntimePluginHandle,
} from "../../plugins/provider-hook-runtime.js";
import { buildAgentRuntimeDeliveryPlan, buildAgentRuntimePlan } from "./build.js";

const resolveProviderIdForAuth = vi.hoisted(() => vi.fn((provider: string) => provider));

vi.mock("../provider-auth-aliases.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../provider-auth-aliases.js")>()),
  resolveProviderIdForAuth,
}));

vi.mock("../../plugins/provider-hook-runtime.js", () => ({
  clearProviderRuntimePluginCacheForTest: vi.fn(),
  testing: {
    clearProviderRuntimePluginCacheForTest: vi.fn(),
  },
  ensureProviderRuntimePluginHandle: vi.fn(
    (params) => params.runtimeHandle ?? { provider: "openai" },
  ),
  getModelProviderRuntimePluginHandle: () => undefined,
  resolveProviderAuthProfileId: vi.fn(() => undefined),
  resolveProviderFollowupFallbackRoute: vi.fn(() => undefined),
  resolveProviderPluginsForHooks: vi.fn(() => []),
  resolveProviderRuntimePlugin: vi.fn(() => undefined),
  resolveProviderRuntimePluginHandle: vi.fn(() => ({ provider: "openai" })),
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
  });

  it("defers default transport extra params until they are read", () => {
    // Extra params are lazy so plan construction stays cheap and provider hooks
    // only run if a transport path actually needs them.
    const prepareProviderExtraParamsMock = vi.fn(() => undefined);
    const providerRuntimeHandle = {
      provider: "openai",
      modelId: gpt54Model.id,
      workspaceDir: "/tmp/openclaw-runtime-plan",
      prepared: true,
      plugin: {
        id: "openai",
        label: "OpenAI",
        auth: [],
        prepareExtraParams: prepareProviderExtraParamsMock,
      },
    } satisfies ProviderRuntimePluginHandle & { modelId: string; prepared: true };
    const plan = buildAgentRuntimePlan({
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      config: {},
      workspaceDir: "/tmp/openclaw-runtime-plan",
      model: gpt54Model,
      providerRuntimeHandle,
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

  it("keeps prepared extra params within their provider generation and attempt", () => {
    const config = { agents: { defaults: { params: { temperature: 0.1 } } } };
    const buildPlan = (owner: string) => {
      const providerRuntimeHandle = {
        provider: "fixture-provider",
        modelId: "fixture-model",
        prepared: true,
        plugin: {
          id: "fixture-provider",
          label: "Fixture",
          auth: [],
          prepareExtraParams: ({ extraParams }) => ({ ...extraParams, owner }),
        },
      } satisfies ProviderRuntimePluginHandle & { modelId: string; prepared: true };
      return buildAgentRuntimePlan({
        config,
        provider: "fixture-provider",
        modelId: "fixture-model",
        providerRuntimeHandle,
      });
    };
    const first = buildPlan("first");
    expect(first.transport.extraParams).toEqual({ temperature: 0.1, owner: "first" });
    const replacement = buildPlan("replacement");
    expect(replacement.transport.extraParams).toEqual({ temperature: 0.1, owner: "replacement" });
    config.agents.defaults.params.temperature = 0.7;
    const updated = buildPlan("updated");
    expect(updated.transport.extraParams).toEqual({ temperature: 0.7, owner: "updated" });
    expect(first.transport.extraParams).toEqual({ temperature: 0.1, owner: "first" });
  });

  it("records resolved model, auth, transport, tool, delivery, and observability policy", () => {
    // This is the broad contract snapshot for the runtime plan facade; callers
    // read these nested policies instead of recomputing runtime decisions.
    const plan = buildAgentRuntimePlan({
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      harnessId: "codex",
      harnessRuntime: "codex",
      authProfileProvider: "openai",
      sessionAuthProfileId: "openai:work",
      config: {},
      workspaceDir: "/tmp/openclaw-runtime-plan",
      model: {
        ...gpt54Model,
        baseUrl: "https://api.openai.com/v1",
      },
    });

    expect(plan.auth.providerForAuth).toBe("openai");
    expect(plan.auth.authProfileProviderForAuth).toBe("openai");
    expect(plan.auth.harnessAuthProvider).toBe("openai");
    expect(plan.auth.forwardedAuthProfileId).toBe("openai:work");
    expect(plan.delivery.isSilentPayload({ text: "NO_REPLY\n\nNO_REPLY" })).toBe(true);
    expect(plan.delivery.isSilentPayload({ text: '{"action":"NO_REPLY"}' })).toBe(true);
    expect(
      plan.delivery.isSilentPayload({
        text: '{"action":"NO_REPLY"}',
        mediaUrl: "file:///tmp/image.png",
      }),
    ).toBe(false);
    expect(
      plan.delivery.isSilentPayload({
        text: '{"action":"NO_REPLY"}',
        presentation: {
          blocks: [{ type: "buttons", buttons: [{ label: "Open", value: "open" }] }],
        },
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
    expect(plan.auth.harnessAuthProvider).toBe("openai");
    expect(plan.auth.forwardedAuthProfileId).toBe("openai:work");
  });

  it("carries forwarded Codex harness auth candidates", () => {
    const plan = buildAgentRuntimePlan({
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      harnessId: "codex",
      harnessRuntime: "codex",
      authProfileProvider: "openai",
      authProfileMode: "oauth",
      sessionAuthProfileId: "openai:work",
      sessionAuthProfileCandidateIds: ["openai:work", "openai:backup"],
      config: {},
      workspaceDir: "/tmp/openclaw-runtime-plan",
    });

    expect(plan.auth.forwardedAuthProfileId).toBe("openai:work");
    expect(plan.auth.forwardedAuthProfileCandidateIds).toEqual(["openai:work", "openai:backup"]);
  });

  it("forwards OpenAI OAuth profiles into the Codex harness auth slot", () => {
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

    expect(plan.auth.forwardedAuthProfileId).toBe("openai:work");
  });

  it("forwards OpenAI Codex profiles for explicit OpenAI OpenClaw runs", () => {
    const plan = buildAgentRuntimePlan({
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      harnessId: "openclaw",
      harnessRuntime: "openclaw",
      authProfileProvider: "openai",
      sessionAuthProfileId: "openai:work",
      config: {},
      workspaceDir: "/tmp/openclaw-runtime-plan",
    });

    expect(plan.auth.providerForAuth).toBe("openai");
    expect(plan.auth.authProfileProviderForAuth).toBe("openai");
    expect(plan.auth.forwardedAuthProfileId).toBe("openai:work");
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
    const providerRuntimeHandle: ProviderRuntimePluginHandle & {
      modelId: string;
      prepared: true;
    } = {
      provider: "openai",
      modelId: "gpt-5.4",
      prepared: true,
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

  it("reuses the provider handle prepared before plan construction", () => {
    const resolveProviderFollowupFallbackRouteMock = vi.mocked(
      resolveProviderFollowupFallbackRoute,
    );
    resolveProviderFollowupFallbackRouteMock.mockClear();

    const suppliedHandle: ProviderRuntimePluginHandle & { modelId: string; prepared: true } = {
      provider: "openai",
      modelId: "gpt-5.4",
      prepared: true,
      config: { plugins: { allow: ["openai"] } },
      workspaceDir: "/tmp/openclaw-runtime-plan",
      env: process.env,
      plugin: {} as never,
    };

    const plan = buildAgentRuntimePlan({
      provider: "openai",
      modelId: "gpt-5.4",
      config: {},
      workspaceDir: "/tmp/openclaw-runtime-plan",
      providerRuntimeHandle: suppliedHandle,
    });

    expect(plan.providerRuntimeHandle).toBe(suppliedHandle);

    plan.delivery.resolveFollowupRoute({
      payload: { text: "hello" },
      originRoutable: false,
      dispatcherAvailable: true,
    });

    const followupCall = latestFollowupRouteCall();
    expect(followupCall.runtimeHandle).toBe(suppliedHandle);
  });

  it("reuses a delivery-only provider handle", () => {
    const resolveProviderFollowupFallbackRouteMock = vi.mocked(
      resolveProviderFollowupFallbackRoute,
    );
    resolveProviderFollowupFallbackRouteMock.mockClear();

    const suppliedHandle: ProviderRuntimePluginHandle & { modelId: string; prepared: true } = {
      provider: "openai",
      modelId: "gpt-5.4",
      prepared: true,
      workspaceDir: "/tmp/openclaw-runtime-plan",
      env: process.env,
      plugin: {} as never,
    };

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

    const followupCall = latestFollowupRouteCall();
    expect(followupCall.runtimeHandle).toBe(suppliedHandle);
  });

  it("threads prepared tool metadata without discovery", () => {
    const metadataSnapshot = { plugins: [] };
    vi.mocked(resolveProviderRuntimePluginHandle).mockClear();
    resolveProviderIdForAuth.mockClear();
    const plan = buildAgentRuntimePlan({
      provider: "openai",
      modelId: "gpt-5.4",
      metadataSnapshot,
    });

    expect(plan.tools.preparedPlanning?.metadataSnapshot).toBe(metadataSnapshot);
    expect(resolveProviderRuntimePluginHandle).toHaveBeenCalledWith(
      expect.objectContaining({ pluginMetadataSnapshot: metadataSnapshot }),
    );
    expect(resolveProviderIdForAuth).toHaveBeenCalledWith(
      "openai",
      expect.objectContaining({ metadataSnapshot }),
    );
  });
});
