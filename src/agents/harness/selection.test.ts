// Covers agent harness selection, fallback behavior, and compaction routing.
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../context-engine/host-compat.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { createOpenClawCodingTools } from "../../plugin-sdk/agent-harness.js";
import { mintSecretSentinel } from "../../secrets/sentinel.js";
import { isHostScopedAgentToolActive } from "../agent-tools.ring-zero-context.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "../embedded-agent-runner/run/types.js";
import type { SystemAgentToolOptions } from "../tools/system-agent-tool.js";
import { maybeCompactAgentHarnessSession } from "./compaction.js";
import { clearAgentHarnesses, registerAgentHarness } from "./registry.js";
import {
  agentHarnessBuildsOpenClawTools,
  agentHarnessExposesOpenClawTools,
  resolveAgentHarnessPolicy,
  resolveAvailableAgentHarnessPolicy,
  resolvePluginHarnessPolicyToolsAllow,
  runAgentHarnessAttempt,
  runAgentHarnessSettledTurnFinalization,
  selectAgentHarness,
  selectAgentHarnessForPreparedModelProviders,
} from "./selection.js";
import {
  buildAgentHarnessSupportContext,
  resolveAgentHarnessPreparedAuthSupport,
  resolveAgentHarnessPreparedRouteSupport,
} from "./support.js";
import type {
  AgentHarness,
  AgentHarnessCompactParams,
  AgentHarnessCompactResult,
} from "./types.js";

const agentRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () =>
  createAttemptResult("openclaw"),
);
const compactAuthMocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
  ensureAuthProfileStoreWithoutExternalProfiles: vi.fn(),
  getApiKeyForModel: vi.fn(),
  resolveModelAsync: vi.fn(),
}));
const providerOwnerMocks = vi.hoisted(() => ({
  resolveProviderRefOwnership: vi.fn(),
}));

it("identifies harnesses that expose OpenClaw tools", () => {
  expect(agentHarnessBuildsOpenClawTools("openclaw")).toBe(false);
  expect(agentHarnessBuildsOpenClawTools("codex")).toBe(true);
  expect(agentHarnessBuildsOpenClawTools("copilot")).toBe(true);
  expect(agentHarnessBuildsOpenClawTools("custom")).toBe(false);
  expect(agentHarnessExposesOpenClawTools("openclaw")).toBe(true);
  expect(agentHarnessExposesOpenClawTools("codex")).toBe(true);
  expect(agentHarnessExposesOpenClawTools("copilot")).toBe(true);
  expect(agentHarnessExposesOpenClawTools("custom")).toBe(false);
});

vi.mock("./builtin-openclaw.js", () => ({
  createOpenClawAgentHarness: (): AgentHarness => ({
    id: "openclaw",
    label: "OpenClaw embedded agent",
    contextEngineHostCapabilities: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST.capabilities,
    supports: () => ({ supported: true, priority: 0 }),
    runAttempt: agentRunAttempt,
  }),
}));
vi.mock("../model-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../model-auth.js")>()),
  applySecretRefHeaderSentinels: (model: unknown) => model,
  ensureAuthProfileStore: compactAuthMocks.ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles:
    compactAuthMocks.ensureAuthProfileStoreWithoutExternalProfiles,
  getApiKeyForModel: compactAuthMocks.getApiKeyForModel,
}));
vi.mock("../embedded-agent-runner/model.js", () => ({
  resolveModelAsync: compactAuthMocks.resolveModelAsync,
}));
vi.mock("../../plugins/providers.js", () => ({
  resolveProviderRefOwnership: providerOwnerMocks.resolveProviderRefOwnership,
}));

const originalRuntime = process.env.OPENCLAW_AGENT_RUNTIME;

beforeEach(() => {
  clearAgentHarnesses();
  compactAuthMocks.ensureAuthProfileStore.mockReturnValue({ version: 1, profiles: {} });
  compactAuthMocks.ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue({
    version: 1,
    profiles: {},
  });
  compactAuthMocks.resolveModelAsync.mockResolvedValue({
    model: { id: "gpt-5.5", provider: "openai" },
  });
  compactAuthMocks.getApiKeyForModel.mockResolvedValue({ apiKey: "test-key" });
  providerOwnerMocks.resolveProviderRefOwnership.mockReset();
  providerOwnerMocks.resolveProviderRefOwnership.mockReturnValue({ status: "unowned" });
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupRegistry: () => ({
      providers: [],
      cliBackends: [],
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [],
    }),
    resolveRuntimeCliBackends: () => [
      {
        id: "claude-cli",
        modelProvider: "anthropic",
        pluginId: "anthropic",
        config: { command: "claude" },
      },
      {
        id: "google-gemini-cli",
        modelProvider: "google",
        pluginId: "google",
        config: { command: "gemini" },
      },
    ],
  });
});

afterEach(() => {
  clearAgentHarnesses();
  cliBackendsTesting.resetDepsForTest();
  agentRunAttempt.mockClear();
  compactAuthMocks.resolveModelAsync.mockReset();
  compactAuthMocks.getApiKeyForModel.mockReset();
  compactAuthMocks.ensureAuthProfileStore.mockReset();
  compactAuthMocks.ensureAuthProfileStoreWithoutExternalProfiles.mockReset();
  providerOwnerMocks.resolveProviderRefOwnership.mockReset();
  if (originalRuntime == null) {
    delete process.env.OPENCLAW_AGENT_RUNTIME;
  } else {
    process.env.OPENCLAW_AGENT_RUNTIME = originalRuntime;
  }
});

function createAttemptParams(config?: OpenClawConfig): EmbeddedRunAttemptParams {
  return {
    prompt: "hello",
    sessionId: "session-1",
    runId: "run-1",
    sessionFile: "/tmp/session.jsonl",
    workspaceDir: "/tmp/workspace",
    timeoutMs: 5_000,
    provider: "codex",
    modelId: "gpt-5.4",
    model: { id: "gpt-5.4", provider: "codex" } as Model,
    authStorage: {} as never,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: {} as never,
    thinkLevel: "low",
    config,
  } as EmbeddedRunAttemptParams;
}

function createAttemptResult(sessionIdUsed: string): EmbeddedRunAttemptResult {
  return {
    terminal: { kind: "ok" },
    sessionIdUsed,
    messagesSnapshot: [],
    assistantTexts: [`${sessionIdUsed} ok`],
    toolMetas: [],
    lastAssistant: undefined,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
  };
}

function createFinalAssistant(): NonNullable<EmbeddedRunAttemptResult["lastAssistant"]> {
  return {
    role: "assistant",
    content: [{ type: "text", text: "final answer" }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

function createContextEngineRequiringAssembly(): ContextEngine {
  // Selection tests use this to prove fallback cannot cross into a harness
  // that lacks required context-engine host capabilities.
  return {
    info: {
      id: "lossless-claw",
      name: "Lossless",
      hostRequirements: {
        "agent-run": {
          requiredCapabilities: ["assemble-before-prompt"],
        },
      },
    },
    async ingest() {
      return { ingested: true };
    },
    async assemble({ messages }) {
      return { messages, estimatedTokens: 0 };
    },
    async compact() {
      return { ok: true, compacted: false };
    },
  };
}

function registerFailingCodexHarness(): void {
  // Forces the selected plugin runtime to throw so fallback behavior is
  // exercised through runAgentHarnessAttempt, not only selectAgentHarness.
  registerAgentHarness(
    {
      id: "codex",
      label: "Failing Codex",
      supports: (ctx) =>
        ctx.provider === "codex" ? { supported: true, priority: 100 } : { supported: false },
      runAttempt: vi.fn(async () => {
        throw new Error("codex startup failed");
      }),
    },
    { ownerPluginId: "codex" },
  );
}

function registerSuccessfulCodexHarness(): void {
  registerAgentHarness(
    {
      id: "codex",
      label: "Codex",
      supports: (ctx) =>
        ctx.provider === "codex" || ctx.provider === "openai"
          ? { supported: true, priority: 100 }
          : { supported: false },
      runAttempt: vi.fn(async () => createAttemptResult("codex")),
    },
    { ownerPluginId: "codex" },
  );
}

function groupSenderDenyAllConfig(): OpenClawConfig {
  // Mirrors Telegram sender policy shape used when selection must preserve
  // channel/group sender tool constraints across fallback attempts.
  return {
    channels: {
      telegram: {
        groups: {
          "test-deny-room": {
            toolsBySender: {
              "id:test-denied-sender": { deny: ["*"] },
            },
          },
        },
      },
    },
  } as OpenClawConfig;
}

function groupDenyAllConfig(): OpenClawConfig {
  return {
    channels: {
      telegram: {
        groups: {
          "test-deny-room": {
            tools: { deny: ["*"] },
          },
        },
      },
    },
  } as OpenClawConfig;
}

function providerRuntimeConfig(provider: string, runtime: string): OpenClawConfig {
  return {
    models: {
      providers: {
        [provider]: {
          baseUrl: "https://api.openai.com/v1",
          agentRuntime: { id: runtime },
          models: [],
        },
      },
    },
  } as OpenClawConfig;
}

function agentModelRuntimeConfig(
  modelRef: string,
  runtime: string,
  agentId?: string,
): OpenClawConfig {
  if (agentId) {
    return {
      agents: {
        list: [
          { id: "main", default: true },
          { id: agentId, models: { [modelRef]: { agentRuntime: { id: runtime } } } },
        ],
      },
    } as OpenClawConfig;
  }
  return {
    agents: {
      defaults: {
        models: {
          [modelRef]: { agentRuntime: { id: runtime } },
        },
      },
    },
  } as OpenClawConfig;
}

type CompactSessionParams = Parameters<typeof maybeCompactAgentHarnessSession>[0];

const OPENAI_PLATFORM_ROUTE = {
  provider: "openai",
  modelId: "gpt-5.5",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  authRequirement: "api-key",
  requestTransportOverrides: "none",
} as const;

const OPENAI_CHATGPT_ROUTE = {
  provider: "openai",
  modelId: "gpt-5.5",
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authRequirement: "subscription",
  requestTransportOverrides: "none",
} as const;

function createCompactionParams(
  overrides: Partial<CompactSessionParams> = {},
): CompactSessionParams {
  return {
    sessionId: "session-1",
    sessionKey: "agent:main:main",
    sessionFile: "/tmp/session.jsonl",
    workspaceDir: "/tmp/workspace",
    provider: "openai",
    model: "gpt-5.5",
    ...overrides,
  };
}

function registerTestCompactor(
  options: {
    id?: string;
    provider?: string;
    authBootstrap?: AgentHarness["authBootstrap"];
    supports?: AgentHarness["supports"];
    result?: AgentHarnessCompactResult;
  } = {},
) {
  const id = options.id ?? "codex";
  const provider = options.provider ?? "openai";
  const compact = vi.fn<NonNullable<AgentHarness["compact"]>>(
    async () => options.result ?? { ok: true, compacted: false },
  );
  registerAgentHarness(
    {
      id,
      label: id,
      supports:
        options.supports ??
        ((ctx) =>
          ctx.provider === provider ? { supported: true, priority: 100 } : { supported: false }),
      runAttempt: vi.fn(async () => createAttemptResult(id)),
      compact,
      ...(options.authBootstrap ? { authBootstrap: options.authBootstrap } : {}),
    },
    { ownerPluginId: id },
  );
  return compact;
}

describe("runAgentHarnessAttempt", () => {
  it("routes settled turns only through an explicit harness finalizer", async () => {
    const runAttempt = vi.fn<AgentHarness["runAttempt"]>(async () => createAttemptResult("run"));
    let hostAuthorityActive = true;
    const finalizeSettledTurn = vi.fn<NonNullable<AgentHarness["finalizeSettledTurn"]>>(
      async ({ attempt, settledAttempt: _settledAttempt }) => {
        hostAuthorityActive = isHostScopedAgentToolActive("openclaw");
        expect(attempt.operation).toBe("settled-tool-finalization");
        return {
          assistant: createFinalAssistant(),
        };
      },
    );
    const harness: AgentHarness = {
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: true, priority: 100 }),
      runAttempt,
      finalizeSettledTurn,
    };
    registerAgentHarness(harness, { ownerPluginId: "codex" });
    const params = createAttemptParams(providerRuntimeConfig("codex", "codex"));
    const settledAttempt = createAttemptResult("settled");

    await expect(
      runAgentHarnessSettledTurnFinalization(params, settledAttempt, harness),
    ).resolves.toMatchObject({
      assistant: { content: [{ type: "text", text: "final answer" }] },
    });
    expect(runAttempt).not.toHaveBeenCalled();
    expect(hostAuthorityActive).toBe(false);
    expect(finalizeSettledTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        settledAttempt,
        attempt: expect.objectContaining({ provider: "codex" }),
      }),
    );
  });

  it("fails closed when the selected harness has no settled-turn finalizer", async () => {
    const harness: AgentHarness = {
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: true, priority: 100 }),
      runAttempt: async () => createAttemptResult("run"),
    };
    registerAgentHarness(harness, { ownerPluginId: "codex" });

    await expect(
      runAgentHarnessSettledTurnFinalization(
        createAttemptParams(providerRuntimeConfig("codex", "codex")),
        createAttemptResult("settled"),
        harness,
      ),
    ).rejects.toThrow("Agent harness codex cannot safely finalize a settled tool turn");
  });

  it.each(["codex", "copilot"] as const)(
    "binds the host OpenClaw tool to the %s SDK construction path without leaking authority",
    async (harnessId) => {
      let receivedPrivateAuthority = true;
      let hostScopeActive = false;
      let toolNames: string[] = [];
      const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async (attemptParams) => {
        receivedPrivateAuthority = "systemAgentTool" in attemptParams;
        await Promise.resolve();
        hostScopeActive = isHostScopedAgentToolActive("openclaw");
        toolNames = createOpenClawCodingTools({
          config: { tools: { allow: ["read"], deny: ["openclaw"], toolSearch: true } },
          runtimeToolAllowlist: ["openclaw"],
          toolConstructionPlan: {
            includeBaseCodingTools: false,
            includeShellTools: false,
            includeChannelTools: false,
            includeOpenClawTools: true,
            includePluginTools: false,
          },
        }).map((tool) => tool.name);
        return createAttemptResult(harnessId);
      });
      registerAgentHarness(
        {
          id: harnessId,
          label: harnessId,
          supports: () => ({ supported: true, priority: 100 }),
          runAttempt: pluginRunAttempt,
        },
        { ownerPluginId: harnessId },
      );
      const params = createAttemptParams(
        providerRuntimeConfig("codex", harnessId),
      ) as EmbeddedRunAttemptParams & { systemAgentTool?: SystemAgentToolOptions };
      params.toolsAllow = ["openclaw"];
      params.systemAgentTool = { surface: "cli", proposalRef: {}, directiveRef: {} };

      await runAgentHarnessAttempt(params);

      expect(pluginRunAttempt).toHaveBeenCalledTimes(1);
      expect(receivedPrivateAuthority).toBe(false);
      expect(hostScopeActive).toBe(true);
      expect(toolNames).toEqual(["openclaw"]);
      expect(isHostScopedAgentToolActive("openclaw")).toBe(false);
    },
  );

  it.each([
    { name: "missing", toolsAllow: undefined },
    { name: "broad", toolsAllow: ["openclaw", "read"] },
  ])("rejects $name allowlists for private OpenClaw authority", async ({ toolsAllow }) => {
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () =>
      createAttemptResult("codex"),
    );
    registerAgentHarness(
      {
        id: "codex",
        label: "Codex",
        supports: () => ({ supported: true, priority: 100 }),
        runAttempt: pluginRunAttempt,
      },
      { ownerPluginId: "codex" },
    );
    const params = createAttemptParams(
      providerRuntimeConfig("codex", "codex"),
    ) as EmbeddedRunAttemptParams & { systemAgentTool?: SystemAgentToolOptions };
    params.toolsAllow = toolsAllow;
    params.systemAgentTool = { surface: "cli", proposalRef: {}, directiveRef: {} };

    await expect(runAgentHarnessAttempt(params)).rejects.toThrow(
      'OpenClaw host authority requires toolsAllow: ["openclaw"]',
    );
    expect(pluginRunAttempt).not.toHaveBeenCalled();
    expect(isHostScopedAgentToolActive("openclaw")).toBe(false);
  });

  it("keeps the host OpenClaw allowlist across global, agent, and sandbox deny-all policy", async () => {
    const received: Array<{
      toolsAllow: string[] | undefined;
      extraSystemPrompt: string | undefined;
      hostScopeActive: boolean;
    }> = [];
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async (attemptParams) => {
      received.push({
        toolsAllow: attemptParams.toolsAllow,
        extraSystemPrompt: attemptParams.extraSystemPrompt,
        hostScopeActive: isHostScopedAgentToolActive("openclaw"),
      });
      return createAttemptResult("codex");
    });
    registerAgentHarness(
      {
        id: "codex",
        label: "Codex",
        supports: () => ({ supported: true, priority: 100 }),
        runAttempt: pluginRunAttempt,
      },
      { ownerPluginId: "codex" },
    );
    const cases: Array<{
      config: OpenClawConfig;
      agentId?: string;
      sessionKey?: string;
    }> = [
      { config: { tools: { deny: ["*"] } } as OpenClawConfig },
      {
        config: {
          agents: { list: [{ id: "worker", tools: { deny: ["*"] } }] },
        } as OpenClawConfig,
        agentId: "worker",
      },
      {
        config: {
          agents: { defaults: { sandbox: { mode: "all" } } },
          tools: { sandbox: { tools: { deny: ["*"] } } },
        } as OpenClawConfig,
        sessionKey: "agent:main:session-1",
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const params = createAttemptParams(testCase.config) as EmbeddedRunAttemptParams & {
        systemAgentTool?: SystemAgentToolOptions;
      };
      params.sessionId = `session-${index}`;
      params.agentHarnessRuntimeOverride = "codex";
      params.agentId = testCase.agentId;
      params.sessionKey = testCase.sessionKey;
      params.toolsAllow = ["openclaw"];
      params.systemAgentTool = { surface: "cli", proposalRef: {}, directiveRef: {} };
      await runAgentHarnessAttempt(params);
    }

    expect(received).toEqual([
      { toolsAllow: ["openclaw"], extraSystemPrompt: undefined, hostScopeActive: true },
      { toolsAllow: ["openclaw"], extraSystemPrompt: undefined, hostScopeActive: true },
      { toolsAllow: ["openclaw"], extraSystemPrompt: undefined, hostScopeActive: true },
    ]);
    expect(isHostScopedAgentToolActive("openclaw")).toBe(false);
  });

  it("binds the same host OpenClaw scope to the built-in OpenClaw harness", async () => {
    let toolNames: string[] = [];
    agentRunAttempt.mockImplementationOnce(async () => {
      await Promise.resolve();
      toolNames = createOpenClawCodingTools({
        config: { tools: { allow: ["read"], deny: ["openclaw"], toolSearch: true } },
        runtimeToolAllowlist: ["openclaw"],
        toolConstructionPlan: {
          includeBaseCodingTools: false,
          includeShellTools: false,
          includeChannelTools: false,
          includeOpenClawTools: true,
          includePluginTools: false,
        },
      }).map((tool) => tool.name);
      return createAttemptResult("openclaw");
    });
    const params = createAttemptParams(
      providerRuntimeConfig("codex", "openclaw"),
    ) as EmbeddedRunAttemptParams & { systemAgentTool?: SystemAgentToolOptions };
    params.toolsAllow = ["openclaw"];
    params.systemAgentTool = { surface: "gateway", proposalRef: {}, directiveRef: {} };

    const result = await runAgentHarnessAttempt(params);

    expect(result.sessionIdUsed).toBe("openclaw");
    expect(toolNames).toEqual(["openclaw"]);
    expect(isHostScopedAgentToolActive("openclaw")).toBe(false);
  });

  it("unwraps sentinels only at the plugin harness handoff", async () => {
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () =>
      createAttemptResult("codex"),
    );
    registerAgentHarness(
      {
        id: "codex",
        label: "Codex",
        supports: () => ({ supported: true, priority: 100 }),
        runAttempt: pluginRunAttempt,
      },
      { ownerPluginId: "codex" },
    );
    const secret = "plugin-provider-secret";
    const sentinel = mintSecretSentinel(secret, { label: "model-auth:codex" });
    const params = createAttemptParams(providerRuntimeConfig("codex", "codex"));
    params.resolvedApiKey = sentinel;
    params.model = {
      ...params.model,
      headers: { Authorization: `Bearer ${sentinel}`, "X-Optional": null } as never,
    };

    await runAgentHarnessAttempt(params);

    const handedOff = pluginRunAttempt.mock.calls[0]?.[0];
    expect(handedOff?.resolvedApiKey).toBe(secret);
    expect(handedOff?.model.headers?.Authorization).toBe(`Bearer ${secret}`);
    expect(handedOff?.model.headers?.["X-Optional"]).toBeNull();
    expect(params.resolvedApiKey).toBe(sentinel);
  });

  it("fails when a forced plugin harness is unavailable and fallback is omitted", async () => {
    process.env.OPENCLAW_AGENT_RUNTIME = "codex";

    await expect(
      runAgentHarnessAttempt(createAttemptParams(providerRuntimeConfig("codex", "codex"))),
    ).rejects.toThrow('Requested agent harness "codex" is not registered.');
    expect(agentRunAttempt).not.toHaveBeenCalled();
  });

  it("falls back to the OpenClaw harness in auto mode when no plugin harness matches", async () => {
    const result = await runAgentHarnessAttempt(createAttemptParams());

    expect(result.sessionIdUsed).toBe("openclaw");
    expect(agentRunAttempt).toHaveBeenCalledTimes(1);
  });

  it("allows the selected OpenClaw harness to satisfy context-engine pre-prompt assembly", async () => {
    const result = await runAgentHarnessAttempt({
      ...createAttemptParams(providerRuntimeConfig("codex", "openclaw")),
      contextEngine: createContextEngineRequiringAssembly(),
    });

    expect(result.sessionIdUsed).toBe("openclaw");
    expect(agentRunAttempt).toHaveBeenCalledTimes(1);
  });

  it("surfaces an auto-selected plugin harness failure instead of replaying through OpenClaw", async () => {
    registerFailingCodexHarness();

    await expect(runAgentHarnessAttempt(createAttemptParams())).rejects.toThrow(
      "codex startup failed",
    );
    expect(agentRunAttempt).not.toHaveBeenCalled();
  });

  it("auto-selects a supporting plugin harness by default", async () => {
    registerFailingCodexHarness();

    await expect(runAgentHarnessAttempt(createAttemptParams())).rejects.toThrow(
      "codex startup failed",
    );
    expect(agentRunAttempt).not.toHaveBeenCalled();
  });

  it("projects deferred route support into the final attempt selection", async () => {
    const supports = vi.fn((ctx: Parameters<AgentHarness["supports"]>[0]) =>
      ctx.modelProvider?.preparedAuth?.source === "harness" &&
      ctx.modelProvider.requestTransportOverrides === "none" &&
      ctx.modelProvider.runtimePolicy?.compatibleIds.includes("codex")
        ? { supported: true as const, priority: 100 }
        : { supported: false as const, reason: "prepared route support is missing" },
    );
    registerAgentHarness(
      {
        id: "codex",
        label: "Codex",
        supports,
        runAttempt: vi.fn(async () => createAttemptResult("codex")),
      },
      { ownerPluginId: "codex" },
    );
    const params = createAttemptParams();
    params.provider = "openai";
    params.modelId = "gpt-5.5";
    params.model = {
      id: "gpt-5.5",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as Model;
    params.agentHarnessRuntimeOverride = "codex";
    params.runtimePlan = {
      auth: {
        providerForAuth: "openai",
        authProfileProviderForAuth: "openai",
        harnessAuthProvider: "openai",
        deferredRouteSupport: {
          requestTransportOverrides: "none",
          runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
        },
      },
    } as never;

    await expect(runAgentHarnessAttempt(params)).resolves.toMatchObject({
      sessionIdUsed: "codex",
    });
    expect(supports).toHaveBeenCalledWith(
      expect.objectContaining({
        modelProvider: expect.objectContaining({
          requestTransportOverrides: "none",
          runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
          preparedAuth: { source: "harness" },
        }),
      }),
    );
  });

  it("surfaces a forced plugin harness failure instead of replaying through OpenClaw", async () => {
    registerFailingCodexHarness();

    await expect(
      runAgentHarnessAttempt(createAttemptParams(providerRuntimeConfig("codex", "codex"))),
    ).rejects.toThrow("codex startup failed");
    expect(agentRunAttempt).not.toHaveBeenCalled();
  });

  it("rejects the candidate when the forced plugin harness does not support its provider", async () => {
    registerFailingCodexHarness();

    const params = createAttemptParams(
      agentModelRuntimeConfig("9router/cc/claude-opus-4-6", "codex"),
    );
    params.provider = "9router";
    params.modelId = "cc/claude-opus-4-6";
    params.agentHarnessRuntimeOverride = "codex";

    await expect(runAgentHarnessAttempt(params)).rejects.toThrow(
      /Requested agent harness "codex" does not support 9router\/cc\/claude-opus-4-6/,
    );
    expect(agentRunAttempt).not.toHaveBeenCalled();
  });

  it("keeps a session-pinned Codex harness across outer provider overrides", async () => {
    registerSuccessfulCodexHarness();

    const result = await runAgentHarnessAttempt({
      ...createAttemptParams(),
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      agentHarnessId: "codex",
    });

    expect(result.sessionIdUsed).toBe("codex");
    expect(agentRunAttempt).not.toHaveBeenCalled();
  });

  it("fails closed when a session-pinned Codex harness is unavailable", async () => {
    await expect(
      runAgentHarnessAttempt({
        ...createAttemptParams(),
        provider: "anthropic",
        modelId: "claude-opus-4-6",
        agentHarnessId: "codex",
      }),
    ).rejects.toThrow('Requested agent harness "codex" is not registered');
    expect(agentRunAttempt).not.toHaveBeenCalled();
  });

  it.each(["openai", "openai"])(
    "does not override forced Codex harness support rejection for %s",
    (provider) => {
      registerFailingCodexHarness();

      expect(() =>
        selectAgentHarness({
          provider,
          modelId: "gpt-5.4",
          agentHarnessRuntimeOverride: "codex",
        }),
      ).toThrow(`Requested agent harness "codex" does not support ${provider}/gpt-5.4`);
      expect(agentRunAttempt).not.toHaveBeenCalled();
    },
  );

  it("uses the Codex harness by default for OpenAI agent model runs", async () => {
    registerSuccessfulCodexHarness();

    expect(resolveAgentHarnessPolicy({ provider: "openai", modelId: "gpt-5.4" })).toEqual({
      runtime: "codex",
      runtimeSource: "implicit",
    });

    const result = await runAgentHarnessAttempt({
      ...createAttemptParams(),
      provider: "openai",
      modelId: "gpt-5.4",
    });
    expect(result.sessionIdUsed).toBe("codex");
    expect(agentRunAttempt).not.toHaveBeenCalled();
  });

  it("falls back to OpenClaw when the implicit OpenAI Codex harness is unavailable", async () => {
    expect(resolveAgentHarnessPolicy({ provider: "openai", modelId: "gpt-5.4" })).toEqual({
      runtime: "codex",
      runtimeSource: "implicit",
    });
    expect(resolveAvailableAgentHarnessPolicy({ provider: "openai", modelId: "gpt-5.4" })).toEqual({
      runtime: "openclaw",
      runtimeSource: "implicit",
    });

    const result = await runAgentHarnessAttempt({
      ...createAttemptParams(),
      provider: "openai",
      modelId: "gpt-5.4",
    });

    expect(result.sessionIdUsed).toBe("openclaw");
    expect(agentRunAttempt).toHaveBeenCalledTimes(1);
  });

  it("honors explicit OpenClaw runtime for OpenAI agent model runs", async () => {
    const result = await runAgentHarnessAttempt({
      ...createAttemptParams(providerRuntimeConfig("openai", "openclaw")),
      provider: "openai",
      modelId: "gpt-5.4",
    });
    expect(result.sessionIdUsed).toBe("openclaw");
    expect(agentRunAttempt).toHaveBeenCalledTimes(1);
  });

  it("honors provider wildcard OpenClaw runtime policy for OpenAI agent model runs", async () => {
    registerSuccessfulCodexHarness();

    const result = await runAgentHarnessAttempt({
      ...createAttemptParams(agentModelRuntimeConfig("openai/*", "openclaw")),
      provider: "openai",
      modelId: "gpt-5.4",
    });
    expect(result.sessionIdUsed).toBe("openclaw");
    expect(agentRunAttempt).toHaveBeenCalledTimes(1);
  });

  it("annotates non-ok harness result classifications for outer model fallback", async () => {
    const classify = vi.fn<NonNullable<AgentHarness["classify"]>>(() => "empty" as const);
    registerAgentHarness(
      {
        id: "codex",
        label: "Classifying Codex",
        supports: (ctx) =>
          ctx.provider === "codex" ? { supported: true, priority: 100 } : { supported: false },
        runAttempt: vi.fn(async () => createAttemptResult("codex")),
        classify,
      },
      { ownerPluginId: "codex" },
    );

    const params = createAttemptParams();
    const result = await runAgentHarnessAttempt(params);

    const classifyCall = classify.mock.calls.at(0);
    expect(classifyCall?.[0].sessionIdUsed).toBe("codex");
    expect(classifyCall?.[1]).toBe(params);
    expect(result.agentHarnessId).toBe("codex");
    expect(result.agentHarnessResultClassification).toBe("empty");
  });

  it("collapses channel group sender deny-all to empty toolsAllow for plugin harnesses", async () => {
    const runAttempt = vi.fn<AgentHarness["runAttempt"]>(async () => createAttemptResult("codex"));
    registerAgentHarness(
      {
        id: "codex",
        label: "Codex",
        supports: (ctx) =>
          ctx.provider === "codex" ? { supported: true, priority: 100 } : { supported: false },
        runAttempt,
      },
      { ownerPluginId: "codex" },
    );

    await runAgentHarnessAttempt({
      ...createAttemptParams(groupSenderDenyAllConfig()),
      sessionKey: "agent:main:telegram:group:test-deny-room",
      messageProvider: "telegram",
      groupId: "test-deny-room",
      senderId: "test-denied-sender",
      extraSystemPrompt: "Existing operator note.",
    });

    expect(runAttempt).toHaveBeenCalledTimes(1);
    const attempt = runAttempt.mock.calls[0]?.[0];
    expect(attempt?.toolsAllow).toEqual([]);
    expect(attempt?.extraSystemPrompt).toContain("Existing operator note.");
    expect(attempt?.extraSystemPrompt).toContain("this sender is not allowed by policy");
  });

  it("adds chat policy wording for plugin harness group deny-all", async () => {
    const runAttempt = vi.fn<AgentHarness["runAttempt"]>(async () => createAttemptResult("codex"));
    registerAgentHarness(
      {
        id: "codex",
        label: "Codex",
        supports: (ctx) =>
          ctx.provider === "codex" ? { supported: true, priority: 100 } : { supported: false },
        runAttempt,
      },
      { ownerPluginId: "codex" },
    );

    await runAgentHarnessAttempt({
      ...createAttemptParams(groupDenyAllConfig()),
      sessionKey: "agent:main:telegram:group:test-deny-room",
      messageProvider: "telegram",
      groupId: "test-deny-room",
      senderId: "test-denied-sender",
    });

    expect(runAttempt).toHaveBeenCalledTimes(1);
    const attempt = runAttempt.mock.calls[0]?.[0];
    expect(attempt?.toolsAllow).toEqual([]);
    expect(attempt?.extraSystemPrompt).toContain("this chat is not allowed by policy");
  });

  it.each([
    {
      name: "narrow allowlist",
      config: { tools: { allow: ["message"] } } as OpenClawConfig,
    },
    {
      name: "specific denylist",
      config: { tools: { deny: ["exec"] } } as OpenClawConfig,
    },
    {
      name: "narrow profile",
      config: { tools: { profile: "coding" } } as OpenClawConfig,
    },
  ])("marks plugin side questions restricted for a $name", ({ config }) => {
    expect(resolvePluginHarnessPolicyToolsAllow(createAttemptParams(config))).toEqual([]);
  });

  it.each([
    { name: "full tool profile", config: { tools: { profile: "full" } } as OpenClawConfig },
    { name: "explicit empty allowlist", config: { tools: { allow: [] } } as OpenClawConfig },
  ])("leaves plugin side questions unrestricted for an $name", ({ config }) => {
    expect(resolvePluginHarnessPolicyToolsAllow(createAttemptParams(config))).toBeUndefined();
  });

  it("leaves owner WebChat unrestricted by wildcard sender policy for plugin harnesses", () => {
    const config = {
      tools: {
        toolsBySender: {
          "*": { deny: ["*"] },
        },
      },
    } as OpenClawConfig;

    expect(
      resolvePluginHarnessPolicyToolsAllow({
        ...createAttemptParams(config),
        messageProvider: "webchat",
        senderIsOwner: true,
      }),
    ).toBeUndefined();
  });

  it("keeps non-owner WebChat restricted by wildcard sender policy for plugin harnesses", () => {
    const config = {
      tools: {
        toolsBySender: {
          "*": { deny: ["*"] },
        },
      },
    } as OpenClawConfig;

    expect(
      resolvePluginHarnessPolicyToolsAllow({
        ...createAttemptParams(config),
        messageProvider: "webchat",
        senderIsOwner: false,
      }),
    ).toEqual([]);
  });

  it("leaves OpenClaw harness params unchanged for channel group sender deny-all policy", async () => {
    await runAgentHarnessAttempt({
      ...createAttemptParams(groupSenderDenyAllConfig()),
      sessionKey: "agent:main:telegram:group:test-deny-room",
      messageProvider: "telegram",
      groupId: "test-deny-room",
      senderId: "test-denied-sender",
    });

    expect(agentRunAttempt).toHaveBeenCalledTimes(1);
    expect(agentRunAttempt.mock.calls[0]?.[0].toolsAllow).toBeUndefined();
  });

  it("fails for config-forced plugin harnesses when fallback is omitted", async () => {
    await expect(
      runAgentHarnessAttempt(createAttemptParams(providerRuntimeConfig("codex", "codex"))),
    ).rejects.toThrow('Requested agent harness "codex" is not registered');
    expect(agentRunAttempt).not.toHaveBeenCalled();
  });

  it("does not let a strict agent model plugin runtime fall back to OpenClaw", async () => {
    await expect(
      runAgentHarnessAttempt({
        ...createAttemptParams(agentModelRuntimeConfig("codex/gpt-5.4", "codex", "strict")),
        sessionKey: "agent:strict:session-1",
      }),
    ).rejects.toThrow('Requested agent harness "codex" is not registered');
    expect(agentRunAttempt).not.toHaveBeenCalled();
  });
});

describe("selectAgentHarness", () => {
  it("does not select Codex from a non-OpenAI model name", () => {
    registerSuccessfulCodexHarness();

    expect(resolveAgentHarnessPolicy({ provider: "custom", modelId: "gpt-5.4-codex" })).toEqual({
      runtime: "auto",
      runtimeSource: "implicit",
    });
    expect(selectAgentHarness({ provider: "custom", modelId: "gpt-5.4-codex" }).id).toBe(
      "openclaw",
    );
  });

  it("auto-selects plugin support by default", () => {
    const supports = vi.fn(() => ({ supported: true as const, priority: 100 }));
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports,
      runAttempt: vi.fn(async () => createAttemptResult("codex")),
    });

    const harness = selectAgentHarness({
      provider: "codex",
      modelId: "gpt-5.4",
    });

    expect(harness.id).toBe("codex");
    expect(supports).toHaveBeenCalledTimes(1);
  });

  it("rejects statically unrelated auto harnesses before provider discovery", () => {
    const supports = vi.fn(() => ({ supported: true as const, priority: 100 }));
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      autoSelection: { providerIds: ["openai", "codex"] },
      supports,
      runAttempt: vi.fn(async () => createAttemptResult("codex")),
    });

    expect(selectAgentHarness({ provider: "deepseek", modelId: "deepseek-v4-pro" }).id).toBe(
      "openclaw",
    );
    expect(supports).not.toHaveBeenCalled();
    expect(providerOwnerMocks.resolveProviderRefOwnership).not.toHaveBeenCalled();
  });

  it("auto-selects the highest-priority plugin harness without duplicate support probes", () => {
    const lowPrioritySupports = vi.fn(() => ({
      supported: true as const,
      priority: 10,
      reason: "generic codex support",
    }));
    const highPrioritySupports = vi.fn(() => ({
      supported: true as const,
      priority: 100,
      reason: "native codex app-server",
    }));
    const unsupportedSupports = vi.fn(() => ({
      supported: false as const,
      reason: "provider mismatch",
    }));
    registerAgentHarness(
      {
        id: "codex-low",
        label: "Low Codex",
        supports: lowPrioritySupports,
        runAttempt: vi.fn(async () => createAttemptResult("codex-low")),
      },
      { ownerPluginId: "codex-low" },
    );
    registerAgentHarness(
      {
        id: "codex-high",
        label: "High Codex",
        supports: highPrioritySupports,
        runAttempt: vi.fn(async () => createAttemptResult("codex-high")),
      },
      { ownerPluginId: "codex-high" },
    );
    registerAgentHarness(
      {
        id: "other",
        label: "Other Harness",
        supports: unsupportedSupports,
        runAttempt: vi.fn(async () => createAttemptResult("other")),
      },
      { ownerPluginId: "other" },
    );

    const harness = selectAgentHarness({
      provider: "codex",
      modelId: "gpt-5.4",
    });

    expect(harness.id).toBe("codex-high");
    expect(lowPrioritySupports).toHaveBeenCalledTimes(1);
    expect(highPrioritySupports).toHaveBeenCalledTimes(1);
    expect(unsupportedSupports).toHaveBeenCalledTimes(1);
  });

  it("honors session-level OpenClaw pins when selecting a harness", () => {
    const supports = vi.fn(() => ({ supported: true as const, priority: 100 }));
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports,
      runAttempt: vi.fn(async () => createAttemptResult("codex")),
    });

    const harness = selectAgentHarness({
      provider: "codex",
      modelId: "gpt-5.4",
      agentHarnessId: "openclaw",
    });

    expect(harness.id).toBe("openclaw");
    expect(supports).not.toHaveBeenCalled();
  });

  it("passes manifest provider owners into plugin support checks", () => {
    providerOwnerMocks.resolveProviderRefOwnership.mockReturnValue({
      status: "owned",
      pluginIds: ["fixture-owner"],
    });
    const supports = vi.fn(() => ({
      supported: false as const,
      reason: "provider is owned by a native plugin",
    }));
    const config = providerRuntimeConfig("fixture-provider", "copilot");
    registerAgentHarness({
      id: "copilot",
      label: "Copilot",
      supports,
      runAttempt: vi.fn(async () => createAttemptResult("copilot")),
    });

    expect(() =>
      selectAgentHarness({
        provider: "fixture-provider",
        modelId: "fixture-model",
        config,
        agentHarnessRuntimeOverride: "copilot",
      }),
    ).toThrow("provider is owned by a native plugin");

    expect(providerOwnerMocks.resolveProviderRefOwnership).toHaveBeenCalledWith({
      provider: "fixture-provider",
      config,
    });
    expect(supports).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "fixture-provider",
        modelId: "fixture-model",
        requestedRuntime: "copilot",
        providerOwnerStatus: "owned",
        providerOwnerPluginIds: ["fixture-owner"],
      }),
    );
  });

  it("passes ambiguous provider ownership into plugin support checks", () => {
    providerOwnerMocks.resolveProviderRefOwnership.mockReturnValue({
      status: "ambiguous",
      pluginIds: ["first-owner", "second-owner"],
    });
    const supports = vi.fn(() => ({
      supported: false as const,
      reason: "provider ownership is ambiguous",
    }));
    const config = providerRuntimeConfig("custom-proxy", "copilot");
    registerAgentHarness({
      id: "copilot",
      label: "Copilot",
      supports,
      runAttempt: vi.fn(async () => createAttemptResult("copilot")),
    });

    expect(() =>
      selectAgentHarness({
        provider: "custom-proxy",
        modelId: "proxy-model",
        config,
        agentHarnessRuntimeOverride: "copilot",
      }),
    ).toThrow("provider ownership is ambiguous");

    expect(supports).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "custom-proxy",
        providerOwnerStatus: "ambiguous",
        providerOwnerPluginIds: ["first-owner", "second-owner"],
      }),
    );
  });

  it("passes resolved provider model shape into plugin support checks", () => {
    const supports = vi.fn(() => ({
      supported: false as const,
      reason: "unsupported test provider",
    }));
    const config = {
      models: {
        providers: {
          "custom-proxy": {
            api: "openai-completions",
            baseUrl: "https://provider.example/v1",
            request: { auth: { mode: "provider-default" as const } },
            agentRuntime: { id: "copilot" },
            models: [
              {
                id: "gpt-test",
                name: "GPT Test",
                api: "openai-responses",
                baseUrl: "https://model.example/v1",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 8_192,
                maxTokens: 1_024,
              },
            ],
          },
        },
      },
    } as OpenClawConfig;
    registerAgentHarness({
      id: "copilot",
      label: "Copilot",
      supports,
      runAttempt: vi.fn(async () => createAttemptResult("copilot")),
    });

    expect(() =>
      selectAgentHarness({
        provider: "custom-proxy",
        modelId: "gpt-test",
        config,
        agentHarnessRuntimeOverride: "copilot",
      }),
    ).toThrow("unsupported test provider");

    expect(supports).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "custom-proxy",
        modelId: "gpt-test",
        modelProvider: expect.objectContaining({
          api: "openai-responses",
          baseUrl: "https://model.example/v1",
          request: { auth: { mode: "provider-default" } },
        }),
      }),
    );
  });

  it("merges prepared model route facts with configured request policy", () => {
    const supports = vi.fn(() => ({
      supported: false as const,
      reason: "unsupported test provider",
    }));
    const config = {
      models: {
        providers: {
          "custom-proxy": {
            api: "openai-completions",
            baseUrl: "https://provider.example/v1",
            request: { auth: { mode: "provider-default" as const } },
            agentRuntime: { id: "copilot" },
            models: [
              {
                id: "gpt-test",
                name: "GPT Test",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 8_192,
                maxTokens: 1_024,
              },
            ],
          },
        },
      },
    } as OpenClawConfig;
    registerAgentHarness({
      id: "copilot",
      label: "Copilot",
      supports,
      runAttempt: vi.fn(async () => createAttemptResult("copilot")),
    });

    expect(() =>
      selectAgentHarness({
        provider: "custom-proxy",
        modelId: "gpt-test",
        modelProvider: {
          api: "openai-responses",
          baseUrl: "https://model.example/v1",
        },
        config,
        agentHarnessRuntimeOverride: "copilot",
      }),
    ).toThrow("unsupported test provider");

    expect(supports).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "custom-proxy",
        modelId: "gpt-test",
        modelProvider: expect.objectContaining({
          api: "openai-responses",
          baseUrl: "https://model.example/v1",
          requestTransportOverrides: "present",
          request: { auth: { mode: "provider-default" } },
        }),
      }),
    );
  });

  it("projects a self-qualified model adapter and transport into harness capability checks", () => {
    const config = {
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            models: [
              {
                id: "openai/gpt-5.5",
                api: "openai-completions",
                headers: { "x-model-route": "custom" },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      buildAgentHarnessSupportContext({
        provider: "openai",
        modelId: "gpt-5.5",
        requestedRuntime: "codex",
        config,
      }).modelProvider,
    ).toMatchObject({
      api: "openai-completions",
      requestTransportOverrides: "present",
      runtimePolicy: { compatibleIds: ["openclaw"] },
    });
  });

  it("projects canonical model transport overrides for a shipped alias", () => {
    const config = {
      models: {
        providers: {
          openai: {
            models: [
              {
                id: "gpt-5.4",
                api: "openai-completions",
                baseUrl: "https://api.openai.com/v1",
                headers: { "x-model-route": "custom" },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      buildAgentHarnessSupportContext({
        provider: "openai",
        modelId: "gpt-5.4-codex",
        requestedRuntime: "codex",
        config,
      }).modelProvider,
    ).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
      requestTransportOverrides: "present",
      runtimePolicy: { compatibleIds: ["openclaw"] },
    });
  });

  it("projects provider-owned compatibility for an official OpenAI route", () => {
    expect(
      buildAgentHarnessSupportContext({
        provider: "openai",
        modelId: "gpt-5.5",
        modelProvider: {
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
        },
        requestedRuntime: "codex",
      }).modelProvider,
    ).toMatchObject({
      runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
    });
  });

  it.each([
    {
      label: "default",
      config: { agents: { defaults: { params: { store: false } } } },
      identity: {},
    },
    {
      label: "model",
      config: {
        agents: {
          defaults: {
            models: { "openai/gpt-5.5": { params: { store: false } } },
          },
        },
      },
      identity: {},
    },
    {
      label: "agent",
      config: {
        agents: { list: [{ id: "worker", params: { store: false } }] },
      },
      identity: { sessionKey: "agent:worker:main" },
    },
  ] as const)(
    "projects $label agent request params into harness support",
    ({ config, identity }) => {
      expect(
        buildAgentHarnessSupportContext({
          provider: "openai",
          modelId: "gpt-5.5",
          modelProvider: {
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            requestTransportOverrides: "none",
          },
          requestedRuntime: "codex",
          config: config as OpenClawConfig,
          ...identity,
        }).modelProvider,
      ).toMatchObject({
        requestTransportOverrides: "present",
        runtimePolicy: { compatibleIds: ["openclaw"] },
      });
    },
  );

  it("rejects explicit Codex when agent request params cannot be reproduced", () => {
    const supports = vi.fn((ctx: Parameters<AgentHarness["supports"]>[0]) =>
      ctx.modelProvider?.requestTransportOverrides === "present"
        ? { supported: false as const, reason: "authored request params are unsupported" }
        : { supported: true as const },
    );
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports,
      runAttempt: vi.fn(async () => createAttemptResult("codex")),
    });

    expect(() =>
      selectAgentHarness({
        provider: "openai",
        modelId: "gpt-5.5",
        modelProvider: {
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          requestTransportOverrides: "none",
          runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
        },
        config: { agents: { defaults: { params: { store: false } } } },
        agentHarnessRuntimeOverride: "codex",
      }),
    ).toThrow("authored request params are unsupported");
    expect(supports).toHaveBeenCalledWith(
      expect.objectContaining({
        modelProvider: expect.objectContaining({ requestTransportOverrides: "present" }),
      }),
    );
  });

  it("keeps request-scoped transport overrides on the implicit OpenClaw runtime", () => {
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: true, priority: 100 }),
      runAttempt: vi.fn(async () => createAttemptResult("codex")),
    });
    const config = {
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig;
    const modelProvider = {
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      requestTransportOverrides: "present" as const,
    };

    expect(
      resolveAvailableAgentHarnessPolicy({
        provider: "openai",
        modelId: "gpt-5.5",
        modelProvider,
        config,
      }),
    ).toEqual({ runtime: "openclaw", runtimeSource: "implicit" });
    expect(
      selectAgentHarness({
        provider: "openai",
        modelId: "gpt-5.5",
        modelProvider,
        config,
      }).id,
    ).toBe("openclaw");
    expect(
      selectAgentHarness({
        provider: "openai",
        modelId: "gpt-5.5",
        modelProvider: {
          api: modelProvider.api,
          baseUrl: modelProvider.baseUrl,
        },
        config,
      }).id,
    ).toBe("codex");
  });

  it("falls back only for implicitly selected Codex transport rejection", () => {
    const supports = vi.fn((ctx: Parameters<AgentHarness["supports"]>[0]) =>
      ctx.modelProvider?.requestTransportOverrides === "present"
        ? {
            supported: false as const,
            reason: "custom provider request transport",
          }
        : { supported: true as const },
    );
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports,
      runAttempt: vi.fn(async () => createAttemptResult("codex")),
    });
    const config = {
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            headers: { "x-route": "custom" },
            models: [],
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveAvailableAgentHarnessPolicy({ provider: "openai", modelId: "gpt-5.5", config }),
    ).toEqual({ runtime: "openclaw", runtimeSource: "implicit" });
    expect(selectAgentHarness({ provider: "openai", modelId: "gpt-5.5", config }).id).toBe(
      "openclaw",
    );
    expect(() =>
      selectAgentHarness({
        provider: "openai",
        modelId: "gpt-5.5",
        config,
        agentHarnessRuntimeOverride: "codex",
      }),
    ).toThrow("custom provider request transport");
  });

  it("falls back only for implicitly selected route-runtime incompatibility", () => {
    const supports = vi.fn((ctx: Parameters<AgentHarness["supports"]>[0]) =>
      ctx.modelProvider?.runtimePolicy?.compatibleIds.includes("codex")
        ? { supported: true as const }
        : { supported: false as const, reason: "native runtime is incompatible with route" },
    );
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports,
      runAttempt: vi.fn(async () => createAttemptResult("codex")),
    });
    const modelProvider = {
      api: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
      requestTransportOverrides: "none" as const,
      runtimePolicy: { compatibleIds: ["openclaw"] },
    };

    expect(selectAgentHarness({ provider: "openai", modelId: "gpt-5.5", modelProvider }).id).toBe(
      "openclaw",
    );
    expect(() =>
      selectAgentHarness({
        provider: "openai",
        modelId: "gpt-5.5",
        modelProvider,
        agentHarnessRuntimeOverride: "codex",
      }),
    ).toThrow("native runtime is incompatible with route");
  });

  it("does not infer native support for an indeterminate OpenAI route", () => {
    const supports = vi.fn((ctx: Parameters<AgentHarness["supports"]>[0]) =>
      ctx.modelProvider?.runtimePolicy
        ? { supported: true as const }
        : { supported: false as const, reason: "route compatibility is undeclared" },
    );
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports,
      runAttempt: vi.fn(async () => createAttemptResult("codex")),
    });

    expect(selectAgentHarness({ provider: "openai", modelId: "gpt-future" }).id).toBe("openclaw");
    expect(supports).toHaveBeenCalledWith(
      expect.objectContaining({
        modelProvider: expect.objectContaining({ runtimePolicy: undefined }),
      }),
    );
  });

  it("projects a harness-owned auth plan as a closed harness source", () => {
    const deferredRouteSupport = {
      requestTransportOverrides: "none" as const,
      runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
    };
    expect(
      resolveAgentHarnessPreparedAuthSupport({
        plan: {
          providerForAuth: "openai",
          authProfileProviderForAuth: "openai",
          harnessAuthProvider: "openai",
          deferredRouteSupport,
        },
      }),
    ).toEqual({ source: "harness" });
    expect(
      resolveAgentHarnessPreparedRouteSupport({
        providerForAuth: "openai",
        authProfileProviderForAuth: "openai",
        harnessAuthProvider: "openai",
        deferredRouteSupport,
      }),
    ).toEqual(deferredRouteSupport);
    expect(
      resolveAgentHarnessPreparedRouteSupport({
        providerForAuth: "openai",
        authProfileProviderForAuth: "openai",
      }),
    ).toEqual({});
    expect(
      resolveAgentHarnessPreparedAuthSupport({
        plan: {
          providerForAuth: "openai",
          authProfileProviderForAuth: "openai",
          harnessAuthProvider: "openai",
          selectedAuthMode: "api-key",
        },
      }),
    ).toEqual({ source: "direct", mode: "api-key" });
  });

  it("keeps finalized native selection for declared deferred harness-owned auth", () => {
    const supports = vi.fn((ctx: Parameters<AgentHarness["supports"]>[0]) =>
      ctx.modelProvider?.preparedAuth?.source === "harness" &&
      ctx.modelProvider.preparedAuth.requirement === undefined &&
      ctx.modelProvider.runtimePolicy?.compatibleIds.includes("codex")
        ? { supported: true as const }
        : { supported: false as const },
    );
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports,
      runAttempt: vi.fn(async () => createAttemptResult("codex")),
    });

    expect(
      selectAgentHarness({
        provider: "openai",
        modelId: "gpt-future",
        modelProvider: {
          requestTransportOverrides: "none",
          runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
          preparedAuth: { source: "harness" },
        },
        agentHarnessRuntimeOverride: "codex",
      }).id,
    ).toBe("codex");
    expect(supports).toHaveBeenCalledWith(
      expect.objectContaining({
        modelProvider: expect.objectContaining({
          preparedAuth: { source: "harness" },
          runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
        }),
      }),
    );
  });

  it("selects one harness compatible with every prepared model provider", () => {
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: (ctx) =>
        ctx.modelProvider?.runtimePolicy?.compatibleIds.includes("codex")
          ? { supported: true }
          : { supported: false, reason: "prepared retry route is incompatible" },
      runAttempt: vi.fn(async () => createAttemptResult("codex")),
    });
    const compatible = {
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      requestTransportOverrides: "none" as const,
      runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
      preparedAuth: { source: "direct" as const, mode: "api-key", requirement: "api-key" as const },
    };
    const incompatible = {
      api: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
      requestTransportOverrides: "none" as const,
      runtimePolicy: { compatibleIds: ["openclaw"] },
      preparedAuth: { source: "direct" as const, mode: "api-key", requirement: "api-key" as const },
    };
    const base = { provider: "openai", modelId: "gpt-5.5" };

    expect(
      selectAgentHarnessForPreparedModelProviders({
        ...base,
        modelProviders: [compatible, compatible],
      }).id,
    ).toBe("codex");
    expect(
      selectAgentHarnessForPreparedModelProviders({
        ...base,
        modelProviders: [compatible, incompatible],
      }).id,
    ).toBe("openclaw");
  });

  it.each([
    ["explicit", { agentHarnessRuntimeOverride: "codex" }],
    ["pinned", { agentHarnessId: "codex" }],
  ] as const)("fails closed when a %s harness cannot own every prepared route", (_label, pin) => {
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: (ctx) =>
        ctx.modelProvider?.runtimePolicy?.compatibleIds.includes("codex")
          ? { supported: true }
          : { supported: false, reason: "prepared retry route is incompatible" },
      runAttempt: vi.fn(async () => createAttemptResult("codex")),
    });

    expect(() =>
      selectAgentHarnessForPreparedModelProviders({
        provider: "openai",
        modelId: "gpt-5.5",
        modelProviders: [
          {
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            requestTransportOverrides: "none",
            runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
          },
          {
            api: "openai-completions",
            baseUrl: "https://api.openai.com/v1",
            requestTransportOverrides: "none",
            runtimePolicy: { compatibleIds: ["openclaw"] },
          },
        ],
        ...pin,
      }),
    ).toThrow("prepared retry route is incompatible");
  });

  it.each([
    {
      label: "a finalized route with undeclared compatibility",
      modelProvider: {
        api: "openai-completions",
        baseUrl: "https://api.openai.com/v1",
      },
      expectsRuntimePolicy: false,
    },
    {
      label: "prepared auth",
      modelProvider: {
        preparedAuth: {
          source: "none" as const,
          requirement: "subscription" as const,
        },
      },
      expectsRuntimePolicy: false,
    },
  ])(
    "validates a session-pinned harness against $label",
    ({ modelProvider, expectsRuntimePolicy }) => {
      const supports = vi.fn((ctx: Parameters<AgentHarness["supports"]>[0]) => {
        const preparedAuth = ctx.modelProvider?.preparedAuth;
        const reproducible =
          ctx.modelProvider?.runtimePolicy !== undefined && preparedAuth?.source !== "none";
        return reproducible
          ? { supported: true as const }
          : {
              supported: false as const,
              reason: "native runtime cannot reproduce prepared facts",
            };
      });
      registerAgentHarness({
        id: "codex",
        label: "Codex",
        supports,
        runAttempt: vi.fn(async () => createAttemptResult("codex")),
      });

      expect(() =>
        selectAgentHarnessForPreparedModelProviders({
          provider: "openai",
          modelId: "gpt-5.5",
          modelProviders: [modelProvider],
          agentHarnessId: "codex",
        }),
      ).toThrow("native runtime cannot reproduce prepared facts");
      expect(supports).toHaveBeenCalledOnce();
      expect(Boolean(supports.mock.calls[0]?.[0].modelProvider?.runtimePolicy)).toBe(
        expectsRuntimePolicy,
      );
    },
  );

  it("honors explicit OpenClaw runtime overrides when selecting a harness", async () => {
    registerSuccessfulCodexHarness();

    const harness = selectAgentHarness({
      provider: "openai",
      modelId: "gpt-5.4",
      agentHarnessRuntimeOverride: "openclaw",
    });

    expect(harness.id).toBe("openclaw");
    expect(providerOwnerMocks.resolveProviderRefOwnership).not.toHaveBeenCalled();

    const result = await runAgentHarnessAttempt({
      ...createAttemptParams(),
      provider: "openai",
      modelId: "gpt-5.4",
      agentHarnessRuntimeOverride: "openclaw",
    });
    expect(result.sessionIdUsed).toBe("openclaw");
  });

  it("treats legacy PI runtime overrides as the built-in OpenClaw harness", async () => {
    registerSuccessfulCodexHarness();

    const harness = selectAgentHarness({
      provider: "openai",
      modelId: "gpt-5.4",
      agentHarnessRuntimeOverride: "pi",
    });

    expect(harness.id).toBe("openclaw");

    const result = await runAgentHarnessAttempt({
      ...createAttemptParams(),
      provider: "openai",
      modelId: "gpt-5.4",
      agentHarnessRuntimeOverride: "pi",
    });
    expect(result.sessionIdUsed).toBe("openclaw");
  });

  it("allows per-agent model runtime policy overrides", () => {
    const config = agentModelRuntimeConfig("anthropic/sonnet-4.6", "codex", "strict");

    expect(() =>
      selectAgentHarness({
        provider: "anthropic",
        modelId: "sonnet-4.6",
        config,
        sessionKey: "agent:strict:session-1",
      }),
    ).toThrow('Requested agent harness "codex" is not registered');
    expect(selectAgentHarness({ provider: "anthropic", modelId: "sonnet-4.6", config }).id).toBe(
      "openclaw",
    );
  });

  it("selects OpenClaw when the implicit OpenAI Codex harness is unavailable", () => {
    expect(selectAgentHarness({ provider: "openai", modelId: "gpt-5.4" }).id).toBe("openclaw");
  });

  it.each(["default", "auto"] as const)(
    "falls back from configured %s to OpenClaw when implicit Codex is unavailable or unsupported",
    (runtime) => {
      const config = providerRuntimeConfig("openai", runtime);
      expect(resolveAgentHarnessPolicy({ provider: "openai", modelId: "gpt-5.4", config })).toEqual(
        { runtime: "codex", runtimeSource: "implicit" },
      );
      expect(selectAgentHarness({ provider: "openai", modelId: "gpt-5.4", config }).id).toBe(
        "openclaw",
      );

      const supports = vi.fn(() => ({ supported: false as const, reason: "unsupported route" }));
      registerAgentHarness(
        {
          id: "codex",
          label: "Codex",
          supports,
          runAttempt: vi.fn(async () => createAttemptResult("codex")),
        },
        { ownerPluginId: "codex" },
      );
      expect(selectAgentHarness({ provider: "openai", modelId: "gpt-5.4", config }).id).toBe(
        "openclaw",
      );
      expect(supports).toHaveBeenCalledOnce();
    },
  );

  it.each(["default", "auto"] as const)(
    "keeps a custom OpenAI route on implicit OpenClaw with configured %s",
    (runtime) => {
      const supports = vi.fn(() => ({ supported: true as const, priority: 100 }));
      registerAgentHarness(
        {
          id: "codex",
          label: "Codex",
          supports,
          runAttempt: vi.fn(async () => createAttemptResult("codex")),
        },
        { ownerPluginId: "codex" },
      );
      const config = {
        models: {
          providers: {
            openai: {
              api: "openai-responses",
              baseUrl: "https://relay.example.test/v1",
              agentRuntime: { id: runtime },
              models: [],
            },
          },
        },
      } as OpenClawConfig;

      expect(resolveAgentHarnessPolicy({ provider: "openai", modelId: "gpt-5.4", config })).toEqual(
        { runtime: "openclaw", runtimeSource: "implicit" },
      );
      expect(selectAgentHarness({ provider: "openai", modelId: "gpt-5.4", config }).id).toBe(
        "openclaw",
      );
      expect(supports).not.toHaveBeenCalled();
    },
  );

  it("ignores legacy agentRuntime as a runtime policy source", () => {
    const config = {
      agents: {
        defaults: {
          agentRuntime: { id: "codex" },
        },
      },
    } as OpenClawConfig;

    expect(
      selectAgentHarness({
        provider: "anthropic",
        modelId: "sonnet-4.6",
        config,
      }).id,
    ).toBe("openclaw");
  });

  it("ignores legacy agent CLI runtime aliases for OpenAI agent model runs", async () => {
    registerSuccessfulCodexHarness();
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          agentRuntime: { id: "claude-cli" },
        },
      },
    };

    expect(selectAgentHarness({ provider: "openai", modelId: "gpt-5.4", config }).id).toBe("codex");

    const result = await runAgentHarnessAttempt({
      ...createAttemptParams(config),
      provider: "openai",
      modelId: "gpt-5.4",
    });
    expect(result.sessionIdUsed).toBe("codex");
    expect(agentRunAttempt).not.toHaveBeenCalled();
  });

  it("keeps an existing session OpenClaw pin when provider policy forces a plugin harness", () => {
    registerFailingCodexHarness();

    expect(
      selectAgentHarness({
        provider: "codex",
        modelId: "gpt-5.4",
        agentHarnessId: "openclaw",
        config: providerRuntimeConfig("codex", "codex"),
      }).id,
    ).toBe("openclaw");
  });

  it("ignores env-forced OpenClaw for OpenAI default runtime selection", () => {
    process.env.OPENCLAW_AGENT_RUNTIME = "openclaw";
    registerFailingCodexHarness();

    expect(
      selectAgentHarness({
        provider: "codex",
        modelId: "gpt-5.4",
        agentHarnessId: "codex",
      }).id,
    ).toBe("codex");
  });

  it("skips harness compaction preflight for claude-cli runtime sessions", async () => {
    await expect(
      maybeCompactAgentHarnessSession({
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        provider: "anthropic",
        model: "claude-opus-4-7",
        config: agentModelRuntimeConfig("anthropic/claude-opus-4-7", "claude-cli"),
      }),
    ).resolves.toBeUndefined();
  });

  it("skips harness compaction preflight for claude-cli provider sessions", async () => {
    await expect(
      maybeCompactAgentHarnessSession({
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        provider: "claude-cli",
        model: "claude-opus-4-7",
        config: providerRuntimeConfig("claude-cli", "claude-cli"),
      }),
    ).resolves.toBeUndefined();
  });

  it("keeps host auth on the built-in OpenClaw compaction fallback", async () => {
    await expect(
      maybeCompactAgentHarnessSession(
        createCompactionParams({
          agentHarnessId: "openclaw",
          authProfileId: "openai:work",
          authProfileIdSource: "user",
          runtimeAuthPlan: {
            providerForAuth: "openai",
            authProfileProviderForAuth: "openai",
            forwardedAuthProfileId: "openai:work",
            forwardedAuthProfileSource: "user",
            selectedAuthMode: "api_key",
          },
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("uses the prepared custom route when selecting a compaction harness", async () => {
    const compact = registerTestCompactor({
      supports: (ctx) =>
        ctx.modelProvider?.api === OPENAI_CHATGPT_ROUTE.api &&
        ctx.modelProvider.baseUrl === OPENAI_CHATGPT_ROUTE.baseUrl
          ? { supported: true, priority: 100 }
          : { supported: false },
    });

    await expect(
      maybeCompactAgentHarnessSession(
        createCompactionParams({
          model: "gpt-5.5-custom",
          runtimeAuthPlan: {
            providerForAuth: "openai",
            authProfileProviderForAuth: "openai",
            modelRoute: {
              ...OPENAI_PLATFORM_ROUTE,
              modelId: "gpt-5.5-custom",
              baseUrl: "https://relay.example.test/v1",
            },
          },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(compact).not.toHaveBeenCalled();
  });

  it("uses the concrete prepared route without replacing harness auth bootstrap", async () => {
    const compact = registerTestCompactor({
      authBootstrap: "harness",
      supports: (ctx) =>
        ctx.modelProvider?.api === OPENAI_CHATGPT_ROUTE.api &&
        ctx.modelProvider.baseUrl === OPENAI_CHATGPT_ROUTE.baseUrl
          ? { supported: true, priority: 100 }
          : { supported: false },
    });

    await expect(
      maybeCompactAgentHarnessSession(
        createCompactionParams({
          runtimeAuthPlan: {
            providerForAuth: "openai",
            authProfileProviderForAuth: "openai",
            harnessAuthProvider: "openai",
            modelRoute: OPENAI_CHATGPT_ROUTE,
          },
        }),
      ),
    ).resolves.toEqual({ ok: true, compacted: false });

    expect(compactAuthMocks.resolveModelAsync).not.toHaveBeenCalled();
    expect(compactAuthMocks.getApiKeyForModel).not.toHaveBeenCalled();
    expect(compact).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeAuthPlan: expect.objectContaining({
          modelRoute: OPENAI_CHATGPT_ROUTE,
        }),
      }),
    );
  });

  it("forwards the prepared Platform key through harness-owned compaction", async () => {
    const compact = registerTestCompactor({ authBootstrap: "harness" });

    await expect(
      maybeCompactAgentHarnessSession(
        createCompactionParams({
          resolvedApiKey: "test-key",
          runtimeAuthPlan: {
            providerForAuth: "openai",
            authProfileProviderForAuth: "openai",
            harnessAuthProvider: "openai",
            selectedAuthMode: "api-key",
            modelRoute: OPENAI_PLATFORM_ROUTE,
          },
        }),
      ),
    ).resolves.toEqual({ ok: true, compacted: false });

    expect(compact).toHaveBeenCalledWith(
      expect.objectContaining({
        resolvedApiKey: "test-key",
        runtimeAuthPlan: expect.objectContaining({ modelRoute: OPENAI_PLATFORM_ROUTE }),
      }),
    );
  });

  it("keeps pinned plugin compaction when the outer provider no longer matches", async () => {
    const compact = vi.fn<NonNullable<AgentHarness["compact"]>>(async () => ({
      ok: true,
      compacted: false,
    }));
    registerAgentHarness(
      {
        id: "codex",
        label: "Codex",
        supports: (ctx) =>
          ctx.provider === "openai" ? { supported: true, priority: 100 } : { supported: false },
        runAttempt: vi.fn(async () => createAttemptResult("codex")),
        compact,
      },
      { ownerPluginId: "codex" },
    );

    await expect(
      maybeCompactAgentHarnessSession({
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        provider: "ollama",
        model: "llama3.3",
        agentHarnessId: "codex",
      }),
    ).resolves.toEqual({ ok: true, compacted: false });
    expect(compact).toHaveBeenCalledOnce();
  });

  it("fails closed when a pinned compaction harness is unavailable", async () => {
    await expect(
      maybeCompactAgentHarnessSession({
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        provider: "anthropic",
        model: "claude-opus-4-6",
        agentHarnessId: "codex",
      }),
    ).rejects.toThrow('Requested agent harness "codex" is not registered');
  });

  it("honors selected plugin harness pins during compaction preflight", async () => {
    const compact = vi.fn<NonNullable<AgentHarness["compact"]>>(async () => ({
      ok: true,
      compacted: false,
    }));
    registerAgentHarness(
      {
        id: "codex",
        label: "Codex",
        supports: (ctx) =>
          ctx.provider === "openai" ? { supported: true, priority: 100 } : { supported: false },
        runAttempt: vi.fn(async () => createAttemptResult("codex")),
        compact,
      },
      { ownerPluginId: "codex" },
    );
    await expect(
      maybeCompactAgentHarnessSession({
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        provider: "openai",
        model: "gpt-5.5",
        authProfileId: "main-profile",
        resolvedApiKey: "test-key",
        agentHarnessId: "codex",
        config: {
          agents: {
            list: [{ id: "main", default: true, agentDir: "/tmp/main-agent" }],
            defaults: {
              models: {
                "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } },
              },
            },
          },
        } as OpenClawConfig,
      }),
    ).resolves.toEqual({ ok: true, compacted: false });
    expect(compact).toHaveBeenCalledTimes(1);
    expect(compact.mock.calls[0]?.[0]).toMatchObject({
      agentDir: "/tmp/main-agent",
      agentId: "main",
      resolvedApiKey: "test-key",
      runtimeModel: {
        id: "gpt-5.5",
        provider: "openai",
      },
    });
  });

  it("routes internal post-context-engine compaction through the harness private capability", async () => {
    const compact = vi.fn<NonNullable<AgentHarness["compact"]>>(async () => ({
      ok: true,
      compacted: true,
    }));
    const compactAfterContextEngine = vi.fn(
      async (_params: AgentHarnessCompactParams): Promise<AgentHarnessCompactResult> => ({
        ok: true,
        compacted: false,
        result: {
          summary: "native follow-up queued",
          firstKeptEntryId: "entry-1",
          tokensBefore: 10,
          details: { request: "after_context_engine" },
        },
      }),
    );
    const harness: AgentHarness & {
      compactAfterContextEngine(
        params: AgentHarnessCompactParams,
      ): Promise<AgentHarnessCompactResult | undefined>;
    } = {
      id: "codex",
      label: "Codex",
      supports: (ctx) =>
        ctx.provider === "openai" ? { supported: true, priority: 100 } : { supported: false },
      runAttempt: vi.fn(async () => createAttemptResult("codex")),
      compact,
      compactAfterContextEngine,
    };
    registerAgentHarness(harness, { ownerPluginId: "codex" });

    await expect(
      maybeCompactAgentHarnessSession(
        {
          sessionId: "session-1",
          sessionKey: "agent:main:main",
          sessionFile: "/tmp/session.jsonl",
          workspaceDir: "/tmp/workspace",
          provider: "openai",
          model: "gpt-5.5",
          agentHarnessId: "codex",
        },
        { nativeCompactionRequest: "after_context_engine" },
      ),
    ).resolves.toEqual({
      ok: true,
      compacted: false,
      result: {
        summary: "native follow-up queued",
        firstKeptEntryId: "entry-1",
        tokensBefore: 10,
        details: { request: "after_context_engine" },
      },
    });
    expect(compact).not.toHaveBeenCalled();
    expect(compactAfterContextEngine).toHaveBeenCalledTimes(1);
  });

  it("skips internal post-context-engine compaction when the harness lacks the private capability", async () => {
    const compact = vi.fn<NonNullable<AgentHarness["compact"]>>(async () => ({
      ok: true,
      compacted: true,
    }));
    registerAgentHarness(
      {
        id: "codex",
        label: "Codex",
        supports: (ctx) =>
          ctx.provider === "openai" ? { supported: true, priority: 100 } : { supported: false },
        runAttempt: vi.fn(async () => createAttemptResult("codex")),
        compact,
      },
      { ownerPluginId: "codex" },
    );

    await expect(
      maybeCompactAgentHarnessSession(
        {
          sessionId: "session-1",
          sessionKey: "agent:main:main",
          sessionFile: "/tmp/session.jsonl",
          workspaceDir: "/tmp/workspace",
          provider: "openai",
          model: "gpt-5.5",
          agentHarnessId: "codex",
        },
        { nativeCompactionRequest: "after_context_engine" },
      ),
    ).resolves.toBeUndefined();
    expect(compact).not.toHaveBeenCalled();
  });

  it("keeps compaction recoverable when auth profile lookup fails", async () => {
    compactAuthMocks.getApiKeyForModel.mockRejectedValue(new Error("missing auth profile"));
    const compact = vi.fn<NonNullable<AgentHarness["compact"]>>(async () => ({
      ok: true,
      compacted: false,
    }));
    registerAgentHarness(
      {
        id: "codex",
        label: "Codex",
        supports: (ctx) =>
          ctx.provider === "openai" ? { supported: true, priority: 100 } : { supported: false },
        runAttempt: vi.fn(async () => createAttemptResult("codex")),
        compact,
      },
      { ownerPluginId: "codex" },
    );

    await expect(
      maybeCompactAgentHarnessSession({
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        provider: "openai",
        model: "gpt-5.5",
        authProfileId: "deleted-profile",
        agentHarnessId: "codex",
        config: agentModelRuntimeConfig("openai/gpt-5.5", "openclaw"),
      }),
    ).resolves.toEqual({ ok: true, compacted: false });
    expect(compact).toHaveBeenCalledTimes(1);
    expect(compact.mock.calls[0]?.[0]).not.toHaveProperty("resolvedApiKey");
    expect(compactAuthMocks.resolveModelAsync).toHaveBeenCalledWith(
      "openai",
      "gpt-5.5",
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({
        authProfileId: "deleted-profile",
        workspaceDir: "/tmp/workspace",
      }),
    );
  });

  it("preserves resolved compaction credentials when model lookup fails", async () => {
    compactAuthMocks.resolveModelAsync.mockRejectedValue(new Error("model lookup unavailable"));
    const compact = vi.fn<NonNullable<AgentHarness["compact"]>>(async () => ({
      ok: true,
      compacted: false,
    }));
    registerAgentHarness(
      {
        id: "copilot",
        label: "Copilot",
        supports: (ctx) =>
          ctx.provider === "local-proxy"
            ? { supported: true, priority: 100 }
            : { supported: false },
        runAttempt: vi.fn(async () => createAttemptResult("copilot")),
        compact,
      },
      { ownerPluginId: "copilot" },
    );

    await expect(
      maybeCompactAgentHarnessSession({
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        provider: "local-proxy",
        model: "proxy-model",
        resolvedApiKey: "already-resolved",
        agentHarnessId: "copilot",
      }),
    ).resolves.toEqual({ ok: true, compacted: false });

    expect(compactAuthMocks.getApiKeyForModel).not.toHaveBeenCalled();
    expect(compact).toHaveBeenCalledWith(
      expect.objectContaining({
        resolvedApiKey: "already-resolved",
      }),
    );
  });

  it("fails closed when route preparation cannot protect harness-owned compaction auth", async () => {
    compactAuthMocks.resolveModelAsync.mockRejectedValue(new Error("model lookup unavailable"));
    const compact = registerTestCompactor({ authBootstrap: "harness" });

    await expect(
      maybeCompactAgentHarnessSession(
        createCompactionParams({
          agentHarnessId: "codex",
          resolvedApiKey: "must-not-reach-ambient-auth",
        }),
      ),
    ).rejects.toThrow("refusing harness-owned ambient auth");
    expect(compact).not.toHaveBeenCalled();
  });

  it("passes runtime model and default credentials to compaction when auth profile id is absent", async () => {
    compactAuthMocks.resolveModelAsync.mockResolvedValue({
      model: {
        id: "proxy-model",
        provider: "local-proxy",
        api: "openai-responses",
        baseUrl: "https://proxy.example/v1",
      },
    });
    const compact = vi.fn<NonNullable<AgentHarness["compact"]>>(async () => ({
      ok: true,
      compacted: false,
    }));
    registerAgentHarness(
      {
        id: "copilot",
        label: "Copilot",
        supports: (ctx) =>
          ctx.provider === "local-proxy"
            ? { supported: true, priority: 100 }
            : { supported: false },
        runAttempt: vi.fn(async () => createAttemptResult("copilot")),
        compact,
      },
      { ownerPluginId: "copilot" },
    );

    await expect(
      maybeCompactAgentHarnessSession({
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        provider: "local-proxy",
        model: "proxy-model",
        agentHarnessId: "copilot",
      }),
    ).resolves.toEqual({ ok: true, compacted: false });

    expect(compactAuthMocks.resolveModelAsync).toHaveBeenCalledWith(
      "local-proxy",
      "proxy-model",
      expect.any(String),
      undefined,
      expect.objectContaining({
        authProfileId: undefined,
        workspaceDir: "/tmp/workspace",
      }),
    );
    expect(compactAuthMocks.getApiKeyForModel).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: expect.any(String),
        model: expect.objectContaining({
          baseUrl: "https://proxy.example/v1",
          id: "proxy-model",
        }),
        workspaceDir: "/tmp/workspace",
      }),
    );
    expect(compact).toHaveBeenCalledWith(
      expect.objectContaining({
        resolvedApiKey: "test-key",
        runtimeModel: expect.objectContaining({
          baseUrl: "https://proxy.example/v1",
          id: "proxy-model",
        }),
      }),
    );
  });

  it("does not compact a selected plugin harness through OpenClaw when the plugin has no compactor", async () => {
    registerFailingCodexHarness();

    await expect(
      maybeCompactAgentHarnessSession({
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        provider: "codex",
        model: "gpt-5.5",
        agentHarnessId: "codex",
      }),
    ).resolves.toEqual({
      ok: false,
      compacted: false,
      reason: 'Agent harness "codex" does not support compaction.',
      failure: { reason: "unsupported_harness_compaction" },
    });
  });

  it("uses agent-scoped runtime policy during compaction preflight", async () => {
    const compact = vi.fn<NonNullable<AgentHarness["compact"]>>(async () => ({
      ok: true,
      compacted: false,
    }));
    registerAgentHarness(
      {
        id: "codex",
        label: "Codex",
        supports: (ctx) =>
          ctx.provider === "openai" ? { supported: true, priority: 100 } : { supported: false },
        runAttempt: vi.fn(async () => createAttemptResult("codex")),
        compact,
      },
      { ownerPluginId: "codex" },
    );

    await expect(
      maybeCompactAgentHarnessSession({
        sessionId: "session-1",
        sessionKey: "agent:strict:main",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        provider: "openai",
        model: "gpt-5.5",
        agentId: "strict",
        config: agentModelRuntimeConfig("openai/gpt-5.5", "codex", "strict"),
      }),
    ).resolves.toEqual({ ok: true, compacted: false });
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("uses sandbox session key for compaction preflight runtime policy", async () => {
    const compact = vi.fn<NonNullable<AgentHarness["compact"]>>(async () => ({
      ok: true,
      compacted: false,
    }));
    registerAgentHarness(
      {
        id: "codex",
        label: "Codex",
        supports: (ctx) =>
          ctx.provider === "openai" ? { supported: true, priority: 100 } : { supported: false },
        runAttempt: vi.fn(async () => createAttemptResult("codex")),
        compact,
      },
      { ownerPluginId: "codex" },
    );

    await expect(
      maybeCompactAgentHarnessSession({
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        sandboxSessionKey: "agent:strict:main",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        provider: "openai",
        model: "gpt-5.5",
        agentId: "main",
        config: agentModelRuntimeConfig("openai/gpt-5.5", "codex", "strict"),
      }),
    ).resolves.toEqual({ ok: true, compacted: false });
    expect(compact).toHaveBeenCalledTimes(1);
    expect(compact.mock.calls[0]?.[0]).toMatchObject({ agentId: "main" });
  });

  it("keeps explicit agent id for non-agent sandbox policy keys during compaction preflight", async () => {
    const compact = vi.fn<NonNullable<AgentHarness["compact"]>>(async () => ({
      ok: true,
      compacted: false,
    }));
    registerAgentHarness(
      {
        id: "codex",
        label: "Codex",
        supports: (ctx) =>
          ctx.provider === "openai" ? { supported: true, priority: 100 } : { supported: false },
        runAttempt: vi.fn(async () => createAttemptResult("codex")),
        compact,
      },
      { ownerPluginId: "codex" },
    );

    await expect(
      maybeCompactAgentHarnessSession({
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        sandboxSessionKey: "global",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        provider: "openai",
        model: "gpt-5.5",
        agentId: "strict",
        config: agentModelRuntimeConfig("openai/gpt-5.5", "codex", "strict"),
      }),
    ).resolves.toEqual({ ok: true, compacted: false });
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it.each([
    { provider: "anthropic", modelId: "sonnet-4.6", alias: "claude-cli" },
    { provider: "google", modelId: "gemini-3-pro-preview", alias: "google-gemini-cli" },
  ])(
    "returns OpenClaw for explicit CLI runtime alias $alias on $provider instead of throwing MissingAgentHarnessError",
    ({ provider, modelId, alias }) => {
      expect(
        selectAgentHarness({
          provider,
          modelId,
          agentHarnessRuntimeOverride: alias,
        }).id,
      ).toBe("openclaw");
    },
  );

  it("still throws MissingAgentHarnessError for an explicit non-CLI unknown runtime", () => {
    expect(() =>
      selectAgentHarness({
        provider: "anthropic",
        modelId: "sonnet-4.6",
        agentHarnessRuntimeOverride: "clade-cli",
      }),
    ).toThrow('Requested agent harness "clade-cli" is not registered');
  });

  it("still throws MissingAgentHarnessError for an explicit CLI alias owned by another provider", () => {
    expect(() =>
      selectAgentHarness({
        provider: "anthropic",
        modelId: "sonnet-4.6",
        agentHarnessRuntimeOverride: "google-gemini-cli",
      }),
    ).toThrow('Requested agent harness "google-gemini-cli" is not registered');
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
