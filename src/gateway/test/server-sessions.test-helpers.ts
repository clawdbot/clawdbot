import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, beforeEach, expect, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { InternalHookEvent } from "../../hooks/internal-hooks.js";
import { resetSystemEventsForTest } from "../../infra/system-events.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "../server.e2e-ws-harness.js";
import {
  connectOk,
  embeddedRunMock,
  installGatewayTestHooks,
  piSdkMock,
  rpcReq,
  testState,
  writeSessionStore,
} from "../test-helpers.js";

let sessionManagerModulePromise:
  | Promise<typeof import("@earendil-works/pi-coding-agent")>
  | undefined;
let gatewayConfigModulePromise: Promise<typeof import("../../config/config.js")> | undefined;

export async function getSessionManagerModule() {
  sessionManagerModulePromise ??= import("@earendil-works/pi-coding-agent");
  return await sessionManagerModulePromise;
}

export async function getGatewayConfigModule() {
  gatewayConfigModulePromise ??= import("../../config/config.js");
  return await gatewayConfigModulePromise;
}

export async function getSessionsHandlers() {
  return (await import("../server-methods/sessions.js")).sessionsHandlers;
}

export function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
  stopSubagentsForRequester: vi.fn(() => ({ stopped: 0 })),
}));

const bootstrapCacheMocks = vi.hoisted(() => ({
  clearBootstrapSnapshot: vi.fn(),
}));

const sessionHookMocks = vi.hoisted(() => ({
  hasInternalHookListeners: vi.fn(() => true),
  triggerInternalHook: vi.fn(async (_event: unknown) => {}),
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
  unbindThreadBindingsBySessionKey: vi.fn((_params?: unknown) => []),
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

vi.mock("../../auto-reply/reply/abort.js", async () => {
  const actual = await vi.importActual<typeof import("../../auto-reply/reply/abort.js")>(
    "../../auto-reply/reply/abort.js",
  );
  return {
    ...actual,
    stopSubagentsForRequester: sessionCleanupMocks.stopSubagentsForRequester,
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

vi.mock("../../agents/pi-bundle-mcp-tools.js", () => ({
  disposeSessionMcpRuntime: bundleMcpRuntimeMocks.disposeSessionMcpRuntime,
  disposeAllSessionMcpRuntimes: bundleMcpRuntimeMocks.disposeAllSessionMcpRuntimes,
  retireSessionMcpRuntime: ({ sessionId }: { sessionId?: string | null }) =>
    sessionId
      ? bundleMcpRuntimeMocks.disposeSessionMcpRuntime(sessionId).then(() => true)
      : Promise.resolve(false),
}));

export function setupGatewaySessionsTestHarness() {
  installGatewayTestHooks({ scope: "suite" });

  let harness: GatewayServerHarness;
  let sharedSessionStoreDir: string;
  let sessionStoreCaseSeq = 0;

  beforeAll(async () => {
    harness = await startGatewayServerHarness();
    sharedSessionStoreDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-"));
  });

  afterAll(async () => {
    await harness.close();
    await fs.rm(sharedSessionStoreDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const { clearConfigCache, clearRuntimeConfigSnapshot } = await getGatewayConfigModule();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    sessionCleanupMocks.clearSessionQueues.mockClear();
    sessionCleanupMocks.stopSubagentsForRequester.mockClear();
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
  });

  const openClient = async (opts?: Parameters<typeof connectOk>[1]) =>
    await harness.openClient(opts);

  async function createSessionStoreDir() {
    const dir = path.join(sharedSessionStoreDir, `case-${sessionStoreCaseSeq++}`);
    await fs.mkdir(dir, { recursive: true });
    const storePath = path.join(dir, "sessions.json");
    testState.sessionStorePath = storePath;
    return { dir, storePath };
  }

  async function seedActiveMainSession() {
    const { dir, storePath } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-main", "hello");
    await writeSessionStore({
      entries: {
        main: sessionStoreEntry("sess-main"),
      },
    });
    return { dir, storePath };
  }

  return {
    createSessionStoreDir,
    getHarness: () => harness,
    openClient,
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

export async function createCheckpointFixture(dir: string) {
  const { SessionManager } = await getSessionManagerModule();
  const session = SessionManager.create(dir, dir);
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
  const sessionFile = session.getSessionFile();
  if (!sessionFile) {
    throw new Error("expected persisted session file");
  }
  const preCompactionSessionFile = path.join(
    dir,
    `${path.parse(sessionFile).name}.checkpoint-test.jsonl`,
  );
  fsSync.copyFileSync(sessionFile, preCompactionSessionFile);
  const preCompactionSession = SessionManager.open(preCompactionSessionFile, dir);
  session.appendCompaction("checkpoint summary", preCompactionLeafId, 123, { ok: true });
  const postCompactionLeafId = session.getLeafId();
  if (!postCompactionLeafId) {
    throw new Error("expected post-compaction leaf");
  }
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
) {
  expect(sessionCleanupMocks.stopSubagentsForRequester).toHaveBeenCalledWith({
    cfg: expect.any(Object),
    requesterSessionKey,
  });
  expect(sessionCleanupMocks.clearSessionQueues).toHaveBeenCalledTimes(1);
  const clearedKeys = (
    sessionCleanupMocks.clearSessionQueues.mock.calls as unknown as Array<[string[]]>
  )[0]?.[0];
  expect(clearedKeys).toEqual(expect.arrayContaining(expectedQueueKeys));
  expect(embeddedRunMock.abortCalls).toEqual([sessionId]);
  expect(embeddedRunMock.waitCalls).toEqual([sessionId]);
}

export async function getMainPreviewEntry(ws: import("ws").WebSocket) {
  const preview = await rpcReq<{
    previews: Array<{
      key: string;
      status: string;
      items: Array<{ role: string; text: string }>;
    }>;
  }>(ws, "sessions.preview", { keys: ["main"], limit: 3, maxChars: 120 });
  expect(preview.ok).toBe(true);
  const entry = preview.payload?.previews[0];
  expect(entry?.key).toBe("main");
  expect(entry?.status).toBe("ok");
  return entry;
}

type SessionsHandlers = Awaited<ReturnType<typeof getSessionsHandlers>>;

export async function directSessionReq<TPayload = unknown>(
  method: keyof SessionsHandlers,
  params: Record<string, unknown>,
  opts?: {
    context?: Record<string, unknown>;
    client?: Parameters<SessionsHandlers[keyof SessionsHandlers]>[0]["client"];
    isWebchatConnect?: Parameters<SessionsHandlers[keyof SessionsHandlers]>[0]["isWebchatConnect"];
    coercePayload?: (payload: unknown) => TPayload;
  },
): Promise<{ ok: boolean; payload?: TPayload; error?: { code?: string; message?: string } }> {
  const sessionsHandlers = await getSessionsHandlers();
  const { getRuntimeConfig } = await getGatewayConfigModule();
  let result:
    | { ok: boolean; payload?: TPayload; error?: { code?: string; message?: string } }
    | undefined;
  await sessionsHandlers[method]({
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
      broadcastToConnIds: vi.fn(),
      getSessionEventSubscriberConnIds: () => new Set<string>(),
      loadGatewayModelCatalog: async () => piSdkMock.models,
      getRuntimeConfig: getRuntimeConfig,
      ...opts?.context,
    } as never,
    client: opts?.client ?? null,
    isWebchatConnect: opts?.isWebchatConnect ?? (() => false),
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
