import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage, UserMessage } from "@mariozechner/pi-ai";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { isSessionPatchEvent, type InternalHookEvent } from "../hooks/internal-hooks.js";
import { withEnvAsync } from "../test-utils/env.js";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "./protocol/client-info.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import { createToolSummaryPreviewTranscriptLines } from "./session-preview.test-helpers.js";
import {
  connectOk,
  embeddedRunMock,
  installGatewayTestHooks,
  piSdkMock,
  rpcReq,
  startConnectedServerWithClient,
  testState,
  trackConnectChallengeNonce,
  writeSessionStore,
} from "./test-helpers.js";

let sessionManagerModulePromise:
  | Promise<typeof import("@mariozechner/pi-coding-agent")>
  | undefined;
let gatewayConfigModulePromise: Promise<typeof import("../config/config.js")> | undefined;

async function getSessionManagerModule() {
  sessionManagerModulePromise ??= import("@mariozechner/pi-coding-agent");
  return await sessionManagerModulePromise;
}

async function getGatewayConfigModule() {
  gatewayConfigModulePromise ??= import("../config/config.js");
  return await gatewayConfigModulePromise;
}

async function getSessionsHandlers() {
  return (await import("./server-methods/sessions.js")).sessionsHandlers;
}

const sessionCleanupMocks = vi.hoisted(() => ({
  clearSessionQueues: vi.fn(() => ({ followupCleared: 0, laneCleared: 0, keys: [] })),
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
}));

vi.mock("../auto-reply/reply/queue.js", async () => {
  const actual = await vi.importActual<typeof import("../auto-reply/reply/queue.js")>(
    "../auto-reply/reply/queue.js",
  );
  return {
    ...actual,
    clearSessionQueues: sessionCleanupMocks.clearSessionQueues,
  };
});

vi.mock("../auto-reply/reply/abort.js", async () => {
  const actual = await vi.importActual<typeof import("../auto-reply/reply/abort.js")>(
    "../auto-reply/reply/abort.js",
  );
  return {
    ...actual,
    stopSubagentsForRequester: sessionCleanupMocks.stopSubagentsForRequester,
  };
});

vi.mock("../agents/bootstrap-cache.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/bootstrap-cache.js")>(
    "../agents/bootstrap-cache.js",
  );
  return {
    ...actual,
    clearBootstrapSnapshot: bootstrapCacheMocks.clearBootstrapSnapshot,
  };
});

vi.mock("../hooks/internal-hooks.js", async () => {
  const actual = await vi.importActual<typeof import("../hooks/internal-hooks.js")>(
    "../hooks/internal-hooks.js",
  );
  return {
    ...actual,
    hasInternalHookListeners: sessionHookMocks.hasInternalHookListeners,
    triggerInternalHook: sessionHookMocks.triggerInternalHook,
  };
});

vi.mock("../plugins/hook-runner-global.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/hook-runner-global.js")>(
    "../plugins/hook-runner-global.js",
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

vi.mock("../infra/outbound/session-binding-service.js", async () => {
  const actual = await vi.importActual<
    typeof import("../infra/outbound/session-binding-service.js")
  >("../infra/outbound/session-binding-service.js");
  return {
    ...actual,
    getSessionBindingService: () => ({
      ...actual.getSessionBindingService(),
      unbind: async (params: unknown) =>
        threadBindingMocks.unbindThreadBindingsBySessionKey(params),
    }),
  };
});

vi.mock("../acp/runtime/registry.js", async () => {
  const actual = await vi.importActual<typeof import("../acp/runtime/registry.js")>(
    "../acp/runtime/registry.js",
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

vi.mock("../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    cancelSession: acpManagerMocks.cancelSession,
    closeSession: acpManagerMocks.closeSession,
  }),
}));

vi.mock("../plugin-sdk/browser-maintenance.js", () => ({
  closeTrackedBrowserTabsForSessions: browserSessionTabMocks.closeTrackedBrowserTabsForSessions,
  movePathToTrash: vi.fn(async () => {}),
}));

vi.mock("../agents/pi-bundle-mcp-tools.js", () => ({
  disposeSessionMcpRuntime: bundleMcpRuntimeMocks.disposeSessionMcpRuntime,
  retireSessionMcpRuntime: ({ sessionId }: { sessionId?: string | null }) =>
    sessionId
      ? bundleMcpRuntimeMocks.disposeSessionMcpRuntime(sessionId).then(() => true)
      : Promise.resolve(false),
}));

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

const openClient = async (opts?: Parameters<typeof connectOk>[1]) => await harness.openClient(opts);

async function createSessionStoreDir() {
  const dir = path.join(sharedSessionStoreDir, `case-${sessionStoreCaseSeq++}`);
  await fs.mkdir(dir, { recursive: true });
  const storePath = path.join(dir, "sessions.json");
  testState.sessionStorePath = storePath;
  return { dir, storePath };
}

async function writeSingleLineSession(dir: string, sessionId: string, content: string) {
  await fs.writeFile(
    path.join(dir, `${sessionId}.jsonl`),
    `${JSON.stringify({ role: "user", content })}\n`,
    "utf-8",
  );
}

async function createCheckpointFixture(dir: string) {
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

async function seedActiveMainSession() {
  const { dir, storePath } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");
  await writeSessionStore({
    entries: {
      main: { sessionId: "sess-main", updatedAt: Date.now() },
    },
  });
  return { dir, storePath };
}

function expectActiveRunCleanup(
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

async function getMainPreviewEntry(ws: import("ws").WebSocket) {
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

async function directSessionReq<TPayload = unknown>(
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

function isInternalHookEvent(value: unknown): value is InternalHookEvent {
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

describe("gateway server sessions", () => {
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

  test("sessions.create stores dashboard session model and parent linkage, and creates a transcript", async () => {
    const { dir, storePath } = await createSessionStoreDir();
    piSdkMock.enabled = true;
    piSdkMock.models = [{ id: "gpt-test-a", name: "A", provider: "openai" }];
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-parent",
          updatedAt: Date.now(),
        },
      },
    });
    const created = await directSessionReq<{
      key?: string;
      sessionId?: string;
      entry?: {
        label?: string;
        providerOverride?: string;
        modelOverride?: string;
        parentSessionKey?: string;
        sessionFile?: string;
      };
    }>("sessions.create", {
      agentId: "ops",
      label: "Dashboard Chat",
      model: "openai/gpt-test-a",
      parentSessionKey: "main",
    });

    expect(created.ok).toBe(true);
    expect(created.payload?.key).toMatch(/^agent:ops:dashboard:/);
    expect(created.payload?.entry?.label).toBe("Dashboard Chat");
    expect(created.payload?.entry?.providerOverride).toBe("openai");
    expect(created.payload?.entry?.modelOverride).toBe("gpt-test-a");
    expect(created.payload?.entry?.parentSessionKey).toBe("agent:main:main");
    expect(created.payload?.entry?.sessionFile).toBeTruthy();
    expect(created.payload?.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const rawStore = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      {
        sessionId?: string;
        label?: string;
        providerOverride?: string;
        modelOverride?: string;
        parentSessionKey?: string;
        sessionFile?: string;
      }
    >;
    const key = created.payload?.key as string;
    expect(rawStore[key]).toMatchObject({
      sessionId: created.payload?.sessionId,
      label: "Dashboard Chat",
      providerOverride: "openai",
      modelOverride: "gpt-test-a",
      parentSessionKey: "agent:main:main",
    });
    expect(created.payload?.entry?.sessionFile).toBe(rawStore[key]?.sessionFile);

    const transcriptPath = path.join(dir, `${created.payload?.sessionId}.jsonl`);
    const transcript = await fs.readFile(transcriptPath, "utf-8");
    const [headerLine] = transcript.trim().split(/\r?\n/, 1);
    expect(JSON.parse(headerLine) as { type?: string; id?: string }).toMatchObject({
      type: "session",
      id: created.payload?.sessionId,
    });
  });

  test("sessions.create accepts an explicit key for persistent dashboard sessions", async () => {
    await createSessionStoreDir();

    const key = "agent:ops-agent:dashboard:direct:subagent-orchestrator";
    const created = await directSessionReq<{
      key?: string;
      sessionId?: string;
      entry?: {
        label?: string;
      };
    }>("sessions.create", {
      key,
      label: "Dashboard Orchestrator",
    });

    expect(created.ok).toBe(true);
    expect(created.payload?.key).toBe(key);
    expect(created.payload?.entry?.label).toBe("Dashboard Orchestrator");
    expect(created.payload?.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("sessions.create scopes the main alias to the requested agent", async () => {
    const { storePath } = await createSessionStoreDir();

    const created = await directSessionReq<{
      key?: string;
      sessionId?: string;
      entry?: {
        sessionFile?: string;
      };
    }>("sessions.create", {
      key: "main",
      agentId: "longmemeval",
    });

    expect(created.ok).toBe(true);
    expect(created.payload?.key).toBe("agent:longmemeval:main");
    expect(created.payload?.entry?.sessionFile).toBeTruthy();

    const rawStore = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      {
        sessionId?: string;
      }
    >;
    expect(rawStore["agent:longmemeval:main"]?.sessionId).toBe(created.payload?.sessionId);
    expect(rawStore["agent:main:main"]).toBeUndefined();
  });

  test("sessions.create preserves global and unknown sentinel keys", async () => {
    const { storePath } = await createSessionStoreDir();

    const globalCreated = await directSessionReq<{
      key?: string;
      sessionId?: string;
      entry?: {
        sessionFile?: string;
      };
    }>("sessions.create", {
      key: "global",
      agentId: "longmemeval",
    });

    expect(globalCreated.ok).toBe(true);
    expect(globalCreated.payload?.key).toBe("global");
    expect(globalCreated.payload?.entry?.sessionFile).toBeTruthy();

    const unknownCreated = await directSessionReq<{
      key?: string;
      sessionId?: string;
      entry?: {
        sessionFile?: string;
      };
    }>("sessions.create", {
      key: "unknown",
      agentId: "longmemeval",
    });

    expect(unknownCreated.ok).toBe(true);
    expect(unknownCreated.payload?.key).toBe("unknown");
    expect(unknownCreated.payload?.entry?.sessionFile).toBeTruthy();

    const rawStore = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      {
        sessionId?: string;
      }
    >;
    expect(rawStore.global?.sessionId).toBe(globalCreated.payload?.sessionId);
    expect(rawStore.unknown?.sessionId).toBe(unknownCreated.payload?.sessionId);
    expect(rawStore["agent:longmemeval:global"]).toBeUndefined();
    expect(rawStore["agent:longmemeval:unknown"]).toBeUndefined();
  });

  test("sessions.create rejects unknown parentSessionKey", async () => {
    await createSessionStoreDir();

    const created = await directSessionReq("sessions.create", {
      agentId: "ops",
      parentSessionKey: "agent:main:missing",
    });

    expect(created.ok).toBe(false);
    expect((created.error as { message?: string } | undefined)?.message ?? "").toContain(
      "unknown parent session",
    );
  });

  test("sessions.create can start the first agent turn from an initial task", async () => {
    await createSessionStoreDir();
    // Register "ops" so the deleted-agent guard added in #65986 does not
    // reject the auto-started chat.send triggered by `task:`.
    testState.agentsConfig = { list: [{ id: "ops", default: true }] };
    const { ws } = await openClient();

    const created = await rpcReq<{
      key?: string;
      sessionId?: string;
      runStarted?: boolean;
      runId?: string;
      messageSeq?: number;
    }>(ws, "sessions.create", {
      agentId: "ops",
      label: "Dashboard Chat",
      task: "hello from create",
    });

    expect(created.ok).toBe(true);
    expect(created.payload?.key).toMatch(/^agent:ops:dashboard:/);
    expect(created.payload?.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(created.payload?.runStarted).toBe(true);
    expect(created.payload?.runId).toBeTruthy();
    expect(created.payload?.messageSeq).toBe(1);

    ws.close();
  });

  test("sessions.list surfaces transcript usage and model fallbacks from the transcript", async () => {
    const { dir } = await createSessionStoreDir();
    testState.agentConfig = {
      models: {
        "anthropic/claude-sonnet-4-6": { params: { context1m: true } },
      },
    };
    await fs.writeFile(
      path.join(dir, "sess-parent.jsonl"),
      `${JSON.stringify({ type: "session", version: 1, id: "sess-parent" })}\n`,
      "utf-8",
    );
    await fs.writeFile(
      path.join(dir, "sess-child.jsonl"),
      [
        JSON.stringify({ type: "session", version: 1, id: "sess-child" }),
        JSON.stringify({
          message: {
            role: "assistant",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            usage: {
              input: 2_000,
              output: 500,
              cacheRead: 1_000,
              cost: { total: 0.0042 },
            },
          },
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            provider: "openclaw",
            model: "delivery-mirror",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        }),
      ].join("\n"),
      "utf-8",
    );
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-parent",
          updatedAt: Date.now(),
        },
        "dashboard:child": {
          sessionId: "sess-child",
          updatedAt: Date.now() - 1_000,
          modelProvider: "anthropic",
          model: "claude-sonnet-4-6",
          parentSessionKey: "agent:main:main",
          totalTokens: 0,
          totalTokensFresh: false,
          inputTokens: 0,
          outputTokens: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
    });

    const { ws } = await openClient();
    const listed = await rpcReq<{
      sessions: Array<{
        key: string;
        parentSessionKey?: string;
        childSessions?: string[];
        totalTokens?: number;
        totalTokensFresh?: boolean;
        contextTokens?: number;
        estimatedCostUsd?: number;
        modelProvider?: string;
        model?: string;
      }>;
    }>(ws, "sessions.list", {});

    expect(listed.ok).toBe(true);
    const parent = listed.payload?.sessions.find((session) => session.key === "agent:main:main");
    const child = listed.payload?.sessions.find(
      (session) => session.key === "agent:main:dashboard:child",
    );
    expect(parent?.childSessions).toEqual(["agent:main:dashboard:child"]);
    expect(child?.parentSessionKey).toBe("agent:main:main");
    expect(child?.totalTokens).toBe(3_000);
    expect(child?.totalTokensFresh).toBe(true);
    expect(child?.contextTokens).toBe(1_048_576);
    expect(child?.estimatedCostUsd).toBe(0.0042);
    expect(child?.modelProvider).toBe("anthropic");
    expect(child?.model).toBe("claude-sonnet-4-6");

    ws.close();
  });

  test("sessions.changed mutation events include live usage metadata", async () => {
    const { dir } = await createSessionStoreDir();
    await fs.writeFile(
      path.join(dir, "sess-main.jsonl"),
      [
        JSON.stringify({ type: "session", version: 1, id: "sess-main" }),
        JSON.stringify({
          id: "msg-usage-zero",
          message: {
            role: "assistant",
            provider: "openai-codex",
            model: "gpt-5.3-codex-spark",
            usage: {
              input: 5_107,
              output: 1_827,
              cacheRead: 1_536,
              cacheWrite: 0,
              cost: { total: 0 },
            },
            timestamp: Date.now(),
          },
        }),
      ].join("\n"),
      "utf-8",
    );
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
          modelProvider: "openai-codex",
          model: "gpt-5.3-codex-spark",
          contextTokens: 123_456,
          totalTokens: 0,
          totalTokensFresh: false,
        },
      },
    });

    const broadcastToConnIds = vi.fn();
    const respond = vi.fn();
    const sessionsHandlers = await getSessionsHandlers();
    await sessionsHandlers["sessions.patch"]({
      req: {} as never,
      params: {
        key: "main",
        label: "Renamed",
      },
      respond,
      context: {
        broadcastToConnIds,
        getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
        loadGatewayModelCatalog: async () => ({ providers: [] }),
      } as never,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ ok: true, key: "agent:main:main" }),
      undefined,
    );
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({
        sessionKey: "agent:main:main",
        reason: "patch",
        totalTokens: 6_643,
        totalTokensFresh: true,
        contextTokens: 123_456,
        estimatedCostUsd: 0,
        modelProvider: "openai-codex",
        model: "gpt-5.3-codex-spark",
      }),
      new Set(["conn-1"]),
      { dropIfSlow: true },
    );
  });

  test("sessions.changed mutation events include live session setting metadata", async () => {
    await createSessionStoreDir();
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
          verboseLevel: "on",
          responseUsage: "full",
          fastMode: true,
          lastChannel: "telegram",
          lastTo: "-100123",
          lastAccountId: "acct-1",
          lastThreadId: 42,
        },
      },
    });

    const broadcastToConnIds = vi.fn();
    const respond = vi.fn();
    const sessionsHandlers = await getSessionsHandlers();
    await sessionsHandlers["sessions.patch"]({
      req: {} as never,
      params: {
        key: "main",
        verboseLevel: "on",
      },
      respond,
      context: {
        broadcastToConnIds,
        getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
        loadGatewayModelCatalog: async () => ({ providers: [] }),
      } as never,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ ok: true, key: "agent:main:main" }),
      undefined,
    );
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({
        sessionKey: "agent:main:main",
        reason: "patch",
        verboseLevel: "on",
        responseUsage: "full",
        fastMode: true,
        lastChannel: "telegram",
        lastTo: "-100123",
        lastAccountId: "acct-1",
        lastThreadId: 42,
      }),
      new Set(["conn-1"]),
      { dropIfSlow: true },
    );
  });

  test("sessions.changed mutation events include sendPolicy metadata", async () => {
    await createSessionStoreDir();
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
          sendPolicy: "deny",
        },
      },
    });

    const broadcastToConnIds = vi.fn();
    const respond = vi.fn();
    const sessionsHandlers = await getSessionsHandlers();
    await sessionsHandlers["sessions.patch"]({
      req: {} as never,
      params: {
        key: "main",
        sendPolicy: "deny",
      },
      respond,
      context: {
        broadcastToConnIds,
        getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
        loadGatewayModelCatalog: async () => ({ providers: [] }),
      } as never,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ ok: true, key: "agent:main:main" }),
      undefined,
    );
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({
        sessionKey: "agent:main:main",
        reason: "patch",
        sendPolicy: "deny",
      }),
      new Set(["conn-1"]),
      { dropIfSlow: true },
    );
  });

  test("sessions.changed mutation events include subagent ownership metadata", async () => {
    await createSessionStoreDir();
    await writeSessionStore({
      entries: {
        "subagent:child": {
          sessionId: "sess-child",
          updatedAt: Date.now(),
          spawnedBy: "agent:main:main",
          spawnedWorkspaceDir: "/tmp/subagent-workspace",
          forkedFromParent: true,
          spawnDepth: 2,
          subagentRole: "orchestrator",
          subagentControlScope: "children",
        },
      },
    });

    const broadcastToConnIds = vi.fn();
    const respond = vi.fn();
    const sessionsHandlers = await getSessionsHandlers();
    await sessionsHandlers["sessions.patch"]({
      req: {} as never,
      params: {
        key: "subagent:child",
        label: "Child",
      },
      respond,
      context: {
        broadcastToConnIds,
        getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
        loadGatewayModelCatalog: async () => ({ providers: [] }),
      } as never,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ ok: true, key: "agent:main:subagent:child" }),
      undefined,
    );
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({
        sessionKey: "agent:main:subagent:child",
        reason: "patch",
        spawnedBy: "agent:main:main",
        spawnedWorkspaceDir: "/tmp/subagent-workspace",
        forkedFromParent: true,
        spawnDepth: 2,
        subagentRole: "orchestrator",
        subagentControlScope: "children",
      }),
      new Set(["conn-1"]),
      { dropIfSlow: true },
    );
  });

  test("lists and patches session store via sessions.* RPC", async () => {
    const { dir, storePath } = await createSessionStoreDir();
    const now = Date.now();
    const recent = now - 30_000;
    const stale = now - 15 * 60_000;

    await fs.writeFile(
      path.join(dir, "sess-main.jsonl"),
      `${Array.from({ length: 10 })
        .map((_, idx) => JSON.stringify({ role: "user", content: `line ${idx}` }))
        .join("\n")}\n`,
      "utf-8",
    );
    await fs.writeFile(
      path.join(dir, "sess-group.jsonl"),
      `${JSON.stringify({ role: "user", content: "group line 0" })}\n`,
      "utf-8",
    );

    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: recent,
          modelProvider: "anthropic",
          model: "claude-sonnet-4-6",
          inputTokens: 10,
          outputTokens: 20,
          thinkingLevel: "low",
          verboseLevel: "on",
          lastChannel: "whatsapp",
          lastTo: "+1555",
          lastAccountId: "work",
          lastThreadId: "1737500000.123456",
        },
        "discord:group:dev": {
          sessionId: "sess-group",
          updatedAt: stale,
          totalTokens: 50,
        },
        "agent:main:subagent:one": {
          sessionId: "sess-subagent",
          updatedAt: stale,
          spawnedBy: "agent:main:main",
        },
        global: {
          sessionId: "sess-global",
          updatedAt: now - 10_000,
        },
      },
    });

    const { ws, hello } = await openClient();
    expect((hello as { features?: { methods?: string[] } }).features?.methods).toEqual(
      expect.arrayContaining([
        "sessions.list",
        "sessions.preview",
        "sessions.patch",
        "sessions.reset",
        "sessions.delete",
        "sessions.compact",
      ]),
    );
    const sessionsHandlers = await getSessionsHandlers();
    const directContext = {
      broadcastToConnIds: vi.fn(),
      getSessionEventSubscriberConnIds: () => new Set<string>(),
      loadGatewayModelCatalog: async () => piSdkMock.models,
    } as never;
    async function directSessionReq<TPayload = unknown>(
      method: keyof typeof sessionsHandlers,
      params: Record<string, unknown>,
      coercePayload?: (payload: unknown) => TPayload,
    ): Promise<{ ok: boolean; payload?: TPayload; error?: unknown }> {
      let result:
        | {
            ok: boolean;
            payload?: TPayload;
            error?: unknown;
          }
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
                : coercePayload
                  ? coercePayload(payload)
                  : (payload as TPayload),
            error,
          };
        },
        context: directContext,
        client: null,
        isWebchatConnect: () => false,
      });
      if (!result) {
        throw new Error(`${method} did not respond`);
      }
      return result;
    }

    const resolvedByKey = await rpcReq<{ ok: true; key: string }>(ws, "sessions.resolve", {
      key: "main",
    });
    expect(resolvedByKey.ok).toBe(true);
    expect(resolvedByKey.payload?.key).toBe("agent:main:main");

    const resolvedBySessionId = await rpcReq<{ ok: true; key: string }>(ws, "sessions.resolve", {
      sessionId: "sess-group",
    });
    expect(resolvedBySessionId.ok).toBe(true);
    expect(resolvedBySessionId.payload?.key).toBe("agent:main:discord:group:dev");
    ws.close();

    const list1 = await directSessionReq<{
      path: string;
      defaults?: { model?: string | null; modelProvider?: string | null };
      sessions: Array<{
        key: string;
        totalTokens?: number;
        totalTokensFresh?: boolean;
        thinkingLevel?: string;
        verboseLevel?: string;
        lastAccountId?: string;
        deliveryContext?: { channel?: string; to?: string; accountId?: string };
      }>;
    }>("sessions.list", { includeGlobal: false, includeUnknown: false });

    expect(list1.ok).toBe(true);
    expect(list1.payload?.path).toBe(storePath);
    expect(list1.payload?.sessions.some((s) => s.key === "global")).toBe(false);
    expect(list1.payload?.defaults?.modelProvider).toBe("anthropic");
    const main = list1.payload?.sessions.find((s) => s.key === "agent:main:main");
    expect(main?.totalTokens).toBeUndefined();
    expect(main?.totalTokensFresh).toBe(false);
    expect(main?.thinkingLevel).toBe("low");
    expect(main?.verboseLevel).toBe("on");
    expect(main?.lastAccountId).toBe("work");
    expect(main?.deliveryContext).toEqual({
      channel: "whatsapp",
      to: "+1555",
      accountId: "work",
      threadId: "1737500000.123456",
    });

    const active = await directSessionReq<{
      sessions: Array<{ key: string }>;
    }>("sessions.list", {
      includeGlobal: false,
      includeUnknown: false,
      activeMinutes: 5,
    });
    expect(active.ok).toBe(true);
    expect(active.payload?.sessions.map((s) => s.key)).toEqual(["agent:main:main"]);

    const limited = await directSessionReq<{
      sessions: Array<{ key: string }>;
    }>("sessions.list", {
      includeGlobal: true,
      includeUnknown: false,
      limit: 1,
    });
    expect(limited.ok).toBe(true);
    expect(limited.payload?.sessions).toHaveLength(1);
    expect(limited.payload?.sessions[0]?.key).toBe("global");

    const patched = await directSessionReq<{ ok: true; key: string }>("sessions.patch", {
      key: "agent:main:main",
      thinkingLevel: "medium",
      verboseLevel: "off",
    });
    expect(patched.ok).toBe(true);
    expect(patched.payload?.ok).toBe(true);
    expect(patched.payload?.key).toBe("agent:main:main");

    const sendPolicyPatched = await directSessionReq<{
      ok: true;
      entry: { sendPolicy?: string };
    }>("sessions.patch", { key: "agent:main:main", sendPolicy: "deny" });
    expect(sendPolicyPatched.ok).toBe(true);
    expect(sendPolicyPatched.payload?.entry.sendPolicy).toBe("deny");

    const labelPatched = await directSessionReq<{
      ok: true;
      entry: { label?: string };
    }>("sessions.patch", {
      key: "agent:main:subagent:one",
      label: "Briefing",
    });
    expect(labelPatched.ok).toBe(true);
    expect(labelPatched.payload?.entry.label).toBe("Briefing");

    const labelPatchedDuplicate = await directSessionReq("sessions.patch", {
      key: "agent:main:discord:group:dev",
      label: "Briefing",
    });
    expect(labelPatchedDuplicate.ok).toBe(false);

    const list2 = await directSessionReq<{
      sessions: Array<{
        key: string;
        thinkingLevel?: string;
        verboseLevel?: string;
        sendPolicy?: string;
        label?: string;
        displayName?: string;
      }>;
    }>("sessions.list", {});
    expect(list2.ok).toBe(true);
    const main2 = list2.payload?.sessions.find((s) => s.key === "agent:main:main");
    expect(main2?.thinkingLevel).toBe("medium");
    expect(main2?.verboseLevel).toBe("off");
    expect(main2?.sendPolicy).toBe("deny");
    const subagent = list2.payload?.sessions.find((s) => s.key === "agent:main:subagent:one");
    expect(subagent?.label).toBe("Briefing");
    expect(subagent?.displayName).toBe("Briefing");

    const clearedVerbose = await directSessionReq<{ ok: true; key: string }>("sessions.patch", {
      key: "agent:main:main",
      verboseLevel: null,
    });
    expect(clearedVerbose.ok).toBe(true);

    const list3 = await directSessionReq<{
      sessions: Array<{
        key: string;
        verboseLevel?: string;
      }>;
    }>("sessions.list", {});
    expect(list3.ok).toBe(true);
    const main3 = list3.payload?.sessions.find((s) => s.key === "agent:main:main");
    expect(main3?.verboseLevel).toBeUndefined();

    const listByLabel = await directSessionReq<{
      sessions: Array<{ key: string }>;
    }>("sessions.list", {
      includeGlobal: false,
      includeUnknown: false,
      label: "Briefing",
    });
    expect(listByLabel.ok).toBe(true);
    expect(listByLabel.payload?.sessions.map((s) => s.key)).toEqual(["agent:main:subagent:one"]);

    const resolvedByLabel = await directSessionReq<{ ok: true; key: string }>("sessions.resolve", {
      label: "Briefing",
      agentId: "main",
    });
    expect(resolvedByLabel.ok).toBe(true);
    expect(resolvedByLabel.payload?.key).toBe("agent:main:subagent:one");

    const spawnedOnly = await directSessionReq<{
      sessions: Array<{ key: string }>;
    }>("sessions.list", {
      includeGlobal: true,
      includeUnknown: true,
      spawnedBy: "agent:main:main",
    });
    expect(spawnedOnly.ok).toBe(true);
    expect(spawnedOnly.payload?.sessions.map((s) => s.key)).toEqual(["agent:main:subagent:one"]);

    const spawnedPatched = await directSessionReq<{
      ok: true;
      entry: { spawnedBy?: string };
    }>("sessions.patch", {
      key: "agent:main:subagent:two",
      spawnedBy: "agent:main:main",
    });
    expect(spawnedPatched.ok).toBe(true);
    expect(spawnedPatched.payload?.entry.spawnedBy).toBe("agent:main:main");

    const acpPatched = await directSessionReq<{
      ok: true;
      entry: { spawnedBy?: string; spawnDepth?: number };
    }>("sessions.patch", {
      key: "agent:main:acp:child",
      spawnedBy: "agent:main:main",
      spawnDepth: 1,
    });
    expect(acpPatched.ok).toBe(true);
    expect(acpPatched.payload?.entry.spawnedBy).toBe("agent:main:main");
    expect(acpPatched.payload?.entry.spawnDepth).toBe(1);

    const spawnedPatchedInvalidKey = await directSessionReq("sessions.patch", {
      key: "agent:main:main",
      spawnedBy: "agent:main:main",
    });
    expect(spawnedPatchedInvalidKey.ok).toBe(false);

    piSdkMock.enabled = true;
    piSdkMock.models = [{ id: "gpt-test-a", name: "A", provider: "openai" }];
    const modelPatched = await directSessionReq<{
      ok: true;
      entry: {
        modelOverride?: string;
        providerOverride?: string;
        model?: string;
        modelProvider?: string;
      };
      resolved?: { model?: string; modelProvider?: string };
    }>("sessions.patch", {
      key: "agent:main:main",
      model: "openai/gpt-test-a",
    });
    expect(modelPatched.ok).toBe(true);
    expect(modelPatched.payload?.entry.modelOverride).toBe("gpt-test-a");
    expect(modelPatched.payload?.entry.providerOverride).toBe("openai");
    expect(modelPatched.payload?.entry.model).toBeUndefined();
    expect(modelPatched.payload?.entry.modelProvider).toBeUndefined();
    expect(modelPatched.payload?.resolved?.modelProvider).toBe("openai");
    expect(modelPatched.payload?.resolved?.model).toBe("gpt-test-a");

    const listAfterModelPatch = await directSessionReq<{
      sessions: Array<{ key: string; modelProvider?: string; model?: string }>;
    }>("sessions.list", {});
    expect(listAfterModelPatch.ok).toBe(true);
    const mainAfterModelPatch = listAfterModelPatch.payload?.sessions.find(
      (session) => session.key === "agent:main:main",
    );
    expect(mainAfterModelPatch?.modelProvider).toBe("openai");
    expect(mainAfterModelPatch?.model).toBe("gpt-test-a");

    const compacted = await directSessionReq<{ ok: true; compacted: boolean }>("sessions.compact", {
      key: "agent:main:main",
      maxLines: 3,
    });
    expect(compacted.ok).toBe(true);
    expect(compacted.payload?.compacted).toBe(true);
    const compactedLines = (await fs.readFile(path.join(dir, "sess-main.jsonl"), "utf-8"))
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0);
    expect(compactedLines).toHaveLength(3);
    const filesAfterCompact = await fs.readdir(dir);
    expect(filesAfterCompact.some((f) => f.startsWith("sess-main.jsonl.bak."))).toBe(true);

    const deleted = await directSessionReq<{ ok: true; deleted: boolean }>("sessions.delete", {
      key: "agent:main:discord:group:dev",
    });
    expect(deleted.ok).toBe(true);
    expect(deleted.payload?.deleted).toBe(true);
    const listAfterDelete = await directSessionReq<{
      sessions: Array<{ key: string }>;
    }>("sessions.list", {});
    expect(listAfterDelete.ok).toBe(true);
    expect(
      listAfterDelete.payload?.sessions.some((s) => s.key === "agent:main:discord:group:dev"),
    ).toBe(false);
    const filesAfterDelete = await fs.readdir(dir);
    expect(filesAfterDelete.some((f) => f.startsWith("sess-group.jsonl.deleted."))).toBe(true);

    const reset = await directSessionReq<{
      ok: true;
      key: string;
      entry: {
        sessionId: string;
        modelProvider?: string;
        model?: string;
        lastAccountId?: string;
        lastThreadId?: string | number;
      };
    }>("sessions.reset", { key: "agent:main:main" });
    expect(reset.ok).toBe(true);
    expect(reset.payload?.key).toBe("agent:main:main");
    expect(reset.payload?.entry.sessionId).not.toBe("sess-main");
    expect(reset.payload?.entry.modelProvider).toBe("openai");
    expect(reset.payload?.entry.model).toBe("gpt-test-a");
    expect(reset.payload?.entry.lastAccountId).toBe("work");
    expect(reset.payload?.entry.lastThreadId).toBe("1737500000.123456");
    const storeAfterReset = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      { lastAccountId?: string; lastThreadId?: string | number }
    >;
    expect(storeAfterReset["agent:main:main"]?.lastAccountId).toBe("work");
    expect(storeAfterReset["agent:main:main"]?.lastThreadId).toBe("1737500000.123456");
    const filesAfterReset = await fs.readdir(dir);
    expect(filesAfterReset.some((f) => f.startsWith("sess-main.jsonl.reset."))).toBe(true);

    const badThinking = await directSessionReq("sessions.patch", {
      key: "agent:main:main",
      thinkingLevel: "banana",
    });
    expect(badThinking.ok).toBe(false);
    expect((badThinking.error as { message?: unknown } | undefined)?.message ?? "").toMatch(
      /invalid thinkinglevel/i,
    );
  });

  test("sessions.compaction.* lists checkpoints and branches or restores from pre-compaction snapshots", async () => {
    const { dir, storePath } = await createSessionStoreDir();
    const fixture = await createCheckpointFixture(dir);
    const { SessionManager } = await getSessionManagerModule();
    await writeSessionStore({
      entries: {
        main: {
          sessionId: fixture.sessionId,
          sessionFile: fixture.sessionFile,
          updatedAt: Date.now(),
          compactionCheckpoints: [
            {
              checkpointId: "checkpoint-1",
              sessionKey: "agent:main:main",
              sessionId: fixture.sessionId,
              createdAt: Date.now(),
              reason: "manual",
              tokensBefore: 123,
              tokensAfter: 45,
              summary: "checkpoint summary",
              firstKeptEntryId: fixture.preCompactionLeafId,
              preCompaction: {
                sessionId: fixture.preCompactionSession.getSessionId(),
                sessionFile: fixture.preCompactionSessionFile,
                leafId: fixture.preCompactionLeafId,
              },
              postCompaction: {
                sessionId: fixture.sessionId,
                sessionFile: fixture.sessionFile,
                leafId: fixture.postCompactionLeafId,
                entryId: fixture.postCompactionLeafId,
              },
            },
          ],
        },
      },
    });

    const { ws } = await openClient();

    const listedSessions = await rpcReq<{
      sessions: Array<{
        key: string;
        compactionCheckpointCount?: number;
        latestCompactionCheckpoint?: {
          checkpointId: string;
          reason: string;
          tokensBefore?: number;
          tokensAfter?: number;
        };
      }>;
    }>(ws, "sessions.list", {});
    expect(listedSessions.ok).toBe(true);
    const main = listedSessions.payload?.sessions.find(
      (session) => session.key === "agent:main:main",
    );
    expect(main?.compactionCheckpointCount).toBe(1);
    expect(main?.latestCompactionCheckpoint?.checkpointId).toBe("checkpoint-1");
    expect(main?.latestCompactionCheckpoint?.reason).toBe("manual");

    const listedCheckpoints = await rpcReq<{
      ok: true;
      key: string;
      checkpoints: Array<{ checkpointId: string; summary?: string; tokensBefore?: number }>;
    }>(ws, "sessions.compaction.list", { key: "main" });
    expect(listedCheckpoints.ok).toBe(true);
    expect(listedCheckpoints.payload?.key).toBe("agent:main:main");
    expect(listedCheckpoints.payload?.checkpoints).toHaveLength(1);
    expect(listedCheckpoints.payload?.checkpoints[0]).toMatchObject({
      checkpointId: "checkpoint-1",
      summary: "checkpoint summary",
      tokensBefore: 123,
    });

    const checkpoint = await rpcReq<{
      ok: true;
      key: string;
      checkpoint: { checkpointId: string; preCompaction: { sessionFile: string } };
    }>(ws, "sessions.compaction.get", {
      key: "main",
      checkpointId: "checkpoint-1",
    });
    expect(checkpoint.ok).toBe(true);
    expect(checkpoint.payload?.checkpoint.checkpointId).toBe("checkpoint-1");
    expect(checkpoint.payload?.checkpoint.preCompaction.sessionFile).toBe(
      fixture.preCompactionSessionFile,
    );

    const branched = await rpcReq<{
      ok: true;
      sourceKey: string;
      key: string;
      entry: { sessionId: string; sessionFile?: string; parentSessionKey?: string };
    }>(ws, "sessions.compaction.branch", {
      key: "main",
      checkpointId: "checkpoint-1",
    });
    expect(branched.ok).toBe(true);
    expect(branched.payload?.sourceKey).toBe("agent:main:main");
    expect(branched.payload?.entry.parentSessionKey).toBe("agent:main:main");
    const branchedSessionFile = branched.payload?.entry.sessionFile;
    expect(branchedSessionFile).toBeTruthy();
    const branchedSession = SessionManager.open(branchedSessionFile!, dir);
    expect(branchedSession.getEntries()).toHaveLength(
      fixture.preCompactionSession.getEntries().length,
    );

    const storeAfterBranch = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      {
        parentSessionKey?: string;
        compactionCheckpoints?: unknown[];
        sessionId?: string;
      }
    >;
    const branchedEntry = storeAfterBranch[branched.payload!.key];
    expect(branchedEntry?.parentSessionKey).toBe("agent:main:main");
    expect(branchedEntry?.compactionCheckpoints).toBeUndefined();

    const restored = await rpcReq<{
      ok: true;
      key: string;
      sessionId: string;
      entry: { sessionId: string; sessionFile?: string; compactionCheckpoints?: unknown[] };
    }>(ws, "sessions.compaction.restore", {
      key: "main",
      checkpointId: "checkpoint-1",
    });
    expect(restored.ok).toBe(true);
    expect(restored.payload?.key).toBe("agent:main:main");
    expect(restored.payload?.sessionId).not.toBe(fixture.sessionId);
    expect(restored.payload?.entry.compactionCheckpoints).toHaveLength(1);
    const restoredSessionFile = restored.payload?.entry.sessionFile;
    expect(restoredSessionFile).toBeTruthy();
    const restoredSession = SessionManager.open(restoredSessionFile!, dir);
    expect(restoredSession.getEntries()).toHaveLength(
      fixture.preCompactionSession.getEntries().length,
    );

    const storeAfterRestore = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      { compactionCheckpoints?: unknown[]; sessionId?: string }
    >;
    expect(storeAfterRestore["agent:main:main"]?.sessionId).toBe(restored.payload?.sessionId);
    expect(storeAfterRestore["agent:main:main"]?.compactionCheckpoints).toHaveLength(1);

    ws.close();
  });

  test("sessions.compact without maxLines runs embedded manual compaction for checkpoint-capable flows", async () => {
    const { dir, storePath } = await createSessionStoreDir();
    await fs.writeFile(
      path.join(dir, "sess-main.jsonl"),
      `${JSON.stringify({ role: "user", content: "hello" })}\n`,
      "utf-8",
    );
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
          thinkingLevel: "medium",
          reasoningLevel: "stream",
        },
      },
    });

    const { ws } = await openClient();
    const compacted = await rpcReq<{
      ok: true;
      key: string;
      compacted: boolean;
      result?: { tokensAfter?: number };
    }>(ws, "sessions.compact", {
      key: "main",
    });

    expect(compacted.ok).toBe(true);
    expect(compacted.payload?.key).toBe("agent:main:main");
    expect(compacted.payload?.compacted).toBe(true);
    expect(embeddedRunMock.compactEmbeddedPiSession).toHaveBeenCalledTimes(1);
    expect(embeddedRunMock.compactEmbeddedPiSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-main",
        sessionKey: "agent:main:main",
        sessionFile: expect.stringMatching(/sess-main\.jsonl$/),
        config: expect.any(Object),
        provider: expect.any(String),
        model: expect.any(String),
        thinkLevel: "medium",
        reasoningLevel: "stream",
        trigger: "manual",
      }),
    );

    const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      { compactionCount?: number; totalTokens?: number; totalTokensFresh?: boolean }
    >;
    expect(store["agent:main:main"]?.compactionCount).toBe(1);
    expect(store["agent:main:main"]?.totalTokens).toBe(80);
    expect(store["agent:main:main"]?.totalTokensFresh).toBe(true);

    ws.close();
  });

  test("sessions.patch preserves nested model ids under provider overrides", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-sessions-nested-"));
    const storePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      storePath,
      JSON.stringify({
        "agent:main:main": {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      }),
      "utf-8",
    );

    await withEnvAsync({ OPENCLAW_CONFIG_PATH: undefined }, async () => {
      const { clearConfigCache, clearRuntimeConfigSnapshot } = await getGatewayConfigModule();
      clearConfigCache();
      clearRuntimeConfigSnapshot();
      const cfg = {
        session: { store: storePath, mainKey: "main" },
        agents: {
          defaults: {
            model: { primary: "openai/gpt-test-a" },
          },
          list: [{ id: "main", default: true, workspace: dir }],
        },
      };
      const configPath = path.join(dir, "openclaw.json");
      await fs.writeFile(configPath, JSON.stringify(cfg, null, 2), "utf-8");

      await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath }, async () => {
        const started = await startConnectedServerWithClient();
        const { server, ws } = started;
        try {
          piSdkMock.enabled = true;
          piSdkMock.models = [
            { id: "moonshotai/kimi-k2.5", name: "Kimi K2.5 (NVIDIA)", provider: "nvidia" },
          ];

          const patched = await rpcReq<{
            ok: true;
            entry: {
              modelOverride?: string;
              providerOverride?: string;
              model?: string;
              modelProvider?: string;
            };
            resolved?: { model?: string; modelProvider?: string };
          }>(ws, "sessions.patch", {
            key: "agent:main:main",
            model: "nvidia/moonshotai/kimi-k2.5",
          });
          expect(patched.ok).toBe(true);
          expect(patched.payload?.entry.modelOverride).toBe("moonshotai/kimi-k2.5");
          expect(patched.payload?.entry.providerOverride).toBe("nvidia");
          expect(patched.payload?.entry.model).toBeUndefined();
          expect(patched.payload?.entry.modelProvider).toBeUndefined();
          expect(patched.payload?.resolved?.modelProvider).toBe("nvidia");
          expect(patched.payload?.resolved?.model).toBe("moonshotai/kimi-k2.5");

          const listed = await rpcReq<{
            sessions: Array<{ key: string; modelProvider?: string; model?: string }>;
          }>(ws, "sessions.list", {});
          expect(listed.ok).toBe(true);
          const mainSession = listed.payload?.sessions.find(
            (session) => session.key === "agent:main:main",
          );
          expect(mainSession?.modelProvider).toBe("nvidia");
          expect(mainSession?.model).toBe("moonshotai/kimi-k2.5");
        } finally {
          ws.close();
          await server.close();
        }
      });
    });
  });

  test("sessions.preview returns transcript previews", async () => {
    const { dir } = await createSessionStoreDir();
    const sessionId = "sess-preview";
    const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
    const lines = createToolSummaryPreviewTranscriptLines(sessionId);
    await fs.writeFile(transcriptPath, lines.join("\n"), "utf-8");

    await writeSessionStore({
      entries: {
        main: {
          sessionId,
          updatedAt: Date.now(),
        },
      },
    });

    const preview = await directSessionReq<{
      previews: Array<{
        key: string;
        status: string;
        items: Array<{ role: string; text: string }>;
      }>;
    }>("sessions.preview", { keys: ["main"], limit: 3, maxChars: 120 });
    expect(preview.ok).toBe(true);
    const entry = preview.payload?.previews[0];
    expect(entry?.key).toBe("main");
    expect(entry?.status).toBe("ok");
    expect(entry?.items.map((item) => item.role)).toEqual(["assistant", "tool", "assistant"]);
    expect(entry?.items[1]?.text).toContain("call weather");
  });

  test("sessions.reset recomputes model from defaults instead of stale runtime model", async () => {
    await createSessionStoreDir();
    testState.agentConfig = {
      model: {
        primary: "openai/gpt-test-a",
      },
    };

    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-stale-model",
          updatedAt: Date.now(),
          modelProvider: "qwencode",
          model: "qwen3.5-plus-2026-02-15",
          contextTokens: 123456,
        },
      },
    });

    const reset = await directSessionReq<{
      ok: true;
      key: string;
      entry: {
        sessionId: string;
        sessionFile?: string;
        modelProvider?: string;
        model?: string;
        contextTokens?: number;
      };
    }>("sessions.reset", { key: "main" });

    expect(reset.ok).toBe(true);
    expect(reset.payload?.key).toBe("agent:main:main");
    expect(reset.payload?.entry.sessionId).not.toBe("sess-stale-model");
    expect(reset.payload?.entry.sessionFile).toBeTruthy();
    expect(reset.payload?.entry.modelProvider).toBe("openai");
    expect(reset.payload?.entry.model).toBe("gpt-test-a");
    expect(reset.payload?.entry.contextTokens).toBeUndefined();
    await expect(fs.stat(reset.payload?.entry.sessionFile as string)).resolves.toBeTruthy();
  });

  test("sessions.reset preserves legacy explicit model overrides without modelOverrideSource", async () => {
    const { storePath } = await createSessionStoreDir();
    testState.agentConfig = {
      model: {
        primary: "openai/gpt-test-a",
      },
    };

    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-explicit-model-override",
          updatedAt: Date.now(),
          providerOverride: "anthropic",
          modelOverride: "claude-opus-4-1",
          modelProvider: "openai",
          model: "gpt-test-a",
        },
      },
    });

    const reset = await directSessionReq<{
      ok: true;
      key: string;
      entry: {
        providerOverride?: string;
        modelOverride?: string;
        modelOverrideSource?: string;
        modelProvider?: string;
        model?: string;
      };
    }>("sessions.reset", { key: "main" });

    expect(reset.ok).toBe(true);
    expect(reset.payload?.entry.providerOverride).toBe("anthropic");
    expect(reset.payload?.entry.modelOverride).toBe("claude-opus-4-1");
    expect(reset.payload?.entry.modelOverrideSource).toBe("user");
    expect(reset.payload?.entry.modelProvider).toBe("anthropic");
    expect(reset.payload?.entry.model).toBe("claude-opus-4-1");

    const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      {
        providerOverride?: string;
        modelOverride?: string;
        modelOverrideSource?: string;
        modelProvider?: string;
        model?: string;
      }
    >;
    expect(store["agent:main:main"]?.providerOverride).toBe("anthropic");
    expect(store["agent:main:main"]?.modelOverride).toBe("claude-opus-4-1");
    expect(store["agent:main:main"]?.modelOverrideSource).toBe("user");
    expect(store["agent:main:main"]?.modelProvider).toBe("anthropic");
    expect(store["agent:main:main"]?.model).toBe("claude-opus-4-1");
  });

  test("sessions.reset clears fallback-pinned model overrides and restores the selected model", async () => {
    const { storePath } = await createSessionStoreDir();
    testState.agentConfig = {
      model: {
        primary: "openai/gpt-test-a",
      },
    };

    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-fallback-model-override",
          updatedAt: Date.now(),
          providerOverride: "anthropic",
          modelOverride: "claude-opus-4-1",
          modelOverrideSource: "auto",
          fallbackNoticeSelectedModel: "openai/gpt-test-a",
          fallbackNoticeActiveModel: "anthropic/claude-opus-4-1",
          fallbackNoticeReason: "rate limit",
        },
      },
    });

    const reset = await directSessionReq<{
      ok: true;
      key: string;
      entry: {
        providerOverride?: string;
        modelOverride?: string;
        modelProvider?: string;
        model?: string;
      };
    }>("sessions.reset", { key: "main" });

    expect(reset.ok).toBe(true);
    expect(reset.payload?.entry.providerOverride).toBeUndefined();
    expect(reset.payload?.entry.modelOverride).toBeUndefined();
    expect(reset.payload?.entry.modelProvider).toBe("openai");
    expect(reset.payload?.entry.model).toBe("gpt-test-a");

    const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      {
        providerOverride?: string;
        modelOverride?: string;
        modelProvider?: string;
        model?: string;
      }
    >;
    expect(store["agent:main:main"]?.providerOverride).toBeUndefined();
    expect(store["agent:main:main"]?.modelOverride).toBeUndefined();
    expect(store["agent:main:main"]?.modelProvider).toBe("openai");
    expect(store["agent:main:main"]?.model).toBe("gpt-test-a");
  });

  test("sessions.reset follows the updated default after an auto fallback pinned an older default", async () => {
    const { storePath } = await createSessionStoreDir();
    testState.agentConfig = {
      model: {
        primary: "openai/gpt-test-c",
      },
    };

    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-fallback-stale-default",
          updatedAt: Date.now(),
          providerOverride: "anthropic",
          modelOverride: "claude-opus-4-1",
          modelOverrideSource: "auto",
          fallbackNoticeSelectedModel: "openai/gpt-test-a",
          fallbackNoticeActiveModel: "anthropic/claude-opus-4-1",
          fallbackNoticeReason: "rate limit",
        },
      },
    });

    const reset = await directSessionReq<{
      ok: true;
      key: string;
      entry: {
        providerOverride?: string;
        modelOverride?: string;
        modelProvider?: string;
        model?: string;
      };
    }>("sessions.reset", { key: "main" });

    expect(reset.ok).toBe(true);
    expect(reset.payload?.entry.providerOverride).toBeUndefined();
    expect(reset.payload?.entry.modelOverride).toBeUndefined();
    expect(reset.payload?.entry.modelProvider).toBe("openai");
    expect(reset.payload?.entry.model).toBe("gpt-test-c");

    const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      {
        providerOverride?: string;
        modelOverride?: string;
        modelProvider?: string;
        model?: string;
      }
    >;
    expect(store["agent:main:main"]?.providerOverride).toBeUndefined();
    expect(store["agent:main:main"]?.modelOverride).toBeUndefined();
    expect(store["agent:main:main"]?.modelProvider).toBe("openai");
    expect(store["agent:main:main"]?.model).toBe("gpt-test-c");
  });

  test("sessions.reset preserves spawned session ownership metadata", async () => {
    const { storePath } = await createSessionStoreDir();
    const customSessionFile = path.join(
      await fs.realpath(path.dirname(storePath)),
      "custom-owned-child-transcript.jsonl",
    );
    await writeSessionStore({
      entries: {
        "subagent:child": {
          sessionId: "sess-owned-child",
          sessionFile: customSessionFile,
          updatedAt: Date.now(),
          chatType: "group",
          channel: "discord",
          groupId: "group-1",
          subject: "Ops Thread",
          groupChannel: "dev",
          space: "hq",
          spawnedBy: "agent:main:main",
          spawnedWorkspaceDir: "/tmp/child-workspace",
          parentSessionKey: "agent:main:main",
          forkedFromParent: true,
          spawnDepth: 2,
          subagentRole: "orchestrator",
          subagentControlScope: "children",
          elevatedLevel: "on",
          ttsAuto: "always",
          providerOverride: "anthropic",
          modelOverride: "claude-opus-4-1",
          modelOverrideSource: "user",
          authProfileOverride: "work",
          authProfileOverrideSource: "user",
          authProfileOverrideCompactionCount: 7,
          sendPolicy: "deny",
          queueMode: "interrupt",
          queueDebounceMs: 250,
          queueCap: 9,
          queueDrop: "old",
          groupActivation: "always",
          groupActivationNeedsSystemIntro: true,
          execHost: "gateway",
          execSecurity: "allowlist",
          execAsk: "on-miss",
          execNode: "mac-mini",
          displayName: "Ops Child",
          cliSessionIds: {
            "claude-cli": "cli-session-123",
          },
          cliSessionBindings: {
            "claude-cli": {
              sessionId: "cli-session-123",
              authProfileId: "anthropic:work",
              extraSystemPromptHash: "prompt-hash",
            },
          },
          claudeCliSessionId: "cli-session-123",
          deliveryContext: {
            channel: "discord",
            to: "discord:child",
            accountId: "acct-1",
            threadId: "thread-1",
          },
          label: "owned child",
        },
      },
    });

    const reset = await directSessionReq<{
      ok: true;
      key: string;
      entry: {
        sessionFile?: string;
        chatType?: string;
        channel?: string;
        groupId?: string;
        subject?: string;
        groupChannel?: string;
        space?: string;
        spawnedBy?: string;
        spawnedWorkspaceDir?: string;
        parentSessionKey?: string;
        forkedFromParent?: boolean;
        spawnDepth?: number;
        subagentRole?: string;
        subagentControlScope?: string;
        elevatedLevel?: string;
        ttsAuto?: string;
        providerOverride?: string;
        modelOverride?: string;
        authProfileOverride?: string;
        authProfileOverrideSource?: string;
        authProfileOverrideCompactionCount?: number;
        sendPolicy?: string;
        queueMode?: string;
        queueDebounceMs?: number;
        queueCap?: number;
        queueDrop?: string;
        groupActivation?: string;
        groupActivationNeedsSystemIntro?: boolean;
        execHost?: string;
        execSecurity?: string;
        execAsk?: string;
        execNode?: string;
        displayName?: string;
        cliSessionBindings?: Record<
          string,
          {
            sessionId?: string;
            authProfileId?: string;
            extraSystemPromptHash?: string;
            mcpConfigHash?: string;
          }
        >;
        cliSessionIds?: Record<string, string>;
        claudeCliSessionId?: string;
        deliveryContext?: {
          channel?: string;
          to?: string;
          accountId?: string;
          threadId?: string;
        };
        label?: string;
      };
    }>("sessions.reset", { key: "subagent:child" });

    expect(reset.ok).toBe(true);
    expect(reset.payload?.entry.sessionFile).toBe(customSessionFile);
    expect(reset.payload?.entry.chatType).toBe("group");
    expect(reset.payload?.entry.channel).toBe("discord");
    expect(reset.payload?.entry.groupId).toBe("group-1");
    expect(reset.payload?.entry.subject).toBe("Ops Thread");
    expect(reset.payload?.entry.groupChannel).toBe("dev");
    expect(reset.payload?.entry.space).toBe("hq");
    expect(reset.payload?.entry.spawnedBy).toBe("agent:main:main");
    expect(reset.payload?.entry.spawnedWorkspaceDir).toBe("/tmp/child-workspace");
    expect(reset.payload?.entry.parentSessionKey).toBe("agent:main:main");
    expect(reset.payload?.entry.forkedFromParent).toBe(true);
    expect(reset.payload?.entry.spawnDepth).toBe(2);
    expect(reset.payload?.entry.subagentRole).toBe("orchestrator");
    expect(reset.payload?.entry.subagentControlScope).toBe("children");
    expect(reset.payload?.entry.elevatedLevel).toBe("on");
    expect(reset.payload?.entry.ttsAuto).toBe("always");
    expect(reset.payload?.entry.providerOverride).toBe("anthropic");
    expect(reset.payload?.entry.modelOverride).toBe("claude-opus-4-1");
    expect(reset.payload?.entry.authProfileOverride).toBe("work");
    expect(reset.payload?.entry.authProfileOverrideSource).toBe("user");
    expect(reset.payload?.entry.authProfileOverrideCompactionCount).toBe(7);
    expect(reset.payload?.entry.sendPolicy).toBe("deny");
    expect(reset.payload?.entry.queueMode).toBe("interrupt");
    expect(reset.payload?.entry.queueDebounceMs).toBe(250);
    expect(reset.payload?.entry.queueCap).toBe(9);
    expect(reset.payload?.entry.queueDrop).toBe("old");
    expect(reset.payload?.entry.groupActivation).toBe("always");
    expect(reset.payload?.entry.groupActivationNeedsSystemIntro).toBe(true);
    expect(reset.payload?.entry.execHost).toBe("gateway");
    expect(reset.payload?.entry.execSecurity).toBe("allowlist");
    expect(reset.payload?.entry.execAsk).toBe("on-miss");
    expect(reset.payload?.entry.execNode).toBe("mac-mini");
    expect(reset.payload?.entry.displayName).toBe("Ops Child");
    expect(reset.payload?.entry.cliSessionBindings).toEqual({
      "claude-cli": {
        sessionId: "cli-session-123",
        authProfileId: "anthropic:work",
        extraSystemPromptHash: "prompt-hash",
      },
    });
    expect(reset.payload?.entry.cliSessionIds).toEqual({
      "claude-cli": "cli-session-123",
    });
    expect(reset.payload?.entry.claudeCliSessionId).toBe("cli-session-123");
    expect(reset.payload?.entry.deliveryContext).toEqual({
      channel: "discord",
      to: "discord:child",
      accountId: "acct-1",
      threadId: "thread-1",
    });
    expect(reset.payload?.entry.label).toBe("owned child");

    const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      {
        sessionFile?: string;
        chatType?: string;
        channel?: string;
        groupId?: string;
        subject?: string;
        groupChannel?: string;
        space?: string;
        spawnedBy?: string;
        spawnedWorkspaceDir?: string;
        parentSessionKey?: string;
        forkedFromParent?: boolean;
        spawnDepth?: number;
        subagentRole?: string;
        subagentControlScope?: string;
        elevatedLevel?: string;
        ttsAuto?: string;
        providerOverride?: string;
        modelOverride?: string;
        authProfileOverride?: string;
        authProfileOverrideSource?: string;
        authProfileOverrideCompactionCount?: number;
        sendPolicy?: string;
        queueMode?: string;
        queueDebounceMs?: number;
        queueCap?: number;
        queueDrop?: string;
        groupActivation?: string;
        groupActivationNeedsSystemIntro?: boolean;
        execHost?: string;
        execSecurity?: string;
        execAsk?: string;
        execNode?: string;
        displayName?: string;
        cliSessionBindings?: Record<
          string,
          {
            sessionId?: string;
            authProfileId?: string;
            extraSystemPromptHash?: string;
            mcpConfigHash?: string;
          }
        >;
        cliSessionIds?: Record<string, string>;
        claudeCliSessionId?: string;
        deliveryContext?: {
          channel?: string;
          to?: string;
          accountId?: string;
          threadId?: string;
        };
        label?: string;
      }
    >;
    expect(store["agent:main:subagent:child"]?.sessionFile).toBe(customSessionFile);
    expect(store["agent:main:subagent:child"]?.chatType).toBe("group");
    expect(store["agent:main:subagent:child"]?.channel).toBe("discord");
    expect(store["agent:main:subagent:child"]?.groupId).toBe("group-1");
    expect(store["agent:main:subagent:child"]?.subject).toBe("Ops Thread");
    expect(store["agent:main:subagent:child"]?.groupChannel).toBe("dev");
    expect(store["agent:main:subagent:child"]?.space).toBe("hq");
    expect(store["agent:main:subagent:child"]?.spawnedBy).toBe("agent:main:main");
    expect(store["agent:main:subagent:child"]?.spawnedWorkspaceDir).toBe("/tmp/child-workspace");
    expect(store["agent:main:subagent:child"]?.parentSessionKey).toBe("agent:main:main");
    expect(store["agent:main:subagent:child"]?.forkedFromParent).toBe(true);
    expect(store["agent:main:subagent:child"]?.spawnDepth).toBe(2);
    expect(store["agent:main:subagent:child"]?.subagentRole).toBe("orchestrator");
    expect(store["agent:main:subagent:child"]?.subagentControlScope).toBe("children");
    expect(store["agent:main:subagent:child"]?.elevatedLevel).toBe("on");
    expect(store["agent:main:subagent:child"]?.ttsAuto).toBe("always");
    expect(store["agent:main:subagent:child"]?.providerOverride).toBe("anthropic");
    expect(store["agent:main:subagent:child"]?.modelOverride).toBe("claude-opus-4-1");
    expect(store["agent:main:subagent:child"]?.authProfileOverride).toBe("work");
    expect(store["agent:main:subagent:child"]?.authProfileOverrideSource).toBe("user");
    expect(store["agent:main:subagent:child"]?.authProfileOverrideCompactionCount).toBe(7);
    expect(store["agent:main:subagent:child"]?.sendPolicy).toBe("deny");
    expect(store["agent:main:subagent:child"]?.queueMode).toBe("interrupt");
    expect(store["agent:main:subagent:child"]?.queueDebounceMs).toBe(250);
    expect(store["agent:main:subagent:child"]?.queueCap).toBe(9);
    expect(store["agent:main:subagent:child"]?.queueDrop).toBe("old");
    expect(store["agent:main:subagent:child"]?.groupActivation).toBe("always");
    expect(store["agent:main:subagent:child"]?.groupActivationNeedsSystemIntro).toBe(true);
    expect(store["agent:main:subagent:child"]?.execHost).toBe("gateway");
    expect(store["agent:main:subagent:child"]?.execSecurity).toBe("allowlist");
    expect(store["agent:main:subagent:child"]?.execAsk).toBe("on-miss");
    expect(store["agent:main:subagent:child"]?.execNode).toBe("mac-mini");
    expect(store["agent:main:subagent:child"]?.displayName).toBe("Ops Child");
    expect(store["agent:main:subagent:child"]?.cliSessionBindings).toEqual({
      "claude-cli": {
        sessionId: "cli-session-123",
        authProfileId: "anthropic:work",
        extraSystemPromptHash: "prompt-hash",
      },
    });
    expect(store["agent:main:subagent:child"]?.cliSessionIds).toEqual({
      "claude-cli": "cli-session-123",
    });
    expect(store["agent:main:subagent:child"]?.claudeCliSessionId).toBe("cli-session-123");
    expect(store["agent:main:subagent:child"]?.deliveryContext).toEqual({
      channel: "discord",
      to: "discord:child",
      accountId: "acct-1",
      threadId: "thread-1",
    });
    expect(store["agent:main:subagent:child"]?.label).toBe("owned child");
  });

  test("sessions.preview resolves legacy mixed-case main alias with custom mainKey", async () => {
    const { dir, storePath } = await createSessionStoreDir();
    testState.agentsConfig = { list: [{ id: "ops", default: true }] };
    testState.sessionConfig = { mainKey: "work" };
    const sessionId = "sess-legacy-main";
    const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ type: "session", version: 1, id: sessionId }),
      JSON.stringify({ message: { role: "assistant", content: "Legacy alias transcript" } }),
    ];
    await fs.writeFile(transcriptPath, lines.join("\n"), "utf-8");
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          "agent:ops:MAIN": {
            sessionId,
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { ws } = await openClient();
    const entry = await getMainPreviewEntry(ws);
    expect(entry?.items[0]?.text).toContain("Legacy alias transcript");

    ws.close();
  });

  test("sessions.preview prefers the freshest duplicate row for a legacy mixed-case main alias", async () => {
    const { dir, storePath } = await createSessionStoreDir();
    testState.agentsConfig = { list: [{ id: "ops", default: true }] };
    testState.sessionConfig = { mainKey: "work" };

    const staleTranscriptPath = path.join(dir, "sess-stale-main.jsonl");
    const freshTranscriptPath = path.join(dir, "sess-fresh-main.jsonl");
    await fs.writeFile(
      staleTranscriptPath,
      [
        JSON.stringify({ type: "session", version: 1, id: "sess-stale-main" }),
        JSON.stringify({ message: { role: "assistant", content: "stale preview" } }),
      ].join("\n"),
      "utf-8",
    );
    await fs.writeFile(
      freshTranscriptPath,
      [
        JSON.stringify({ type: "session", version: 1, id: "sess-fresh-main" }),
        JSON.stringify({ message: { role: "assistant", content: "fresh preview" } }),
      ].join("\n"),
      "utf-8",
    );
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          "agent:ops:work": {
            sessionId: "sess-stale-main",
            updatedAt: 1,
          },
          "agent:ops:WORK": {
            sessionId: "sess-fresh-main",
            updatedAt: 2,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { ws } = await openClient();
    const entry = await getMainPreviewEntry(ws);
    expect(entry?.items[0]?.text).toContain("fresh preview");

    ws.close();
  });

  test("sessions.resolve and mutators clean legacy main-alias ghost keys", async () => {
    const { dir, storePath } = await createSessionStoreDir();
    testState.agentsConfig = { list: [{ id: "ops", default: true }] };
    testState.sessionConfig = { mainKey: "work" };
    const sessionId = "sess-alias-cleanup";
    const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
    await fs.writeFile(
      transcriptPath,
      `${Array.from({ length: 8 })
        .map((_, idx) => JSON.stringify({ role: "assistant", content: `line ${idx}` }))
        .join("\n")}\n`,
      "utf-8",
    );

    const writeRawStore = async (store: Record<string, unknown>) => {
      await fs.writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf-8");
    };
    const readStore = async () =>
      JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<string, Record<string, unknown>>;

    await writeRawStore({
      "agent:ops:MAIN": { sessionId, updatedAt: Date.now() - 2_000 },
      "agent:ops:Main": { sessionId, updatedAt: Date.now() - 1_000 },
    });

    const { ws } = await openClient();

    const resolved = await rpcReq<{ ok: true; key: string }>(ws, "sessions.resolve", {
      key: "main",
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.payload?.key).toBe("agent:ops:work");
    let store = await readStore();
    expect(Object.keys(store).toSorted()).toEqual(["agent:ops:work"]);

    await writeRawStore({
      ...store,
      "agent:ops:MAIN": { ...store["agent:ops:work"] },
    });
    const patched = await rpcReq<{ ok: true; key: string }>(ws, "sessions.patch", {
      key: "main",
      thinkingLevel: "medium",
    });
    expect(patched.ok).toBe(true);
    expect(patched.payload?.key).toBe("agent:ops:work");
    store = await readStore();
    expect(Object.keys(store).toSorted()).toEqual(["agent:ops:work"]);
    expect(store["agent:ops:work"]?.thinkingLevel).toBe("medium");

    await writeRawStore({
      ...store,
      "agent:ops:MAIN": { ...store["agent:ops:work"] },
    });
    const compacted = await rpcReq<{ ok: true; compacted: boolean }>(ws, "sessions.compact", {
      key: "main",
      maxLines: 3,
    });
    expect(compacted.ok).toBe(true);
    expect(compacted.payload?.compacted).toBe(true);
    store = await readStore();
    expect(Object.keys(store).toSorted()).toEqual(["agent:ops:work"]);

    await writeRawStore({
      ...store,
      "agent:ops:MAIN": { ...store["agent:ops:work"] },
    });
    const reset = await rpcReq<{ ok: true; key: string }>(ws, "sessions.reset", { key: "main" });
    expect(reset.ok).toBe(true);
    expect(reset.payload?.key).toBe("agent:ops:work");
    store = await readStore();
    expect(Object.keys(store).toSorted()).toEqual(["agent:ops:work"]);

    ws.close();
  });

  test("sessions.resolve by sessionId ignores fuzzy-search list limits and returns the exact match", async () => {
    await createSessionStoreDir();
    const now = Date.now();
    const entries: Record<string, { sessionId: string; updatedAt: number; label?: string }> = {
      "agent:main:subagent:target": {
        sessionId: "sess-target-exact",
        updatedAt: now - 20_000,
      },
    };
    for (let i = 0; i < 9; i += 1) {
      entries[`agent:main:subagent:noisy-${i}`] = {
        sessionId: `sess-noisy-${i}`,
        updatedAt: now - i * 1_000,
        label: `sess-target-exact noisy ${i}`,
      };
    }
    await writeSessionStore({ entries });

    const { ws } = await openClient();
    const resolved = await rpcReq<{ ok: true; key: string }>(ws, "sessions.resolve", {
      sessionId: "sess-target-exact",
    });

    expect(resolved.ok).toBe(true);
    expect(resolved.payload?.key).toBe("agent:main:subagent:target");
  });

  test("sessions.resolve by key respects spawnedBy visibility filters", async () => {
    await createSessionStoreDir();
    const now = Date.now();
    await writeSessionStore({
      entries: {
        "agent:main:subagent:visible-parent": {
          sessionId: "sess-visible-parent",
          updatedAt: now - 3_000,
          spawnedBy: "agent:main:main",
        },
        "agent:main:subagent:hidden-parent": {
          sessionId: "sess-hidden-parent",
          updatedAt: now - 2_000,
          spawnedBy: "agent:main:main",
        },
        "agent:main:subagent:shared-child-key-filter": {
          sessionId: "sess-shared-child-key-filter",
          updatedAt: now - 1_000,
          spawnedBy: "agent:main:subagent:hidden-parent",
        },
      },
    });

    const { ws } = await openClient();
    const resolved = await rpcReq(ws, "sessions.resolve", {
      key: "agent:main:subagent:shared-child-key-filter",
      spawnedBy: "agent:main:subagent:visible-parent",
    });

    expect(resolved.ok).toBe(false);
    expect(resolved.error?.message).toContain(
      "No session found: agent:main:subagent:shared-child-key-filter",
    );
  });

  test("sessions.delete rejects main and aborts active runs", async () => {
    const { dir } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-main", "hello");
    await writeSingleLineSession(dir, "sess-active", "active");

    await writeSessionStore({
      entries: {
        main: { sessionId: "sess-main", updatedAt: Date.now() },
        "discord:group:dev": {
          sessionId: "sess-active",
          updatedAt: Date.now(),
        },
      },
    });

    embeddedRunMock.activeIds.add("sess-active");
    embeddedRunMock.waitResults.set("sess-active", true);

    const mainDelete = await directSessionReq("sessions.delete", { key: "main" });
    expect(mainDelete.ok).toBe(false);

    const deleted = await directSessionReq<{ ok: true; deleted: boolean }>("sessions.delete", {
      key: "discord:group:dev",
    });
    expect(deleted.ok).toBe(true);
    expect(deleted.payload?.deleted).toBe(true);
    expectActiveRunCleanup(
      "agent:main:discord:group:dev",
      ["discord:group:dev", "agent:main:discord:group:dev", "sess-active"],
      "sess-active",
    );
    expect(bundleMcpRuntimeMocks.disposeSessionMcpRuntime).toHaveBeenCalledWith("sess-active");
    expect(browserSessionTabMocks.closeTrackedBrowserTabsForSessions).toHaveBeenCalledTimes(1);
    expect(browserSessionTabMocks.closeTrackedBrowserTabsForSessions).toHaveBeenCalledWith({
      sessionKeys: expect.arrayContaining([
        "discord:group:dev",
        "agent:main:discord:group:dev",
        "sess-active",
      ]),
      onWarn: expect.any(Function),
    });
    expect(subagentLifecycleHookMocks.runSubagentEnded).toHaveBeenCalledTimes(1);
    expect(subagentLifecycleHookMocks.runSubagentEnded).toHaveBeenCalledWith(
      {
        targetSessionKey: "agent:main:discord:group:dev",
        targetKind: "acp",
        reason: "session-delete",
        sendFarewell: true,
        outcome: "deleted",
      },
      {
        childSessionKey: "agent:main:discord:group:dev",
      },
    );
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:discord:group:dev",
      reason: "session-delete",
    });
  });

  test("sessions.delete closes ACP runtime handles before removing ACP sessions", async () => {
    const { dir } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-main", "hello");
    await writeSingleLineSession(dir, "sess-acp", "acp");

    await writeSessionStore({
      entries: {
        main: { sessionId: "sess-main", updatedAt: Date.now() },
        "discord:group:dev": {
          sessionId: "sess-acp",
          updatedAt: Date.now(),
          acp: {
            backend: "acpx",
            agent: "codex",
            runtimeSessionName: "runtime:delete",
            mode: "persistent",
            state: "idle",
            lastActivityAt: Date.now(),
          },
        },
      },
    });
    const deleted = await directSessionReq<{ ok: true; deleted: boolean }>("sessions.delete", {
      key: "discord:group:dev",
    });
    expect(deleted.ok).toBe(true);
    expect(deleted.payload?.deleted).toBe(true);
    expect(acpManagerMocks.closeSession).toHaveBeenCalledWith({
      allowBackendUnavailable: true,
      cfg: expect.any(Object),
      discardPersistentState: true,
      requireAcpSession: false,
      reason: "session-delete",
      sessionKey: "agent:main:discord:group:dev",
    });
    expect(acpManagerMocks.cancelSession).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      reason: "session-delete",
      sessionKey: "agent:main:discord:group:dev",
    });
  });

  test("sessions.delete emits session_end with deleted reason and no replacement", async () => {
    const { dir } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-main", "hello");
    const transcriptPath = path.join(dir, "sess-delete.jsonl");
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: "message",
        id: "m-delete",
        message: { role: "user", content: "delete me" },
      })}\n`,
      "utf-8",
    );

    await writeSessionStore({
      entries: {
        main: { sessionId: "sess-main", updatedAt: Date.now() },
        "discord:group:delete": {
          sessionId: "sess-delete",
          sessionFile: transcriptPath,
          updatedAt: Date.now(),
        },
      },
    });

    const deleted = await directSessionReq<{ ok: true; deleted: boolean }>("sessions.delete", {
      key: "discord:group:delete",
    });
    expect(deleted.ok).toBe(true);
    expect(deleted.payload?.deleted).toBe(true);
    expect(sessionLifecycleHookMocks.runSessionEnd).toHaveBeenCalledTimes(1);
    expect(sessionLifecycleHookMocks.runSessionStart).not.toHaveBeenCalled();

    const [event, context] = (
      sessionLifecycleHookMocks.runSessionEnd.mock.calls as unknown as Array<[unknown, unknown]>
    )[0] ?? [undefined, undefined];
    expect(event).toMatchObject({
      sessionId: "sess-delete",
      sessionKey: "agent:main:discord:group:delete",
      reason: "deleted",
      transcriptArchived: true,
    });
    expect((event as { sessionFile?: string } | undefined)?.sessionFile).toContain(
      ".jsonl.deleted.",
    );
    expect((event as { nextSessionId?: string } | undefined)?.nextSessionId).toBeUndefined();
    expect(context).toMatchObject({
      sessionId: "sess-delete",
      sessionKey: "agent:main:discord:group:delete",
      agentId: "main",
    });
  });

  test("sessions.delete does not emit lifecycle events when nothing was deleted", async () => {
    const { dir } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-main", "hello");
    await writeSessionStore({
      entries: {
        main: { sessionId: "sess-main", updatedAt: Date.now() },
      },
    });

    const deleted = await directSessionReq<{ ok: true; deleted: boolean }>("sessions.delete", {
      key: "agent:main:subagent:missing",
    });

    expect(deleted.ok).toBe(true);
    expect(deleted.payload?.deleted).toBe(false);
    expect(subagentLifecycleHookMocks.runSubagentEnded).not.toHaveBeenCalled();
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).not.toHaveBeenCalled();
  });

  test("sessions.delete emits subagent targetKind for subagent sessions", async () => {
    const { dir } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-subagent", "hello");
    await writeSessionStore({
      entries: {
        "agent:main:subagent:worker": {
          sessionId: "sess-subagent",
          updatedAt: Date.now(),
        },
      },
    });

    const deleted = await directSessionReq<{ ok: true; deleted: boolean }>("sessions.delete", {
      key: "agent:main:subagent:worker",
    });
    expect(deleted.ok).toBe(true);
    expect(deleted.payload?.deleted).toBe(true);
    expect(subagentLifecycleHookMocks.runSubagentEnded).toHaveBeenCalledTimes(1);
    const event = (
      subagentLifecycleHookMocks.runSubagentEnded.mock.calls as unknown[][]
    )[0]?.[0] as
      | { targetKind?: string; targetSessionKey?: string; reason?: string; outcome?: string }
      | undefined;
    expect(event).toMatchObject({
      targetSessionKey: "agent:main:subagent:worker",
      targetKind: "subagent",
      reason: "session-delete",
      outcome: "deleted",
    });
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:worker",
      reason: "session-delete",
    });
  });

  test("sessions.delete can skip lifecycle hooks while still unbinding thread bindings", async () => {
    const { dir } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-subagent", "hello");
    await writeSessionStore({
      entries: {
        "agent:main:subagent:worker": {
          sessionId: "sess-subagent",
          updatedAt: Date.now(),
        },
      },
    });

    const deleted = await directSessionReq<{ ok: true; deleted: boolean }>("sessions.delete", {
      key: "agent:main:subagent:worker",
      emitLifecycleHooks: false,
    });
    expect(deleted.ok).toBe(true);
    expect(deleted.payload?.deleted).toBe(true);
    expect(subagentLifecycleHookMocks.runSubagentEnded).not.toHaveBeenCalled();
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:worker",
      reason: "session-delete",
    });
  });

  test("sessions.delete directly unbinds thread bindings when hooks are unavailable", async () => {
    const { dir } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-subagent", "hello");
    await writeSessionStore({
      entries: {
        "agent:main:subagent:worker": {
          sessionId: "sess-subagent",
          updatedAt: Date.now(),
        },
      },
    });
    subagentLifecycleHookState.hasSubagentEndedHook = false;

    const deleted = await directSessionReq<{ ok: true; deleted: boolean }>("sessions.delete", {
      key: "agent:main:subagent:worker",
    });
    expect(deleted.ok).toBe(true);
    expect(subagentLifecycleHookMocks.runSubagentEnded).not.toHaveBeenCalled();
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:worker",
      reason: "session-delete",
    });
  });

  test("sessions.reset aborts active runs and clears queues", async () => {
    await seedActiveMainSession();
    const waitCallCountAtSnapshotClear: number[] = [];
    bootstrapCacheMocks.clearBootstrapSnapshot.mockImplementation(() => {
      waitCallCountAtSnapshotClear.push(embeddedRunMock.waitCalls.length);
    });

    embeddedRunMock.activeIds.add("sess-main");
    embeddedRunMock.waitResults.set("sess-main", true);

    const reset = await directSessionReq<{ ok: true; key: string; entry: { sessionId: string } }>(
      "sessions.reset",
      {
        key: "main",
      },
    );
    expect(reset.ok).toBe(true);
    expect(reset.payload?.key).toBe("agent:main:main");
    expect(reset.payload?.entry.sessionId).not.toBe("sess-main");
    expectActiveRunCleanup(
      "agent:main:main",
      ["main", "agent:main:main", "sess-main"],
      "sess-main",
    );
    expect(bundleMcpRuntimeMocks.disposeSessionMcpRuntime).toHaveBeenCalledWith("sess-main");
    expect(waitCallCountAtSnapshotClear).toEqual([1]);
    expect(browserSessionTabMocks.closeTrackedBrowserTabsForSessions).toHaveBeenCalledTimes(1);
    expect(browserSessionTabMocks.closeTrackedBrowserTabsForSessions).toHaveBeenCalledWith({
      sessionKeys: expect.arrayContaining(["main", "agent:main:main", "sess-main"]),
      onWarn: expect.any(Function),
    });
    expect(subagentLifecycleHookMocks.runSubagentEnded).toHaveBeenCalledTimes(1);
    expect(subagentLifecycleHookMocks.runSubagentEnded).toHaveBeenCalledWith(
      {
        targetSessionKey: "agent:main:main",
        targetKind: "acp",
        reason: "session-reset",
        sendFarewell: true,
        outcome: "reset",
      },
      {
        childSessionKey: "agent:main:main",
      },
    );
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:main",
      reason: "session-reset",
    });
  });

  test("sessions.reset closes ACP runtime handles for ACP sessions", async () => {
    const { dir, storePath } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-main", "hello");
    const prepareFreshSession = vi.fn(async () => {});
    acpRuntimeMocks.getAcpRuntimeBackend.mockReturnValue({
      id: "acpx",
      runtime: {
        prepareFreshSession,
      },
    });

    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
          acp: {
            backend: "acpx",
            agent: "codex",
            runtimeSessionName: "runtime:reset",
            identity: {
              state: "resolved",
              acpxRecordId: "agent:main:main",
              acpxSessionId: "backend-session-1",
              source: "status",
              lastUpdatedAt: Date.now(),
            },
            mode: "persistent",
            runtimeOptions: {
              runtimeMode: "auto",
              timeoutSeconds: 30,
            },
            cwd: "/tmp/acp-session",
            state: "idle",
            lastActivityAt: Date.now(),
          },
        },
      },
    });
    const reset = await directSessionReq<{
      ok: true;
      key: string;
      entry: {
        acp?: {
          backend?: string;
          agent?: string;
          runtimeSessionName?: string;
          identity?: {
            state?: string;
            acpxRecordId?: string;
            acpxSessionId?: string;
          };
          mode?: string;
          runtimeOptions?: {
            runtimeMode?: string;
            timeoutSeconds?: number;
          };
          cwd?: string;
          state?: string;
        };
      };
    }>("sessions.reset", {
      key: "main",
    });
    expect(reset.ok).toBe(true);
    expect(reset.payload?.entry.acp).toMatchObject({
      backend: "acpx",
      agent: "codex",
      runtimeSessionName: "runtime:reset",
      identity: {
        state: "pending",
        acpxRecordId: "agent:main:main",
      },
      mode: "persistent",
      runtimeOptions: {
        runtimeMode: "auto",
        timeoutSeconds: 30,
      },
      cwd: "/tmp/acp-session",
      state: "idle",
    });
    expect(reset.payload?.entry.acp?.identity?.acpxSessionId).toBeUndefined();
    expect(acpManagerMocks.closeSession).toHaveBeenCalledWith({
      allowBackendUnavailable: true,
      cfg: expect.any(Object),
      discardPersistentState: true,
      requireAcpSession: false,
      reason: "session-reset",
      sessionKey: "agent:main:main",
    });
    expect(prepareFreshSession).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
    });
    const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      {
        acp?: {
          backend?: string;
          agent?: string;
          runtimeSessionName?: string;
          identity?: {
            state?: string;
            acpxRecordId?: string;
            acpxSessionId?: string;
          };
          mode?: string;
          runtimeOptions?: {
            runtimeMode?: string;
            timeoutSeconds?: number;
          };
          cwd?: string;
          state?: string;
        };
      }
    >;
    expect(store["agent:main:main"]?.acp).toMatchObject({
      backend: "acpx",
      agent: "codex",
      runtimeSessionName: "runtime:reset",
      identity: {
        state: "pending",
        acpxRecordId: "agent:main:main",
      },
      mode: "persistent",
      runtimeOptions: {
        runtimeMode: "auto",
        timeoutSeconds: 30,
      },
      cwd: "/tmp/acp-session",
      state: "idle",
    });
    expect(store["agent:main:main"]?.acp?.identity?.acpxSessionId).toBeUndefined();
  });

  test("sessions.reset does not emit lifecycle events when key does not exist", async () => {
    const { dir } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-main", "hello");
    await writeSessionStore({
      entries: {
        main: { sessionId: "sess-main", updatedAt: Date.now() },
      },
    });

    const reset = await directSessionReq<{
      ok: true;
      key: string;
      entry: { sessionId: string };
    }>("sessions.reset", {
      key: "agent:main:subagent:missing",
    });

    expect(reset.ok).toBe(true);
    expect(subagentLifecycleHookMocks.runSubagentEnded).not.toHaveBeenCalled();
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).not.toHaveBeenCalled();
  });

  test("sessions.reset emits subagent targetKind for subagent sessions", async () => {
    const { dir } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-subagent", "hello");
    await writeSessionStore({
      entries: {
        "agent:main:subagent:worker": {
          sessionId: "sess-subagent",
          updatedAt: Date.now(),
        },
      },
    });

    const reset = await directSessionReq<{
      ok: true;
      key: string;
      entry: { sessionId: string };
    }>("sessions.reset", {
      key: "agent:main:subagent:worker",
    });
    expect(reset.ok).toBe(true);
    expect(reset.payload?.key).toBe("agent:main:subagent:worker");
    expect(reset.payload?.entry.sessionId).not.toBe("sess-subagent");
    expect(subagentLifecycleHookMocks.runSubagentEnded).toHaveBeenCalledTimes(1);
    const event = (
      subagentLifecycleHookMocks.runSubagentEnded.mock.calls as unknown[][]
    )[0]?.[0] as
      | { targetKind?: string; targetSessionKey?: string; reason?: string; outcome?: string }
      | undefined;
    expect(event).toMatchObject({
      targetSessionKey: "agent:main:subagent:worker",
      targetKind: "subagent",
      reason: "session-reset",
      outcome: "reset",
    });
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:worker",
      reason: "session-reset",
    });
  });

  test("sessions.reset directly unbinds thread bindings when hooks are unavailable", async () => {
    const { dir } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-main", "hello");
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
    });
    subagentLifecycleHookState.hasSubagentEndedHook = false;

    const reset = await directSessionReq<{ ok: true; key: string }>("sessions.reset", {
      key: "main",
    });
    expect(reset.ok).toBe(true);
    expect(subagentLifecycleHookMocks.runSubagentEnded).not.toHaveBeenCalled();
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:main",
      reason: "session-reset",
    });
  });

  test("sessions.reset emits internal command hook with reason", async () => {
    const { dir } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-main", "hello");

    await writeSessionStore({
      entries: {
        main: { sessionId: "sess-main", updatedAt: Date.now() },
      },
    });

    const reset = await directSessionReq<{ ok: true; key: string }>("sessions.reset", {
      key: "main",
      reason: "new",
    });
    expect(reset.ok).toBe(true);
    const resetHookEvents = (
      sessionHookMocks.triggerInternalHook.mock.calls as unknown as Array<[unknown]>
    )
      .map((call) => call[0])
      .filter(
        (
          event,
        ): event is {
          type: string;
          action: string;
          context?: { previousSessionEntry?: unknown };
        } =>
          Boolean(event) &&
          typeof event === "object" &&
          (event as { type?: unknown }).type === "command" &&
          (event as { action?: unknown }).action === "new",
      );
    expect(resetHookEvents).toHaveLength(1);
    const event = resetHookEvents[0];
    if (!event) {
      throw new Error("expected session hook event");
    }
    expect(event).toMatchObject({
      type: "command",
      action: "new",
      sessionKey: "agent:main:main",
      context: {
        commandSource: "gateway:sessions.reset",
      },
    });
    expect(event.context?.previousSessionEntry).toMatchObject({ sessionId: "sess-main" });
  });

  test("sessions.reset emits before_reset hook with transcript context", async () => {
    const { dir } = await createSessionStoreDir();
    const transcriptPath = path.join(dir, "sess-main.jsonl");
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: "message",
        id: "m1",
        message: { role: "user", content: "hello from transcript" },
      })}\n`,
      "utf-8",
    );

    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          sessionFile: transcriptPath,
          updatedAt: Date.now(),
        },
      },
    });

    beforeResetHookState.hasBeforeResetHook = true;

    const reset = await directSessionReq<{ ok: true; key: string }>("sessions.reset", {
      key: "main",
      reason: "new",
    });
    expect(reset.ok).toBe(true);
    expect(beforeResetHookMocks.runBeforeReset).toHaveBeenCalledTimes(1);
    const [event, context] = (
      beforeResetHookMocks.runBeforeReset.mock.calls as unknown as Array<[unknown, unknown]>
    )[0] ?? [undefined, undefined];
    expect(event).toMatchObject({
      sessionFile: transcriptPath,
      reason: "new",
      messages: [
        {
          role: "user",
          content: "hello from transcript",
        },
      ],
    });
    expect(context).toMatchObject({
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "sess-main",
    });
  });

  test("sessions.reset emits enriched session_end and session_start hooks", async () => {
    const { dir } = await createSessionStoreDir();
    const transcriptPath = path.join(dir, "sess-main.jsonl");
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: "message",
        id: "m1",
        message: { role: "user", content: "hello from transcript" },
      })}\n`,
      "utf-8",
    );

    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          sessionFile: transcriptPath,
          updatedAt: Date.now(),
        },
      },
    });

    const reset = await directSessionReq<{ ok: true; key: string }>("sessions.reset", {
      key: "main",
      reason: "new",
    });
    expect(reset.ok).toBe(true);
    expect(sessionLifecycleHookMocks.runSessionEnd).toHaveBeenCalledTimes(1);
    expect(sessionLifecycleHookMocks.runSessionStart).toHaveBeenCalledTimes(1);

    const [endEvent, endContext] = (
      sessionLifecycleHookMocks.runSessionEnd.mock.calls as unknown as Array<[unknown, unknown]>
    )[0] ?? [undefined, undefined];
    const [startEvent, startContext] = (
      sessionLifecycleHookMocks.runSessionStart.mock.calls as unknown as Array<[unknown, unknown]>
    )[0] ?? [undefined, undefined];

    expect(endEvent).toMatchObject({
      sessionId: "sess-main",
      sessionKey: "agent:main:main",
      reason: "new",
      transcriptArchived: true,
    });
    expect((endEvent as { sessionFile?: string } | undefined)?.sessionFile).toContain(
      ".jsonl.reset.",
    );
    expect((endEvent as { nextSessionId?: string } | undefined)?.nextSessionId).toBe(
      (startEvent as { sessionId?: string } | undefined)?.sessionId,
    );
    expect(endContext).toMatchObject({
      sessionId: "sess-main",
      sessionKey: "agent:main:main",
      agentId: "main",
    });
    expect(startEvent).toMatchObject({
      sessionKey: "agent:main:main",
      resumedFrom: "sess-main",
    });
    expect(startContext).toMatchObject({
      sessionId: (startEvent as { sessionId?: string } | undefined)?.sessionId,
      sessionKey: "agent:main:main",
      agentId: "main",
    });
  });

  test("sessions.reset returns unavailable when active run does not stop", async () => {
    const { dir, storePath } = await seedActiveMainSession();
    const waitCallCountAtSnapshotClear: number[] = [];
    bootstrapCacheMocks.clearBootstrapSnapshot.mockImplementation(() => {
      waitCallCountAtSnapshotClear.push(embeddedRunMock.waitCalls.length);
    });

    beforeResetHookState.hasBeforeResetHook = true;
    embeddedRunMock.activeIds.add("sess-main");
    embeddedRunMock.waitResults.set("sess-main", false);

    const reset = await directSessionReq("sessions.reset", {
      key: "main",
    });
    expect(reset.ok).toBe(false);
    expect(reset.error?.code).toBe("UNAVAILABLE");
    expect(reset.error?.message ?? "").toMatch(/still active/i);
    expectActiveRunCleanup(
      "agent:main:main",
      ["main", "agent:main:main", "sess-main"],
      "sess-main",
    );
    expect(beforeResetHookMocks.runBeforeReset).not.toHaveBeenCalled();
    expect(waitCallCountAtSnapshotClear).toEqual([1]);
    expect(browserSessionTabMocks.closeTrackedBrowserTabsForSessions).not.toHaveBeenCalled();

    const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      { sessionId?: string }
    >;
    expect(store["agent:main:main"]?.sessionId).toBe("sess-main");
    const filesAfterResetAttempt = await fs.readdir(dir);
    expect(filesAfterResetAttempt.some((f) => f.startsWith("sess-main.jsonl.reset."))).toBe(false);
  });

  test("sessions.reset emits before_reset for the entry actually reset under the store lock", async () => {
    const { dir } = await createSessionStoreDir();
    const oldTranscriptPath = path.join(dir, "sess-old.jsonl");
    const newTranscriptPath = path.join(dir, "sess-new.jsonl");
    await fs.writeFile(
      oldTranscriptPath,
      `${JSON.stringify({
        type: "message",
        id: "m-old",
        message: { role: "user", content: "old transcript" },
      })}\n`,
      "utf-8",
    );
    await fs.writeFile(
      newTranscriptPath,
      `${JSON.stringify({
        type: "message",
        id: "m-new",
        message: { role: "user", content: "new transcript" },
      })}\n`,
      "utf-8",
    );

    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-old",
          sessionFile: oldTranscriptPath,
          updatedAt: Date.now(),
        },
      },
    });

    beforeResetHookState.hasBeforeResetHook = true;
    const [{ loadConfig }, { resolveGatewaySessionStoreTarget }, { withSessionStoreLockForTest }] =
      await Promise.all([
        import("../config/config.js"),
        import("./session-utils.js"),
        import("../config/sessions/store.js"),
      ]);
    const gatewayStorePath = resolveGatewaySessionStoreTarget({
      cfg: loadConfig(),
      key: "main",
    }).storePath;

    let pendingReset:
      | ReturnType<(typeof import("./session-reset-service.js"))["performGatewaySessionReset"]>
      | undefined;
    const { performGatewaySessionReset } = await import("./session-reset-service.js");
    await withSessionStoreLockForTest(gatewayStorePath, async () => {
      pendingReset = performGatewaySessionReset({
        key: "main",
        reason: "new",
        commandSource: "gateway:sessions.reset",
      });
      await vi.waitFor(() => {
        expect(sessionHookMocks.triggerInternalHook).toHaveBeenCalledTimes(1);
      });
      await fs.writeFile(
        gatewayStorePath,
        JSON.stringify(
          {
            "agent:main:main": {
              sessionId: "sess-new",
              sessionFile: newTranscriptPath,
              updatedAt: Date.now(),
            },
          },
          null,
          2,
        ),
        "utf-8",
      );
    });

    const reset = await pendingReset!;
    expect(reset.ok).toBe(true);
    const internalEvent = (
      sessionHookMocks.triggerInternalHook.mock.calls as unknown as Array<[unknown]>
    )[0]?.[0] as { context?: { previousSessionEntry?: { sessionId?: string } } } | undefined;
    expect(internalEvent?.context?.previousSessionEntry?.sessionId).toBe("sess-old");
    expect(beforeResetHookMocks.runBeforeReset).toHaveBeenCalledTimes(1);
    const [event, context] = (
      beforeResetHookMocks.runBeforeReset.mock.calls as unknown as Array<[unknown, unknown]>
    )[0] ?? [undefined, undefined];
    expect(event).toMatchObject({
      sessionFile: newTranscriptPath,
      reason: "new",
      messages: [
        {
          role: "user",
          content: "new transcript",
        },
      ],
    });
    expect(context).toMatchObject({
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "sess-new",
    });
  });

  test("sessions.delete returns unavailable when active run does not stop", async () => {
    const { dir, storePath } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-active", "active");

    await writeSessionStore({
      entries: {
        "discord:group:dev": {
          sessionId: "sess-active",
          updatedAt: Date.now(),
        },
      },
    });

    embeddedRunMock.activeIds.add("sess-active");
    embeddedRunMock.waitResults.set("sess-active", false);

    const { ws } = await openClient();

    const deleted = await rpcReq(ws, "sessions.delete", {
      key: "discord:group:dev",
    });
    expect(deleted.ok).toBe(false);
    expect(deleted.error?.code).toBe("UNAVAILABLE");
    expect(deleted.error?.message ?? "").toMatch(/still active/i);
    expectActiveRunCleanup(
      "agent:main:discord:group:dev",
      ["discord:group:dev", "agent:main:discord:group:dev", "sess-active"],
      "sess-active",
    );
    expect(browserSessionTabMocks.closeTrackedBrowserTabsForSessions).not.toHaveBeenCalled();

    const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      { sessionId?: string }
    >;
    expect(store["agent:main:discord:group:dev"]?.sessionId).toBe("sess-active");
    const filesAfterDeleteAttempt = await fs.readdir(dir);
    expect(filesAfterDeleteAttempt.some((f) => f.startsWith("sess-active.jsonl.deleted."))).toBe(
      false,
    );

    ws.close();
  });

  test("webchat clients cannot patch, delete, compact, or restore sessions", async () => {
    const { dir } = await createSessionStoreDir();
    const fixture = await createCheckpointFixture(dir);

    await writeSessionStore({
      entries: {
        main: {
          sessionId: fixture.sessionId,
          sessionFile: fixture.sessionFile,
          updatedAt: Date.now(),
          compactionCheckpoints: [
            {
              checkpointId: "checkpoint-1",
              sessionKey: "agent:main:main",
              sessionId: fixture.sessionId,
              createdAt: Date.now(),
              reason: "manual",
              tokensBefore: 123,
              tokensAfter: 45,
              summary: "checkpoint summary",
              firstKeptEntryId: fixture.preCompactionLeafId,
              preCompaction: {
                sessionId: fixture.preCompactionSession.getSessionId(),
                sessionFile: fixture.preCompactionSessionFile,
                leafId: fixture.preCompactionLeafId,
              },
              postCompaction: {
                sessionId: fixture.sessionId,
                sessionFile: fixture.sessionFile,
                leafId: fixture.postCompactionLeafId,
                entryId: fixture.postCompactionLeafId,
              },
            },
          ],
        },
        "discord:group:dev": {
          sessionId: "sess-group",
          updatedAt: Date.now(),
        },
      },
    });

    const ws = new WebSocket(`ws://127.0.0.1:${harness.port}`, {
      headers: { origin: `http://127.0.0.1:${harness.port}` },
    });
    trackConnectChallengeNonce(ws);
    await new Promise<void>((resolve) => ws.once("open", resolve));
    await connectOk(ws, {
      client: {
        id: GATEWAY_CLIENT_IDS.WEBCHAT_UI,
        version: "1.0.0",
        platform: "test",
        mode: GATEWAY_CLIENT_MODES.UI,
      },
      scopes: ["operator.admin"],
    });

    const patched = await rpcReq(ws, "sessions.patch", {
      key: "agent:main:discord:group:dev",
      label: "should-fail",
    });
    expect(patched.ok).toBe(false);
    expect(patched.error?.message ?? "").toMatch(/webchat clients cannot patch sessions/i);

    const deleted = await rpcReq(ws, "sessions.delete", {
      key: "agent:main:discord:group:dev",
    });
    expect(deleted.ok).toBe(false);
    expect(deleted.error?.message ?? "").toMatch(/webchat clients cannot delete sessions/i);

    const compacted = await rpcReq(ws, "sessions.compact", {
      key: "main",
      maxLines: 3,
    });
    expect(compacted.ok).toBe(false);
    expect(compacted.error?.message ?? "").toMatch(/webchat clients cannot compact sessions/i);

    const restored = await rpcReq(ws, "sessions.compaction.restore", {
      key: "main",
      checkpointId: "checkpoint-1",
    });
    expect(restored.ok).toBe(false);
    expect(restored.error?.message ?? "").toMatch(/webchat clients cannot restore sessions/i);

    ws.close();
  });

  test("session:patch hook fires with correct context", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-patch-hook-"));
    const storePath = path.join(dir, "sessions.json");
    testState.sessionStorePath = storePath;

    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-hook-test",
          updatedAt: Date.now(),
          label: "original-label",
        },
      },
    });

    sessionHookMocks.triggerInternalHook.mockClear();

    const { ws } = await openClient();

    const patched = await rpcReq(ws, "sessions.patch", {
      key: "agent:main:main",
      label: "updated-label",
    });

    expect(patched.ok).toBe(true);
    expect(sessionHookMocks.triggerInternalHook).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session",
        action: "patch",
        sessionKey: expect.stringMatching(/agent:main:main/),
        context: expect.objectContaining({
          sessionEntry: expect.objectContaining({
            sessionId: "sess-hook-test",
            label: "updated-label",
          }),
          patch: expect.objectContaining({
            label: "updated-label",
          }),
          cfg: expect.any(Object),
        }),
      }),
    );

    ws.close();
  });

  test("session:patch hook does not fire for webchat clients", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-webchat-hook-"));
    const storePath = path.join(dir, "sessions.json");
    testState.sessionStorePath = storePath;

    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-webchat-test",
          updatedAt: Date.now(),
        },
      },
    });

    sessionHookMocks.triggerInternalHook.mockClear();

    const ws = new WebSocket(`ws://127.0.0.1:${harness.port}`, {
      headers: { origin: `http://127.0.0.1:${harness.port}` },
    });
    trackConnectChallengeNonce(ws);
    await new Promise<void>((resolve) => ws.once("open", resolve));
    await connectOk(ws, {
      client: {
        id: GATEWAY_CLIENT_IDS.WEBCHAT_UI,
        version: "1.0.0",
        platform: "test",
        mode: GATEWAY_CLIENT_MODES.UI,
      },
      scopes: ["operator.admin"],
    });

    const patched = await rpcReq(ws, "sessions.patch", {
      key: "agent:main:main",
      label: "should-not-trigger-hook",
    });

    expect(patched.ok).toBe(false);
    expect(sessionHookMocks.triggerInternalHook).not.toHaveBeenCalled();

    ws.close();
  });

  test("session:patch hook only fires after successful patch", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-success-hook-"));
    const storePath = path.join(dir, "sessions.json");
    testState.sessionStorePath = storePath;

    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-success-test",
          updatedAt: Date.now(),
        },
      },
    });

    const { ws } = await openClient();

    sessionHookMocks.triggerInternalHook.mockClear();

    // Test 1: Invalid patch (missing key) - hook should not fire
    const invalidPatch = await rpcReq(ws, "sessions.patch", {
      // Missing required 'key' parameter
      label: "should-fail",
    });

    expect(invalidPatch.ok).toBe(false);
    expect(sessionHookMocks.triggerInternalHook).not.toHaveBeenCalled();

    // Test 2: Valid patch - hook should fire
    const validPatch = await rpcReq(ws, "sessions.patch", {
      key: "agent:main:main",
      label: "should-succeed",
    });

    expect(validPatch.ok).toBe(true);
    expect(sessionHookMocks.triggerInternalHook).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session",
        action: "patch",
      }),
    );

    ws.close();
  });

  test("session:patch skips clone and dispatch when no hooks listen", async () => {
    const structuredCloneSpy = vi.spyOn(globalThis, "structuredClone");
    sessionHookMocks.hasInternalHookListeners.mockReturnValue(false);

    const { ws } = await openClient();
    const patched = await rpcReq(ws, "sessions.patch", {
      key: "agent:main:main",
      label: "no-hook-listener",
    });

    expect(patched.ok).toBe(true);
    expect(structuredCloneSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: expect.any(Object),
        patch: expect.any(Object),
        sessionEntry: expect.any(Object),
      }),
    );
    expect(sessionHookMocks.triggerInternalHook).not.toHaveBeenCalled();

    structuredCloneSpy.mockRestore();
    ws.close();
  });

  test("session:patch hook mutations cannot change the response path", async () => {
    await createSessionStoreDir();
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-cfg-isolation-test",
          updatedAt: Date.now(),
        },
      },
    });

    sessionHookMocks.triggerInternalHook.mockImplementationOnce(async (event) => {
      if (!isInternalHookEvent(event) || !isSessionPatchEvent(event)) {
        return;
      }
      event.context.cfg.agents = {
        ...event.context.cfg.agents,
        defaults: {
          ...event.context.cfg.agents?.defaults,
          model: "zai/glm-4.6",
        },
      };
    });

    const { ws } = await openClient();
    const patched = await rpcReq<{
      entry: { label?: string };
      key: string;
      resolved: { modelProvider: string; model: string };
    }>(ws, "sessions.patch", {
      key: "agent:main:main",
      label: "cfg-isolation",
    });

    expect(patched.ok).toBe(true);
    expect(patched.payload?.resolved).toEqual({
      modelProvider: "anthropic",
      model: "claude-opus-4-6",
    });
    expect(patched.payload?.entry.label).toBe("cfg-isolation");

    ws.close();
  });

  test("control-ui client can delete sessions even in webchat mode", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-control-ui-delete-"));
    const storePath = path.join(dir, "sessions.json");
    testState.sessionStorePath = storePath;

    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
        "discord:group:dev": {
          sessionId: "sess-group",
          updatedAt: Date.now(),
        },
      },
    });

    const ws = new WebSocket(`ws://127.0.0.1:${harness.port}`, {
      headers: { origin: `http://127.0.0.1:${harness.port}` },
    });
    trackConnectChallengeNonce(ws);
    await new Promise<void>((resolve) => ws.once("open", resolve));
    await connectOk(ws, {
      client: {
        id: GATEWAY_CLIENT_IDS.CONTROL_UI,
        version: "1.0.0",
        platform: "test",
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      },
      scopes: ["operator.admin"],
    });

    const deleted = await rpcReq<{ ok: true; deleted: boolean }>(ws, "sessions.delete", {
      key: "agent:main:discord:group:dev",
    });
    expect(deleted.ok).toBe(true);
    expect(deleted.payload?.deleted).toBe(true);

    const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      { sessionId?: string }
    >;
    expect(store["agent:main:discord:group:dev"]).toBeUndefined();

    ws.close();
  });
});
