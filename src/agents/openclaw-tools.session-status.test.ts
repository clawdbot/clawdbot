import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { resolvePreferredSessionKeyForSessionIdMatches } from "../sessions/session-id-resolution.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import { buildTaskStatusSnapshot } from "../tasks/task-status.js";

const loadSessionStoreMock = vi.fn();
const updateSessionStoreMock = vi.fn();
const callGatewayMock = vi.fn();
const loadCombinedSessionStoreForGatewayMock = vi.fn();
const buildStatusMessageMock = vi.hoisted(() =>
  vi.fn((_params?: unknown) => "OpenClaw\n🧠 Model: GPT-5.4"),
);
const resolveQueueSettingsMock = vi.hoisted(() =>
  vi.fn((_params?: unknown) => ({ mode: "interrupt" })),
);
const listTasksForRelatedSessionKeyForOwnerMock = vi.hoisted(() =>
  vi.fn(
    (_: { relatedSessionKey: string; callerOwnerKey: string }) =>
      [] as Array<Record<string, unknown>>,
  ),
);
const resolveEnvApiKeyMock = vi.hoisted(() =>
  vi.fn((_provider?: string, _env?: NodeJS.ProcessEnv) => null),
);
const resolveUsableCustomProviderApiKeyMock = vi.hoisted(() =>
  vi.fn((_params?: { provider?: string }) => null as { apiKey: string; source: string } | null),
);
const emptyPluginMetadataSnapshot = vi.hoisted(() => ({
  configFingerprint: "session-status-test-empty-plugin-metadata",
  plugins: [],
}));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const createMockConfig = () => ({
  session: { mainKey: "main", scope: "per-sender" },
  agents: {
    defaults: {
      model: { primary: "openai/gpt-5.4" },
      models: {},
    },
  },
  tools: {
    agentToAgent: { enabled: false },
  },
});

let mockConfig: Record<string, unknown> = createMockConfig();
const TASK_STATUS_SNAPSHOT_NOW = 1_000_000_000_000;

function createScopedSessionStores() {
  return new Map<string, Record<string, unknown>>([
    [
      "/tmp/main/sessions.json",
      {
        "agent:main:main": { sessionId: "s-main", updatedAt: 10 },
      },
    ],
    [
      "/tmp/support/sessions.json",
      {
        main: { sessionId: "s-support", updatedAt: 20 },
      },
    ],
  ]);
}

function installScopedSessionStores(syncUpdates = false) {
  const stores = createScopedSessionStores();
  loadSessionStoreMock.mockClear();
  updateSessionStoreMock.mockClear();
  callGatewayMock.mockClear();
  loadCombinedSessionStoreForGatewayMock.mockClear();
  loadSessionStoreMock.mockImplementation((storePath: string) => stores.get(storePath) ?? {});
  loadCombinedSessionStoreForGatewayMock.mockReturnValue({
    storePath: "(multiple)",
    store: Object.fromEntries([...stores.values()].flatMap((store) => Object.entries(store))),
  });
  if (syncUpdates) {
    updateSessionStoreMock.mockImplementation(
      (storePath: string, store: Record<string, unknown>) => {
        if (storePath) {
          stores.set(storePath, store);
        }
      },
    );
  }
  return stores;
}

async function createSessionsModuleMock() {
  const actual =
    await vi.importActual<typeof import("../config/sessions.js")>("../config/sessions.js");
  return {
    ...actual,
    loadSessionStore: (storePath: string) => loadSessionStoreMock(storePath),
    updateSessionStore: async (
      storePath: string,
      mutator: (store: Record<string, unknown>) => Promise<void> | void,
    ) => {
      const store = loadSessionStoreMock(storePath) as Record<string, unknown>;
      await mutator(store);
      updateSessionStoreMock(storePath, store);
      return store;
    },
    resolveStorePath: (_store: string | undefined, opts?: { agentId?: string }) =>
      opts?.agentId === "support" ? "/tmp/support/sessions.json" : "/tmp/main/sessions.json",
  };
}

function createGatewayCallModuleMock() {
  return {
    callGateway: (opts: unknown) => callGatewayMock(opts),
  };
}

async function createGatewaySessionUtilsModuleMock() {
  const actual = await vi.importActual<typeof import("../gateway/session-utils.js")>(
    "../gateway/session-utils.js",
  );
  return {
    ...actual,
    loadCombinedSessionStoreForGateway: (cfg: unknown) =>
      loadCombinedSessionStoreForGatewayMock(cfg),
  };
}

async function createConfigModuleMock() {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: () => mockConfig,
  };
}

function createModelCatalogModuleMock() {
  return {
    loadModelCatalog: async () => [
      {
        provider: "anthropic",
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        contextWindow: 200000,
      },
      {
        provider: "openai",
        id: "gpt-5.4",
        name: "GPT-5.4",
        reasoning: true,
        contextWindow: 400000,
      },
    ],
  };
}

function createAuthProfilesModuleMock() {
  return {
    ensureAuthProfileStore: () => ({ profiles: {} }),
    resolveAuthProfileDisplayLabel: () => undefined,
    resolveAuthProfileOrder: () => [],
  };
}

function createModelAuthModuleMock() {
  return {
    resolveEnvApiKey: resolveEnvApiKeyMock,
    resolveUsableCustomProviderApiKey: resolveUsableCustomProviderApiKeyMock,
    resolveModelAuthMode: () => "api-key",
  };
}

function createProviderUsageModuleMock() {
  return {
    resolveUsageProviderId: () => undefined,
    loadProviderUsageSummary: async () => ({
      updatedAt: Date.now(),
      providers: [],
    }),
    formatUsageSummaryLine: () => null,
  };
}

function formatPrimaryModelLabel(provider: string | undefined, model: string): string {
  return provider ? `${provider}/${model}` : model;
}

function formatStatusLines(primary: string, taskLineOverride: string | undefined): string {
  return taskLineOverride
    ? `OpenClaw\n🧠 Model: ${primary}\n${taskLineOverride}`
    : `OpenClaw\n🧠 Model: ${primary}`;
}

function createCommandsStatusRuntimeModuleMock() {
  return {
    buildStatusText: async (params: {
      sessionKey: string;
      sessionEntry: SessionEntry;
      statusChannel: string;
      provider?: string;
      model: string;
      workspaceDir?: string;
      primaryModelLabelOverride?: string;
      includeTranscriptUsage?: boolean;
      taskLineOverride?: string;
      resolveDefaultThinkingLevel?: () => unknown;
    }) => {
      resolveQueueSettingsMock({
        channel: params.statusChannel,
        sessionEntry: params.sessionEntry,
      });
      const parsed = params.sessionKey.startsWith("agent:") ? params.sessionKey.split(":") : null;
      const agentId = parsed?.[1] || "main";
      const configuredAgent = Array.isArray(
        (mockConfig as { agents?: { list?: Array<Record<string, unknown>> } }).agents?.list,
      )
        ? (mockConfig as { agents?: { list?: Array<Record<string, unknown>> } }).agents?.list?.find(
            (entry) => entry.id === agentId,
          )
        : undefined;
      const primary =
        params.primaryModelLabelOverride ?? formatPrimaryModelLabel(params.provider, params.model);
      const customAuth = params.provider
        ? resolveUsableCustomProviderApiKeyMock({ provider: params.provider })
        : null;
      const envAuth =
        !customAuth && params.provider ? resolveEnvApiKeyMock(params.provider, process.env) : null;
      const modelAuth = customAuth
        ? `api-key (${customAuth.source})`
        : envAuth
          ? "api-key (env)"
          : undefined;
      buildStatusMessageMock({
        agentId,
        agent: {
          model: { primary },
          thinkingDefault:
            configuredAgent?.thinkingDefault ?? (await params.resolveDefaultThinkingLevel?.()),
        },
        sessionEntry: params.sessionEntry,
        modelAuth,
        includeTranscriptUsage: params.includeTranscriptUsage,
        workspaceDir: params.workspaceDir,
      });
      return formatStatusLines(primary, params.taskLineOverride);
    },
  };
}

vi.mock("../config/sessions.js", createSessionsModuleMock);
vi.mock("../gateway/call.js", createGatewayCallModuleMock);
vi.mock("../gateway/session-utils.js", createGatewaySessionUtilsModuleMock);
vi.mock("../config/config.js", createConfigModuleMock);
vi.mock("../agents/model-catalog.js", createModelCatalogModuleMock);
vi.mock("../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: () => undefined,
}));
vi.mock("../plugins/current-plugin-metadata-snapshot.js", () => ({
  getCurrentPluginMetadataSnapshot: () => emptyPluginMetadataSnapshot,
}));
// Keep provider-runtime/plugin activation out of this focused tool test. The
// session_status surface only needs model selection semantics here, not real
// bundled provider registration.
vi.mock("../plugins/providers.runtime.js", () => ({
  resolvePluginProviders: () => [],
}));
vi.mock("../agents/auth-profiles.js", createAuthProfilesModuleMock);
vi.mock("../agents/model-auth.js", createModelAuthModuleMock);
vi.mock("../infra/provider-usage.js", createProviderUsageModuleMock);
vi.mock("./tools/session-status.runtime.js", createCommandsStatusRuntimeModuleMock);
vi.mock("../auto-reply/group-activation.js", () => ({
  normalizeGroupActivation: (value: unknown) => value ?? "always",
}));
vi.mock("../auto-reply/reply/queue.js", () => ({
  getFollowupQueueDepth: () => 0,
  resolveQueueSettings: resolveQueueSettingsMock,
}));
vi.mock("../auto-reply/status.js", () => ({
  buildStatusMessage: buildStatusMessageMock,
}));
vi.mock("../tasks/task-owner-access.js", () => ({
  listTasksForRelatedSessionKeyForOwner: (params: {
    relatedSessionKey: string;
    callerOwnerKey: string;
  }) => listTasksForRelatedSessionKeyForOwnerMock(params),
  buildTaskStatusSnapshotForRelatedSessionKeyForOwner: (params: {
    relatedSessionKey: string;
    callerOwnerKey: string;
  }) =>
    buildTaskStatusSnapshot(listTasksForRelatedSessionKeyForOwnerMock(params) as TaskRecord[], {
      now: TASK_STATUS_SNAPSHOT_NOW,
    }),
}));

let createSessionStatusTool: typeof import("./tools/session-status-tool.js").createSessionStatusTool;

beforeAll(async () => {
  ({ createSessionStatusTool } = await import("./tools/session-status-tool.js"));
});

function resetSessionStore(store: Record<string, SessionEntry>) {
  buildStatusMessageMock.mockClear();
  resolveQueueSettingsMock.mockClear();
  resolveQueueSettingsMock.mockReturnValue({ mode: "interrupt" });
  resolveEnvApiKeyMock.mockReset();
  resolveEnvApiKeyMock.mockReturnValue(null);
  resolveUsableCustomProviderApiKeyMock.mockReset();
  resolveUsableCustomProviderApiKeyMock.mockReturnValue(null);
  loadSessionStoreMock.mockClear();
  updateSessionStoreMock.mockClear();
  callGatewayMock.mockClear();
  loadCombinedSessionStoreForGatewayMock.mockClear();
  listTasksForRelatedSessionKeyForOwnerMock.mockClear();
  listTasksForRelatedSessionKeyForOwnerMock.mockReturnValue([]);
  loadSessionStoreMock.mockReturnValue(store);
  loadCombinedSessionStoreForGatewayMock.mockReturnValue({
    storePath: "(multiple)",
    store,
  });
  callGatewayMock.mockImplementation(async (opts: unknown) => {
    const request = opts as { method?: string; params?: Record<string, unknown> };
    if (request.method === "sessions.resolve") {
      const key = typeof request.params?.key === "string" ? request.params.key.trim() : "";
      if (key && store[key]) {
        return { key };
      }
      const sessionId =
        typeof request.params?.sessionId === "string" ? request.params.sessionId.trim() : "";
      if (!sessionId) {
        return {};
      }
      const spawnedBy =
        typeof request.params?.spawnedBy === "string" ? request.params.spawnedBy.trim() : "";
      const matches = Object.entries(store).filter((entry): entry is [string, SessionEntry] => {
        return (
          entry[1].sessionId === sessionId &&
          (!spawnedBy ||
            entry[1].spawnedBy === spawnedBy ||
            entry[1].parentSessionKey === spawnedBy)
        );
      });
      return { key: resolvePreferredSessionKeyForSessionIdMatches(matches, sessionId) };
    }
    if (request.method === "sessions.list") {
      return { sessions: [] };
    }
    return {};
  });
  mockConfig = createMockConfig();
}

function installSandboxedSessionStatusConfig() {
  mockConfig = {
    session: { mainKey: "main", scope: "per-sender" },
    tools: {
      sessions: { visibility: "all" },
      agentToAgent: { enabled: true, allow: ["*"] },
    },
    agents: {
      defaults: {
        model: { primary: "openai/gpt-5.4" },
        models: {},
        sandbox: { sessionToolsVisibility: "spawned" },
      },
    },
  };
}

function mockSpawnedSessionList(
  resolveSessions: (spawnedBy: string | undefined) => Array<Record<string, unknown>>,
) {
  callGatewayMock.mockImplementation(async (opts: unknown) => {
    const request = opts as { method?: string; params?: Record<string, unknown> };
    if (request.method === "sessions.list") {
      return { sessions: resolveSessions(request.params?.spawnedBy as string | undefined) };
    }
    return {};
  });
}

function expectSpawnedSessionLookupCalls(spawnedBy: string) {
  const expectedCall = {
    method: "sessions.list",
    params: {
      includeGlobal: false,
      includeUnknown: false,
      spawnedBy,
    },
  };
  expect(callGatewayMock).toHaveBeenCalledTimes(2);
  expect(callGatewayMock).toHaveBeenNthCalledWith(1, expectedCall);
  expect(callGatewayMock).toHaveBeenNthCalledWith(2, expectedCall);
}

function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0) {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[argIndex];
}

function getSessionStatusTool(
  agentSessionKey = "main",
  options?: { sandboxed?: boolean; activeModelProvider?: string; activeModelId?: string },
) {
  const tool = createSessionStatusTool({
    agentSessionKey,
    sandboxed: options?.sandboxed,
    activeModelProvider: options?.activeModelProvider,
    activeModelId: options?.activeModelId,
    config: mockConfig as never,
  });
  expect(tool.name).toBe("session_status");
  return tool;
}

describe("session_status tool", () => {
  beforeEach(() => {
    buildStatusMessageMock.mockClear();
  });

  it("returns a status card for the current session", async () => {
    resetSessionStore({
      main: {
        sessionId: "s1",
        updatedAt: 10,
      },
    });

    const tool = getSessionStatusTool();

    const result = await tool.execute("call1", {});
    const details = result.details as { ok?: boolean; statusText?: string };
    expect(details.ok).toBe(true);
    expect(details.statusText).toContain("OpenClaw");
    expect(details.statusText).toContain("🧠 Model:");
    expect(details.statusText).not.toContain("OAuth/token status");
  });

  it("enables transcript usage fallback for session_status", async () => {
    resetSessionStore({
      main: {
        sessionId: "s1",
        updatedAt: 10,
      },
    });

    const tool = getSessionStatusTool();

    await tool.execute("call-transcript-usage", {});

    expectRecordFields(mockCallArg(buildStatusMessageMock), { includeTranscriptUsage: true });
  });

  it("passes spawned workspace to session_status auth labels", async () => {
    resetSessionStore({
      "agent:main:spawned": {
        sessionId: "spawned-status",
        updatedAt: 10,
        spawnedWorkspaceDir: "/tmp/openclaw-spawned-workspace",
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-6",
      },
    });

    const tool = getSessionStatusTool("agent:main:spawned");

    await tool.execute("call-spawned-workspace-status", {});

    expectRecordFields(mockCallArg(buildStatusMessageMock), {
      workspaceDir: "/tmp/openclaw-spawned-workspace",
    });
  });

  it("errors for unknown session keys", async () => {
    resetSessionStore({
      main: { sessionId: "s1", updatedAt: 10 },
    });

    const tool = getSessionStatusTool();

    await expect(tool.execute("call2", { sessionKey: "nope" })).rejects.toThrow(
      "Unknown sessionId",
    );
    expect(updateSessionStoreMock).not.toHaveBeenCalled();
  });

  it("resolves sessionKey=current to the requester session", async () => {
    resetSessionStore({
      main: {
        sessionId: "s1",
        updatedAt: 10,
      },
    });

    const tool = getSessionStatusTool();

    const result = await tool.execute("call-current", { sessionKey: "current" });
    const details = result.details as { ok?: boolean; sessionKey?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("main");
  });

  it("resolves sessionKey=current to the requester agent session", async () => {
    installScopedSessionStores();

    const tool = getSessionStatusTool("agent:support:main");

    // "current" resolves to the support agent's own session via the "main" alias.
    const result = await tool.execute("call-current-child", { sessionKey: "current" });
    const details = result.details as { ok?: boolean; sessionKey?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("main");
  });

  it("resolves sessionKey=current to runSessionKey under default tree visibility (#76708)", async () => {
    resetSessionStore({
      "agent:main:telegram:default:direct:1234": {
        sessionId: "s-tg-direct",
        updatedAt: 5,
        status: "done",
      },
      "agent:main:main": {
        sessionId: "s-main",
        updatedAt: 10,
        status: "running",
      },
    });

    // Default visibility is "tree". The tool is constructed with the Telegram
    // sandbox key as agentSessionKey but the live run session key as runSessionKey.
    // semantic-current must be treated as self for visibility purposes.
    const tool = createSessionStatusTool({
      agentSessionKey: "agent:main:telegram:default:direct:1234",
      runSessionKey: "agent:main:main",
      config: mockConfig as never,
    });

    const result = await tool.execute("call-current-run-session", { sessionKey: "current" });
    const details = result.details as { ok?: boolean; sessionKey?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("agent:main:main");
  });

  it("synthesizes semantic current from runSessionKey when the live run is not persisted yet", async () => {
    resetSessionStore({
      "agent:main:telegram:default:direct:1234": {
        sessionId: "s-tg-direct",
        updatedAt: 5,
        status: "done",
      },
    });

    const tool = createSessionStatusTool({
      agentSessionKey: "agent:main:telegram:default:direct:1234",
      runSessionKey: "agent:main:main",
      config: mockConfig as never,
    });

    const result = await tool.execute("call-current-unpersisted-run", { sessionKey: "current" });
    const details = result.details as { ok?: boolean; sessionKey?: string; statusText?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("agent:main:main");
    expect(details.statusText).toContain("OpenClaw");
  });

  it("rejects explicit cross-session key under tree visibility even when it equals runSessionKey (#76708)", async () => {
    resetSessionStore({
      "agent:main:telegram:default:direct:1234": {
        sessionId: "s-tg-direct",
        updatedAt: 5,
        status: "done",
      },
      "agent:main:main": {
        sessionId: "s-main",
        updatedAt: 10,
        status: "running",
      },
    });

    // Same setup but with an explicit key — should NOT bypass visibility.
    const tool = createSessionStatusTool({
      agentSessionKey: "agent:main:telegram:default:direct:1234",
      runSessionKey: "agent:main:main",
      config: mockConfig as never,
    });

    await expect(
      tool.execute("call-explicit-key", { sessionKey: "agent:main:main" }),
    ).rejects.toThrow(/visibility is restricted/);
  });

  it("treats the TUI client label as the current requester session", async () => {
    resetSessionStore({
      "agent:main:main": {
        sessionId: "s-main",
        updatedAt: 10,
      },
    });

    const tool = getSessionStatusTool("agent:main:main");

    const result = await tool.execute("call-tui-label", { sessionKey: "openclaw-tui" });
    const details = result.details as { ok?: boolean; sessionKey?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("agent:main:main");
  });

  it("falls back from implicit default-account direct policy keys to persisted direct sessions", async () => {
    resetSessionStore({
      "agent:main:telegram:direct:1053274893": {
        sessionId: "s-direct",
        updatedAt: 10,
      },
    });

    const tool = getSessionStatusTool("agent:main:telegram:default:direct:1053274893");

    const result = await tool.execute("call-default-direct", {});
    const details = result.details as { ok?: boolean; sessionKey?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("agent:main:telegram:direct:1053274893");
  });

  it("falls back from implicit default-account direct policy keys to main sessions", async () => {
    resetSessionStore({
      "agent:main:main": {
        sessionId: "s-main",
        updatedAt: 10,
      },
    });

    const tool = getSessionStatusTool("agent:main:telegram:default:direct:1053274893");

    const result = await tool.execute("call-default-direct-main", {});
    const details = result.details as { ok?: boolean; sessionKey?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("agent:main:main");
  });

  it("keeps explicit default-account direct session lookups strict", async () => {
    resetSessionStore({
      "agent:main:main": {
        sessionId: "s-main",
        updatedAt: 10,
      },
    });

    const tool = getSessionStatusTool("agent:main:telegram:default:direct:1053274893");

    await expect(
      tool.execute("call-default-direct-explicit", {
        sessionKey: "agent:main:telegram:default:direct:1053274893",
      }),
    ).rejects.toThrow("Unknown sessionKey: agent:main:telegram:default:direct:1053274893");
  });

  it("prefers a literal current session key in session_status", async () => {
    resetSessionStore({
      main: {
        sessionId: "s-main",
        updatedAt: 10,
      },
      "agent:main:current": {
        sessionId: "s-current",
        updatedAt: 20,
      },
    });

    const tool = getSessionStatusTool();

    const result = await tool.execute("call-current-literal-key", { sessionKey: "current" });
    const details = result.details as { ok?: boolean; sessionKey?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("agent:main:current");
  });

  it("does not apply the active run model to a literal current session key", async () => {
    resetSessionStore({
      main: {
        sessionId: "s-main",
        updatedAt: 10,
      },
      "agent:main:current": {
        sessionId: "s-current",
        updatedAt: 20,
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-6",
      },
    });

    const tool = getSessionStatusTool("main", {
      activeModelProvider: "openai-codex",
      activeModelId: "gpt-5.2",
    });

    const result = await tool.execute("call-current-literal-key-active-model", {
      sessionKey: "current",
    });
    const details = result.details as { ok?: boolean; sessionKey?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("agent:main:current");

    const statusArg = mockCallArg(buildStatusMessageMock) as Record<string, unknown>;
    expectRecordFields(statusArg.sessionEntry, {
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-6",
    });
    const agent = statusArg.agent as Record<string, unknown>;
    const model = agent.model as Record<string, unknown>;
    expect(model.primary).not.toBe("openai-codex/gpt-5.2");
  });

  it("resolves sessionKey=current for a channel-plugin requester via implicit fallback", async () => {
    resetSessionStore({});

    const tool = getSessionStatusTool("agent:main:scope:scopy:direct:scopy");

    const result = await tool.execute("call-current-channel-plugin", { sessionKey: "current" });
    const details = result.details as { ok?: boolean; sessionKey?: string; statusText?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("agent:main:scope:scopy:direct:scopy");
    expect(details.statusText).toContain("OpenClaw");
    expect(details.statusText).toContain("🧠 Model:");
  });

  it("resolves sandboxed sessionKey=current to the requester when no run session override exists", async () => {
    resetSessionStore({});

    const tool = getSessionStatusTool("agent:main:telegram:group:-5096326138", {
      sandboxed: true,
    });

    const result = await tool.execute("call-current-sandboxed-channel", {
      sessionKey: "current",
    });
    const details = result.details as { ok?: boolean; sessionKey?: string; statusText?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("agent:main:telegram:group:-5096326138");
    expect(details.statusText).toContain("OpenClaw");
    expect(details.statusText).toContain("🧠 Model:");
    expect(
      callGatewayMock.mock.calls.some(([arg]) => {
        const request = arg as { method?: string; params?: { key?: string } };
        return request.method === "sessions.resolve" && request.params?.key === "current";
      }),
    ).toBe(false);
  });

  it("resolves the default session_status lookup for a channel-plugin requester via implicit fallback", async () => {
    resetSessionStore({});

    const tool = getSessionStatusTool("agent:main:scope:scopy:direct:scopy");

    const result = await tool.execute("call-current-channel-plugin-default", {});
    const details = result.details as { ok?: boolean; sessionKey?: string; statusText?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("agent:main:scope:scopy:direct:scopy");
    expect(details.statusText).toContain("OpenClaw");
    expect(details.statusText).toContain("🧠 Model:");
  });

  it("renders the active run model for semantic current lookups", async () => {
    resetSessionStore({
      "agent:main:scope:scopy:direct:scopy": {
        sessionId: "current-active-model",
        updatedAt: 10,
      },
    });

    const tool = getSessionStatusTool("agent:main:scope:scopy:direct:scopy", {
      activeModelProvider: "openai-codex",
      activeModelId: "gpt-5.2",
    });

    await tool.execute("call-current-active-model", { sessionKey: "current" });

    const statusArg = mockCallArg(buildStatusMessageMock) as Record<string, unknown>;
    const agent = statusArg.agent as Record<string, unknown>;
    expectRecordFields(agent.model, { primary: "openai-codex/gpt-5.2" });
  });

  it("renders the active run model for omitted sessionKey lookups", async () => {
    resetSessionStore({
      "agent:main:scope:scopy:direct:scopy": {
        sessionId: "implicit-current-active-model",
        updatedAt: 10,
      },
    });

    const tool = getSessionStatusTool("agent:main:scope:scopy:direct:scopy", {
      activeModelProvider: "openai-codex",
      activeModelId: "gpt-5.2",
    });

    await tool.execute("call-implicit-current-active-model", {});

    const statusArg = mockCallArg(buildStatusMessageMock) as Record<string, unknown>;
    const agent = statusArg.agent as Record<string, unknown>;
    expectRecordFields(agent.model, { primary: "openai-codex/gpt-5.2" });
  });

  it("renders the active run model for current lookups with persisted overrides", async () => {
    resetSessionStore({
      "agent:main:scope:scopy:direct:scopy": {
        sessionId: "current-active-model-with-override",
        updatedAt: 10,
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-6",
      },
    });

    const tool = getSessionStatusTool("agent:main:scope:scopy:direct:scopy", {
      activeModelProvider: "openai-codex",
      activeModelId: "gpt-5.2",
    });

    await tool.execute("call-current-active-model-with-override", { sessionKey: "current" });

    const statusArg = mockCallArg(buildStatusMessageMock) as Record<string, unknown>;
    const sessionEntry = statusArg.sessionEntry as Record<string, unknown>;
    expect(sessionEntry.providerOverride).toBeUndefined();
    expect(sessionEntry.modelOverride).toBeUndefined();
    const agent = statusArg.agent as Record<string, unknown>;
    expectRecordFields(agent.model, { primary: "openai-codex/gpt-5.2" });
  });

  it("does not reuse the active run model after a semantic current reset", async () => {
    resetSessionStore({
      "agent:main:scope:scopy:direct:scopy": {
        sessionId: "current-reset-model",
        updatedAt: 10,
        providerOverride: "openai-codex",
        modelOverride: "gpt-5.2",
      },
    });

    const tool = getSessionStatusTool("agent:main:scope:scopy:direct:scopy", {
      activeModelProvider: "openai-codex",
      activeModelId: "gpt-5.2",
    });

    await tool.execute("call-current-reset-model", {
      sessionKey: "current",
      model: "default",
    });

    const statusArg = mockCallArg(buildStatusMessageMock) as Record<string, unknown>;
    const agent = statusArg.agent as Record<string, unknown>;
    expectRecordFields(agent.model, { primary: "openai/gpt-5.4" });
  });

  it("materializes a valid persisted session entry when implicit current fallback mutates model state", async () => {
    resetSessionStore({});

    const tool = getSessionStatusTool("agent:main:scope:scopy:direct:scopy");

    const result = await tool.execute("call-current-channel-plugin-model", {
      sessionKey: "current",
      model: "anthropic/claude-sonnet-4-6",
    });
    const details = result.details as {
      ok?: boolean;
      sessionKey?: string;
      model?: string;
      modelProvider?: string;
      modelOverride?: string | null;
    };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("agent:main:scope:scopy:direct:scopy");
    expect(details.model).toBe("claude-sonnet-4-6");
    expect(details.modelProvider).toBe("anthropic");
    expect(details.modelOverride).toBe("anthropic/claude-sonnet-4-6");
    expect(updateSessionStoreMock).toHaveBeenCalledTimes(1);
    const [, savedStore] = updateSessionStoreMock.mock.calls.at(-1) as [
      string,
      Record<string, SessionEntry>,
    ];
    const saved = savedStore["agent:main:scope:scopy:direct:scopy"];
    expectRecordFields(saved, {
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-6",
      liveModelSwitchPending: true,
    });
    expect(saved.sessionId).toMatch(UUID_RE);
  });

  it("materializes a valid persisted session entry when the default implicit current fallback mutates model state", async () => {
    resetSessionStore({});

    const tool = getSessionStatusTool("agent:main:scope:scopy:direct:scopy");

    const result = await tool.execute("call-current-channel-plugin-default-model", {
      model: "anthropic/claude-sonnet-4-6",
    });
    const details = result.details as { ok?: boolean; sessionKey?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("agent:main:scope:scopy:direct:scopy");
    expect(updateSessionStoreMock).toHaveBeenCalledTimes(1);
    const [, savedStore] = updateSessionStoreMock.mock.calls.at(-1) as [
      string,
      Record<string, SessionEntry>,
    ];
    const saved = savedStore["agent:main:scope:scopy:direct:scopy"];
    expectRecordFields(saved, {
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-6",
      liveModelSwitchPending: true,
    });
    expect(saved.sessionId).toMatch(UUID_RE);
  });

  it("does not synthesize a current fallback for unknown non-literal session keys", async () => {
    resetSessionStore({});

    const tool = getSessionStatusTool("agent:main:scope:scopy:direct:scopy");

    await expect(
      tool.execute("call-current-non-literal", { sessionKey: "definitely-not-current" }),
    ).rejects.toThrow("Unknown sessionId: definitely-not-current");
  });

  it("includes background task context in session_status output", async () => {
    resetSessionStore({
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: Date.now(),
      },
    });
    listTasksForRelatedSessionKeyForOwnerMock.mockReturnValue([
      {
        taskId: "task-1",
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
        task: "Summarize inbox backlog",
        status: "running",
        deliveryStatus: "pending",
        notifyPolicy: "done_only",
        createdAt: Date.now() - 5_000,
        progressSummary: "Indexing the latest threads",
      },
    ]);

    const tool = createSessionStatusTool({ agentSessionKey: "agent:main:main" });
    const result = await tool.execute("tc-1", { sessionKey: "agent:main:main" });
    const firstContent = result.content?.[0];
    const text = (firstContent as { text: string } | undefined)?.text ?? "";

    expect(text).toContain("📌 Tasks: 1 active");
    expect(text).toContain("acp");
    expect(text).toContain("Summarize inbox backlog");
    expect(text).toContain("Indexing the latest threads");
  });

  it("hides stale completed task rows from session_status output", async () => {
    resetSessionStore({
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: Date.now(),
      },
    });
    listTasksForRelatedSessionKeyForOwnerMock.mockReturnValue([
      {
        taskId: "task-stale",
        runtime: "cron",
        requesterSessionKey: "agent:main:main",
        task: "stale completed task",
        status: "succeeded",
        deliveryStatus: "delivered",
        notifyPolicy: "done_only",
        createdAt: Date.now() - 15 * 60_000,
        terminalSummary: "finished long ago",
      },
      {
        taskId: "task-live",
        runtime: "subagent",
        requesterSessionKey: "agent:main:main",
        task: "live task",
        status: "running",
        deliveryStatus: "pending",
        notifyPolicy: "done_only",
        createdAt: Date.now() - 5_000,
        progressSummary: "still working",
      },
    ]);

    const tool = createSessionStatusTool({ agentSessionKey: "agent:main:main" });
    const result = await tool.execute("tc-stale", { sessionKey: "agent:main:main" });
    const firstContent = result.content?.[0];
    const text = (firstContent as { text: string } | undefined)?.text ?? "";

    expect(text).toContain("📌 Tasks: 1 active");
    expect(text).toContain("live task");
    expect(text).not.toContain("stale completed task");
    expect(text).not.toContain("finished long ago");
  });

  it("shows recent failure context in session_status output when no task is active", async () => {
    resetSessionStore({
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: Date.now(),
      },
    });
    listTasksForRelatedSessionKeyForOwnerMock.mockReturnValue([
      {
        taskId: "task-failed",
        runtime: "cron",
        requesterSessionKey: "agent:main:main",
        task: "failing task",
        status: "failed",
        deliveryStatus: "pending",
        notifyPolicy: "done_only",
        createdAt: Date.now() - 5_000,
        error: "permission denied",
      },
    ]);

    const tool = createSessionStatusTool({ agentSessionKey: "agent:main:main" });
    const result = await tool.execute("tc-failed", { sessionKey: "agent:main:main" });
    const firstContent = result.content?.[0];
    const text = (firstContent as { text: string } | undefined)?.text ?? "";

    expect(text).toContain("📌 Tasks: 1 recent failure");
    expect(text).toContain("failing task");
    expect(text).toContain("permission denied");
  });

  it("truncates long task titles and details in session_status output", async () => {
    resetSessionStore({
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: Date.now(),
      },
    });
    listTasksForRelatedSessionKeyForOwnerMock.mockReturnValue([
      {
        taskId: "task-long",
        runtime: "subagent",
        requesterSessionKey: "agent:main:main",
        task: "This is a deliberately long task prompt that should never be emitted in full by session_status because it can include internal instructions and file paths that are not appropriate for user-visible task summaries.",
        status: "running",
        deliveryStatus: "pending",
        notifyPolicy: "done_only",
        createdAt: Date.now() - 5_000,
        progressSummary:
          "This progress detail is also intentionally long so the session_status tool proves it truncates verbose task context instead of dumping a long internal update into the tool response.",
      },
    ]);

    const tool = createSessionStatusTool({ agentSessionKey: "agent:main:main" });
    const result = await tool.execute("tc-truncated", { sessionKey: "agent:main:main" });
    const firstContent = result.content?.[0];
    const text = (firstContent as { text: string } | undefined)?.text ?? "";

    expect(text).toContain(
      "This is a deliberately long task prompt that should never be emitted in full by…",
    );
    expect(text).toContain(
      "This progress detail is also intentionally long so the session_status tool proves it truncates verbose task context ins…",
    );
    expect(text).not.toContain("internal instructions and file paths");
    expect(text).not.toContain("dumping a long internal update");
  });

  it("prefers failure context over newer success context in session_status output", async () => {
    resetSessionStore({
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: Date.now(),
      },
    });
    listTasksForRelatedSessionKeyForOwnerMock.mockReturnValue([
      {
        taskId: "task-failed",
        runtime: "cron",
        requesterSessionKey: "agent:main:main",
        task: "failing task",
        status: "failed",
        deliveryStatus: "pending",
        notifyPolicy: "done_only",
        createdAt: Date.now() - 60_000,
        endedAt: Date.now() - 30_000,
        error: "permission denied",
      },
      {
        taskId: "task-succeeded",
        runtime: "subagent",
        requesterSessionKey: "agent:main:main",
        task: "successful task",
        status: "succeeded",
        deliveryStatus: "delivered",
        notifyPolicy: "done_only",
        createdAt: Date.now() - 10_000,
        endedAt: Date.now(),
        terminalSummary: "all done",
      },
    ]);

    const tool = createSessionStatusTool({ agentSessionKey: "agent:main:main" });
    const result = await tool.execute("tc-failed-priority", { sessionKey: "agent:main:main" });
    const firstContent = result.content?.[0];
    const text = (firstContent as { text: string } | undefined)?.text ?? "";

    expect(text).toContain("📌 Tasks: 1 recent failure");
    expect(text).toContain("failing task");
    expect(text).toContain("permission denied");
    expect(text).not.toContain("successful task");
    expect(text).not.toContain("all done");
  });

  it("resolves a literal current sessionId in session_status", async () => {
    resetSessionStore({
      main: {
        sessionId: "s-main",
        updatedAt: 10,
      },
      "agent:main:other": {
        sessionId: "current",
        updatedAt: 20,
      },
    });
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender" },
      tools: {
        sessions: { visibility: "all" },
        agentToAgent: { enabled: true, allow: ["*"] },
      },
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          models: {},
        },
      },
    };

    const tool = getSessionStatusTool();

    const result = await tool.execute("call-current-literal-id", { sessionKey: "current" });
    const details = result.details as { ok?: boolean; sessionKey?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("agent:main:other");
  });

  it("keeps sessionKey=current bound to the requester subagent session", async () => {
    resetSessionStore({
      "agent:main:main": {
        sessionId: "s-parent",
        updatedAt: 10,
      },
      "agent:main:subagent:child": {
        sessionId: "s-child",
        updatedAt: 20,
        providerOverride: "openai",
        modelOverride: "gpt-5.4",
      },
    });

    const tool = getSessionStatusTool("agent:main:subagent:child");

    const result = await tool.execute("call-current-subagent", {
      sessionKey: "current",
      model: "anthropic/claude-sonnet-4-6",
    });
    const details = result.details as { ok?: boolean; sessionKey?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("agent:main:subagent:child");
    expect(mockCallArg(updateSessionStoreMock)).toBe("/tmp/main/sessions.json");
    const savedStore = mockCallArg(updateSessionStoreMock, 0, 1) as Record<string, unknown>;
    expectRecordFields(savedStore["agent:main:subagent:child"], {
      liveModelSwitchPending: true,
      modelOverride: "claude-sonnet-4-6",
    });
  });

  it("uses the runtime session model as the selected card model when no override is set", async () => {
    resetSessionStore({
      main: {
        sessionId: "runtime-model",
        updatedAt: 10,
        modelProvider: "anthropic",
        model: "claude-opus-4-6",
      },
    });

    const tool = getSessionStatusTool();

    await tool.execute("call-runtime-model", {});

    const statusArg = mockCallArg(buildStatusMessageMock) as Record<string, unknown>;
    const agent = statusArg.agent as Record<string, unknown>;
    expectRecordFields(agent.model, { primary: "anthropic/claude-opus-4-6" });
  });

  it("infers configured custom providers for runtime-only models in session_status", async () => {
    resetSessionStore({
      main: {
        sessionId: "runtime-custom-provider",
        updatedAt: 10,
        model: "qwen-max",
      },
    });
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          models: {},
        },
      },
      models: {
        providers: {
          "qwen-dashscope": {
            apiKey: "DASHSCOPE_API_KEY",
            models: [{ id: "qwen-max" }],
          },
        },
      },
      tools: {
        agentToAgent: { enabled: false },
      },
    };
    resolveUsableCustomProviderApiKeyMock.mockImplementation((params) =>
      params?.provider === "qwen-dashscope" ? { apiKey: "sk-test", source: "models.json" } : null,
    );

    const tool = getSessionStatusTool();

    await tool.execute("call-runtime-custom-provider", {});

    const statusArg = mockCallArg(buildStatusMessageMock) as Record<string, unknown>;
    const agent = statusArg.agent as Record<string, unknown>;
    expectRecordFields(agent.model, { primary: "qwen-dashscope/qwen-max" });
    expect(statusArg.modelAuth).toBe("api-key (models.json)");
  });

  it("preserves an unknown runtime provider in the selected status card model", async () => {
    resetSessionStore({
      main: {
        sessionId: "legacy-runtime-model",
        updatedAt: 10,
        model: "legacy-runtime-model",
      },
    });

    const tool = getSessionStatusTool();

    await tool.execute("call-legacy-runtime-model", {});

    const statusArg = mockCallArg(buildStatusMessageMock) as Record<string, unknown>;
    const agent = statusArg.agent as Record<string, unknown>;
    expectRecordFields(agent.model, { primary: "legacy-runtime-model" });
    expectRecordFields(statusArg.sessionEntry, {
      model: "legacy-runtime-model",
      providerOverride: "",
    });
    expect(statusArg.modelAuth).toBeUndefined();
  });

  it("passes per-agent thinkingDefault through to the status card", async () => {
    resetSessionStore({
      "agent:kira:main": {
        sessionId: "agent-thinking",
        updatedAt: 10,
      },
    });
    const savedConfig = mockConfig;
    try {
      mockConfig = {
        session: { mainKey: "main", scope: "per-sender" },
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.4" },
            models: {},
          },
          list: [
            {
              id: "kira",
              model: "openai/gpt-5.4",
              thinkingDefault: "xhigh",
            },
          ],
        },
        tools: {
          agentToAgent: { enabled: false },
        },
      };

      const tool = getSessionStatusTool("agent:kira:main");

      await tool.execute("call-agent-thinking", {});

      const statusArg = mockCallArg(buildStatusMessageMock) as Record<string, unknown>;
      expect(statusArg.agentId).toBe("kira");
      expectRecordFields(statusArg.agent, { thinkingDefault: "xhigh" });
    } finally {
      mockConfig = savedConfig;
    }
  });

  it("uses the implicit model thinking default when no config default is set", async () => {
    resetSessionStore({
      "agent:kira:main": {
        sessionId: "agent-thinking-implicit",
        updatedAt: 10,
      },
    });
    const savedConfig = mockConfig;
    try {
      mockConfig = {
        session: { mainKey: "main", scope: "per-sender" },
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.4" },
            models: {},
          },
          list: [
            {
              id: "kira",
              model: "openai/gpt-5.4",
            },
          ],
        },
        tools: {
          agentToAgent: { enabled: false },
        },
      };

      const tool = getSessionStatusTool("agent:kira:main");

      await tool.execute("call-agent-thinking-implicit", {});

      const statusArg = mockCallArg(buildStatusMessageMock) as Record<string, unknown>;
      expect(statusArg.agentId).toBe("kira");
      expectRecordFields(statusArg.agent, { thinkingDefault: "medium" });
    } finally {
      mockConfig = savedConfig;
    }
  });

  it("hydrates runtime catalog metadata for status when configured model metadata omits reasoning", async () => {
    resetSessionStore({
      "agent:kira:main": {
        sessionId: "agent-thinking-runtime-hydration",
        updatedAt: 10,
      },
    });
    const savedConfig = mockConfig;
    try {
      mockConfig = {
        session: { mainKey: "main", scope: "per-sender" },
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.4" },
            models: {},
          },
          list: [
            {
              id: "kira",
              model: "openai/gpt-5.4",
            },
          ],
        },
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              models: [{ id: "gpt-5.4", name: "GPT-5.4" }],
            },
          },
        },
        tools: {
          agentToAgent: { enabled: false },
        },
      };

      const tool = getSessionStatusTool("agent:kira:main");

      await tool.execute("call-agent-thinking-runtime-hydration", {});

      const statusArg = mockCallArg(buildStatusMessageMock) as Record<string, unknown>;
      expect(statusArg.agentId).toBe("kira");
      expectRecordFields(statusArg.agent, { thinkingDefault: "medium" });
    } finally {
      mockConfig = savedConfig;
    }
  });

  it("falls back to origin.provider when resolving queue settings", async () => {
    resetSessionStore({
      main: {
        sessionId: "status-origin-provider",
        updatedAt: 10,
        origin: { provider: "quietchat" },
      },
    });

    const tool = getSessionStatusTool();

    await tool.execute("call-origin-provider", {});

    const queueArg = mockCallArg(resolveQueueSettingsMock) as Record<string, unknown>;
    expect(queueArg.channel).toBe("quietchat");
    expectRecordFields(queueArg.sessionEntry, { origin: { provider: "quietchat" } });
  });

  it("resolves sessionId inputs", async () => {
    const sessionId = "sess-main";
    resetSessionStore({
      "agent:main:main": {
        sessionId,
        updatedAt: 10,
      },
    });

    const tool = getSessionStatusTool();

    const result = await tool.execute("call3", { sessionKey: sessionId });
    const details = result.details as { ok?: boolean; sessionKey?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("agent:main:main");
  });

  it("resolves duplicate sessionId inputs deterministically", async () => {
    resetSessionStore({
      "agent:main:main": {
        sessionId: "current",
        updatedAt: 10,
      },
      "agent:main:other": {
        sessionId: "run-dup",
        updatedAt: 999,
      },
      "agent:main:acp:run-dup": {
        sessionId: "run-dup",
        updatedAt: 100,
      },
    });
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender" },
      tools: {
        sessions: { visibility: "all" },
        agentToAgent: { enabled: true, allow: ["*"] },
      },
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          models: {},
        },
      },
    };

    const tool = getSessionStatusTool();

    const result = await tool.execute("call-dup", { sessionKey: "run-dup" });
    const details = result.details as { ok?: boolean; sessionKey?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("agent:main:acp:run-dup");
  });

  it("uses non-standard session keys without sessionId resolution", async () => {
    resetSessionStore({
      "temp:slug-generator": {
        sessionId: "sess-temp",
        updatedAt: 10,
      },
    });

    const tool = getSessionStatusTool();

    const result = await tool.execute("call4", { sessionKey: "temp:slug-generator" });
    const details = result.details as { ok?: boolean; sessionKey?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("temp:slug-generator");
  });

  it("blocks cross-agent session_status without agent-to-agent access", async () => {
    resetSessionStore({
      "agent:other:main": {
        sessionId: "s2",
        updatedAt: 10,
      },
    });

    const tool = getSessionStatusTool("agent:main:main");

    await expect(tool.execute("call5", { sessionKey: "agent:other:main" })).rejects.toThrow(
      "Agent-to-agent status is disabled",
    );
  });

  it("blocks unsandboxed same-agent session_status outside self visibility", async () => {
    resetSessionStore({
      "agent:main:main": {
        sessionId: "s-parent",
        updatedAt: 10,
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-6",
      },
      "agent:main:subagent:child": {
        sessionId: "s-child",
        updatedAt: 20,
      },
    });
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender" },
      tools: {
        sessions: { visibility: "self" },
        agentToAgent: { enabled: true, allow: ["*"] },
      },
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          models: {},
        },
      },
    };

    const tool = getSessionStatusTool("agent:main:subagent:child");

    await expect(
      tool.execute("call-self-visibility", {
        sessionKey: "agent:main:main",
        model: "default",
      }),
    ).rejects.toThrow(
      "Session status visibility is restricted to the current session (tools.sessions.visibility=self).",
    );

    expect(loadSessionStoreMock).not.toHaveBeenCalled();
    expect(updateSessionStoreMock).not.toHaveBeenCalled();
  });

  it("blocks unsandboxed same-agent bare main session_status outside self visibility", async () => {
    resetSessionStore({
      "agent:main:main": {
        sessionId: "s-parent",
        updatedAt: 10,
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-6",
      },
      "agent:main:subagent:child": {
        sessionId: "s-child",
        updatedAt: 20,
      },
    });
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender" },
      tools: {
        sessions: { visibility: "self" },
        agentToAgent: { enabled: true, allow: ["*"] },
      },
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          models: {},
        },
      },
    };

    const tool = getSessionStatusTool("agent:main:subagent:child");

    await expect(
      tool.execute("call-self-visibility-bare-main", {
        sessionKey: "main",
        model: "default",
      }),
    ).rejects.toThrow(
      "Session status visibility is restricted to the current session (tools.sessions.visibility=self).",
    );

    expect(updateSessionStoreMock).not.toHaveBeenCalled();
  });

  it("blocks unsandboxed same-agent session_status outside tree visibility before mutation", async () => {
    resetSessionStore({
      "agent:main:main": {
        sessionId: "s-parent",
        updatedAt: 10,
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-6",
      },
      "agent:main:subagent:child": {
        sessionId: "s-child",
        updatedAt: 20,
      },
    });
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender" },
      tools: {
        sessions: { visibility: "tree" },
        agentToAgent: { enabled: true, allow: ["*"] },
      },
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          models: {},
        },
      },
    };
    mockSpawnedSessionList(() => []);

    const tool = getSessionStatusTool("agent:main:subagent:child");

    await expect(
      tool.execute("call-tree-visibility", {
        sessionKey: "agent:main:main",
        model: "default",
      }),
    ).rejects.toThrow(
      "Session status visibility is restricted to the current session tree (tools.sessions.visibility=tree).",
    );

    expect(loadSessionStoreMock).not.toHaveBeenCalled();
    expect(updateSessionStoreMock).not.toHaveBeenCalled();
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "sessions.list",
      params: {
        includeGlobal: false,
        includeUnknown: false,
        spawnedBy: "agent:main:subagent:child",
      },
    });
  });

  it("allows unsandboxed same-agent session_status under agent visibility", async () => {
    resetSessionStore({
      "agent:main:main": {
        sessionId: "s-parent",
        updatedAt: 10,
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-6",
      },
      "agent:main:subagent:child": {
        sessionId: "s-child",
        updatedAt: 20,
      },
    });
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender" },
      tools: {
        sessions: { visibility: "agent" },
        agentToAgent: { enabled: true, allow: ["*"] },
      },
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          models: {},
        },
      },
    };

    const tool = getSessionStatusTool("agent:main:subagent:child");

    const result = await tool.execute("call-agent-visibility", {
      sessionKey: "agent:main:main",
      model: "default",
    });
    const details = result.details as { ok?: boolean; sessionKey?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("agent:main:main");
    expect(updateSessionStoreMock).toHaveBeenCalledTimes(1);
  });

  it("blocks unsandboxed sessionId session_status outside tree visibility before mutation", async () => {
    resetSessionStore({
      "agent:main:main": {
        sessionId: "s-parent",
        updatedAt: 10,
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-6",
      },
      "agent:main:subagent:child": {
        sessionId: "s-child",
        updatedAt: 20,
      },
    });
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender" },
      tools: {
        sessions: { visibility: "tree" },
        agentToAgent: { enabled: true, allow: ["*"] },
      },
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          models: {},
        },
      },
    };
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      if (request.method === "sessions.resolve") {
        if (request.params?.sessionId === "s-parent") {
          return { key: "agent:main:main" };
        }
        return {};
      }
      if (request.method === "sessions.list") {
        return { sessions: [] };
      }
      return {};
    });

    const tool = getSessionStatusTool("agent:main:subagent:child");

    await expect(
      tool.execute("call-tree-session-id-visibility", {
        sessionKey: "s-parent",
        model: "default",
      }),
    ).rejects.toThrow(
      "Session status visibility is restricted to the current session tree (tools.sessions.visibility=tree).",
    );

    expect(updateSessionStoreMock).not.toHaveBeenCalled();
  });

  it("blocks sandboxed child session_status access outside its tree before store lookup", async () => {
    resetSessionStore({
      "agent:main:subagent:child": {
        sessionId: "s-child",
        updatedAt: 20,
      },
      "agent:main:main": {
        sessionId: "s-parent",
        updatedAt: 10,
      },
    });
    installSandboxedSessionStatusConfig();
    mockSpawnedSessionList(() => []);

    const tool = getSessionStatusTool("agent:main:subagent:child", {
      sandboxed: true,
    });
    const expectedError = "Session status visibility is restricted to the current session tree";

    await expect(
      tool.execute("call6", {
        sessionKey: "agent:main:main",
        model: "anthropic/claude-sonnet-4-6",
      }),
    ).rejects.toThrow(expectedError);

    await expect(
      tool.execute("call7", {
        sessionKey: "agent:main:subagent:missing",
      }),
    ).rejects.toThrow(expectedError);

    expect(loadSessionStoreMock).not.toHaveBeenCalled();
    expect(updateSessionStoreMock).not.toHaveBeenCalled();
    expectSpawnedSessionLookupCalls("agent:main:subagent:child");
  });

  it("blocks sandboxed child bare main session_status access outside its tree", async () => {
    resetSessionStore({
      "agent:main:subagent:child": {
        sessionId: "s-child",
        updatedAt: 20,
      },
      "agent:main:main": {
        sessionId: "s-parent",
        updatedAt: 10,
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-6",
      },
    });
    installSandboxedSessionStatusConfig();
    mockSpawnedSessionList(() => []);

    const tool = getSessionStatusTool("agent:main:subagent:child", {
      sandboxed: true,
    });
    const expectedError = "Session status visibility is restricted to the current session tree";

    await expect(
      tool.execute("call6-bare-main", {
        sessionKey: "main",
        model: "default",
      }),
    ).rejects.toThrow(expectedError);

    expect(updateSessionStoreMock).not.toHaveBeenCalled();
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "sessions.list",
      params: {
        includeGlobal: false,
        includeUnknown: false,
        spawnedBy: "agent:main:subagent:child",
      },
    });
  });

  it("blocks sandboxed child session_status sessionId access outside its tree before store lookup", async () => {
    resetSessionStore({
      "agent:main:subagent:child": {
        sessionId: "s-child",
        updatedAt: 20,
      },
      "agent:main:main": {
        sessionId: "s-parent",
        updatedAt: 10,
      },
      "agent:other:main": {
        sessionId: "s-other",
        updatedAt: 30,
      },
    });
    installSandboxedSessionStatusConfig();
    mockSpawnedSessionList(() => []);

    const tool = getSessionStatusTool("agent:main:subagent:child", {
      sandboxed: true,
    });
    const expectedError = "Session status visibility is restricted to the current session tree";

    await expect(
      tool.execute("call6-session-id", {
        sessionKey: "s-other",
      }),
    ).rejects.toThrow(expectedError);

    expect(loadSessionStoreMock).toHaveBeenCalledTimes(1);
    expect(loadSessionStoreMock).toHaveBeenCalledWith("/tmp/main/sessions.json");
    expect(updateSessionStoreMock).not.toHaveBeenCalled();
    expect(callGatewayMock).toHaveBeenCalledTimes(3);
    expect(callGatewayMock).toHaveBeenNthCalledWith(1, {
      method: "sessions.list",
      params: {
        includeGlobal: false,
        includeUnknown: false,
        spawnedBy: "agent:main:subagent:child",
      },
    });
    expect(callGatewayMock).toHaveBeenNthCalledWith(2, {
      method: "sessions.resolve",
      params: {
        key: "s-other",
        spawnedBy: "agent:main:subagent:child",
      },
    });
    expect(callGatewayMock).toHaveBeenNthCalledWith(3, {
      method: "sessions.resolve",
      params: {
        sessionId: "s-other",
        spawnedBy: "agent:main:subagent:child",
        includeGlobal: false,
        includeUnknown: false,
      },
    });
  });

  it("blocks sandboxed child session_status parent sessionId access outside its tree", async () => {
    resetSessionStore({
      "agent:main:subagent:child": {
        sessionId: "s-child",
        updatedAt: 20,
      },
      "agent:main:main": {
        sessionId: "s-parent",
        updatedAt: 10,
      },
    });
    installSandboxedSessionStatusConfig();
    mockSpawnedSessionList(() => []);

    const tool = getSessionStatusTool("agent:main:subagent:child", {
      sandboxed: true,
    });

    await expect(
      tool.execute("call7-parent-session-id", {
        sessionKey: "s-parent",
      }),
    ).rejects.toThrow("Session status visibility is restricted to the current session tree");

    expect(loadSessionStoreMock).toHaveBeenCalledTimes(1);
    expect(loadSessionStoreMock).toHaveBeenCalledWith("/tmp/main/sessions.json");
    expect(updateSessionStoreMock).not.toHaveBeenCalled();
    expect(callGatewayMock).toHaveBeenCalledTimes(3);
    expect(callGatewayMock).toHaveBeenNthCalledWith(1, {
      method: "sessions.list",
      params: {
        includeGlobal: false,
        includeUnknown: false,
        spawnedBy: "agent:main:subagent:child",
      },
    });
    expect(callGatewayMock).toHaveBeenNthCalledWith(2, {
      method: "sessions.resolve",
      params: {
        key: "s-parent",
        spawnedBy: "agent:main:subagent:child",
      },
    });
    expect(callGatewayMock).toHaveBeenNthCalledWith(3, {
      method: "sessions.resolve",
      params: {
        sessionId: "s-parent",
        spawnedBy: "agent:main:subagent:child",
        includeGlobal: false,
        includeUnknown: false,
      },
    });
  });

  it("keeps legacy main requester keys for sandboxed session tree checks", async () => {
    resetSessionStore({
      "agent:main:main": {
        sessionId: "s-main",
        updatedAt: 10,
      },
      "agent:main:subagent:child": {
        sessionId: "s-child",
        updatedAt: 20,
      },
    });
    installSandboxedSessionStatusConfig();
    mockSpawnedSessionList((spawnedBy) =>
      spawnedBy === "main" ? [{ key: "agent:main:subagent:child" }] : [],
    );

    const tool = getSessionStatusTool("main", {
      sandboxed: true,
    });

    const mainResult = await tool.execute("call8", {});
    const mainDetails = mainResult.details as { ok?: boolean; sessionKey?: string };
    expect(mainDetails.ok).toBe(true);
    expect(mainDetails.sessionKey).toBe("agent:main:main");

    const childResult = await tool.execute("call9", {
      sessionKey: "agent:main:subagent:child",
    });
    const childDetails = childResult.details as { ok?: boolean; sessionKey?: string };
    expect(childDetails.ok).toBe(true);
    expect(childDetails.sessionKey).toBe("agent:main:subagent:child");

    expectSpawnedSessionLookupCalls("main");
  });

  it("scopes bare session keys to the requester agent", async () => {
    installScopedSessionStores(true);

    const tool = getSessionStatusTool("agent:support:main");

    const result = await tool.execute("call6", { sessionKey: "main" });
    const details = result.details as { ok?: boolean; sessionKey?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("main");
  });

  it("resets per-session model override via model=default", async () => {
    resetSessionStore({
      main: {
        sessionId: "s1",
        updatedAt: 10,
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-6",
        authProfileOverride: "p1",
      },
    });

    const tool = getSessionStatusTool();

    const result = await tool.execute("call3", { model: "default" });
    const details = result.details as { modelOverride?: string | null };
    expect(details.modelOverride).toBeNull();
    expect(updateSessionStoreMock).toHaveBeenCalledTimes(1);
    const [, savedStore] = updateSessionStoreMock.mock.calls.at(-1) as [
      string,
      Record<string, unknown>,
    ];
    const saved = savedStore.main as Record<string, unknown>;
    expect(saved.providerOverride).toBeUndefined();
    expect(saved.modelOverride).toBeUndefined();
    expect(saved.authProfileOverride).toBeUndefined();
    expect(saved.liveModelSwitchPending).toBe(true);
  });
});
