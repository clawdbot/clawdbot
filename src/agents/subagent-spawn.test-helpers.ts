// Subagent spawn test helpers install mocked runtime seams so sessions_spawn
// tests can exercise orchestration without real gateway/session-store effects.
import os from "node:os";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { expect, vi } from "vitest";
import { resolveLeastPrivilegeOperatorScopesForMethod } from "../gateway/method-scopes.js";
import type { SubagentLifecycleHookRunner } from "../plugins/hooks.js";

type MockFn = (...args: unknown[]) => unknown;
type MockImplementationTarget = {
  mockImplementation: (implementation: (opts: { method?: string }) => Promise<unknown>) => unknown;
};
type SessionStore = Record<string, Record<string, unknown>>;
type SessionStoreMutator = (store: SessionStore) => unknown;
type HookRunner = Pick<SubagentLifecycleHookRunner, "hasHooks"> &
  Partial<
    Pick<
      SubagentLifecycleHookRunner,
      "runSubagentSpawning" | "runSubagentSpawned" | "runSubagentProgress" | "runSubagentEnded"
    >
  >;
type SubagentSpawnModuleForTest = Awaited<typeof import("./subagent-spawn.js")> & {
  resetSubagentRegistryForTests: MockFn;
};

/** Build a minimal runtime config for sessions_spawn tests. */
export function createSubagentSpawnTestConfig(
  workspaceDir = os.tmpdir(),
  overrides?: Record<string, unknown>,
) {
  return {
    session: {
      mainKey: "main",
      scope: "per-sender",
    },
    tools: {
      sessions_spawn: {
        attachments: {
          enabled: true,
          maxFiles: 50,
          maxFileBytes: 1 * 1024 * 1024,
          maxTotalBytes: 5 * 1024 * 1024,
        },
      },
    },
    agents: {
      defaults: {
        workspace: workspaceDir,
      },
    },
    ...overrides,
  };
}

/** Mock gateway calls for the common accepted-spawn flow. */
export function setupAcceptedSubagentGatewayMock(callGatewayMock: MockImplementationTarget) {
  callGatewayMock.mockImplementation(async (opts: { method?: string }) => {
    if (opts.method === "sessions.patch") {
      return { ok: true };
    }
    if (opts.method === "sessions.delete") {
      return { ok: true };
    }
    if (opts.method === "agent") {
      return { runId: "run-1", status: "accepted", acceptedAt: 1000 };
    }
    return {};
  });
}

function identityDeliveryContext(value: unknown) {
  return value;
}

function createDefaultSessionHelperMocks() {
  return {
    resolveMainSessionAlias: () => ({ mainKey: "main", alias: "main" }),
    resolveInternalSessionKey: ({ key }: { key?: string }) => key ?? "agent:main:main",
    resolveDisplaySessionKey: ({ key }: { key?: string }) => key ?? "agent:main:main",
  };
}

/** Install an updateSessionStore mock that captures mutations in memory. */
export function installSessionStoreCaptureMock(
  updateSessionStoreMock: {
    mockImplementation: (
      implementation: (storePath: string, mutator: SessionStoreMutator) => Promise<SessionStore>,
    ) => unknown;
  },
  params?: {
    operations?: string[];
    onStore?: (store: SessionStore) => void;
  },
) {
  const store: SessionStore = {};
  updateSessionStoreMock.mockImplementation(
    async (_storePath: string, mutator: SessionStoreMutator) => {
      params?.operations?.push("store:update");
      await mutator(store);
      params?.onStore?.(store);
      return store;
    },
  );
}

/** Assert the persisted session entry captured the expected runtime model. */
export function expectPersistedRuntimeModel(params: {
  persistedStore: SessionStore | undefined;
  sessionKey: string | RegExp;
  provider: string;
  model: string;
  overrideSource?: "auto" | "user";
}) {
  const [persistedKey, persistedEntry] = Object.entries(params.persistedStore ?? {})[0] ?? [];
  if (typeof params.sessionKey === "string") {
    expect(persistedKey).toBe(params.sessionKey);
  } else {
    expect(persistedKey).toMatch(params.sessionKey);
  }
  expect(persistedEntry?.modelProvider).toBe(params.provider);
  expect(persistedEntry?.model).toBe(params.model);
  expect(persistedEntry?.providerOverride).toBe(params.provider);
  expect(persistedEntry?.modelOverride).toBe(params.model);
  if (params.overrideSource) {
    expect(persistedEntry?.modelOverrideSource).toBe(params.overrideSource);
  }
}

/** Load subagent-spawn with runtime dependencies replaced by test doubles. */
export async function loadSubagentSpawnModuleForTest(params: {
  callGatewayMock: MockFn;
  dispatchGatewayMethodInProcessMock?: MockFn;
  hasInProcessGatewayContextMock?: MockFn;
  getRuntimeConfig?: () => Record<string, unknown>;
  loadSessionStoreMock?: MockFn;
  loadPreparedModelCatalogMock?: MockFn;
  ensureContextEnginesInitializedMock?: MockFn;
  updateSessionStoreMock?: MockFn;
  forkSessionEntryFromParentMock?: MockFn;
  forkSessionFromParentMock?: MockFn;
  resolveContextEngineMock?: MockFn;
  resolveParentForkDecisionMock?: MockFn;
  registerSubagentRunMock?: MockFn;
  startQueuedSubagentRunMock?: MockFn;
  settleFailedQueuedSubagentLaunchMock?: MockFn;
  completeCollectorLaunchCleanupMock?: MockFn;
  emitSessionLifecycleEventMock?: MockFn;
  hookRunner?: HookRunner;
  resolveAgentConfig?: (cfg: Record<string, unknown>, agentId: string) => unknown;
  resolveAgentWorkspaceDir?: (cfg: Record<string, unknown>, agentId: string) => string;
  resolveSubagentSpawnModelSelection?: () => string | undefined;
  getSubagentDepthFromSessionStore?: (sessionKey: string, opts?: unknown) => number;
  countActiveRunsForSession?: (sessionKey: string) => number;
  listSwarmRunsForGroup?: (groupId: string) => unknown[];
  resolveSandboxRuntimeStatus?: (params: {
    cfg?: Record<string, unknown>;
    sessionKey?: string;
  }) => { sandboxed: boolean };
  getSessionBindingService?: () => {
    getCapabilities?: (params: { channel?: string; accountId?: string }) => {
      adapterAvailable: boolean;
      bindSupported: boolean;
      placements: Array<"current" | "child">;
    };
    bind?: (params: {
      targetSessionKey: string;
      targetKind?: string;
      conversation: {
        channel: string;
        accountId?: string;
        conversationId: string;
        parentConversationId?: string;
      };
      placement: "current" | "child";
      metadata?: Record<string, unknown>;
    }) => Promise<{
      targetSessionKey: string;
      targetKind?: string;
      status?: string;
      conversation: {
        channel: string;
        accountId?: string;
        conversationId: string;
        parentConversationId?: string;
      };
    }>;
    listBySession: (targetSessionKey: string) => Array<{
      status?: string;
      conversation: {
        channel: string;
        accountId?: string;
        conversationId: string;
        parentConversationId?: string;
      };
    }>;
  };
  resolveConversationDeliveryTarget?: (params: {
    channel?: string;
    conversationId?: string | number;
    parentConversationId?: string | number;
  }) => { to?: string; threadId?: string };
  workspaceDir?: string;
  sessionStorePath?: string;
  resetModules?: boolean;
}): Promise<SubagentSpawnModuleForTest> {
  if (params.resetModules ?? true) {
    // The helper rewires imports with vi.doMock, so each test starts from a
    // fresh module graph unless explicitly sharing mocks.
    vi.resetModules();
  }

  const resetSubagentRegistryForTests = vi.fn();

  vi.doMock("./provider-model-normalization.runtime.js", () => ({
    normalizeProviderModelIdWithRuntime: () => undefined,
  }));

  vi.doMock("./subagent-spawn.runtime.js", () => ({
    callGateway: (opts: unknown) => params.callGatewayMock(opts),
    dispatchGatewayMethodInProcess: (...args: unknown[]) =>
      params.dispatchGatewayMethodInProcessMock?.(...args),
    hasInProcessGatewayContext: () => Boolean(params.hasInProcessGatewayContextMock?.()),
    buildSubagentSystemPrompt: () => "system-prompt",
    forkSessionEntryFromParent:
      params.forkSessionEntryFromParentMock ??
      (async () => {
        const fork = (
          params.forkSessionFromParentMock
            ? await params.forkSessionFromParentMock()
            : { sessionId: "forked-session-id", sessionFile: "/tmp/forked-session.jsonl" }
        ) as { sessionId: string; sessionFile: string } | null;
        if (!fork) {
          return { status: "failed" };
        }
        return {
          status: "forked",
          fork,
          parentEntry: {
            sessionId: "parent-session-id",
            sessionFile: "/tmp/parent-session.jsonl",
            updatedAt: Date.now(),
          },
          sessionEntry: {
            sessionId: fork.sessionId,
            sessionFile: fork.sessionFile,
            forkedFromParent: true,
          },
          decision: {
            status: "fork",
            maxTokens: 100_000,
          },
        };
      }),
    forkSessionFromParent:
      params.forkSessionFromParentMock ??
      (async () => ({ sessionId: "forked-session-id", sessionFile: "/tmp/forked-session.jsonl" })),
    getGlobalHookRunner: () => params.hookRunner ?? { hasHooks: () => false },
    emitSessionLifecycleEvent: (...args: unknown[]) =>
      params.emitSessionLifecycleEventMock?.(...args),
    formatThinkingLevels: (levels: string[]) => levels.join(", "),
    normalizeThinkLevel: (level: unknown) => normalizeOptionalString(level),
    DEFAULT_SUBAGENT_MAX_CHILDREN_PER_AGENT: 5,
    DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH: 3,
    ADMIN_SCOPE: "operator.admin",
    AGENT_LANE_SUBAGENT: "subagent",
    getRuntimeConfig: () =>
      params.getRuntimeConfig?.() ??
      createSubagentSpawnTestConfig(params.workspaceDir ?? os.tmpdir()),
    loadPreparedModelCatalog: (...args: unknown[]) =>
      params.loadPreparedModelCatalogMock?.(...args) ?? [],
    loadSessionEntry: (scope: { storePath?: string; sessionKey: string }) =>
      ((params.loadSessionStoreMock?.(scope.storePath) ?? {}) as SessionStore)[scope.sessionKey],
    loadSessionStore: params.loadSessionStoreMock ?? (() => ({})),
    ensureContextEnginesInitialized:
      params.ensureContextEnginesInitializedMock ?? (() => undefined),
    resolveContextEngine: params.resolveContextEngineMock ?? (async () => ({})),
    resolveParentForkDecision:
      params.resolveParentForkDecisionMock ??
      (async (forkParams: { parentEntry?: { totalTokens?: unknown } }) => {
        const maxTokens = 100_000;
        const parentTokens =
          typeof forkParams.parentEntry?.totalTokens === "number" &&
          Number.isFinite(forkParams.parentEntry.totalTokens)
            ? Math.floor(forkParams.parentEntry.totalTokens)
            : undefined;
        if (maxTokens > 0 && typeof parentTokens === "number" && parentTokens > maxTokens) {
          return {
            status: "skip",
            reason: "parent-too-large",
            maxTokens,
            parentTokens,
            message: `Parent context is too large to fork (${parentTokens}/${maxTokens} tokens); starting with isolated context instead.`,
          };
        }
        return {
          status: "fork",
          maxTokens,
          ...(typeof parentTokens === "number" ? { parentTokens } : {}),
        };
      }),
    mergeSessionEntry: (
      current: Record<string, unknown> | undefined,
      next: Record<string, unknown>,
    ) => ({
      ...current,
      ...next,
    }),
    updateSessionStore:
      params.updateSessionStoreMock ??
      (async (_storePath: string, mutator: SessionStoreMutator) => {
        const store: SessionStore = {};
        await mutator(store);
        return store;
      }),
    // Real scope resolver: spawn's admin-tier pinning depends on params-aware
    // sessions.patch policy, so a stub here would hide policy regressions.
    resolveLeastPrivilegeOperatorScopesForMethod,
    upsertSessionEntry: async (
      scope: { storePath?: string; sessionKey: string },
      patch: Record<string, unknown>,
    ) => {
      const updateSessionStore =
        params.updateSessionStoreMock ??
        (async (_storePath: string, mutator: SessionStoreMutator) => {
          const store: SessionStore = {};
          await mutator(store);
          return store;
        });
      let updated: Record<string, unknown> | undefined;
      const storePath =
        scope.storePath ?? params.sessionStorePath ?? "/tmp/subagent-spawn-model-session.json";
      await updateSessionStore(storePath, (store: SessionStore) => {
        updated = Object.assign({}, store[scope.sessionKey], patch);
        store[scope.sessionKey] = updated;
      });
      return updated ?? null;
    },
    getSessionBindingService:
      params.getSessionBindingService ??
      (() => ({
        getCapabilities: () => ({
          adapterAvailable: false,
          bindSupported: false,
          placements: [],
        }),
        bind: async () => {
          throw new Error("session binding adapter unavailable");
        },
        listBySession: () => [],
      })),
    resolveConversationDeliveryTarget:
      params.resolveConversationDeliveryTarget ??
      ((targetParams: { channel?: string; conversationId?: string | number }) => ({
        to: targetParams.conversationId
          ? `channel:${String(targetParams.conversationId)}`
          : undefined,
      })),
    mergeDeliveryContext: (
      primary?: Record<string, unknown>,
      fallback?: Record<string, unknown>,
    ) => ({
      ...fallback,
      ...primary,
    }),
    resolveGatewaySessionStoreTarget: (targetParams: { key: string }) => ({
      agentId: "main",
      storePath: params.sessionStorePath ?? "/tmp/subagent-spawn-model-session.json",
      canonicalKey: targetParams.key,
      storeKeys: [targetParams.key],
    }),
    normalizeDeliveryContext: identityDeliveryContext,
    resolveAgentConfig: params.resolveAgentConfig ?? (() => undefined),
    resolveAgentWorkspaceDir:
      params.resolveAgentWorkspaceDir ?? (() => params.workspaceDir ?? os.tmpdir()),
    resolveSubagentSpawnModelSelection:
      params.resolveSubagentSpawnModelSelection ??
      ((spawnParams: { modelOverride?: unknown }) =>
        typeof spawnParams.modelOverride === "string" && spawnParams.modelOverride.trim()
          ? spawnParams.modelOverride.trim()
          : "openai/gpt-4"),
    resolveSandboxRuntimeStatus:
      params.resolveSandboxRuntimeStatus ?? (() => ({ sandboxed: false })),
    ...createDefaultSessionHelperMocks(),
  }));

  vi.doMock("./subagent-depth.js", () => ({
    getSubagentDepthFromSessionStore: params.getSubagentDepthFromSessionStore ?? (() => 0),
  }));

  vi.doMock("./subagent-registry.js", () => ({
    completeCollectorLaunchCleanup: params.completeCollectorLaunchCleanupMock ?? vi.fn(),
    countActiveRunsForSession: params.countActiveRunsForSession ?? (() => 0),
    listSwarmRunsForGroup: params.listSwarmRunsForGroup ?? vi.fn(() => []),
    registerSubagentRun:
      params.registerSubagentRunMock ?? vi.fn((_record: Record<string, unknown>) => undefined),
    resetSubagentRegistryForTests,
    settleFailedQueuedSubagentLaunch:
      params.settleFailedQueuedSubagentLaunchMock ?? vi.fn(() => true),
    startQueuedSubagentRun: params.startQueuedSubagentRunMock ?? vi.fn(() => true),
  }));

  const subagentSpawnModule = await import("./subagent-spawn.js");
  return {
    ...subagentSpawnModule,
    resetSubagentRegistryForTests,
  };
}
