// Agent method tests cover run/steer/reset/wait behavior, task/subagent state,
// approval followups, lifecycle hooks, and emitted gateway events.
import { expectDefined } from "@openclaw/normalization-core";
import { expect, vi } from "vitest";
import type { readAcpSessionMeta } from "../../acp/runtime/session-meta.js";
import type { AgentInternalEvent } from "../../agents/internal-events.js";
import {
  resetSubagentRegistryForTests,
  testing as subagentRegistryTesting,
} from "../../agents/subagent-registry.test-helpers.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { SessionTranscriptStats } from "../../config/sessions/session-accessor.js";
import { parseSqliteSessionFileMarker } from "../../config/sessions/sqlite-marker.js";
import { resetDiagnosticEventsForTest } from "../../infra/diagnostic-events.js";
import {
  resetDetachedTaskLifecycleRuntimeForTests,
  resetTaskRegistryForTests,
} from "../../tasks/task-runtime.test-helpers.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { agentHandlers } from "./agent.js";
import { suspendHandlers } from "./suspend.js";
import type { GatewayRequestContext } from "./types.js";

const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);

export const REAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

export const REAL_PNG_DATA_URL = `data:image/png;base64,${REAL_PNG.toString("base64")}`;

const mocks = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
  loadGatewaySessionRow: vi.fn(),
  updateSessionStore: vi.fn(),
  applySessionEntryReplacements: vi.fn(),
  patchSessionEntryTarget: vi.fn(),
  readTranscriptStatsSync: vi.fn<() => SessionTranscriptStats>(() => ({
    eventCount: 0,
    maxSeq: 0,
    sizeBytes: 0,
  })),
  agentCommand: vi.fn(),
  clearAgentRunContext: vi.fn(),
  registerAgentRunContext: vi.fn(),
  emitAgentEvent: vi.fn(),
  performGatewaySessionReset: vi.fn(),
  emitGatewaySessionEndPluginHook: vi.fn(),
  emitGatewaySessionStartPluginHook: vi.fn(),
  getLatestSubagentRunByChildSessionKey: vi.fn(),
  replaceSubagentRunAfterSteer: vi.fn(),
  resolveExplicitAgentSessionKey: vi.fn(),
  resolveAgentExplicitRecipientSession: vi.fn(async () => ({})),
  readAcpSessionMeta: vi.fn<typeof readAcpSessionMeta>(() => undefined),
  listAgentIds: vi.fn(() => ["main"]),
  loadConfigReturn: {} as Record<string, unknown>,
  loadVoiceWakeRoutingConfig: vi.fn(),
  resolveVoiceWakeRouteByTrigger: vi.fn(),
  getChannelPlugin: vi.fn(),
  sendDurableMessageBatch: vi.fn(),
  resolveSendPolicy: vi.fn((_args?: { entry?: { sendPolicy?: string } }) => "allow"),
  resolveSessionLifecycleTimestamps: vi.fn(
    ({ entry }: { entry?: { sessionStartedAt?: number; lastInteractionAt?: number } }) => ({
      sessionStartedAt: entry?.sessionStartedAt,
      lastInteractionAt: entry?.lastInteractionAt,
    }),
  ),
  lifecycleGeneration: "test-generation",
}));

export function getAgentTestMocks() {
  return mocks;
}

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: mocks.loadSessionEntry,
    loadGatewaySessionRow: mocks.loadGatewaySessionRow,
  };
});

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    updateSessionStore: mocks.updateSessionStore,
    resolveSessionLifecycleTimestamps: mocks.resolveSessionLifecycleTimestamps,
    resolveAgentIdFromSessionKey: (sessionKey: string) => {
      const m = /^agent:([^:]+):/.exec(sessionKey.trim());
      return m?.[1] ?? "main";
    },
    resolveExplicitAgentSessionKey: mocks.resolveExplicitAgentSessionKey,
    resolveAgentMainSessionKey: ({
      cfg,
      agentId,
    }: {
      cfg?: { session?: { mainKey?: string } };
      agentId: string;
    }) => `agent:${agentId}:${cfg?.session?.mainKey ?? "main"}`,
  };
});

vi.mock("../../config/sessions/store.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions/store.js")>(
    "../../config/sessions/store.js",
  );
  return {
    ...actual,
    updateSessionStore: (...args: Parameters<typeof actual.updateSessionStore>) =>
      mocks.updateSessionStore(...args),
  };
});

vi.mock("../../config/sessions/session-accessor.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions/session-accessor.js")>(
    "../../config/sessions/session-accessor.js",
  );
  return {
    ...actual,
    applySessionEntryReplacements: mocks.applySessionEntryReplacements,
    patchSessionEntryTarget: mocks.patchSessionEntryTarget,
    readTranscriptStatsSync: mocks.readTranscriptStatsSync,
  };
});

vi.mock("../../commands/agent.js", () => ({
  agentCommand: mocks.agentCommand,
  agentCommandFromGatewayIngress: mocks.agentCommand,
  agentCommandFromIngress: mocks.agentCommand,
}));

vi.mock("../../acp/runtime/session-meta.js", async () => {
  const actual = await vi.importActual<typeof import("../../acp/runtime/session-meta.js")>(
    "../../acp/runtime/session-meta.js",
  );
  return {
    ...actual,
    readAcpSessionMeta: mocks.readAcpSessionMeta,
  };
});

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: () => mocks.loadConfigReturn,
  };
});

vi.mock("../../agents/agent-scope.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/agent-scope.js")>(
    "../../agents/agent-scope.js",
  );
  return {
    ...actual,
    listAgentIds: mocks.listAgentIds,
    resolveDefaultAgentId: (cfg?: {
      agents?: { list?: Array<{ id?: string; default?: boolean }> };
    }) =>
      cfg?.agents?.list?.find((agent) => agent.default)?.id ?? cfg?.agents?.list?.[0]?.id ?? "main",
    resolveSessionAgentId: ({
      sessionKey,
    }: {
      sessionKey?: string | null;
      config?: Record<string, unknown>;
    }) => {
      const m = /^agent:([^:]+):/.exec((sessionKey ?? "").trim());
      return m?.[1] ?? "main";
    },
    resolveSessionAgentIds: ({
      sessionKey,
      agentId,
      fallbackAgentId,
    }: {
      sessionKey?: string | null;
      agentId?: string;
      fallbackAgentId?: string;
    }) => {
      const parsedAgentId = /^agent:([^:]+):/.exec((sessionKey ?? "").trim())?.[1];
      return {
        defaultAgentId: "main",
        sessionAgentId: agentId ?? parsedAgentId ?? fallbackAgentId ?? "main",
      };
    },
    resolveAgentConfig: (cfg: { agents?: { list?: Array<{ id?: string }> } }, agentId: string) =>
      cfg.agents?.list?.find((agent) => agent.id === agentId),
    resolveAgentWorkspaceDir: (
      cfg: {
        agents?: {
          defaults?: { workspace?: string };
          list?: Array<{ id?: string; workspace?: string }>;
        };
      },
      agentId?: string,
    ) =>
      cfg?.agents?.list?.find((agent) => agent.id === agentId)?.workspace ??
      cfg?.agents?.defaults?.workspace ??
      "/tmp/workspace",
    resolveAgentEffectiveModelPrimary: () => undefined,
  };
});

vi.mock("../../infra/agent-events.js", () => ({
  assertAgentRunLifecycleGenerationCurrent: (lifecycleGeneration: string) => {
    if (lifecycleGeneration === mocks.lifecycleGeneration) {
      return;
    }
    const error = new Error("Agent run belongs to a stale gateway lifecycle");
    error.name = "AbortError";
    throw error;
  },
  claimAgentRunContext: mocks.registerAgentRunContext,
  clearAgentRunContext: mocks.clearAgentRunContext,
  emitAgentEvent: mocks.emitAgentEvent,
  getAgentEventLifecycleGeneration: () => mocks.lifecycleGeneration,
  getAgentRunContext: vi.fn(() => undefined),
  hasProjectedAgentRunForSession: vi.fn(() => false),
  registerAgentRunContext: mocks.registerAgentRunContext,
  onAgentEvent: vi.fn(),
}));

vi.mock("../../agents/subagent-registry-read.js", () => ({
  getLatestSubagentRunByChildSessionKey: mocks.getLatestSubagentRunByChildSessionKey,
}));

vi.mock("../session-subagent-reactivation.runtime.js", () => ({
  replaceSubagentRunAfterSteer: mocks.replaceSubagentRunAfterSteer,
}));

vi.mock("../session-reset-service.js", () => ({
  emitGatewaySessionEndPluginHook: (...args: unknown[]) =>
    (mocks.emitGatewaySessionEndPluginHook as (...args: unknown[]) => unknown)(...args),
  emitGatewaySessionStartPluginHook: (...args: unknown[]) =>
    (mocks.emitGatewaySessionStartPluginHook as (...args: unknown[]) => unknown)(...args),
  performGatewaySessionReset: (...args: unknown[]) =>
    (mocks.performGatewaySessionReset as (...args: unknown[]) => unknown)(...args),
}));

vi.mock("../../infra/voicewake-routing.js", () => ({
  loadVoiceWakeRoutingConfig: mocks.loadVoiceWakeRoutingConfig,
  resolveVoiceWakeRouteByTrigger: mocks.resolveVoiceWakeRouteByTrigger,
}));

vi.mock("../../infra/outbound/agent-delivery.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/outbound/agent-delivery.js")>(
    "../../infra/outbound/agent-delivery.js",
  );
  return {
    ...actual,
    resolveAgentExplicitRecipientSession: mocks.resolveAgentExplicitRecipientSession,
  };
});

vi.mock("../../sessions/send-policy.js", () => ({
  resolveSendPolicy: (...args: unknown[]) =>
    (mocks.resolveSendPolicy as (...args: unknown[]) => unknown)(...args),
}));

vi.mock("../../channels/plugins/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../channels/plugins/index.js")>(
    "../../channels/plugins/index.js",
  );
  return {
    ...actual,
    getChannelPlugin: (...args: Parameters<typeof actual.getChannelPlugin>) => {
      const override = mocks.getChannelPlugin.getMockImplementation();
      return override
        ? (override(...args) as ReturnType<typeof actual.getChannelPlugin>)
        : actual.getChannelPlugin(...args);
    },
  };
});

vi.mock("../../channels/message/runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../../channels/message/runtime.js")>(
    "../../channels/message/runtime.js",
  );
  return {
    ...actual,
    sendDurableMessageBatch: (...args: Parameters<typeof actual.sendDurableMessageBatch>) => {
      const override = mocks.sendDurableMessageBatch.getMockImplementation();
      return override
        ? (mocks.sendDurableMessageBatch(...args) as ReturnType<
            typeof actual.sendDurableMessageBatch
          >)
        : actual.sendDurableMessageBatch(...args);
    },
  };
});

vi.mock("../../utils/delivery-context.js", async () => {
  const actual = await vi.importActual<typeof import("../../utils/delivery-context.js")>(
    "../../utils/delivery-context.js",
  );
  return {
    ...actual,
    normalizeSessionDeliveryFields: () => ({}),
  };
});

export const makeContext = (): GatewayRequestContext =>
  ({
    dedupe: new Map(),
    addChatRun: vi.fn(),
    removeChatRun: vi.fn(),
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    chatRunBuffers: new Map(),
    chatDeltaSentAt: new Map(),
    chatDeltaLastBroadcastLen: new Map(),
    chatDeltaLastBroadcastText: new Map(),
    agentDeltaSentAt: new Map(),
    bufferedAgentEvents: new Map(),
    chatAbortedRuns: new Map(),
    clearChatRunState: vi.fn(),
    agentRunSeq: new Map(),
    broadcast: vi.fn(),
    nodeSendToSession: vi.fn(),
    logGateway: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    broadcastToConnIds: vi.fn(),
    getSessionEventSubscriberConnIds: () => new Set(),
    getRuntimeConfig: () => mocks.loadConfigReturn,
  }) as unknown as GatewayRequestContext;

type AgentHandler = NonNullable<typeof agentHandlers.agent>;

export type AgentHandlerArgs = Parameters<AgentHandler>[0];

export type AgentParams = AgentHandlerArgs["params"];

export type AgentCommandCall = Record<string, unknown>;

type AgentIdentityGetHandler = NonNullable<(typeof agentHandlers)["agent.identity.get"]>;

type AgentIdentityGetHandlerArgs = Parameters<AgentIdentityGetHandler>[0];

type AgentIdentityGetParams = AgentIdentityGetHandlerArgs["params"];

const realSetTimeout = globalThis.setTimeout.bind(globalThis);

let dateOnlyFakeClockActive = false;

export function setDateOnlyFakeClockActive(active: boolean): void {
  dateOnlyFakeClockActive = active;
}

function waitForRealTimer(ms: number) {
  return new Promise<void>((resolve) => {
    realSetTimeout(resolve, ms);
  });
}

export async function waitForAssertion(assertion: () => void, timeoutMs = 2_000, stepMs = 5) {
  let lastError: unknown;
  for (let elapsed = 0; elapsed <= timeoutMs; elapsed += stepMs) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }

    await Promise.resolve();
    if (vi.isFakeTimers() && !dateOnlyFakeClockActive) {
      await vi.advanceTimersByTimeAsync(stepMs);
    } else {
      await waitForRealTimer(stepMs);
    }
  }
  throw toLintErrorObject(
    lastError ?? new Error("assertion did not pass in time"),
    "Non-Error thrown",
  );
}

export function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value == null) {
    throw new Error(message);
  }
  return value;
}

export function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

export function expectStringFieldContains(
  record: Record<string, unknown>,
  field: string,
  expected: string,
) {
  expect(record[field]).toBeTypeOf("string");
  expect(record[field]).toContain(expected);
}

export function expectSqliteSessionFileMarkerForEntry(entry: Record<string, unknown> | undefined) {
  const sessionFile = entry?.sessionFile;
  expect(sessionFile).toBeTypeOf("string");
  const marker = parseSqliteSessionFileMarker(sessionFile as string);
  expect(marker?.sessionId).toBe(entry?.sessionId);
}

export function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0) {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[argIndex];
}

export function expectRespondError(
  mock: ReturnType<typeof vi.fn>,
  expected: Record<string, unknown>,
) {
  expect(mockCallArg(mock)).toBe(false);
  expect(mockCallArg(mock, 0, 1)).toBeUndefined();
  return expectRecordFields(mockCallArg(mock, 0, 2), expected);
}

export async function flushScheduledDispatchStep() {
  await Promise.resolve();
  if (vi.isFakeTimers() && !dateOnlyFakeClockActive) {
    await vi.runOnlyPendingTimersAsync();
  } else {
    await waitForRealTimer(15);
  }
  await Promise.resolve();
}

async function waitForAcceptedRunDispatch(params: {
  respond: ReturnType<typeof vi.fn>;
  commandCallCount: number;
}) {
  const { respond } = params;
  const accepted = respond.mock.calls.some(([ok, payload]) => {
    return ok === true && (payload as { status?: string } | undefined)?.status === "accepted";
  });
  if (!accepted) {
    return;
  }
  const respondCallCount = respond.mock.calls.length;
  for (let attempt = 0; attempt < 50; attempt++) {
    await flushScheduledDispatchStep();
    if (
      mocks.agentCommand.mock.calls.length > params.commandCallCount ||
      respond.mock.calls.length > respondCallCount
    ) {
      return;
    }
  }
}

export function mockMainSessionEntry(
  entry: Record<string, unknown>,
  cfg: Record<string, unknown> = {},
) {
  mocks.loadSessionEntry.mockReturnValue({
    cfg,
    storePath: "/tmp/sessions.json",
    entry: {
      sessionId: "existing-session-id",
      updatedAt: Date.now(),
      ...entry,
    },
    canonicalKey: "agent:main:main",
  });
}

export function buildExistingMainStoreEntry(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "existing-session-id",
    updatedAt: Date.now(),
    ...overrides,
  };
}

type SessionStoreFixture = Record<string, Record<string, unknown>>;

type SessionEntryTargetFixture = {
  canonicalKey: string;
  storeKeys: string[];
};

function cloneSessionStoreFixtureEntry(
  entry: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return entry ? structuredClone(entry) : undefined;
}

function selectFreshestTargetFixtureEntry(
  store: SessionStoreFixture,
  target: SessionEntryTargetFixture,
): { entry: Record<string, unknown>; key: string } | undefined {
  let freshest: { entry: Record<string, unknown>; key: string } | undefined;
  for (const key of new Set([target.canonicalKey, ...target.storeKeys])) {
    const entry = store[key];
    if (!entry) {
      continue;
    }
    if (
      !freshest ||
      ((entry.updatedAt as number | undefined) ?? 0) >
        ((freshest.entry.updatedAt as number | undefined) ?? 0)
    ) {
      freshest = { entry, key };
    }
  }
  return freshest;
}

function resetSessionAccessorMocks() {
  mocks.readTranscriptStatsSync.mockReset().mockReturnValue({
    eventCount: 0,
    maxSeq: 0,
    sizeBytes: 0,
  });
  mocks.applySessionEntryReplacements.mockReset().mockImplementation(
    async (params: {
      activeSessionKey?: string;
      requireWriteSuccess?: boolean;
      sessionKeys?: readonly string[];
      skipMaintenance?: boolean;
      storePath: string;
      update: (entries: Array<{ sessionKey: string; entry: SessionEntry }>) =>
        | Promise<{
            replacements?: Iterable<{ sessionKey: string; entry: SessionEntry }>;
            result: unknown;
          }>
        | {
            replacements?: Iterable<{ sessionKey: string; entry: SessionEntry }>;
            result: unknown;
          };
    }) =>
      await mocks.updateSessionStore(
        params.storePath,
        async (store: Record<string, SessionEntry>) => {
          const keys = params.sessionKeys ?? Object.keys(store);
          const snapshots = keys.flatMap((sessionKey) => {
            const entry = store[sessionKey];
            return entry ? [{ sessionKey, entry: structuredClone(entry) }] : [];
          });
          const planned = await params.update(snapshots);
          for (const replacement of planned.replacements ?? []) {
            if (store[replacement.sessionKey]) {
              store[replacement.sessionKey] = structuredClone(replacement.entry);
            }
          }
          return planned.result;
        },
        {
          activeSessionKey: params.activeSessionKey,
          requireWriteSuccess: params.requireWriteSuccess,
          skipMaintenance: params.skipMaintenance,
        },
      ),
  );
  mocks.patchSessionEntryTarget.mockReset().mockImplementation(
    async (
      scope: { storePath: string; target: SessionEntryTargetFixture },
      update: (
        entry: Record<string, unknown>,
        context: { existingEntry?: Record<string, unknown> },
      ) => Promise<Record<string, unknown> | null> | Record<string, unknown> | null,
      options: {
        fallbackEntry?: Record<string, unknown>;
        replaceEntry?: boolean;
      } = {},
    ) =>
      await mocks.updateSessionStore(
        scope.storePath,
        async (store: SessionStoreFixture) => {
          const existing = selectFreshestTargetFixtureEntry(store, scope.target);
          const base = existing?.entry ?? options.fallbackEntry;
          if (!base) {
            return null;
          }
          const patchContext = existing ? { existingEntry: structuredClone(existing.entry) } : {};
          const patch = await update(structuredClone(base), patchContext);
          if (!patch) {
            return cloneSessionStoreFixtureEntry(base);
          }
          const fresh = selectFreshestTargetFixtureEntry(store, scope.target);
          const writeBase = fresh?.entry ?? options.fallbackEntry;
          if (!writeBase) {
            return null;
          }
          const next = options.replaceEntry ? structuredClone(patch) : { ...writeBase, ...patch };
          for (const key of new Set([scope.target.canonicalKey, ...scope.target.storeKeys])) {
            delete store[key];
          }
          store[scope.target.canonicalKey] = next;
          return next;
        },
        options,
      ),
  );
}

resetSessionAccessorMocks();

export function setupNewYorkTimeConfig(isoDate: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  dateOnlyFakeClockActive = true;
  vi.setSystemTime(new Date(isoDate)); // Wed Jan 28, 8:30 PM EST
  mocks.agentCommand.mockClear();
  mocks.loadConfigReturn = {
    agents: {
      defaults: {
        userTimezone: "America/New_York",
      },
    },
  };
}

export function resetTimeConfig() {
  mocks.loadConfigReturn = {};
  dateOnlyFakeClockActive = false;
  vi.useRealTimers();
}

export function useTestStateDir(root: string): void {
  setTestEnvValue("OPENCLAW_STATE_DIR", root);
}

export async function expectResetCall(expectedMessage: string) {
  const call = await waitForAgentCommandCall();
  expect(mocks.performGatewaySessionReset).toHaveBeenCalledTimes(1);
  expect(call?.message).toBe(expectedMessage);
  return call;
}

export function primeMainAgentRun(params?: { sessionId?: string; cfg?: Record<string, unknown> }) {
  mockMainSessionEntry(
    { sessionId: params?.sessionId ?? "existing-session-id" },
    params?.cfg ?? {},
  );
  mocks.updateSessionStore.mockResolvedValue(undefined);
  mocks.agentCommand.mockResolvedValue({
    payloads: [{ text: "ok" }],
    meta: { durationMs: 100 },
  });
}

export async function runMainAgent(message: string, idempotencyKey: string) {
  const respond = vi.fn();
  await invokeAgent(
    {
      message,
      agentId: "main",
      sessionKey: "agent:main:main",
      idempotencyKey,
    },
    { respond, reqId: idempotencyKey },
  );
  return respond;
}

export async function runMainAgentAndCaptureEntry(idempotencyKey: string) {
  const loaded = mocks.loadSessionEntry();
  const canonicalKey = loaded?.canonicalKey ?? "agent:main:main";
  const existingEntry = structuredClone(loaded?.entry ?? buildExistingMainStoreEntry());
  let capturedEntry: Record<string, unknown> | undefined;
  mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
    const store: Record<string, unknown> = {
      [canonicalKey]: existingEntry,
    };
    const result = await updater(store);
    capturedEntry = structuredClone(store[canonicalKey]) as Record<string, unknown>;
    return result;
  });
  mocks.agentCommand.mockResolvedValue({
    payloads: [{ text: "ok" }],
    meta: { durationMs: 100 },
  });
  await runMainAgent("hi", idempotencyKey);
  return requireValue(capturedEntry, "updated session entry missing");
}

function readLastAgentCommandCall(): AgentCommandCall | undefined {
  const calls = mocks.agentCommand.mock.calls;
  const call = calls[calls.length - 1];
  return call?.[0] as AgentCommandCall | undefined;
}

export function backendGatewayClient(): AgentHandlerArgs["client"] {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "gateway-client",
        version: "test",
        platform: "test",
        mode: "backend",
      },
      scopes: ["operator.write"],
    },
  } as AgentHandlerArgs["client"];
}

export function cronContinuationGatewayClient(): AgentHandlerArgs["client"] {
  const client = backendGatewayClient();
  if (!client) {
    throw new Error("expected backend gateway client");
  }
  return {
    ...client,
    internal: { ...client.internal, cronRunContinuation: true },
  };
}

export function cronMediaCompletionEvent(): AgentInternalEvent {
  return {
    type: "task_completion",
    source: "image_generation",
    childSessionKey: "image_generate:task-1",
    childSessionId: "task-1",
    announceType: "image generation task",
    taskLabel: "header image",
    status: "ok",
    statusLabel: "completed successfully",
    result: "MEDIA:/tmp/header.png",
    replyInstruction: "Continue the original cron task.",
  };
}

export function setupCronContinuationReleaseFixture() {
  const sessionKey = "agent:main:cron:job-1:run:run-1";
  const entry: SessionEntry = {
    sessionId: "run-1",
    updatedAt: Date.now(),
    lifecycleRevision: "revision-1",
    modelProvider: "openai",
    model: "gpt-5.4",
    cronRunContinuation: {
      lifecycleRevision: "revision-1",
      phase: "ready",
      basePersisted: true,
    },
  };
  mocks.loadSessionEntry.mockReturnValue({
    cfg: {},
    storePath: "/tmp/sessions.json",
    canonicalKey: sessionKey,
    entry,
  });
  return {
    sessionKey,
    store: { [sessionKey]: structuredClone(entry) } as Record<string, SessionEntry>,
  };
}

export async function invokeGatewaySuspendPrepare(
  context: GatewayRequestContext,
  requestId: string,
) {
  const respond = vi.fn();
  await expectDefined(
    suspendHandlers["gateway.suspend.prepare"],
    'suspendHandlers["gateway.suspend.prepare"] test invariant',
  )({
    params: { requestId },
    respond: respond as never,
    context: {
      ...context,
      cron: {
        pauseScheduling: vi.fn(),
        resumeScheduling: vi.fn(),
        getSuspensionBlockerCount: () => 0,
      },
    } as unknown as GatewayRequestContext,
    req: { type: "req", id: requestId, method: "gateway.suspend.prepare" },
    client: null,
    isWebchatConnect: () => false,
  });
  return respond;
}

// Operator-write client that is NOT the in-process backend ACP spawn caller:
// a control-UI connection with the same operator.write scope. It can set
// acpTurnSource but owns no replacement `acp` task row, so CLI tracking stays on.
export function operatorWriteGatewayClient(): AgentHandlerArgs["client"] {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-control-ui",
        version: "test",
        platform: "test",
        mode: "ui",
      },
      scopes: ["operator.write"],
    },
  } as AgentHandlerArgs["client"];
}

export function operatorWriteCliClient(): AgentHandlerArgs["client"] {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "cli",
        version: "test",
        platform: "test",
        mode: "cli",
      },
      scopes: ["operator.write"],
    },
  } as AgentHandlerArgs["client"];
}

export async function waitForAgentCommandCall<
  T extends AgentCommandCall = AgentCommandCall,
>(): Promise<T> {
  await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalled());
  const call = readLastAgentCommandCall();
  if (!call) {
    throw new Error("expected agentCommand call");
  }
  return call as T;
}

export function mockSessionResetSuccess(params: {
  reason: "new" | "reset";
  key?: string;
  sessionId?: string;
}) {
  const key = params.key ?? "agent:main:main";
  const sessionId = params.sessionId ?? "reset-session-id";
  mocks.performGatewaySessionReset.mockImplementation(
    async (opts: { key: string; reason: string; commandSource: string }) => {
      expect(opts.key).toBe(key);
      expect(opts.reason).toBe(params.reason);
      expect(opts.commandSource).toBe("gateway:agent");
      return {
        ok: true,
        key,
        entry: { sessionId },
      };
    },
  );
}

export async function invokeAgent(
  params: AgentParams,
  options?: {
    respond?: ReturnType<typeof vi.fn>;
    reqId?: string;
    context?: GatewayRequestContext;
    client?: AgentHandlerArgs["client"];
    isWebchatConnect?: AgentHandlerArgs["isWebchatConnect"];
    flushDispatch?: boolean;
  },
) {
  const respond = options?.respond ?? vi.fn();
  const commandCallCount = mocks.agentCommand.mock.calls.length;
  // Most cases only need to cross the accepted-ack timer; keep tests that own
  // timer semantics on their explicit clock while avoiding a real sleep here.
  const ownsDispatchTimers = options?.flushDispatch !== false && !vi.isFakeTimers();
  if (ownsDispatchTimers) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  }
  try {
    await expectDefined(agentHandlers.agent, "agentHandlers.agent test invariant").call(
      agentHandlers,
      {
        params,
        respond: respond as never,
        context: options?.context ?? makeContext(),
        req: { type: "req", id: options?.reqId ?? "agent-test-req", method: "agent" },
        client: options?.client ?? null,
        isWebchatConnect: options?.isWebchatConnect ?? (() => false),
      },
    );
    if (options?.flushDispatch !== false) {
      await waitForAcceptedRunDispatch({ respond, commandCallCount });
    }
  } finally {
    if (ownsDispatchTimers) {
      vi.useRealTimers();
    }
  }
  return respond;
}

export async function invokeAgentIdentityGet(
  params: AgentIdentityGetParams,
  options?: {
    respond?: ReturnType<typeof vi.fn>;
    reqId?: string;
    context?: GatewayRequestContext;
  },
) {
  const respond = options?.respond ?? vi.fn();
  await expectDefined(
    agentHandlers["agent.identity.get"],
    'agentHandlers["agent.identity.get"] test invariant',
  )({
    params,
    respond: respond as never,
    context: options?.context ?? makeContext(),
    req: {
      type: "req",
      id: options?.reqId ?? "agent-identity-test-req",
      method: "agent.identity.get",
    },
    client: null,
    isWebchatConnect: () => false,
  });
  return respond;
}

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}

/**
 * Pins subagent-registry deps for gateway handler tests, always keeping
 * `ensureRuntimePluginsLoaded` a no-op. Real ended-run hooks reload the
 * standalone plugin runtime in the background, and `loadOpenClawPlugins`
 * starts by wiping process-wide plugin registrations — including the detached
 * task lifecycle runtime a later test just installed via
 * `setDetachedTaskLifecycleRuntime`. Without this pin, a prior test's async
 * subagent completion can silently uninstall a later test's runtime seam
 * between install and finalize, so the finalize spy is never called.
 */
export function applyGatewaySubagentRegistryTestDeps(
  overrides?: Parameters<typeof subagentRegistryTesting.setDepsForTest>[0],
) {
  subagentRegistryTesting.setDepsForTest({
    ensureRuntimePluginsLoaded: () => {},
    ...overrides,
  });
}

applyGatewaySubagentRegistryTestDeps();

export const describe0AfterEach0 = () => {
  envSnapshot.restore();
  resetDetachedTaskLifecycleRuntimeForTests();
  resetDiagnosticEventsForTest();
  resetTaskRegistryForTests();
  resetSubagentRegistryForTests({ persist: false });
  applyGatewaySubagentRegistryTestDeps();
  mocks.loadConfigReturn = {};
  mocks.emitGatewaySessionEndPluginHook.mockReset();
  mocks.emitGatewaySessionStartPluginHook.mockReset();
  resetSessionAccessorMocks();
  mocks.resolveExplicitAgentSessionKey.mockReset().mockReturnValue(undefined);
  mocks.resolveAgentExplicitRecipientSession.mockReset().mockResolvedValue({});
  mocks.readAcpSessionMeta.mockReset().mockReturnValue(undefined);
  mocks.listAgentIds.mockReset().mockReturnValue(["main"]);
  mocks.getChannelPlugin.mockReset();
  mocks.sendDurableMessageBatch.mockReset();
  mocks.resolveSendPolicy.mockReset().mockReturnValue("allow");
  mocks.resolveSessionLifecycleTimestamps
    .mockReset()
    .mockImplementation(
      ({ entry }: { entry?: { sessionStartedAt?: number; lastInteractionAt?: number } }) => ({
        sessionStartedAt: entry?.sessionStartedAt,
        lastInteractionAt: entry?.lastInteractionAt,
      }),
    );
  mocks.lifecycleGeneration = "test-generation";
  dateOnlyFakeClockActive = false;
  vi.useRealTimers();
};

function resetIntegrationState() {
  envSnapshot.restore();
  resetDetachedTaskLifecycleRuntimeForTests();
  resetTaskRegistryForTests();
  mocks.agentCommand.mockReset();
  mocks.loadConfigReturn = {};
  mocks.loadGatewaySessionRow.mockReset();
  mocks.loadSessionEntry.mockReset();
  mocks.updateSessionStore.mockReset();
  resetSessionAccessorMocks();
  mocks.emitGatewaySessionEndPluginHook.mockReset();
  mocks.emitGatewaySessionStartPluginHook.mockReset();
  mocks.getLatestSubagentRunByChildSessionKey.mockReset();
  mocks.replaceSubagentRunAfterSteer.mockReset();
  mocks.resolveExplicitAgentSessionKey.mockReset().mockReturnValue(undefined);
  mocks.readAcpSessionMeta.mockReset().mockReturnValue(undefined);
  mocks.listAgentIds.mockReset().mockReturnValue(["main"]);
  mocks.getChannelPlugin.mockReset();
  mocks.sendDurableMessageBatch.mockReset();
  mocks.loadVoiceWakeRoutingConfig.mockReset();
  mocks.resolveVoiceWakeRouteByTrigger.mockReset();
  mocks.resolveSendPolicy.mockReset().mockReturnValue("allow");
  mocks.lifecycleGeneration = "test-generation";
  dateOnlyFakeClockActive = false;
  vi.useRealTimers();
}

export const describe1BeforeEach0 = () => {
  resetIntegrationState();
};

export const describe1AfterEach1 = () => {
  resetIntegrationState();
};

export function prime(sessionId = "existing-session-id", cfg: Record<string, unknown> = {}) {
  mockMainSessionEntry({ sessionId }, cfg);
  mocks.updateSessionStore.mockResolvedValue(undefined);
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
