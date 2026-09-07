/**
 * HTTP server session fixtures shared by gateway session tests.
 */
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { AssistantMessage, UserMessage } from "openclaw/plugin-sdk/llm";
import { beforeEach, expect, vi } from "vitest";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import type { InternalHookEvent } from "../../hooks/internal-hooks.js";
import { resetSystemEventsForTest } from "../../infra/system-events.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import type { GatewayRequestContext } from "../server-methods/types.js";
import { embeddedRunMock, agentDiscoveryMock, testState } from "../test-helpers.runtime-state.js";
import * as gatewayTestHelpers from "../test-helpers.server.js";
import {
  installGatewaySessionsTestResources,
  type GatewaySessionsSuiteSetup,
} from "./server-sessions-resources.test-helpers.js";

export const getSessionManagerModule = createLazyRuntimeModule(
  () => import("../../agents/sessions/index.js"),
);

export const getGatewayConfigModule = createLazyRuntimeModule(
  () => import("../../config/config.js"),
);

const getSessionAccessorModule = createLazyRuntimeModule(
  () => import("../../config/sessions/session-accessor.js"),
);

const getGatewayServerMethodsModule = createLazyRuntimeModule(() => import("../server-methods.js"));

export async function getSessionsHandlers() {
  return (await getGatewayServerMethodsModule()).coreGatewayHandlers;
}

type TestTranscriptMessage = Record<string, unknown> & {
  role: string;
};
type RetireSessionMcpRuntimeParams = Parameters<
  (typeof import("../../agents/agent-bundle-mcp-tools.js"))["retireSessionMcpRuntime"]
>[0];

export async function seedSessionTranscript(params: {
  agentId?: string;
  messages: readonly TestTranscriptMessage[];
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<void> {
  const { persistSessionTranscriptTurn } = await getSessionAccessorModule();
  await persistSessionTranscriptTurn(
    {
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
    {
      cwd: "/tmp",
      updateMode: "none",
      messages: params.messages.map((message, index) => ({
        message: {
          timestamp: index + 1,
          ...message,
        },
        now: Date.parse(`2026-06-19T12:00:${String(index + 1).padStart(2, "0")}.000Z`),
      })),
    },
  );
}

export async function seedLinearSessionTranscript(params: {
  agentId?: string;
  contents: readonly string[];
  role?: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<void> {
  await seedSessionTranscript({
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    messages: params.contents.map((content) => ({
      role: params.role ?? "user",
      content,
    })),
  });
}

export async function loadSeededTranscriptEvents(params: {
  agentId?: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<unknown[]> {
  const { loadTranscriptEvents } = await getSessionAccessorModule();
  return await loadTranscriptEvents({
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });
}

const sessionCleanupMocks = vi.hoisted(() => ({
  clearSessionQueues: vi.fn((keys: Array<string | undefined>) => {
    const clearedKeys = Array.from(
      new Set(
        keys
          .map((key) => (typeof key === "string" ? key.trim() : ""))
          .filter((key) => key.length > 0),
      ),
    );
    return { followupCleared: 0, laneCleared: 0, keys: clearedKeys };
  }),
  stopSessionResetSubagents: vi.fn(async () => {}),
}));

const bootstrapCacheMocks = vi.hoisted(() => ({
  clearBootstrapSnapshot: vi.fn(),
}));

const sessionHookMocks = vi.hoisted(() => ({
  hasInternalHookListeners: vi.fn(() => true),
  triggerInternalHook: vi.fn(async (_eventValue: unknown) => {}),
}));

const beforeResetHookMocks = vi.hoisted(() => ({
  runBeforeReset: vi.fn(async () => {}),
}));

const sessionLifecycleHookMocks = vi.hoisted(() => ({
  runSessionEnd: vi.fn(async () => {}),
  runSessionStart: vi.fn(async () => {}),
}));

const subagentLifecycleHookMocks = vi.hoisted(() => ({
  runSubagentEnded: vi.fn(async () => {}),
}));

const beforeResetHookState = vi.hoisted(() => ({
  hasBeforeResetHook: false,
}));

const sessionLifecycleHookState = vi.hoisted(() => ({
  hasSessionEndHook: true,
  hasSessionStartHook: true,
}));

const subagentLifecycleHookState = vi.hoisted(() => ({
  hasSubagentEndedHook: true,
}));

const threadBindingMocks = vi.hoisted(() => ({
  unbindThreadBindingsBySessionKey: vi.fn(async (_params?: unknown) => []),
}));
const acpRuntimeMocks = vi.hoisted(() => ({
  cancel: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  getAcpRuntimeBackend: vi.fn(),
  requireAcpRuntimeBackend: vi.fn(),
}));
const acpManagerMocks = vi.hoisted(() => ({
  cancelSession: vi.fn(async () => {}),
  closeSession: vi.fn(async () => {}),
}));
const browserSessionTabMocks = vi.hoisted(() => ({
  closeTrackedBrowserTabsForSessions: vi.fn(async () => 0),
}));
const bundleMcpRuntimeMocks = vi.hoisted(() => ({
  disposeSessionMcpRuntime: vi.fn(async (_sessionId: string) => {}),
  disposeAllSessionMcpRuntimes: vi.fn(async () => {}),
  retireSessionMcpRuntime: vi.fn(async (_params: RetireSessionMcpRuntimeParams) => true),
}));

vi.mock("../../auto-reply/reply/queue.js", async () => {
  const actual = await vi.importActual<typeof import("../../auto-reply/reply/queue.js")>(
    "../../auto-reply/reply/queue.js",
  );
  return {
    ...actual,
    clearSessionQueues: sessionCleanupMocks.clearSessionQueues,
  };
});

vi.mock("../../auto-reply/reply/queue/cleanup.js", async () => {
  const actual = await vi.importActual<typeof import("../../auto-reply/reply/queue/cleanup.js")>(
    "../../auto-reply/reply/queue/cleanup.js",
  );
  return {
    ...actual,
    clearSessionQueues: sessionCleanupMocks.clearSessionQueues,
  };
});

vi.mock("../../auto-reply/reply/session-reset-cleanup.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../auto-reply/reply/session-reset-cleanup.js")
  >("../../auto-reply/reply/session-reset-cleanup.js");
  return {
    ...actual,
    stopSessionResetSubagents: sessionCleanupMocks.stopSessionResetSubagents,
  };
});

vi.mock("../../agents/bootstrap-cache.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/bootstrap-cache.js")>(
    "../../agents/bootstrap-cache.js",
  );
  return {
    ...actual,
    clearBootstrapSnapshot: bootstrapCacheMocks.clearBootstrapSnapshot,
  };
});

vi.mock("../../hooks/internal-hooks.js", async () => {
  const actual = await vi.importActual<typeof import("../../hooks/internal-hooks.js")>(
    "../../hooks/internal-hooks.js",
  );
  return {
    ...actual,
    hasInternalHookListeners: sessionHookMocks.hasInternalHookListeners,
    triggerInternalHook: sessionHookMocks.triggerInternalHook,
  };
});

vi.mock("../../plugins/hook-runner-global.js", async () => {
  const actual = await vi.importActual<typeof import("../../plugins/hook-runner-global.js")>(
    "../../plugins/hook-runner-global.js",
  );
  return {
    ...actual,
    getGlobalHookRunner: vi.fn(() => ({
      hasHooks: (hookName: string) =>
        (hookName === "subagent_ended" && subagentLifecycleHookState.hasSubagentEndedHook) ||
        (hookName === "before_reset" && beforeResetHookState.hasBeforeResetHook) ||
        (hookName === "session_end" && sessionLifecycleHookState.hasSessionEndHook) ||
        (hookName === "session_start" && sessionLifecycleHookState.hasSessionStartHook),
      runBeforeReset: beforeResetHookMocks.runBeforeReset,
      runSessionEnd: sessionLifecycleHookMocks.runSessionEnd,
      runSessionStart: sessionLifecycleHookMocks.runSessionStart,
      runSubagentEnded: subagentLifecycleHookMocks.runSubagentEnded,
    })),
  };
});

vi.mock("../../infra/outbound/session-binding-service.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../infra/outbound/session-binding-service.js")
  >("../../infra/outbound/session-binding-service.js");
  return {
    ...actual,
    getSessionBindingService: () => ({
      ...actual.getSessionBindingService(),
      unbind: async (params: unknown) =>
        threadBindingMocks.unbindThreadBindingsBySessionKey(params),
    }),
  };
});

vi.mock("../../acp/runtime/registry.js", async () => {
  const actual = await vi.importActual<typeof import("../../acp/runtime/registry.js")>(
    "../../acp/runtime/registry.js",
  );
  return {
    ...actual,
    getAcpRuntimeBackend: acpRuntimeMocks.getAcpRuntimeBackend,
    requireAcpRuntimeBackend: (backendId?: string) => {
      const backend = acpRuntimeMocks.requireAcpRuntimeBackend(backendId);
      if (!backend) {
        throw new Error("missing mocked ACP backend");
      }
      return backend;
    },
  };
});

vi.mock("../../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    cancelSession: acpManagerMocks.cancelSession,
    closeSession: acpManagerMocks.closeSession,
  }),
}));

vi.mock("../../plugin-sdk/browser-maintenance.js", () => ({
  closeTrackedBrowserTabsForSessions: browserSessionTabMocks.closeTrackedBrowserTabsForSessions,
  movePathToTrash: vi.fn(async () => {}),
}));

vi.mock("../../agents/agent-bundle-mcp-tools.js", async (importOriginal) => ({
  ...(await importOriginal()),
  disposeSessionMcpRuntime: bundleMcpRuntimeMocks.disposeSessionMcpRuntime,
  disposeAllSessionMcpRuntimes: bundleMcpRuntimeMocks.disposeAllSessionMcpRuntimes,
  retireSessionMcpRuntime: bundleMcpRuntimeMocks.retireSessionMcpRuntime,
}));

export function setupGatewaySessionsHandlerTestHarness() {
  const { getHarness, openClient, ...handlerFixture } = createGatewaySessionsTestHarness(false);
  void [getHarness, openClient];
  return handlerFixture;
}

export function setupGatewaySessionsTestHarness(setup?: GatewaySessionsSuiteSetup) {
  return createGatewaySessionsTestHarness(true, setup);
}

function createGatewaySessionsTestHarness(startServer: boolean, setup?: GatewaySessionsSuiteSetup) {
  const { defaultAgentWorkspace, requireHarness, requireSharedSessionStoreDir } =
    installGatewaySessionsTestResources(startServer, setup);
  let sessionStoreCaseSeq = 0;

  beforeEach(async () => {
    const { clearConfigCache, clearRuntimeConfigSnapshot } = await getGatewayConfigModule();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    sessionCleanupMocks.clearSessionQueues.mockClear();
    sessionCleanupMocks.stopSessionResetSubagents.mockClear();
    bootstrapCacheMocks.clearBootstrapSnapshot.mockReset();
    sessionHookMocks.hasInternalHookListeners.mockReset();
    sessionHookMocks.hasInternalHookListeners.mockReturnValue(true);
    sessionHookMocks.triggerInternalHook.mockClear();
    beforeResetHookMocks.runBeforeReset.mockClear();
    beforeResetHookState.hasBeforeResetHook = false;
    sessionLifecycleHookMocks.runSessionEnd.mockClear();
    sessionLifecycleHookMocks.runSessionStart.mockClear();
    sessionLifecycleHookState.hasSessionEndHook = true;
    sessionLifecycleHookState.hasSessionStartHook = true;
    subagentLifecycleHookMocks.runSubagentEnded.mockClear();
    subagentLifecycleHookState.hasSubagentEndedHook = true;
    threadBindingMocks.unbindThreadBindingsBySessionKey.mockClear();
    resetSystemEventsForTest();
    acpRuntimeMocks.cancel.mockClear();
    acpRuntimeMocks.close.mockClear();
    acpRuntimeMocks.getAcpRuntimeBackend.mockReset();
    acpRuntimeMocks.getAcpRuntimeBackend.mockReturnValue(null);
    acpRuntimeMocks.requireAcpRuntimeBackend.mockReset();
    acpRuntimeMocks.requireAcpRuntimeBackend.mockImplementation((backendId?: string) =>
      acpRuntimeMocks.getAcpRuntimeBackend(backendId),
    );
    acpManagerMocks.cancelSession.mockClear();
    acpManagerMocks.closeSession.mockClear();
    browserSessionTabMocks.closeTrackedBrowserTabsForSessions.mockClear();
    browserSessionTabMocks.closeTrackedBrowserTabsForSessions.mockResolvedValue(0);
    bundleMcpRuntimeMocks.disposeSessionMcpRuntime.mockClear();
    bundleMcpRuntimeMocks.disposeSessionMcpRuntime.mockResolvedValue(undefined);
    bundleMcpRuntimeMocks.retireSessionMcpRuntime.mockReset();
    bundleMcpRuntimeMocks.retireSessionMcpRuntime.mockImplementation(async ({ sessionId }) => {
      if (!sessionId) {
        return false;
      }
      await bundleMcpRuntimeMocks.disposeSessionMcpRuntime(sessionId);
      return true;
    });
  });

  const openClient = async (opts?: Parameters<typeof gatewayTestHelpers.connectOk>[1]) => {
    await gatewayTestHelpers.prepareGatewayReplyRuntimeForTest({ force: true });
    return await requireHarness().openClient(opts);
  };

  async function createSessionStoreDir() {
    const dir = path.join(requireSharedSessionStoreDir(), `case-${sessionStoreCaseSeq++}`);
    await fs.mkdir(dir, { recursive: true });
    testState.sessionStorePath = path.join(dir, "sessions.json");
    (await getGatewayConfigModule()).clearRuntimeConfigSnapshot(); // A suite server may prewarm before case setup.
    return { dir, storePath: testState.sessionStorePath };
  }

  async function createSelectedGlobalSessionStore() {
    const { dir } = await createSessionStoreDir();
    const storeTemplate = path.join(dir, "agents", "{agentId}", "sessions", "sessions.json");
    testState.sessionStorePath = storeTemplate;
    testState.sessionConfig = { scope: "global" };
    testState.agentsConfig = { list: [{ id: "main", default: true }, { id: "work" }] };
    return {
      dir,
      storeTemplate,
      mainStorePath: storeTemplate.replace("{agentId}", "main"),
      workStorePath: storeTemplate.replace("{agentId}", "work"),
    };
  }

  async function createConfiguredGlobalAgentSessionStore({
    writePrimeStore = false,
    withTranscripts = false,
  }: {
    writePrimeStore?: boolean;
    withTranscripts?: boolean;
  } = {}) {
    const { dir } = await createSessionStoreDir();
    const storeTemplate = path.join(dir, "agents", "{agentId}", "sessions", "sessions.json");
    testState.sessionStorePath = storeTemplate;
    testState.sessionConfig = { scope: "global" };
    if (writePrimeStore) {
      await gatewayTestHelpers.writeSessionStore({
        entries: {},
        storePath: path.join(dir, "prime-sessions.json"),
      });
    }

    const mainStorePath = storeTemplate.replace("{agentId}", "main");
    const workStorePath = storeTemplate.replace("{agentId}", "work");
    await fs.mkdir(path.dirname(mainStorePath), { recursive: true });
    await fs.mkdir(path.dirname(workStorePath), { recursive: true });
    await gatewayTestHelpers.writeSessionStore({
      agentId: "main",
      entries: {
        global: sessionStoreEntry("sess-main-global"),
      },
      storePath: mainStorePath,
    });
    await gatewayTestHelpers.writeSessionStore({
      agentId: "work",
      entries: {
        global: sessionStoreEntry("sess-work-global", {
          authProfileOverride: "github-copilot:work",
        }),
      },
      storePath: workStorePath,
    });
    if (withTranscripts) {
      await seedLinearSessionTranscript({
        agentId: "main",
        contents: ["main one", "main two"],
        sessionId: "sess-main-global",
        sessionKey: "global",
        storePath: mainStorePath,
      });
      await seedLinearSessionTranscript({
        agentId: "work",
        contents: ["work one", "work two"],
        sessionId: "sess-work-global",
        sessionKey: "global",
        storePath: workStorePath,
      });
    }

    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    if (!configPath) {
      throw new Error("OPENCLAW_CONFIG_PATH is required");
    }
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          agents: { list: [{ id: "main", default: true }, { id: "work" }] },
          session: { scope: "global", store: storeTemplate },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    const { clearConfigCache, clearRuntimeConfigSnapshot, getRuntimeConfig } =
      await getGatewayConfigModule();
    clearRuntimeConfigSnapshot();
    clearConfigCache();

    return {
      clearConfigCache,
      clearRuntimeConfigSnapshot,
      configPath,
      getRuntimeConfig,
      mainStorePath,
      workStorePath,
    };
  }

  async function resetConfiguredGlobalAgentSessionStore({
    clearConfigCache,
    clearRuntimeConfigSnapshot,
    configPath,
  }: {
    clearConfigCache: () => void;
    clearRuntimeConfigSnapshot: () => void;
    configPath: string;
  }) {
    testState.sessionStorePath = undefined;
    testState.sessionConfig = undefined;
    await fs.writeFile(configPath, "{}\n", "utf-8");
    clearRuntimeConfigSnapshot();
    clearConfigCache();
  }

  async function seedActiveMainSession() {
    const { dir, storePath } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-main", "hello");
    await gatewayTestHelpers.writeSessionStore({
      entries: {
        main: sessionStoreEntry("sess-main"),
      },
    });
    return { dir, storePath };
  }

  return {
    createConfiguredGlobalAgentSessionStore,
    createSessionStoreDir,
    createSelectedGlobalSessionStore,
    defaultAgentWorkspace,
    getHarness: requireHarness,
    openClient,
    resetConfiguredGlobalAgentSessionStore,
    seedActiveMainSession,
  };
}

export async function writeSingleLineSession(dir: string, sessionId: string, content: string) {
  await fs.writeFile(
    path.join(dir, `${sessionId}.jsonl`),
    `${JSON.stringify({ role: "user", content })}\n`,
    "utf-8",
  );
}

export function sessionStoreEntry(sessionId: string, overrides: Partial<SessionEntry> = {}) {
  return {
    sessionId,
    updatedAt: Date.now(),
    ...overrides,
  };
}

function writeSessionFixture(
  sessionFile: string,
  session: { getPersistedEntries(): unknown[] },
): void {
  const contents = session
    .getPersistedEntries()
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  fsSync.writeFileSync(sessionFile, `${contents}\n`, "utf8");
}

export async function createCheckpointFixture(
  dir: string,
  options: { legacyPreCompactionSnapshot?: boolean } = { legacyPreCompactionSnapshot: true },
) {
  const { SessionManager } = await getSessionManagerModule();
  const session = SessionManager.inMemory(dir);
  const userMessage: UserMessage = {
    role: "user",
    content: "before compaction",
    timestamp: Date.now(),
  };
  const assistantMessage: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "working on it" }],
    api: "responses",
    provider: "openai",
    model: "gpt-test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  session.appendMessage(userMessage);
  session.appendMessage(assistantMessage);
  const preCompactionLeafId = session.getLeafId();
  if (!preCompactionLeafId) {
    throw new Error("expected persisted session leaf before compaction");
  }
  const sessionFile = path.join(dir, `${session.getSessionId()}.jsonl`);
  writeSessionFixture(sessionFile, session);
  const legacyPreCompactionSnapshot = options.legacyPreCompactionSnapshot ?? true;
  const preCompactionSessionFile = legacyPreCompactionSnapshot
    ? path.join(dir, `${path.parse(sessionFile).name}.checkpoint-test.jsonl`)
    : undefined;
  if (preCompactionSessionFile) {
    fsSync.copyFileSync(sessionFile, preCompactionSessionFile);
  }
  const preCompactionSession = preCompactionSessionFile
    ? SessionManager.fromEntries(session.getPersistedEntries(), dir)
    : undefined;
  session.appendCompaction("checkpoint summary", preCompactionLeafId, 123, { ok: true });
  const postCompactionLeafId = session.getLeafId();
  if (!postCompactionLeafId) {
    throw new Error("expected post-compaction leaf");
  }
  writeSessionFixture(sessionFile, session);
  return {
    session,
    sessionId: session.getSessionId(),
    sessionFile,
    preCompactionSession,
    preCompactionSessionFile,
    preCompactionLeafId,
    postCompactionLeafId,
  };
}

export function expectActiveRunCleanup(
  requesterSessionKey: string,
  expectedQueueKeys: string[],
  sessionId: string,
  requesterAgentId: string,
) {
  expect(sessionCleanupMocks.stopSessionResetSubagents).toHaveBeenCalledWith(
    expect.objectContaining({
      cfg: expect.any(Object),
      sessionKey: requesterSessionKey,
      agentId: requesterAgentId,
    }),
  );
  expectSessionQueueCleanup(expectedQueueKeys);
  expect(embeddedRunMock.abortCalls).toEqual([sessionId]);
  expect(embeddedRunMock.waitCalls).toEqual([sessionId]);
}

function expectSessionQueueCleanup(expectedQueueKeys: string[]) {
  expect(sessionCleanupMocks.clearSessionQueues).toHaveBeenCalledTimes(1);
  const clearedKeys = (
    sessionCleanupMocks.clearSessionQueues.mock.calls as unknown as Array<[string[]]>
  )[0]?.[0];
  for (const key of expectedQueueKeys) {
    expect(clearedKeys).toContain(key);
  }
}

export function expectNoSessionQueueCleanup() {
  expect(sessionCleanupMocks.clearSessionQueues).not.toHaveBeenCalled();
}

type SessionsHandlers = Awaited<ReturnType<typeof getSessionsHandlers>>;
type SessionsHandlerOptions = Parameters<SessionsHandlers[keyof SessionsHandlers]>[0];

export async function directSessionReq<TPayload = unknown>(
  method: keyof SessionsHandlers,
  params: Record<string, unknown>,
  opts?: {
    context?: Record<string, unknown>;
    client?: SessionsHandlerOptions["client"];
    isWebchatConnect?: SessionsHandlerOptions["isWebchatConnect"];
    sessionMutationAuthorization?: SessionsHandlerOptions["sessionMutationAuthorization"];
    coercePayload?: (payload: unknown) => TPayload;
  },
): Promise<{
  ok: boolean;
  payload?: TPayload;
  error?: { code?: string; message?: string; details?: unknown };
}> {
  const sessionsHandlers = await getSessionsHandlers();
  const { getRuntimeConfig } = await getGatewayConfigModule();
  const loadGatewayModelCatalog =
    (opts?.context?.loadGatewayModelCatalog as GatewayRequestContext["loadGatewayModelCatalog"]) ??
    (async () => agentDiscoveryMock.models);
  let result:
    | {
        ok: boolean;
        payload?: TPayload;
        error?: { code?: string; message?: string; details?: unknown };
      }
    | undefined;
  const handler = sessionsHandlers[method];
  if (!handler) {
    throw new Error(`missing sessions handler for ${method}`);
  }
  await handler({
    req: {} as never,
    params,
    respond: (ok, payload, error) => {
      result = {
        ok,
        payload:
          payload === undefined
            ? undefined
            : opts?.coercePayload
              ? opts.coercePayload(payload)
              : (payload as TPayload),
        error,
      };
    },
    context: {
      ...createDirectChatContext(),
      broadcastToConnIds: vi.fn(),
      chatAbortControllers: new Map(),
      chatQueuedTurns: new Map(),
      dedupe: new Map(),
      getSessionEventSubscriberConnIds: () => new Set<string>(),
      loadGatewayModelCatalog,
      readPreparedGatewayModelCatalog: async () => ({ entries: await loadGatewayModelCatalog() }),
      getRuntimeConfig,
      ...opts?.context,
    } as never,
    client: opts?.client ?? null,
    isWebchatConnect: opts?.isWebchatConnect ?? (() => false),
    sessionMutationAuthorization: opts?.sessionMutationAuthorization,
  });
  if (!result) {
    throw new Error(`${method} did not respond`);
  }
  return result;
}

export function isInternalHookEvent(value: unknown): value is InternalHookEvent {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.type === "string" &&
    typeof candidate.action === "string" &&
    typeof candidate.sessionKey === "string" &&
    Array.isArray(candidate.messages) &&
    typeof candidate.context === "object" &&
    candidate.context !== null
  );
}

export {
  bootstrapCacheMocks,
  sessionHookMocks,
  beforeResetHookMocks,
  sessionLifecycleHookMocks,
  subagentLifecycleHookMocks,
  beforeResetHookState,
  subagentLifecycleHookState,
  threadBindingMocks,
  acpRuntimeMocks,
  acpManagerMocks,
  browserSessionTabMocks,
  bundleMcpRuntimeMocks,
};
