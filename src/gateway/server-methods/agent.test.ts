// Agent method tests cover run/steer/reset/wait behavior, task/subagent state,
// approval followups, lifecycle hooks, and emitted gateway events.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { readAcpSessionMeta } from "../../acp/runtime/session-meta.js";
import {
  registerExecApprovalFollowupRuntimeHandoff,
  resetExecApprovalFollowupRuntimeHandoffsForTests,
} from "../../agents/bash-tools.exec-approval-followup-state.js";
import type { AgentInternalEvent } from "../../agents/internal-events.js";
import {
  createAgentRunRestartAbortError,
  isAgentRunRestartAbortReason,
} from "../../agents/run-termination.js";
import {
  getSubagentRunByChildSessionKey,
  resetSubagentRegistryForTests,
  testing as subagentRegistryTesting,
} from "../../agents/subagent-registry.js";
import {
  registerSubagentTraceparentHandoff,
  resetSubagentTraceparentHandoffsForTests,
} from "../../agents/subagent-traceparent-handoff.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { SessionTranscriptStats } from "../../config/sessions/session-accessor.js";
import { parseSqliteSessionFileMarker } from "../../config/sessions/sqlite-marker.js";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import {
  resetGatewaySuspendCoordinatorForTest,
  resumeGatewaySuspend,
} from "../../infra/gateway-suspend-coordinator.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import {
  interruptSessionWorkAdmissions,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import { AVATAR_MAX_BYTES } from "../../shared/avatar-policy.js";
import {
  getDetachedTaskLifecycleRuntime,
  resetDetachedTaskLifecycleRuntimeForTests,
  setDetachedTaskLifecycleRuntime,
} from "../../tasks/detached-task-runtime.js";
import {
  findTaskByRunId,
  listTaskRecords,
  markTaskTerminalById,
  resetTaskRegistryForTests,
} from "../../tasks/task-registry.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { setGatewayDedupeEntry } from "./agent-job.js";
import { agentHandlers } from "./agent.js";
import { chatHandlers } from "./chat.js";
import { expectSubagentFollowupReactivation } from "./subagent-followup.test-helpers.js";
import { suspendHandlers } from "./suspend.js";
import type { GatewayRequestContext } from "./types.js";

const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
const REAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const REAL_PNG_DATA_URL = `data:image/png;base64,${REAL_PNG.toString("base64")}`;

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

const makeContext = (): GatewayRequestContext =>
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
type AgentHandlerArgs = Parameters<AgentHandler>[0];
type AgentParams = AgentHandlerArgs["params"];
type AgentCommandCall = Record<string, unknown>;

type AgentIdentityGetHandler = NonNullable<(typeof agentHandlers)["agent.identity.get"]>;
type AgentIdentityGetHandlerArgs = Parameters<AgentIdentityGetHandler>[0];
type AgentIdentityGetParams = AgentIdentityGetHandlerArgs["params"];

const realSetTimeout = globalThis.setTimeout.bind(globalThis);
let dateOnlyFakeClockActive = false;

function waitForRealTimer(ms: number) {
  return new Promise<void>((resolve) => {
    realSetTimeout(resolve, ms);
  });
}

async function waitForAssertion(assertion: () => void, timeoutMs = 2_000, stepMs = 5) {
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

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value == null) {
    throw new Error(message);
  }
  return value;
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

function expectStringFieldContains(
  record: Record<string, unknown>,
  field: string,
  expected: string,
) {
  expect(record[field]).toBeTypeOf("string");
  expect(record[field]).toContain(expected);
}

function expectSqliteSessionFileMarkerForEntry(entry: Record<string, unknown> | undefined) {
  const sessionFile = entry?.sessionFile;
  expect(sessionFile).toBeTypeOf("string");
  const marker = parseSqliteSessionFileMarker(sessionFile as string);
  expect(marker?.sessionId).toBe(entry?.sessionId);
}

function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0) {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[argIndex];
}

function expectRespondError(mock: ReturnType<typeof vi.fn>, expected: Record<string, unknown>) {
  expect(mockCallArg(mock)).toBe(false);
  expect(mockCallArg(mock, 0, 1)).toBeUndefined();
  return expectRecordFields(mockCallArg(mock, 0, 2), expected);
}

async function flushScheduledDispatchStep() {
  await Promise.resolve();
  if (vi.isFakeTimers() && !dateOnlyFakeClockActive) {
    await vi.runOnlyPendingTimersAsync();
  } else {
    await waitForRealTimer(15);
  }
  await Promise.resolve();
}

async function waitForAcceptedRunDispatch(respond: ReturnType<typeof vi.fn>) {
  const accepted = respond.mock.calls.some(([ok, payload]) => {
    return ok === true && (payload as { status?: string } | undefined)?.status === "accepted";
  });
  if (!accepted) {
    return;
  }

  const commandCallCount = mocks.agentCommand.mock.calls.length;
  const respondCallCount = respond.mock.calls.length;
  for (let attempt = 0; attempt < 50; attempt++) {
    await flushScheduledDispatchStep();
    if (
      mocks.agentCommand.mock.calls.length > commandCallCount ||
      respond.mock.calls.length > respondCallCount
    ) {
      return;
    }
  }
}

function mockMainSessionEntry(entry: Record<string, unknown>, cfg: Record<string, unknown> = {}) {
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

function buildExistingMainStoreEntry(overrides: Record<string, unknown> = {}) {
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

function setupNewYorkTimeConfig(isoDate: string) {
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

function resetTimeConfig() {
  mocks.loadConfigReturn = {};
  dateOnlyFakeClockActive = false;
  vi.useRealTimers();
}

function useTestStateDir(root: string): void {
  setTestEnvValue("OPENCLAW_STATE_DIR", root);
}

async function expectResetCall(expectedMessage: string) {
  const call = await waitForAgentCommandCall();
  expect(mocks.performGatewaySessionReset).toHaveBeenCalledTimes(1);
  expect(call?.message).toBe(expectedMessage);
  return call;
}

function primeMainAgentRun(params?: { sessionId?: string; cfg?: Record<string, unknown> }) {
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

async function runMainAgent(message: string, idempotencyKey: string) {
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

async function runMainAgentAndCaptureEntry(idempotencyKey: string) {
  const loaded = mocks.loadSessionEntry();
  const canonicalKey = loaded?.canonicalKey ?? "agent:main:main";
  const existingEntry = structuredClone(loaded?.entry ?? buildExistingMainStoreEntry());
  let capturedEntry: Record<string, unknown> | undefined;
  mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
    const store: Record<string, unknown> = {
      [canonicalKey]: existingEntry,
    };
    const result = await updater(store);
    capturedEntry = result as Record<string, unknown>;
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

function backendGatewayClient(): AgentHandlerArgs["client"] {
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

function cronContinuationGatewayClient(): AgentHandlerArgs["client"] {
  const client = backendGatewayClient();
  if (!client) {
    throw new Error("expected backend gateway client");
  }
  return {
    ...client,
    internal: { ...client.internal, cronRunContinuation: true },
  };
}

function cronMediaCompletionEvent(): AgentInternalEvent {
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

function setupCronContinuationReleaseFixture() {
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

async function invokeGatewaySuspendPrepare(context: GatewayRequestContext, requestId: string) {
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
function operatorWriteGatewayClient(): AgentHandlerArgs["client"] {
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

function operatorWriteCliClient(): AgentHandlerArgs["client"] {
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

async function waitForAgentCommandCall<
  T extends AgentCommandCall = AgentCommandCall,
>(): Promise<T> {
  await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalled());
  const call = readLastAgentCommandCall();
  if (!call) {
    throw new Error("expected agentCommand call");
  }
  return call as T;
}

function mockSessionResetSuccess(params: {
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

async function invokeAgent(
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
      await waitForAcceptedRunDispatch(respond);
    }
  } finally {
    if (ownsDispatchTimers) {
      vi.useRealTimers();
    }
  }
  return respond;
}

async function invokeAgentIdentityGet(
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

describe("gateway agent handler", () => {
  afterEach(() => {
    envSnapshot.restore();
    resetDetachedTaskLifecycleRuntimeForTests();
    resetDiagnosticEventsForTest();
    resetTaskRegistryForTests();
    resetSubagentRegistryForTests({ persist: false });
    subagentRegistryTesting.setDepsForTest();
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
    resetExecApprovalFollowupRuntimeHandoffsForTests();
    resetSubagentTraceparentHandoffsForTests();
  });

  it("uses the same-process subagent traceparent handoff when the request field is missing", async () => {
    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const sessionKey = "agent:main:subagent:child-trace";
    const idempotencyKey = "child-trace-run";
    registerSubagentTraceparentHandoff({
      idempotencyKey,
      sessionKey,
      traceparent,
    });
    const existingEntry = buildExistingMainStoreEntry({
      spawnedBy: "agent:main:main",
    });
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: existingEntry,
      canonicalKey: sessionKey,
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, Record<string, unknown>> = {
        [sessionKey]: { ...existingEntry },
      };
      const result = await updater(store);
      return result;
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "child task",
        agentId: "main",
        sessionKey,
        idempotencyKey,
      },
      { client: backendGatewayClient() },
    );

    const call = await waitForAgentCommandCall();
    expect(call.traceparent).toBe(traceparent);
  });

  it("uses the provisional child session traceparent when the request field is missing across process", async () => {
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    const sessionKey = "agent:main:subagent:child-session-trace";
    const idempotencyKey = "child-session-trace-run";
    const existingEntry = buildExistingMainStoreEntry({
      spawnedBy: "agent:main:main",
      continuationTraceparent: traceparent,
    });
    let persistedEntry: Record<string, unknown> | undefined;
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: existingEntry,
      canonicalKey: sessionKey,
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, Record<string, unknown>> = {
        [sessionKey]: { ...existingEntry },
      };
      const result = await updater(store);
      persistedEntry = result as Record<string, unknown>;
      return result;
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "child task",
        agentId: "main",
        sessionKey,
        idempotencyKey,
      },
      { client: backendGatewayClient() },
    );

    const call = await waitForAgentCommandCall();
    expect(call.traceparent).toBe(traceparent);
    expect(persistedEntry?.continuationTraceparent).toBeUndefined();
  });

  it("passes resolved maintenance config to the gateway admission store write", async () => {
    primeMainAgentRun({
      cfg: {
        session: {
          maintenance: {
            mode: "enforce",
            maxEntries: 42,
          },
        },
      },
    });

    await runMainAgent("hi", "idem-maintenance-config");

    const updateOptions = mocks.updateSessionStore.mock.calls.at(-1)?.[2];
    expect(updateOptions).toMatchObject({
      takeCacheOwnership: true,
      maintenanceConfig: {
        mode: "enforce",
        maxEntries: 42,
      },
    });
  });

  it("resolves explicit recipient sessions before Gateway admission", async () => {
    const sessionKey = "agent:ops:whatsapp:work:direct:+15551234567";
    mocks.listAgentIds.mockReturnValue(["main", "ops"]);
    mocks.loadConfigReturn = { session: { dmScope: "per-account-channel-peer" } };
    mocks.resolveAgentExplicitRecipientSession.mockResolvedValue({
      sessionKey,
      channel: "whatsapp",
      to: "user:+15551234567",
      accountId: "work",
      threadId: "topic-42",
    });
    mocks.loadSessionEntry.mockReturnValue({
      cfg: mocks.loadConfigReturn,
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "recipient-session", updatedAt: Date.now() },
      canonicalKey: sessionKey,
    });
    let persistedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store = {
        [sessionKey]: { sessionId: "recipient-session", updatedAt: Date.now() },
      };
      const result = await updater(store);
      persistedEntry = store[sessionKey];
      return result;
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent({
      message: "hi",
      agentId: "ops",
      channel: "whatsapp",
      to: "+15551234567",
      threadId: "topic-42",
      idempotencyKey: "recipient-session-route",
    });

    expect(mocks.resolveAgentExplicitRecipientSession).toHaveBeenCalledWith({
      cfg: mocks.loadConfigReturn,
      agentId: "ops",
      channel: "whatsapp",
      to: "+15551234567",
      accountId: undefined,
      threadId: "topic-42",
    });
    const call = await waitForAgentCommandCall<{
      sessionKey?: string;
      channel?: string;
      to?: string;
      accountId?: string;
      threadId?: string;
    }>();
    expect(call.sessionKey).toBe(sessionKey);
    expect(call).toMatchObject({
      channel: "whatsapp",
      to: "user:+15551234567",
      accountId: "work",
      threadId: "topic-42",
    });
    expect(persistedEntry?.deliveryContext).toEqual({
      channel: "whatsapp",
      to: "user:+15551234567",
      accountId: "work",
      threadId: "topic-42",
    });
  });

  it.each(["webchat", "LAST"])(
    "keeps the agent main session for non-deliverable channel hint %s",
    async (channel) => {
      const sessionKey = "agent:ops:main";
      mocks.listAgentIds.mockReturnValue(["main", "ops"]);
      mocks.resolveExplicitAgentSessionKey.mockReturnValue(sessionKey);
      mocks.loadSessionEntry.mockReturnValue({
        cfg: {},
        storePath: "/tmp/sessions.json",
        entry: { sessionId: "ops-main", updatedAt: Date.now() },
        canonicalKey: sessionKey,
      });
      mocks.updateSessionStore.mockImplementation(
        async (_path, updater) =>
          await updater({
            [sessionKey]: { sessionId: "ops-main", updatedAt: Date.now() },
          }),
      );
      mocks.agentCommand.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      });

      await invokeAgent({
        message: "hi",
        agentId: "ops",
        channel,
        to: "+15551234567",
        idempotencyKey: `non-deliverable-${channel}`,
      });

      expect(mocks.resolveAgentExplicitRecipientSession).not.toHaveBeenCalled();
      const call = await waitForAgentCommandCall<{ sessionKey?: string }>();
      expect(call.sessionKey).toBe(sessionKey);
    },
  );

  it("dedupes retries while explicit recipient session routing is pending", async () => {
    const sessionKey = "agent:ops:whatsapp:work:direct:+15551234567";
    const runId = "recipient-session-route-pending";
    let finishRoute = (_result: { sessionKey: string }) => {};
    const routePending = new Promise<{ sessionKey: string }>((resolve) => {
      finishRoute = resolve;
    });
    mocks.listAgentIds.mockReturnValue(["main", "ops"]);
    mocks.loadConfigReturn = { session: { dmScope: "per-account-channel-peer" } };
    mocks.resolveAgentExplicitRecipientSession.mockReturnValue(routePending);
    mocks.loadSessionEntry.mockReturnValue({
      cfg: mocks.loadConfigReturn,
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "recipient-session", updatedAt: Date.now() },
      canonicalKey: sessionKey,
    });
    mocks.updateSessionStore.mockImplementation(
      async (_path, updater) =>
        await updater({
          [sessionKey]: { sessionId: "recipient-session", updatedAt: Date.now() },
        }),
    );
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    const context = makeContext();
    const request = {
      message: "hi",
      agentId: "ops",
      channel: "whatsapp",
      accountId: "work",
      to: "+15551234567",
      idempotencyKey: runId,
    } satisfies AgentParams;
    const first = invokeAgent(request, { context, reqId: runId });
    await waitForAssertion(() => {
      expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
        runId,
        status: "accepted",
      });
    });
    expect(context.dedupe.get(`agent:${runId}`)?.payload).not.toHaveProperty("sessionKey");

    const duplicateRespond = vi.fn();
    await invokeAgent(request, {
      context,
      reqId: `${runId}-duplicate`,
      respond: duplicateRespond,
      flushDispatch: false,
    });
    expect(duplicateRespond).toHaveBeenCalledWith(true, { runId, status: "in_flight" }, undefined, {
      cached: true,
      runId,
    });
    expect(mocks.resolveAgentExplicitRecipientSession).toHaveBeenCalledTimes(1);

    finishRoute({ sessionKey });
    await first;
  });

  it("honors owner cancellation while explicit recipient session routing is pending", async () => {
    const sessionKey = "agent:ops:whatsapp:work:direct:+15551234567";
    const runId = "recipient-session-route-abort";
    let finishRoute = (_result: { sessionKey: string }) => {};
    const routePending = new Promise<{ sessionKey: string }>((resolve) => {
      finishRoute = resolve;
    });
    mocks.listAgentIds.mockReturnValue(["main", "ops"]);
    mocks.loadConfigReturn = { session: { dmScope: "per-account-channel-peer" } };
    mocks.resolveAgentExplicitRecipientSession.mockReturnValue(routePending);
    mocks.loadSessionEntry.mockReturnValue({
      cfg: mocks.loadConfigReturn,
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "recipient-session", updatedAt: Date.now() },
      canonicalKey: sessionKey,
    });
    mocks.updateSessionStore.mockImplementation(
      async (_path, updater) =>
        await updater({
          [sessionKey]: { sessionId: "recipient-session", updatedAt: Date.now() },
        }),
    );
    mocks.agentCommand.mockClear();
    const context = makeContext();
    const ownerClient = { connId: "owner-conn" } as AgentHandlerArgs["client"];
    const pending = invokeAgent(
      {
        message: "hi",
        agentId: "ops",
        channel: "whatsapp",
        to: "+15551234567",
        idempotencyKey: runId,
      },
      { context, client: ownerClient, reqId: runId, flushDispatch: false },
    );
    await waitForAssertion(() => {
      expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
        runId,
        agentId: "ops",
        status: "accepted",
      });
    });
    expect(context.dedupe.get(`agent:${runId}`)?.payload).not.toHaveProperty("sessionKey");

    const abortRespond = vi.fn();
    await expectDefined(
      chatHandlers["chat.abort"],
      'chatHandlers["chat.abort"] test invariant',
    )({
      params: { sessionKey: "agent:ops:main", runId },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-recipient-route", method: "chat.abort" },
      client: ownerClient,
      isWebchatConnect: () => false,
    });

    expectRecordFields(mockCallArg(abortRespond, 0, 1), {
      aborted: true,
      runIds: [runId],
    });
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      status: "timeout",
      stopReason: "rpc",
    });
    expect(context.dedupe.get(`agent:${runId}`)?.payload).not.toHaveProperty("sessionKey");

    finishRoute({ sessionKey });
    await pending;
    await flushScheduledDispatchStep();

    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("clears pending dedupe when explicit recipient session routing fails", async () => {
    const runId = "recipient-session-route-error";
    mocks.listAgentIds.mockReturnValue(["main", "ops"]);
    mocks.resolveAgentExplicitRecipientSession.mockResolvedValue({
      error: new Error("ambiguous recipient"),
    });
    mocks.agentCommand.mockClear();
    const context = makeContext();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "hi",
        agentId: "ops",
        channel: "whatsapp",
        to: "team",
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );

    expectRespondError(respond, {
      code: ErrorCodes.INVALID_REQUEST,
      message: "ambiguous recipient",
    });
    expect(context.dedupe.has(`agent:${runId}`)).toBe(false);
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("clears pending dedupe when the routed recipient session is unavailable", async () => {
    const sessionKey = "agent:ops:whatsapp:direct:+15551234567";
    const runId = "recipient-session-route-archived";
    mocks.listAgentIds.mockReturnValue(["main", "ops"]);
    mocks.resolveAgentExplicitRecipientSession.mockResolvedValue({ sessionKey });
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "recipient-session", updatedAt: 1, archivedAt: 1 },
      canonicalKey: sessionKey,
    });
    mocks.agentCommand.mockClear();
    const context = makeContext();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "hi",
        agentId: "ops",
        channel: "whatsapp",
        to: "+15551234567",
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );

    expectRespondError(respond, {
      message: `Session "${sessionKey}" is archived. Restore it before starting new work.`,
    });
    expect(context.dedupe.has(`agent:${runId}`)).toBe(false);
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("rejects agent RPC creation in an agent harness-owned namespace", async () => {
    const sessionKey = "agent:main:harness:codex:supervision:native-thread";
    const runId = "agent-harness-reserved";
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: undefined,
      canonicalKey: sessionKey,
    });
    mocks.agentCommand.mockClear();
    const context = makeContext();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "claim reserved session",
        agentId: "main",
        sessionKey,
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );

    expectRespondError(respond, {
      code: ErrorCodes.INVALID_REQUEST,
      message: "Session key namespace is reserved for agent harness-owned sessions.",
    });
    expect(context.dedupe.has(`agent:${runId}`)).toBe(false);
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it.each(["agent:main:harness:codex:supervision:native-thread", "agent:main:ordinary-locked"])(
    "rejects agent RPC session-id rotation for locked session %s",
    async (sessionKey) => {
      const runId = "agent-harness-session-id-rotation";
      mocks.loadSessionEntry.mockReturnValue({
        cfg: {},
        storePath: "/tmp/sessions.json",
        entry: {
          agentHarnessId: "codex",
          modelSelectionLocked: true,
          sessionId: "native-session",
        },
        canonicalKey: sessionKey,
      });
      mocks.agentCommand.mockClear();
      const updateSessionStoreCallsBefore = mocks.updateSessionStore.mock.calls.length;
      const context = makeContext();
      const respond = vi.fn();

      await invokeAgent(
        {
          message: "replace native transcript identity",
          agentId: "main",
          sessionKey,
          sessionId: "replacement-session",
          idempotencyKey: runId,
        },
        { context, respond, reqId: runId, flushDispatch: false },
      );

      expectRespondError(respond, {
        code: ErrorCodes.INVALID_REQUEST,
        message: "Agent harness-owned session identity is locked and cannot be replaced or shared.",
      });
      expect(context.dedupe.has(`agent:${runId}`)).toBe(false);
      expect(mocks.updateSessionStore).toHaveBeenCalledTimes(updateSessionStoreCallsBefore);
      expect(mocks.agentCommand).not.toHaveBeenCalled();
    },
  );

  it("rejects one-shot model runs against harness-owned sessions", async () => {
    const sessionKey = "agent:main:harness:codex:supervision:native-thread";
    const runId = "agent-harness-model-run";
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        sessionId: "native-session",
      },
      canonicalKey: sessionKey,
    });
    mocks.agentCommand.mockClear();
    const context = makeContext();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "run through another model",
        agentId: "main",
        sessionKey,
        modelRun: true,
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );

    expectRespondError(respond, {
      code: ErrorCodes.INVALID_REQUEST,
      message: "Agent harness-owned sessions cannot be used for one-shot model runs.",
    });
    expect(context.dedupe.has(`agent:${runId}`)).toBe(false);
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("allows raw model runs against grandfathered unlocked harness-prefixed sessions", async () => {
    const sessionKey = "agent:main:harness:notes";
    const runId = "legacy-harness-model-run";
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        agentHarnessId: "codex",
        modelSelectionLocked: false,
        sessionId: "legacy-session",
        updatedAt: Date.now(),
      },
      canonicalKey: sessionKey,
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "pong" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "Reply exactly: pong",
        agentId: "main",
        sessionKey,
        modelRun: true,
        promptMode: "none",
        idempotencyKey: runId,
      },
      {
        reqId: runId,
        client: operatorWriteCliClient(),
      },
    );

    expectRecordFields(await waitForAgentCommandCall(), {
      modelRun: true,
      promptMode: "none",
      sessionEffects: "internal",
      sessionId: "legacy-session",
      sessionKey,
    });
  });

  it("passes a canonical user-turn recorder to gateway agent runs", async () => {
    primeMainAgentRun();

    await runMainAgent("persist me", "idem-user-turn-recorder");

    const call = await waitForAgentCommandCall<
      AgentCommandCall & {
        userTurnTranscriptRecorder?: {
          persistApproved: () => Promise<unknown>;
        };
      }
    >();
    expect(call.userTurnTranscriptRecorder).toEqual(
      expect.objectContaining({
        persistApproved: expect.any(Function),
        persistFallback: expect.any(Function),
      }),
    );
  });

  it("dispatches with the session id reloaded during lifecycle admission", async () => {
    const sessionKey = "agent:main:main";
    const initialSessionId = "session-before-reset";
    const admittedSessionId = "session-after-reset";
    let currentSessionId = initialSessionId;
    mocks.loadSessionEntry.mockImplementation(() => ({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: { sessionId: currentSessionId, updatedAt: Date.now() },
      canonicalKey: sessionKey,
    }));
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const result = await updater({
        [sessionKey]: { sessionId: initialSessionId, updatedAt: Date.now() },
      });
      currentSessionId = admittedSessionId;
      return result;
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await runMainAgent("hi", "idem-reset-before-admission");

    const call = await waitForAgentCommandCall<{ sessionId?: string }>();
    expect(call.sessionId).toBe(admittedSessionId);
  });

  it("does not recreate a session deleted before lifecycle admission", async () => {
    const sessionKey = "agent:main:main";
    let deleted = false;
    mocks.loadSessionEntry.mockImplementation(() => ({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: deleted ? undefined : { sessionId: "session-before-delete", updatedAt: Date.now() },
      canonicalKey: sessionKey,
    }));
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const result = await updater({
        [sessionKey]: { sessionId: "session-before-delete", updatedAt: Date.now() },
      });
      deleted = true;
      return result;
    });
    mocks.agentCommand.mockClear();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "do not recreate the deleted session",
        agentId: "main",
        sessionKey,
        idempotencyKey: "idem-deleted-before-admission",
      },
      { respond, reqId: "idem-deleted-before-admission" },
    );

    expectRespondError(respond, {
      message: `Error: Session "${sessionKey}" was deleted while starting work. Retry.`,
    });
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("does not recreate a session deleted before its initial store touch", async () => {
    const sessionKey = "agent:main:main";
    mocks.loadSessionEntry.mockImplementation(() => ({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "session-before-delete", updatedAt: Date.now() },
      canonicalKey: sessionKey,
    }));
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => await updater({}));
    mocks.agentCommand.mockClear();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "do not recreate the deleted session",
        agentId: "main",
        sessionKey,
        idempotencyKey: "idem-deleted-before-touch",
      },
      { respond, reqId: "idem-deleted-before-touch" },
    );

    expectRespondError(respond, {
      message: `Error: Session "${sessionKey}" was deleted while starting work. Retry.`,
    });
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("does not recreate a newly touched session deleted before lifecycle admission", async () => {
    const sessionKey = "agent:main:slack:group:new-session";
    let storedEntry: Record<string, unknown> | undefined;
    mocks.loadSessionEntry.mockImplementation(() => ({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: storedEntry,
      canonicalKey: sessionKey,
    }));
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const result = await updater({});
      storedEntry = undefined;
      return result;
    });
    mocks.agentCommand.mockClear();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "do not revive the newly deleted session",
        agentId: "main",
        sessionKey,
        idempotencyKey: "idem-new-session-deleted-before-admission",
      },
      { respond, reqId: "idem-new-session-deleted-before-admission" },
    );

    expectRespondError(respond, {
      message: `Error: Session "${sessionKey}" was deleted while starting work. Retry.`,
    });
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("blocks the initial store touch and preserves an abort while admission waits", async () => {
    primeMainAgentRun();
    mocks.agentCommand.mockClear();
    mocks.updateSessionStore.mockClear();
    const sessionKey = "agent:main:main";
    const runId = "idem-abort-during-admission";
    let releaseMutation = () => {};
    let markMutationStarted = () => {};
    const mutationStarted = new Promise<void>((resolve) => {
      markMutationStarted = resolve;
    });
    const mutation = runExclusiveSessionLifecycleMutation({
      scope: "/tmp/sessions.json",
      identities: [sessionKey, "existing-session-id"],
      run: async () => {
        markMutationStarted();
        await new Promise<void>((release) => {
          releaseMutation = release;
        });
      },
    });
    await mutationStarted;
    const context = makeContext();
    const respond = vi.fn();
    const request = invokeAgent(
      {
        message: "do not run after abort",
        agentId: "main",
        sessionKey,
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId },
    );
    await waitForAssertion(() => {
      expect(context.dedupe.has(`agent:${runId}`)).toBe(true);
    });
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();

    const abortRespond = vi.fn();
    await expectDefined(
      chatHandlers["chat.abort"],
      'chatHandlers["chat.abort"] test invariant',
    )({
      params: { sessionKey, runId },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-req", method: "chat.abort" },
      client: null,
      isWebchatConnect: () => false,
    });
    releaseMutation();
    await mutation;
    await request;

    expect(mockCallArg(abortRespond)).toBe(true);
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(context.chatAbortControllers.has(runId)).toBe(false);
    expect(
      respond.mock.calls.some(
        ([ok, payload]) => ok === true && (payload as { status?: string })?.status === "timeout",
      ),
    ).toBe(true);
  });

  it("does not revive an expired reservation after lifecycle admission waits", async () => {
    primeMainAgentRun();
    mocks.agentCommand.mockClear();
    const sessionKey = "agent:main:main";
    const runId = "idem-expired-during-admission";
    let releaseMutation = () => {};
    let markMutationStarted = () => {};
    const mutationStarted = new Promise<void>((resolve) => {
      markMutationStarted = resolve;
    });
    const mutation = runExclusiveSessionLifecycleMutation({
      scope: "/tmp/sessions.json",
      identities: [sessionKey, "existing-session-id"],
      run: async () => {
        markMutationStarted();
        await new Promise<void>((release) => {
          releaseMutation = release;
        });
      },
    });
    await mutationStarted;
    const context = makeContext();
    const respond = vi.fn();
    const request = invokeAgent(
      {
        message: "do not run after queue expiry",
        agentId: "main",
        sessionKey,
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId },
    );
    const dedupeKey = `agent:${runId}`;
    await waitForAssertion(() => {
      expect(context.dedupe.has(dedupeKey)).toBe(true);
    });
    const reserved = context.dedupe.get(dedupeKey);
    context.dedupe.set(dedupeKey, {
      ts: reserved?.ts ?? Date.now(),
      ok: true,
      payload: {
        ...(reserved?.payload as Record<string, unknown>),
        expiresAtMs: Date.now() - 1,
      },
    });

    releaseMutation();
    await mutation;
    await request;

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(context.chatAbortControllers.has(runId)).toBe(false);
    expect(
      respond.mock.calls.some(
        ([ok, payload]) =>
          ok === true &&
          (payload as { status?: string; stopReason?: string })?.status === "timeout" &&
          (payload as { stopReason?: string }).stopReason === "timeout",
      ),
    ).toBe(true);
  });

  it("preserves a newer terminal reservation result after lifecycle admission waits", async () => {
    primeMainAgentRun();
    mocks.agentCommand.mockClear();
    const sessionKey = "agent:main:main";
    const runId = "idem-terminal-during-admission";
    let releaseMutation = () => {};
    let markMutationStarted = () => {};
    const mutationStarted = new Promise<void>((resolve) => {
      markMutationStarted = resolve;
    });
    const mutation = runExclusiveSessionLifecycleMutation({
      scope: "/tmp/sessions.json",
      identities: [sessionKey, "existing-session-id"],
      run: async () => {
        markMutationStarted();
        await new Promise<void>((release) => {
          releaseMutation = release;
        });
      },
    });
    await mutationStarted;
    const context = makeContext();
    const respond = vi.fn();
    const request = invokeAgent(
      {
        message: "do not overwrite the replacement result",
        agentId: "main",
        sessionKey,
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId },
    );
    const dedupeKey = `agent:${runId}`;
    await waitForAssertion(() => {
      expect(context.dedupe.has(dedupeKey)).toBe(true);
    });
    const replacement = {
      ts: Date.now(),
      ok: true,
      payload: { runId, status: "ok", summary: "replacement completed" },
    };
    context.dedupe.set(dedupeKey, replacement);

    releaseMutation();
    await mutation;
    await request;

    expect(context.dedupe.get(dedupeKey)).toBe(replacement);
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(respond).toHaveBeenLastCalledWith(
      true,
      replacement.payload,
      undefined,
      expect.objectContaining({ cached: true, runId }),
    );
  });

  it("runs gateway agent work inside its lifecycle admission context", async () => {
    primeMainAgentRun();
    const sessionKey = "agent:main:main";
    const sessionId = "existing-session-id";
    mocks.agentCommand.mockImplementationOnce(async () => {
      await expect(
        interruptSessionWorkAdmissions({
          scope: "/tmp/sessions.json",
          identities: [sessionKey, sessionId],
          timeoutMs: 5,
        }),
      ).resolves.toBe(true);
      return {
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      };
    });

    await invokeAgent({
      message: "run in-band lifecycle work",
      agentId: "main",
      sessionKey,
      idempotencyKey: "idem-agent-admission-context",
    });

    expect(mocks.agentCommand).toHaveBeenCalledOnce();
  });

  it("classifies gateway lifecycle interruption as restart", async () => {
    primeMainAgentRun();
    const sessionKey = "agent:main:main";
    const sessionId = "existing-session-id";
    let observedAbortReason: unknown;
    mocks.agentCommand.mockImplementationOnce(
      async (opts: { abortSignal?: AbortSignal }) =>
        await new Promise((_resolve, reject) => {
          const finish = () => {
            observedAbortReason = opts.abortSignal?.reason;
            reject(
              observedAbortReason instanceof Error
                ? observedAbortReason
                : new Error("agent lifecycle interrupted"),
            );
          };
          if (opts.abortSignal?.aborted) {
            finish();
            return;
          }
          opts.abortSignal?.addEventListener("abort", finish, { once: true });
        }),
    );
    const context = makeContext();
    const runId = "idem-agent-lifecycle-restart";
    await invokeAgent(
      {
        message: "interrupt as restart",
        agentId: "main",
        sessionKey,
        idempotencyKey: runId,
      },
      { context, reqId: runId },
    );
    await waitForAgentCommandCall();

    await interruptSessionWorkAdmissions({
      scope: "/tmp/sessions.json",
      identities: [sessionKey, sessionId],
    });
    await flushScheduledDispatchStep();

    expect(isAgentRunRestartAbortReason(observedAbortReason)).toBe(true);
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      status: "timeout",
      stopReason: "restart",
    });
  });

  it("does not mutate a session archived before the initial store update", async () => {
    primeMainAgentRun();
    mocks.agentCommand.mockClear();
    const sessionKey = "agent:main:main";
    const archivedEntry = {
      sessionId: "existing-session-id",
      updatedAt: Date.now(),
      archivedAt: Date.now(),
    };
    const store = { [sessionKey]: structuredClone(archivedEntry) };
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => await updater(store));
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "do not touch the archive",
        agentId: "main",
        sessionKey,
        idempotencyKey: "idem-archive-before-store-update",
      },
      { respond, reqId: "idem-archive-before-store-update" },
    );

    expectRespondError(respond, {
      message: `Session "${sessionKey}" is archived. Restore it before starting new work.`,
    });
    expect(store).toEqual({ [sessionKey]: archivedEntry });
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("uses the freshest alias when checking archive state before migration", async () => {
    const cfg = {
      session: { mainKey: "work" },
      agents: { list: [{ id: "main", default: true }] },
    };
    mocks.loadConfigReturn = cfg;
    mocks.loadSessionEntry.mockReturnValue({
      cfg,
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "restored-session", updatedAt: 2 },
      canonicalKey: "agent:main:work",
      // Post-flip the accessor target carries the alias set prepared at request
      // start; freshest-entry resolution happens inside the patch transaction.
      storeKeys: ["agent:main:work", "agent:main:main"],
    });
    const store = {
      "agent:main:work": {
        sessionId: "archived-session",
        updatedAt: 1,
        archivedAt: 1,
      },
      "agent:main:main": {
        sessionId: "restored-session",
        updatedAt: 2,
      },
    };
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => await updater(store));
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent({
      message: "continue restored session",
      agentId: "main",
      sessionKey: "agent:main:main",
      idempotencyKey: "idem-restored-alias",
    });

    expect(mocks.agentCommand).toHaveBeenCalled();
    expect(store["agent:main:work"]?.archivedAt).toBeUndefined();
    expect(store["agent:main:main"]).toBeUndefined();
  });

  it("does not persist a gateway user-turn recorder after the session key is rebound", async () => {
    primeMainAgentRun({ sessionId: "accepted-session-id" });

    await runMainAgent("stale after reset", "idem-user-turn-rebound");

    const call = await waitForAgentCommandCall<
      AgentCommandCall & {
        userTurnTranscriptRecorder?: {
          persistApproved: () => Promise<unknown>;
        };
      }
    >();
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "new-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: "agent:main:main",
      store: {
        "agent:main:main": {
          sessionId: "new-session-id",
          updatedAt: Date.now(),
        },
      },
    });

    await expect(call.userTurnTranscriptRecorder?.persistApproved()).resolves.toBeUndefined();
  });

  it("does not pass a text-only user-turn recorder for image agent runs", async () => {
    mockMainSessionEntry({
      sessionId: "existing-session-id",
      model: "vision-model",
      modelProvider: "test",
      modelOverride: "vision-model",
      modelOverrideSource: "user",
      providerOverride: "test",
    });
    mocks.updateSessionStore.mockResolvedValue(undefined);
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });
    const context = {
      ...makeContext(),
      loadGatewayModelCatalog: vi.fn(async () => [
        {
          id: "vision-model",
          name: "vision-model",
          provider: "test",
          input: ["image"],
        },
      ]),
    } as unknown as GatewayRequestContext;

    await invokeAgent(
      {
        message: "describe this image",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: "idem-image-user-turn-recorder",
        attachments: [
          {
            type: "file",
            mimeType: "image/png",
            fileName: "test.png",
            content: Buffer.from("fake-png-data").toString("base64"),
          },
        ],
      },
      { context, reqId: "idem-image-user-turn-recorder" },
    );

    const call = await waitForAgentCommandCall();
    expect(call.images).toEqual([
      expect.objectContaining({
        type: "image",
        mimeType: "image/png",
      }),
    ]);
    expect(call.userTurnTranscriptRecorder).toBeUndefined();
  });

  it("does not pass a text-only user-turn recorder for offloaded image agent runs", async () => {
    await withTempDir({ prefix: "openclaw-gateway-agent-offloaded-image-" }, async (root) => {
      useTestStateDir(root);
      mockMainSessionEntry({
        sessionId: "existing-session-id",
        model: "vision-model",
        modelProvider: "test",
        modelOverride: "vision-model",
        modelOverrideSource: "user",
        providerOverride: "test",
      });
      mocks.updateSessionStore.mockResolvedValue(undefined);
      mocks.agentCommand.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      });
      const context = {
        ...makeContext(),
        loadGatewayModelCatalog: vi.fn(async () => [
          {
            id: "vision-model",
            name: "vision-model",
            provider: "test",
            input: ["image"],
          },
        ]),
      } as unknown as GatewayRequestContext;

      await invokeAgent(
        {
          message: "describe this large image",
          agentId: "main",
          sessionKey: "agent:main:main",
          idempotencyKey: "idem-offloaded-image-user-turn-recorder",
          attachments: [
            {
              type: "file",
              mimeType: "image/png",
              fileName: "large.png",
              content: Buffer.alloc(2_000_001, 1).toString("base64"),
            },
          ],
        },
        { context, reqId: "idem-offloaded-image-user-turn-recorder" },
      );

      const call = await waitForAgentCommandCall();
      expect(call.images).toEqual([]);
      expect(call.imageOrder).toEqual(["offloaded"]);
      expect(call.message).toContain("[media attached: media://inbound/");
      expect(call.userTurnTranscriptRecorder).toBeUndefined();
    });
  });

  it("preserves ACP metadata from the current stored session entry", async () => {
    const existingAcpMeta = {
      backend: "acpx",
      agent: "codex",
      runtimeSessionName: "runtime-1",
      mode: "persistent",
      state: "idle",
      lastActivityAt: Date.now(),
    };

    mockMainSessionEntry({
      acp: existingAcpMeta,
    });

    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:main": buildExistingMainStoreEntry({ acp: existingAcpMeta }),
      };
      const result = await updater(store);
      capturedEntry = store["agent:main:main"] as Record<string, unknown>;
      return result;
    });

    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await runMainAgent("test", "test-idem-acp-meta");

    expect(mocks.updateSessionStore).toHaveBeenCalled();
    expect(requireValue(capturedEntry, "updated session entry missing").acp).toEqual(
      existingAcpMeta,
    );
  });

  it("drops a stale transcript path when a stale session rotates ids", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    dateOnlyFakeClockActive = true;
    vi.setSystemTime(new Date("2026-05-07T12:00:00.000Z"));
    const staleEntry = {
      sessionId: "old-session-id",
      sessionFile: "/tmp/openclaw/agents/main/sessions/old-session-id.jsonl",
      updatedAt: 0,
      sessionStartedAt: 0,
    };
    mockMainSessionEntry(staleEntry);

    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:main": { ...staleEntry },
      };
      const result = await updater(store);
      capturedEntry = result as Record<string, unknown>;
      return result;
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await runMainAgent("test", "test-idem-stale-transcript");

    expect(capturedEntry?.sessionId).not.toBe("old-session-id");
    expectSqliteSessionFileMarkerForEntry(capturedEntry);
  });

  it("rotates a failed session instead of resuming when its transcript is missing", async () => {
    const now = Date.parse("2026-05-18T09:45:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    dateOnlyFakeClockActive = true;
    vi.setSystemTime(now);
    const missingTranscriptEntry = {
      sessionId: "failed-missing-session-id",
      sessionFile: "/tmp/openclaw/missing/failed-missing-session-id.jsonl",
      status: "failed",
      updatedAt: now,
      sessionStartedAt: now,
      lastInteractionAt: now,
      startedAt: now - 2_000,
      endedAt: now - 1_000,
      runtimeMs: 1_000,
      abortedLastRun: true,
    };
    mockMainSessionEntry(missingTranscriptEntry);

    const capturedEntry = await runMainAgentAndCaptureEntry("test-idem-failed-missing-transcript");

    const call = await waitForAgentCommandCall<{ sessionId?: string }>();
    expect(call.sessionId).not.toBe("failed-missing-session-id");
    expect(capturedEntry?.sessionId).not.toBe("failed-missing-session-id");
    expect(capturedEntry?.status).toBeUndefined();
    expect(capturedEntry?.startedAt).toBeUndefined();
    expect(capturedEntry?.endedAt).toBeUndefined();
    expect(capturedEntry?.runtimeMs).toBeUndefined();
    expect(capturedEntry?.abortedLastRun).toBeUndefined();
    expectSqliteSessionFileMarkerForEntry(capturedEntry);
  });

  it.each([
    { name: "status-done row", status: "done" as const, expectReuse: true },
    { name: "status-killed row", status: "killed" as const, expectReuse: false },
    { name: "endedAt-only row", status: undefined, expectReuse: false },
  ])(
    "handles a terminal main session from a $name when its transcript is newer",
    async (scenario) => {
      const now = Date.parse("2026-05-18T09:47:00.000Z");
      vi.useFakeTimers({ toFake: ["Date"] });
      dateOnlyFakeClockActive = true;
      vi.setSystemTime(now);
      mocks.readTranscriptStatsSync.mockReturnValue({
        eventCount: 1,
        lastMutationAtMs: now - 1_000,
        lastObservedMutationAtMs: now - 10_000,
        maxSeq: 0,
        sizeBytes: 64,
      });

      await withTempDir({ prefix: "openclaw-gateway-terminal-main-newer-" }, async (root) => {
        const sessionsDir = `${root}/sessions`;
        const sessionFile = "terminal-main-session.jsonl";
        mocks.loadSessionEntry.mockReturnValue({
          cfg: {},
          storePath: `${sessionsDir}/sessions.json`,
          entry: {
            sessionId: "terminal-main-session",
            sessionFile,
            ...(scenario.status ? { status: scenario.status } : {}),
            updatedAt: now - 10_000,
            sessionStartedAt: now - 60_000,
            lastInteractionAt: now - 10_000,
            startedAt: now - 20_000,
            endedAt: now - 15_000,
            runtimeMs: 5_000,
            cliSessionBindings: {
              "claude-cli": { sessionId: "old-claude-cli-session" },
              "codex-cli": { sessionId: "old-codex-cli-session" },
            },
            cliSessionIds: {
              "claude-cli": "old-claude-cli-session",
              "codex-cli": "old-codex-cli-session",
            },
            claudeCliSessionId: "old-claude-cli-session",
          },
          canonicalKey: "agent:main:main",
        });

        const capturedEntry = await runMainAgentAndCaptureEntry(
          "test-idem-terminal-main-newer-transcript",
        );

        const call = await waitForAgentCommandCall<{ sessionId?: string }>();
        if (scenario.expectReuse) {
          expect(call.sessionId).toBe("terminal-main-session");
          expect(capturedEntry?.sessionId).toBe("terminal-main-session");
          return;
        }
        expect(call.sessionId).not.toBe("terminal-main-session");
        expect(capturedEntry?.sessionId).not.toBe("terminal-main-session");
        expect(capturedEntry?.status).toBeUndefined();
        expect(capturedEntry?.startedAt).toBeUndefined();
        expect(capturedEntry?.endedAt).toBeUndefined();
        expect(capturedEntry?.runtimeMs).toBeUndefined();
        expectSqliteSessionFileMarkerForEntry(capturedEntry);
        expect(capturedEntry?.cliSessionBindings).toBeUndefined();
        expect(capturedEntry?.cliSessionIds).toBeUndefined();
        expect(capturedEntry?.claudeCliSessionId).toBeUndefined();
      });
    },
  );

  it("reuses terminal main sessions when the fresh store row has the transcript marker", async () => {
    const now = Date.parse("2026-05-18T09:47:30.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    dateOnlyFakeClockActive = true;
    vi.setSystemTime(now);

    await withTempDir({ prefix: "openclaw-gateway-terminal-main-fresh-marker-" }, async (root) => {
      const sessionsDir = `${root}/sessions`;
      await fs.mkdir(sessionsDir, { recursive: true });
      const sessionFile = "terminal-main-session.jsonl";
      const transcriptPath = `${sessionsDir}/${sessionFile}`;
      await fs.writeFile(
        transcriptPath,
        `${JSON.stringify({ type: "session", id: "terminal-main-session" })}\n`,
        "utf8",
      );
      await fs.utimes(transcriptPath, new Date(now - 1_000), new Date(now - 1_000));
      const staleEntry = {
        sessionId: "terminal-main-session",
        sessionFile,
        status: "done",
        updatedAt: now - 10_000,
        cliSessionBindings: {
          "claude-cli": { sessionId: "existing-claude-cli-session" },
        },
        cliSessionIds: {
          "claude-cli": "existing-claude-cli-session",
        },
        claudeCliSessionId: "existing-claude-cli-session",
      };
      mocks.loadSessionEntry.mockReturnValue({
        cfg: {},
        storePath: `${sessionsDir}/sessions.json`,
        entry: staleEntry,
        canonicalKey: "agent:main:main",
      });
      let capturedEntry: Record<string, unknown> | undefined;
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        const store = {
          "agent:main:main": {
            ...staleEntry,
            updatedAt: now,
          },
        };
        const result = await updater(store);
        capturedEntry = result as Record<string, unknown>;
        return result;
      });
      mocks.agentCommand.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      });

      await runMainAgent("hi", "test-idem-terminal-main-fresh-marker");

      const call = await waitForAgentCommandCall<{ sessionId?: string }>();
      expect(call.sessionId).toBe("terminal-main-session");
      expect(capturedEntry?.sessionId).toBe("terminal-main-session");
      expectSqliteSessionFileMarkerForEntry(capturedEntry);
      expect(capturedEntry?.cliSessionIds).toEqual({
        "claude-cli": "existing-claude-cli-session",
      });
      expect(capturedEntry?.claudeCliSessionId).toBe("existing-claude-cli-session");
    });
  });

  it("honors explicit gateway session-id resumes for terminal main rows", async () => {
    const now = Date.parse("2026-05-18T09:48:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    dateOnlyFakeClockActive = true;
    vi.setSystemTime(now);

    await withTempDir(
      { prefix: "openclaw-gateway-terminal-main-explicit-resume-" },
      async (root) => {
        const sessionsDir = `${root}/sessions`;
        await fs.mkdir(sessionsDir, { recursive: true });
        const sessionFile = "terminal-main-session.jsonl";
        const transcriptPath = `${sessionsDir}/${sessionFile}`;
        await fs.writeFile(
          transcriptPath,
          `${JSON.stringify({ type: "session", id: "terminal-main-session" })}\n`,
          "utf8",
        );
        await fs.utimes(transcriptPath, new Date(now - 1_000), new Date(now - 1_000));
        const existingEntry = {
          sessionId: "terminal-main-session",
          sessionFile,
          status: "done",
          updatedAt: now - 10_000,
          sessionStartedAt: now - 60_000,
          lastInteractionAt: now - 10_000,
          startedAt: now - 20_000,
          endedAt: now - 15_000,
          runtimeMs: 5_000,
        };
        mocks.loadSessionEntry.mockReturnValue({
          cfg: {},
          storePath: `${sessionsDir}/sessions.json`,
          entry: existingEntry,
          canonicalKey: "agent:main:main",
        });
        let capturedEntry: Record<string, unknown> | undefined;
        mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
          const store: Record<string, unknown> = {
            "agent:main:main": { ...existingEntry },
          };
          const result = await updater(store);
          capturedEntry = result as Record<string, unknown>;
          return result;
        });
        mocks.agentCommand.mockResolvedValue({
          payloads: [{ text: "ok" }],
          meta: { durationMs: 100 },
        });

        await invokeAgent({
          message: "resume terminal main",
          agentId: "main",
          sessionKey: "agent:main:main",
          sessionId: "terminal-main-session",
          idempotencyKey: "test-idem-terminal-main-explicit-resume",
        } as AgentParams);

        const call = await waitForAgentCommandCall<{ sessionId?: string }>();
        expect(call.sessionId).toBe("terminal-main-session");
        expect(capturedEntry?.sessionId).toBe("terminal-main-session");
        expectSqliteSessionFileMarkerForEntry(capturedEntry);
        expect(capturedEntry?.status).toBe("done");
        expect(capturedEntry?.startedAt).toBe(now - 20_000);
        expect(capturedEntry?.endedAt).toBe(now - 15_000);
        expect(capturedEntry?.runtimeMs).toBe(5_000);
      },
    );
  });

  it.each(["heartbeat", "cron"] as const)(
    "preserves terminal main session reuse for %s gateway runs",
    async (runKind) => {
      const now = Date.parse("2026-05-18T09:49:00.000Z");
      vi.useFakeTimers({ toFake: ["Date"] });
      dateOnlyFakeClockActive = true;
      vi.setSystemTime(now);

      await withTempDir(
        { prefix: `openclaw-gateway-terminal-main-${runKind}-reuse-` },
        async (root) => {
          const sessionsDir = `${root}/sessions`;
          await fs.mkdir(sessionsDir, { recursive: true });
          const sessionFile = `terminal-main-${runKind}.jsonl`;
          const transcriptPath = `${sessionsDir}/${sessionFile}`;
          await fs.writeFile(
            transcriptPath,
            `${JSON.stringify({ type: "session", id: "terminal-main-session" })}\n`,
            "utf8",
          );
          await fs.utimes(transcriptPath, new Date(now - 1_000), new Date(now - 1_000));
          const existingEntry = {
            sessionId: "terminal-main-session",
            sessionFile,
            status: "done",
            updatedAt: now - 10_000,
            sessionStartedAt: now - 60_000,
            lastInteractionAt: now - 10_000,
            startedAt: now - 20_000,
            endedAt: now - 15_000,
            runtimeMs: 5_000,
          };
          mocks.loadSessionEntry.mockReturnValue({
            cfg: {},
            storePath: `${sessionsDir}/sessions.json`,
            entry: existingEntry,
            canonicalKey: "agent:main:main",
          });

          let capturedEntry: Record<string, unknown> | undefined;
          mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
            const store: Record<string, unknown> = {
              "agent:main:main": { ...existingEntry },
            };
            const result = await updater(store);
            capturedEntry = result as Record<string, unknown>;
            return result;
          });
          mocks.agentCommand.mockResolvedValue({
            payloads: [{ text: "ok" }],
            meta: { durationMs: 100 },
          });

          await invokeAgent({
            message: `${runKind} probe`,
            agentId: "main",
            sessionKey: "agent:main:main",
            bootstrapContextRunKind: runKind,
            idempotencyKey: `test-idem-terminal-main-${runKind}-reuse`,
          } as AgentParams);

          const call = await waitForAgentCommandCall<{ sessionId?: string }>();
          expect(call.sessionId).toBe("terminal-main-session");
          expect(capturedEntry?.sessionId).toBe("terminal-main-session");
          expectSqliteSessionFileMarkerForEntry(capturedEntry);
        },
      );
    },
  );

  it("rotates a failed session when its default transcript is missing", async () => {
    const now = Date.parse("2026-05-18T09:48:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    dateOnlyFakeClockActive = true;
    vi.setSystemTime(now);
    const missingDefaultTranscriptEntry = {
      sessionId: "failed-missing-default-session-id",
      status: "failed",
      updatedAt: now,
      sessionStartedAt: now,
      lastInteractionAt: now,
    };
    mockMainSessionEntry(missingDefaultTranscriptEntry);

    const capturedEntry = await runMainAgentAndCaptureEntry(
      "test-idem-failed-missing-default-transcript",
    );

    const call = await waitForAgentCommandCall<{ sessionId?: string }>();
    expect(call.sessionId).not.toBe("failed-missing-default-session-id");
    expect(capturedEntry?.sessionId).not.toBe("failed-missing-default-session-id");
    expect(capturedEntry?.status).toBeUndefined();
    expectSqliteSessionFileMarkerForEntry(capturedEntry);
  });

  it("recovers a failed session when its default transcript exists", async () => {
    const now = Date.parse("2026-05-18T09:49:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    dateOnlyFakeClockActive = true;
    vi.setSystemTime(now);

    await withTempDir({ prefix: "openclaw-gateway-failed-default-session-file-" }, async (root) => {
      const sessionsDir = `${root}/sessions`;
      await fs.mkdir(sessionsDir, { recursive: true });
      await fs.writeFile(`${sessionsDir}/failed-present-default-session-id.jsonl`, "", "utf8");
      const failedEntryWithDefaultTranscript = {
        sessionId: "failed-present-default-session-id",
        status: "failed",
        startedAt: now - 1_000,
        endedAt: now,
        runtimeMs: 1_000,
        abortedLastRun: true,
        updatedAt: now,
        sessionStartedAt: now,
        lastInteractionAt: now,
      };
      mocks.loadSessionEntry.mockReturnValue({
        cfg: {},
        storePath: `${sessionsDir}/sessions.json`,
        entry: failedEntryWithDefaultTranscript,
        canonicalKey: "agent:main:main",
      });

      const capturedEntry = await runMainAgentAndCaptureEntry(
        "test-idem-failed-present-default-transcript",
      );

      const call = await waitForAgentCommandCall<{ sessionId?: string }>();
      expect(call.sessionId).toBe("failed-present-default-session-id");
      expect(capturedEntry?.sessionId).toBe("failed-present-default-session-id");
      expect(capturedEntry?.status).toBeUndefined();
      expect(capturedEntry?.startedAt).toBeUndefined();
      expect(capturedEntry?.endedAt).toBeUndefined();
      expect(capturedEntry?.runtimeMs).toBeUndefined();
      expect(capturedEntry?.abortedLastRun).toBeUndefined();
      expectSqliteSessionFileMarkerForEntry(capturedEntry);
    });
  });

  it.each([
    {
      name: "default transcript",
      sessionKey: "agent:main:telegram:group:stale-failed",
      sessionId: "stale-failed-session-id",
      configureTranscript: async (params: { sessionId: string; sessionsDir: string }) => {
        await fs.writeFile(`${params.sessionsDir}/${params.sessionId}.jsonl`, "", "utf8");
        return {};
      },
      expectsSqliteStats: false,
    },
    {
      name: "SQLite transcript marker",
      sessionKey: "agent:main:telegram:group:stale-failed-sqlite",
      sessionId: "stale-failed-sqlite-session-id",
      configureTranscript: async (params: { sessionId: string; storePath: string }) => {
        mocks.readTranscriptStatsSync.mockReturnValue({
          eventCount: 1,
          maxSeq: 1,
          sizeBytes: 32,
        });
        return { sessionFile: `sqlite:main:${params.sessionId}:${params.storePath}` };
      },
      expectsSqliteStats: true,
    },
  ])("recovers a stale failed session when its $name exists", async (scenario) => {
    const now = Date.parse("2026-05-18T09:49:30.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    dateOnlyFakeClockActive = true;
    vi.setSystemTime(now);

    await withTempDir({ prefix: "openclaw-gateway-stale-failed-session-" }, async (root) => {
      const sessionsDir = `${root}/sessions`;
      const storePath = `${sessionsDir}/sessions.json`;
      await fs.mkdir(sessionsDir, { recursive: true });
      const transcriptFields = await scenario.configureTranscript({
        sessionId: scenario.sessionId,
        sessionsDir,
        storePath,
      });
      const failedEntryWithStaleActivity = {
        sessionId: scenario.sessionId,
        ...transcriptFields,
        status: "failed",
        startedAt: now - 11 * 60_000,
        endedAt: now - 10 * 60_000,
        runtimeMs: 60_000,
        abortedLastRun: true,
        updatedAt: now - 10 * 60_000,
        sessionStartedAt: now - 20 * 60_000,
        lastInteractionAt: now - 10 * 60_000,
      };
      mocks.loadSessionEntry.mockReturnValue({
        cfg: { session: { idleMinutes: 5 } },
        storePath,
        entry: failedEntryWithStaleActivity,
        canonicalKey: scenario.sessionKey,
      });
      let capturedEntry: Record<string, unknown> | undefined;
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        const store: Record<string, unknown> = {
          [scenario.sessionKey]: { ...failedEntryWithStaleActivity },
        };
        const result = await updater(store);
        capturedEntry = result as Record<string, unknown>;
        return result;
      });
      mocks.agentCommand.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      });

      await invokeAgent({
        message: "recover stale failed",
        agentId: "main",
        sessionKey: scenario.sessionKey,
        idempotencyKey: `test-idem-${scenario.sessionId}`,
      } as AgentParams);

      const call = await waitForAgentCommandCall<{ sessionId?: string }>();
      expect(call.sessionId).toBe(scenario.sessionId);
      if (scenario.expectsSqliteStats) {
        expect(mocks.readTranscriptStatsSync).toHaveBeenCalledWith({
          agentId: "main",
          sessionId: scenario.sessionId,
          sessionKey: scenario.sessionKey,
          storePath,
          sessionEntry: failedEntryWithStaleActivity,
        });
      } else {
        expect(mocks.readTranscriptStatsSync).not.toHaveBeenCalled();
      }
      expect(capturedEntry?.sessionId).toBe(scenario.sessionId);
      expect(capturedEntry?.status).toBeUndefined();
      expect(capturedEntry?.startedAt).toBeUndefined();
      expect(capturedEntry?.endedAt).toBeUndefined();
      expect(capturedEntry?.runtimeMs).toBeUndefined();
      expect(capturedEntry?.abortedLastRun).toBeUndefined();
      expectSqliteSessionFileMarkerForEntry(capturedEntry);
    });
  });

  it("recovers a failed session when its relative transcript resolves and exists", async () => {
    const now = Date.parse("2026-05-18T09:50:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    dateOnlyFakeClockActive = true;
    vi.setSystemTime(now);

    await withTempDir({ prefix: "openclaw-gateway-failed-session-file-" }, async (root) => {
      const sessionsDir = `${root}/sessions`;
      await fs.mkdir(sessionsDir, { recursive: true });
      await fs.writeFile(`${sessionsDir}/relative-present.jsonl`, "", "utf8");
      const failedEntryWithResolvedTranscript = {
        sessionId: "failed-present-session-id",
        sessionFile: "relative-present.jsonl",
        status: "failed",
        startedAt: now - 1_000,
        endedAt: now,
        runtimeMs: 1_000,
        abortedLastRun: true,
        updatedAt: now,
        sessionStartedAt: now,
        lastInteractionAt: now,
      };
      mocks.loadSessionEntry.mockReturnValue({
        cfg: {},
        storePath: `${sessionsDir}/sessions.json`,
        entry: failedEntryWithResolvedTranscript,
        canonicalKey: "agent:main:main",
      });

      const capturedEntry = await runMainAgentAndCaptureEntry(
        "test-idem-failed-present-transcript",
      );

      const call = await waitForAgentCommandCall<{ sessionId?: string }>();
      expect(call.sessionId).toBe("failed-present-session-id");
      expect(capturedEntry?.sessionId).toBe("failed-present-session-id");
      expect(capturedEntry?.status).toBeUndefined();
      expect(capturedEntry?.startedAt).toBeUndefined();
      expect(capturedEntry?.endedAt).toBeUndefined();
      expect(capturedEntry?.runtimeMs).toBeUndefined();
      expect(capturedEntry?.abortedLastRun).toBeUndefined();
      expectSqliteSessionFileMarkerForEntry(capturedEntry);
    });
  });

  it("keeps stored group metadata when a trusted group session receives caller-supplied selectors", async () => {
    const sessionKey = "agent:main:slack:group:C123";
    const existingEntry = buildExistingMainStoreEntry({
      channel: "slack",
      groupId: "C123",
      groupChannel: "#trusted",
      space: "TTRUSTED",
    });
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: existingEntry,
      canonicalKey: sessionKey,
    });

    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        [sessionKey]: { ...existingEntry },
      };
      const result = await updater(store);
      capturedEntry = result as Record<string, unknown>;
      return result;
    });

    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "trusted group turn",
        agentId: "main",
        sessionKey,
        channel: "slack",
        groupId: "C123",
        groupChannel: "#forged-admin",
        groupSpace: "TFORGED",
        idempotencyKey: "trusted-group-forged-selectors",
      },
      { reqId: "trusted-group-forged-selectors" },
    );

    expect(mocks.updateSessionStore).toHaveBeenCalled();
    expect(capturedEntry?.groupId).toBe("C123");
    expect(capturedEntry?.groupChannel).toBe("#trusted");
    expect(capturedEntry?.space).toBe("TTRUSTED");
    const callArgs = await waitForAgentCommandCall<{
      groupChannel?: string;
      groupSpace?: string;
      runContext?: { groupChannel?: string; groupSpace?: string };
    }>();
    expect(callArgs.groupChannel).toBe("#trusted");
    expect(callArgs.groupSpace).toBe("TTRUSTED");
    expect(callArgs.runContext?.groupChannel).toBe("#trusted");
    expect(callArgs.runContext?.groupSpace).toBe("TTRUSTED");
  });

  it("persists first-turn group selectors for a trusted new group session", async () => {
    const sessionKey = "agent:main:slack:group:C123";
    let capturedEntry: Record<string, unknown> | undefined;
    mocks.loadSessionEntry.mockImplementation(() => ({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: capturedEntry,
      canonicalKey: sessionKey,
    }));

    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {};
      const result = await updater(store);
      capturedEntry = result as Record<string, unknown>;
      return result;
    });

    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "first trusted group turn",
        agentId: "main",
        sessionKey,
        channel: "slack",
        groupId: "C123",
        groupChannel: "#general",
        groupSpace: "TWORKSPACE",
        idempotencyKey: "trusted-group-first-turn-selectors",
      },
      { reqId: "trusted-group-first-turn-selectors" },
    );

    expect(mocks.updateSessionStore).toHaveBeenCalled();
    expect(capturedEntry?.groupId).toBe("C123");
    expect(capturedEntry?.groupChannel).toBe("#general");
    expect(capturedEntry?.space).toBe("TWORKSPACE");
    const callArgs = await waitForAgentCommandCall<{
      groupChannel?: string;
      groupSpace?: string;
      runContext?: { groupChannel?: string; groupSpace?: string };
    }>();
    expect(callArgs.groupChannel).toBe("#general");
    expect(callArgs.groupSpace).toBe("TWORKSPACE");
    expect(callArgs.runContext?.groupChannel).toBe("#general");
    expect(callArgs.runContext?.groupSpace).toBe("TWORKSPACE");
  });

  it("tags newly-created plugin runtime sessions with the plugin owner", async () => {
    const sessionKey = "agent:main:dreaming-narrative-light-workspace-1";
    let capturedEntry: Record<string, unknown> | undefined;
    mocks.loadSessionEntry.mockImplementation(() => ({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: capturedEntry,
      canonicalKey: sessionKey,
    }));

    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {};
      const result = await updater(store);
      capturedEntry = store[sessionKey] as Record<string, unknown>;
      return result;
    });

    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "write a narrative",
        sessionKey,
        idempotencyKey: "plugin-runtime-owner",
      },
      {
        client: {
          internal: {
            pluginRuntimeOwnerId: "memory-core",
          },
        } as never,
      },
    );

    expect(mocks.updateSessionStore).toHaveBeenCalled();
    expect(capturedEntry?.pluginOwnerId).toBe("memory-core");
  });

  it("does not claim stale pre-existing sessions for plugin runtime cleanup", async () => {
    const sessionKey = "agent:main:existing-user-session";
    const existingEntry = {
      sessionId: "stale-session",
      updatedAt: 1,
      pluginOwnerId: "other-plugin",
    };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: existingEntry,
      canonicalKey: sessionKey,
    });

    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        [sessionKey]: { ...existingEntry },
      };
      const result = await updater(store);
      capturedEntry = store[sessionKey] as Record<string, unknown>;
      return result;
    });

    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "write a narrative",
        sessionKey,
        idempotencyKey: "plugin-runtime-existing-owner",
      },
      {
        client: {
          internal: {
            pluginRuntimeOwnerId: "memory-core",
          },
        } as never,
      },
    );

    expect(capturedEntry?.pluginOwnerId).toBe("other-plugin");
  });

  it("forwards provider and model overrides for admin-scoped callers", async () => {
    primeMainAgentRun();

    await invokeAgent(
      {
        message: "test override",
        agentId: "main",
        sessionKey: "agent:main:main",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        idempotencyKey: "test-idem-model-override",
      },
      {
        reqId: "test-idem-model-override",
        client: {
          connect: {
            scopes: ["operator.admin"],
          },
        } as AgentHandlerArgs["client"],
      },
    );

    expectRecordFields(await waitForAgentCommandCall(), {
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
  });

  it("forwards explicit ACP turn source markers", async () => {
    primeMainAgentRun();

    await invokeAgent(
      {
        message: "bootstrap ACP child",
        agentId: "main",
        sessionKey: "agent:main:main",
        acpTurnSource: "manual_spawn",
        idempotencyKey: "test-acp-turn-source",
      },
      { reqId: "test-acp-turn-source" },
    );

    expectRecordFields(await waitForAgentCommandCall(), {
      acpTurnSource: "manual_spawn",
    });
  });

  it("does not bypass image support check for non-ACP sessions with acpTurnSource", async () => {
    primeMainAgentRun();
    mocks.agentCommand.mockClear();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "describe this image",
        agentId: "main",
        sessionKey: "agent:main:main",
        acpTurnSource: "manual_spawn",
        idempotencyKey: "test-acp-image-bypass-guard",
        attachments: [
          {
            type: "file",
            mimeType: "image/png",
            fileName: "test.png",
            content: Buffer.from("fake-png-data").toString("base64"),
          },
        ],
      },
      { respond, reqId: "test-acp-image-bypass-guard" },
    );

    // Non-ACP session (agent:main:main) with acpTurnSource="manual_spawn" must
    // NOT bypass resolveGatewayModelSupportsImages. The image should be rejected
    // by the normal image-support check since this is not an ACP session.
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    const error = expectRespondError(respond, {});
    expectStringFieldContains(error, "message", "does not accept image inputs");
  });

  it("does not bypass image support check for ACP-shaped sessions without ACP metadata", async () => {
    mockMainSessionEntry({ sessionId: "existing-acp-shaped-session" });
    mocks.updateSessionStore.mockResolvedValue(undefined);
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });
    mocks.agentCommand.mockClear();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "describe this image",
        agentId: "main",
        sessionKey: "agent:main:acp:missing-meta",
        acpTurnSource: "manual_spawn",
        idempotencyKey: "test-acp-image-metadata-bypass-guard",
        attachments: [
          {
            type: "file",
            mimeType: "image/png",
            fileName: "test.png",
            content: Buffer.from("fake-png-data").toString("base64"),
          },
        ],
      },
      { respond, reqId: "test-acp-image-metadata-bypass-guard" },
    );

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    const error = expectRespondError(respond, {});
    expectStringFieldContains(error, "message", "does not accept image inputs");
  });

  it("rejects provider and model overrides for write-scoped callers", async () => {
    primeMainAgentRun();
    mocks.agentCommand.mockClear();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "test override",
        agentId: "main",
        sessionKey: "agent:main:main",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        idempotencyKey: "test-idem-model-override-write",
      },
      {
        reqId: "test-idem-model-override-write",
        client: {
          connect: {
            scopes: ["operator.write"],
          },
        } as AgentHandlerArgs["client"],
        respond,
      },
    );

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expectRespondError(respond, {
      message: "provider/model overrides are not authorized for this caller.",
    });
  });

  it("forwards provider and model overrides when internal override authorization is set", async () => {
    primeMainAgentRun();

    await invokeAgent(
      {
        message: "test override",
        agentId: "main",
        sessionKey: "agent:main:main",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        idempotencyKey: "test-idem-model-override-internal",
      },
      {
        reqId: "test-idem-model-override-internal",
        client: {
          connect: {
            scopes: ["operator.write"],
          },
          internal: {
            allowModelOverride: true,
          },
        } as AgentHandlerArgs["client"],
      },
    );

    expectRecordFields(await waitForAgentCommandCall(), {
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
  });

  it("preserves cliSessionIds from existing session entry", async () => {
    const existingCliSessionIds = { "claude-cli": "abc-123-def" };
    const existingClaudeCliSessionId = "abc-123-def";

    mockMainSessionEntry({
      cliSessionIds: existingCliSessionIds,
      claudeCliSessionId: existingClaudeCliSessionId,
    });

    const capturedEntry = await runMainAgentAndCaptureEntry("test-idem");
    expect(capturedEntry.cliSessionIds).toEqual(existingCliSessionIds);
    expect(capturedEntry.claudeCliSessionId).toBe(existingClaudeCliSessionId);
  });
  // #5369: sessions.patch can write modelOverride to the session store between
  // when the agent handler reads its cached entry and when updateSessionStore
  // runs. The handler's loadSessionEntry may return the stale pre-patch entry
  // (no modelOverride), while the store-load inside updateSessionStore has the
  // fresh value. If the patch built from the stale entry carries modelOverride:
  // undefined, the merge {...fresh, ...patch} clobbers the fresh value.
  it("preserves fresh modelOverride when cached entry is stale (#5369)", async () => {
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "subagent-session-id",
        updatedAt: Date.now() - 1000,
        // modelOverride absent — stale pre-patch view
      },
      canonicalKey: "agent:main:subagent:test-uuid",
    });
    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const freshStore: Record<string, Record<string, unknown>> = {
        "agent:main:subagent:test-uuid": {
          sessionId: "subagent-session-id",
          updatedAt: Date.now(),
          modelOverride: "qwen3-coder:30b",
          providerOverride: "ollama",
        },
      };
      const result = await updater(freshStore);
      capturedEntry = freshStore["agent:main:subagent:test-uuid"];
      return result;
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:subagent:test-uuid",
        idempotencyKey: "test-5369-race",
      },
      { reqId: "race-1" },
    );
    expect(capturedEntry?.modelOverride).toBe("qwen3-coder:30b");
    expect(capturedEntry?.providerOverride).toBe("ollama");
  });
  // Broader regression guard for the #5369 stale-writeback class: any field
  // that the patch blindly carries from the cached entry will clobber a fresh
  // concurrent write. The fix dropped all such fields from the patch; this
  // test ensures none get silently re-added. If a future change puts e.g.
  // `sendPolicy: entry?.sendPolicy` back into the patch, this test fails.
  it("preserves all fresh session fields when cached entry is stale (#5369 broader)", async () => {
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "subagent-session-id",
        updatedAt: Date.now() - 1000,
        // All fields below absent — stale pre-patch view
      },
      canonicalKey: "agent:main:subagent:test-broader",
    });
    const freshFields = {
      sendPolicy: "allow",
      skillsSnapshot: { tools: ["bash"] },
      thinkingLevel: "high",
      fastMode: true,
      verboseLevel: "detailed",
      traceLevel: "info",
      reasoningLevel: "on",
      systemSent: true,
      spawnedWorkspaceDir: "/work/fresh",
      spawnDepth: 2,
      label: "fresh-label",
      spawnedBy: "agent:main:main",
      channel: "telegram",
      deliveryContext: {
        channel: "telegram",
        to: "12345",
        accountId: "acct-1",
        threadId: 42,
      },
      lastChannel: "telegram",
      lastTo: "12345",
      lastAccountId: "acct-1",
      lastThreadId: 42,
      cliSessionIds: { "claude-cli": "fresh-cli-id" },
      cliSessionBindings: { "claude-cli": { sessionId: "fresh-binding" } },
      claudeCliSessionId: "fresh-cli-id",
    };
    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const freshStore: Record<string, Record<string, unknown>> = {
        "agent:main:subagent:test-broader": {
          sessionId: "subagent-session-id",
          updatedAt: Date.now(),
          ...freshFields,
        },
      };
      const result = await updater(freshStore);
      capturedEntry = freshStore["agent:main:subagent:test-broader"];
      return result;
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:subagent:test-broader",
        idempotencyKey: "test-5369-broader",
      },
      { reqId: "broader-1" },
    );
    for (const [field, expected] of Object.entries(freshFields)) {
      expect(capturedEntry?.[field]).toEqual(expected);
    }
  });
  it("checks delivery sendPolicy against the fresh store entry (#5369)", async () => {
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "subagent-session-id",
        updatedAt: Date.now() - 1000,
        // sendPolicy absent — stale pre-patch view
      },
      canonicalKey: "agent:main:subagent:test-policy",
    });
    const freshUpdatedAt = Date.now();
    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const freshStore: Record<string, Record<string, unknown>> = {
        "agent:main:subagent:test-policy": {
          sessionId: "subagent-session-id",
          updatedAt: freshUpdatedAt,
          sendPolicy: "deny",
          channel: "telegram",
        },
      };
      const result = await updater(freshStore);
      capturedEntry = freshStore["agent:main:subagent:test-policy"];
      return result;
    });
    mocks.resolveSendPolicy.mockImplementation((args?: { entry?: { sendPolicy?: string } }) =>
      args?.entry?.sendPolicy === "deny" ? "deny" : "allow",
    );
    mocks.agentCommand.mockClear();
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });
    const respond = vi.fn();
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:subagent:test-policy",
        channel: "telegram",
        to: "99999",
        deliver: true,
        idempotencyKey: "test-5369-policy",
      },
      { reqId: "policy-1", respond },
    );
    expectRespondError(respond, { message: "send blocked by session policy" });
    const sendPolicyArgs = expectRecordFields(mockCallArg(mocks.resolveSendPolicy), {
      sessionKey: "agent:main:subagent:test-policy",
    });
    expectRecordFields(sendPolicyArgs.entry, { sendPolicy: "deny" });
    expectRecordFields(capturedEntry, {
      sessionId: "subagent-session-id",
      updatedAt: freshUpdatedAt,
      sendPolicy: "deny",
      channel: "telegram",
      deliveryContext: undefined,
      lastTo: undefined,
    });
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("recovers terminal failed agent API sessions without rotating the session id", async () => {
    const sessionId = "failed-agent-session";
    await withTempDir({ prefix: "openclaw-gateway-terminal-recovery-" }, async (root) => {
      const sessionsDir = `${root}/sessions`;
      await fs.mkdir(sessionsDir, { recursive: true });
      await fs.writeFile(`${sessionsDir}/${sessionId}.jsonl`, "", "utf8");
      mocks.loadSessionEntry.mockReturnValue({
        cfg: {},
        storePath: `${sessionsDir}/sessions.json`,
        entry: {
          sessionId,
          status: "failed",
          startedAt: 100,
          endedAt: 200,
          runtimeMs: 100,
          abortedLastRun: true,
          updatedAt: Date.now(),
        },
        canonicalKey: "agent:main:main",
      });

      const capturedEntry = await runMainAgentAndCaptureEntry("recover-terminal-agent-session");
      const call = await waitForAgentCommandCall();

      expect(call.sessionId).toBe(sessionId);
      expectRecordFields(capturedEntry, {
        sessionId,
        status: undefined,
        startedAt: undefined,
        endedAt: undefined,
        runtimeMs: undefined,
        abortedLastRun: undefined,
      });
    });
  });

  it("does not restore a stale session id over a fresh store rotation (#5369)", async () => {
    mocks.resolveSessionLifecycleTimestamps.mockImplementation(
      ({ entry }: { entry?: { sessionId?: string; sessionStartedAt?: number } }) => ({
        sessionStartedAt: entry?.sessionId === "old-session-id" ? 123 : entry?.sessionStartedAt,
        lastInteractionAt: undefined,
      }),
    );
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "old-session-id",
        updatedAt: Date.now() - 1000,
      },
      canonicalKey: "agent:main:subagent:test-rotation",
    });
    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const freshStore: Record<string, Record<string, unknown>> = {
        "agent:main:subagent:test-rotation": {
          sessionId: "fresh-session-id",
          updatedAt: Date.now(),
          status: "running",
          startedAt: 111,
          sessionFile: "/tmp/fresh-session.jsonl",
        },
      };
      const result = await updater(freshStore);
      capturedEntry = freshStore["agent:main:subagent:test-rotation"];
      return result;
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:subagent:test-rotation",
        idempotencyKey: "test-5369-rotation",
      },
      { reqId: "rotation-1" },
    );

    expectRecordFields(capturedEntry, {
      sessionId: "fresh-session-id",
      status: "running",
      startedAt: 111,
      sessionStartedAt: undefined,
    });
    expectSqliteSessionFileMarkerForEntry(capturedEntry);
  });
  // Upgrade-path self-heal: a legacy session entry may lack sessionStartedAt
  // because the field was added after the entry was first persisted. The
  // handler recovers it from the transcript JSONL header and writes it back,
  // but only when the fresh store still lacks the field — so a concurrent
  // writer that sets it cannot be clobbered (the #5369 stale-writeback class).
  it("self-heals missing sessionStartedAt from JSONL when fresh store also lacks it", async () => {
    // Use a value distinct from `now` but recent enough that
    // evaluateSessionFreshness — which also calls the mocked
    // resolveSessionLifecycleTimestamps — keeps this session fresh.
    const recoveredStartedAt = Date.now() - 5_000;
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "legacy-session-id",
        updatedAt: Date.now() - 1000,
        // sessionStartedAt absent — legacy schema
      },
      canonicalKey: "agent:main:subagent:legacy",
    });
    mocks.resolveSessionLifecycleTimestamps.mockReturnValue({
      sessionStartedAt: recoveredStartedAt,
      lastInteractionAt: undefined,
    });
    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const freshStore: Record<string, Record<string, unknown>> = {
        "agent:main:subagent:legacy": {
          sessionId: "legacy-session-id",
          updatedAt: Date.now(),
          // sessionStartedAt absent on disk too — self-heal should fire
        },
      };
      const result = await updater(freshStore);
      capturedEntry = freshStore["agent:main:subagent:legacy"];
      return result;
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:subagent:legacy",
        idempotencyKey: "test-selfheal-write",
      },
      { reqId: "selfheal-1" },
    );
    expect(capturedEntry?.sessionStartedAt).toBe(recoveredStartedAt);
  });
  it("does not clobber fresh sessionStartedAt with the recovered candidate", async () => {
    // See note in the prior test: keep both values recent so freshness
    // evaluation (which also reads the lifecycle mock) doesn't trip the
    // idle-reset path and turn this into an isNewSession path.
    const recoveredStartedAt = Date.now() - 5_000;
    const freshStartedAt = Date.now() - 2_500;
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "legacy-session-id",
        updatedAt: Date.now() - 1000,
        // sessionStartedAt absent in cached entry — would trigger recovery
      },
      canonicalKey: "agent:main:subagent:concurrent",
    });
    mocks.resolveSessionLifecycleTimestamps.mockReturnValue({
      sessionStartedAt: recoveredStartedAt,
      lastInteractionAt: undefined,
    });
    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const freshStore: Record<string, Record<string, unknown>> = {
        "agent:main:subagent:concurrent": {
          sessionId: "legacy-session-id",
          updatedAt: Date.now(),
          // Concurrent writer set sessionStartedAt between cache load and lock
          sessionStartedAt: freshStartedAt,
        },
      };
      const result = await updater(freshStore);
      capturedEntry = freshStore["agent:main:subagent:concurrent"];
      return result;
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:subagent:concurrent",
        idempotencyKey: "test-selfheal-noclobber",
      },
      { reqId: "selfheal-2" },
    );
    expect(capturedEntry?.sessionStartedAt).toBe(freshStartedAt);
  });
  it("reactivates completed subagent sessions and broadcasts send updates", async () => {
    const childSessionKey = "agent:main:subagent:followup";
    const updatedAt = Date.now() - 1_000;
    const completedRun = {
      runId: "run-old",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      requesterDisplayKey: "main",
      task: "initial task",
      cleanup: "keep" as const,
      createdAt: 1,
      startedAt: 2,
      endedAt: 3,
      outcome: { status: "ok" as const },
    };

    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "sess-followup",
        updatedAt,
      },
      canonicalKey: childSessionKey,
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        [childSessionKey]: {
          sessionId: "sess-followup",
          updatedAt,
        },
      };
      return await updater(store);
    });
    mocks.getLatestSubagentRunByChildSessionKey.mockReturnValueOnce(completedRun);
    mocks.replaceSubagentRunAfterSteer.mockReturnValueOnce(true);
    mocks.loadGatewaySessionRow.mockReturnValueOnce({
      status: "running",
      startedAt: 123,
      endedAt: undefined,
      runtimeMs: 10,
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    const respond = vi.fn();
    const broadcastToConnIds = vi.fn();
    await invokeAgent(
      {
        message: "follow-up",
        sessionKey: childSessionKey,
        idempotencyKey: "run-new",
      },
      {
        respond,
        context: {
          dedupe: new Map(),
          addChatRun: vi.fn(),
          chatAbortControllers: new Map(),
          logGateway: { info: vi.fn(), error: vi.fn() },
          broadcastToConnIds,
          getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
          getRuntimeConfig: () => mocks.loadConfigReturn,
        } as unknown as GatewayRequestContext,
      },
    );

    expect(mockCallArg(respond)).toBe(true);
    expectRecordFields(mockCallArg(respond, 0, 1), {
      runId: "run-new",
      status: "accepted",
    });
    expect(mockCallArg(respond, 0, 2)).toBeUndefined();
    expect(mockCallArg(respond, 0, 3)).toEqual({ runId: "run-new" });
    expectSubagentFollowupReactivation({
      replaceSubagentRunAfterSteerMock: mocks.replaceSubagentRunAfterSteer,
      broadcastToConnIds,
      completedRun,
      childSessionKey,
      task: "follow-up",
    });
  });

  it("includes live session setting metadata in agent send events", async () => {
    const updatedAt = Date.now() - 1_000;
    mockMainSessionEntry({
      sessionId: "sess-main",
      updatedAt,
      fastMode: true,
      sendPolicy: "deny",
      lastChannel: "telegram",
      lastTo: "-100123",
      lastAccountId: "acct-1",
      lastThreadId: 42,
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:main": buildExistingMainStoreEntry({
          sessionId: "sess-main",
          updatedAt,
          fastMode: true,
          sendPolicy: "deny",
          lastChannel: "telegram",
          lastTo: "-100123",
          lastAccountId: "acct-1",
          lastThreadId: 42,
        }),
      };
      return await updater(store);
    });
    mocks.loadGatewaySessionRow.mockReturnValue({
      spawnedBy: "agent:main:main",
      spawnedWorkspaceDir: "/tmp/subagent",
      forkedFromParent: true,
      spawnDepth: 2,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      fastMode: true,
      sendPolicy: "deny",
      lastChannel: "telegram",
      lastTo: "-100123",
      lastAccountId: "acct-1",
      lastThreadId: 42,
      totalTokens: 12,
      status: "running",
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    const broadcastToConnIds = vi.fn();
    await invokeAgent(
      {
        message: "test",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-live-settings",
      },
      {
        context: {
          dedupe: new Map(),
          addChatRun: vi.fn(),
          chatAbortControllers: new Map(),
          logGateway: { info: vi.fn(), error: vi.fn() },
          broadcastToConnIds,
          getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
          getRuntimeConfig: () => mocks.loadConfigReturn,
        } as unknown as GatewayRequestContext,
      },
    );

    expect(mockCallArg(broadcastToConnIds)).toBe("sessions.changed");
    expectRecordFields(mockCallArg(broadcastToConnIds, 0, 1), {
      sessionKey: "agent:main:main",
      reason: "send",
      spawnedBy: "agent:main:main",
      spawnedWorkspaceDir: "/tmp/subagent",
      forkedFromParent: true,
      spawnDepth: 2,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      fastMode: true,
      sendPolicy: "deny",
      lastChannel: "telegram",
      lastTo: "-100123",
      lastAccountId: "acct-1",
      lastThreadId: 42,
      totalTokens: 12,
      status: "running",
    });
    expect(mockCallArg(broadcastToConnIds, 0, 2)).toEqual(new Set(["conn-1"]));
    expect(mockCallArg(broadcastToConnIds, 0, 3)).toEqual({ dropIfSlow: true });
  });

  it("passes the raw user message to agentCommand for LLM-boundary timestamping", async () => {
    setupNewYorkTimeConfig("2026-01-29T01:30:00.000Z");

    primeMainAgentRun({ cfg: mocks.loadConfigReturn });

    await invokeAgent(
      {
        message: "Is it the weekend?",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-timestamp-inject",
      },
      { reqId: "ts-1" },
    );

    const callArgs = await waitForAgentCommandCall<{ message?: string }>();
    expect(callArgs.message).toBe("Is it the weekend?");

    resetTimeConfig();
  });

  it("marks inter-session agent messages at the gateway boundary without timestamping them", async () => {
    setupNewYorkTimeConfig("2026-01-29T01:30:00.000Z");
    primeMainAgentRun({ cfg: mocks.loadConfigReturn });

    await invokeAgent(
      {
        message: "forwarded reply",
        agentId: "main",
        sessionKey: "agent:main:main",
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:discord:source",
          sourceTool: "sessions_send",
        },
        idempotencyKey: "test-inter-session-marker",
      },
      { reqId: "inter-session-marker" },
    );

    const callArgs = await waitForAgentCommandCall<
      AgentCommandCall & {
        message?: string;
        userTurnTranscriptRecorder?: {
          message?: unknown;
        };
      }
    >();
    expect(callArgs.message).toMatch(/^\[Inter-session message\]/);
    expect(callArgs.message).toContain("isUser=false");
    expect(callArgs.message).toContain("forwarded reply");
    expect(callArgs.message).not.toContain("[Wed 2026-01-28 20:30 EST]");
    expect(callArgs.userTurnTranscriptRecorder?.message).toMatchObject({
      role: "user",
      content: "forwarded reply",
      provenance: {
        kind: "inter_session",
        sourceSessionKey: "agent:main:discord:source",
        sourceTool: "sessions_send",
      },
    });

    resetTimeConfig();
  });

  it("suppresses persisted prompts for subagent announce task-completion handoffs", async () => {
    primeMainAgentRun({ cfg: mocks.loadConfigReturn });
    mocks.agentCommand.mockClear();

    await invokeAgent(
      {
        message: "runtime-only announce bookkeeping",
        agentId: "main",
        sessionKey: "agent:main:main",
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:subagent:child",
          sourceTool: "subagent_announce",
        },
        internalEvents: [
          {
            type: "task_completion",
            source: "subagent",
            childSessionKey: "agent:main:subagent:child",
            childSessionId: "child-session-id",
            announceType: "completion",
            taskLabel: "child task",
            status: "ok",
            statusLabel: "completed",
            result: "child result",
            statsLine: "tokens=10",
            replyInstruction: "Deliver the child result.",
          },
        ],
        idempotencyKey: "test-subagent-announce-suppress-prompt",
      },
      {
        reqId: "subagent-announce-suppress-prompt",
        client: backendGatewayClient(),
      },
    );

    const callArgs = await waitForAgentCommandCall<{
      suppressPromptPersistence?: boolean;
      preserveUserFacingSessionModelState?: boolean;
      message?: string;
    }>();
    expect(callArgs.suppressPromptPersistence).toBe(true);
    expect(callArgs.preserveUserFacingSessionModelState).toBe(true);
    expect(callArgs.message).toMatch(/^\[Inter-session message\]/);
    expect(callArgs.message).toContain("sourceTool=subagent_announce");
  });

  it("restores exact cron continuation policy for generated-media wakes", async () => {
    mocks.agentCommand.mockClear();
    const sessionKey = "agent:main:cron:job-1:run:run-1";
    const baseSessionKey = "agent:main:cron:job-1";
    const entry: SessionEntry = {
      sessionId: "run-1",
      updatedAt: Date.now(),
      lifecycleRevision: "revision-1",
      modelProvider: "claude-cli",
      model: "claude-opus-4-8",
      thinkingLevel: "high",
      cliSessionBindings: {
        "claude-cli": { sessionId: "native-claude-session" },
      },
      cronRunContinuation: {
        lifecycleRevision: "revision-1",
        phase: "ready" as const,
        basePersisted: true,
        toolsAllow: ["image_generate", "write"],
        toolsAllowIsDefault: true,
        cliSessionBindingFacts: {
          sourceReplyDeliveryMode: "automatic" as const,
          requireExplicitMessageTarget: true,
        },
      },
    };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: sessionKey,
      entry,
    });
    const { cronRunContinuation: _cronRunContinuation, ...baseEntry } = structuredClone(entry);
    const store: Record<string, SessionEntry> = {
      [baseSessionKey]: baseEntry,
      [sessionKey]: structuredClone(entry),
    };
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => await updater(store));
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "continued" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "image generation finished",
        sessionKey,
        internalEvents: [cronMediaCompletionEvent()],
        idempotencyKey: "cron-media-continuation",
      },
      {
        reqId: "cron-media-continuation",
        client: cronContinuationGatewayClient(),
      },
    );

    const callArgs = await waitForAgentCommandCall<{
      bootstrapContextRunKind?: string;
      provider?: string;
      model?: string;
      thinking?: string;
      sessionId?: string;
      toolsAllow?: string[];
      toolsAllowIsDefault?: boolean;
      requireExplicitMessageTarget?: boolean;
      sourceReplyDeliveryMode?: string;
      cliSessionBindingFacts?: {
        sourceReplyDeliveryMode?: string;
        requireExplicitMessageTarget?: boolean;
      };
      allowModelOverride?: boolean;
      senderIsOwner?: boolean;
    }>();
    expect(callArgs.sessionId).toBe("run-1");
    expect(callArgs.provider).toBe("claude-cli");
    expect(callArgs.model).toBe("claude-opus-4-8");
    expect(callArgs.thinking).toBe("high");
    expect(callArgs.bootstrapContextRunKind).toBe("cron");
    expect(callArgs.toolsAllow).toEqual(["image_generate", "write"]);
    expect(callArgs.toolsAllowIsDefault).toBe(true);
    expect(callArgs.requireExplicitMessageTarget).toBe(true);
    expect(callArgs.sourceReplyDeliveryMode).toBe("automatic");
    expect(callArgs.cliSessionBindingFacts).toEqual({
      sourceReplyDeliveryMode: "automatic",
      requireExplicitMessageTarget: true,
    });
    expect(callArgs.allowModelOverride).toBe(true);
    expect(callArgs.senderIsOwner).toBe(true);
  });

  it.each([
    {
      name: "from a public operator caller",
      client: "operator" as const,
      phase: "ready" as const,
      freshRevision: "revision-1",
      code: ErrorCodes.INVALID_REQUEST,
    },
    {
      name: "from a backend-mode caller without server authority",
      client: "backend" as const,
      phase: "ready" as const,
      freshRevision: "revision-1",
      code: ErrorCodes.INVALID_REQUEST,
    },
    {
      name: "before the initial cron owner is ready",
      client: "continuation" as const,
      phase: "running" as const,
      freshRevision: "revision-1",
      code: ErrorCodes.UNAVAILABLE,
    },
    {
      name: "after its lifecycle revision changes",
      client: "continuation" as const,
      phase: "ready" as const,
      freshRevision: "revision-2",
      code: ErrorCodes.UNAVAILABLE,
    },
    {
      name: "after the gateway owner generation is lost",
      client: "continuation" as const,
      phase: "continuing" as const,
      freshRevision: "revision-1",
      ownerLifecycleGeneration: "retired-gateway-generation",
      code: ErrorCodes.INVALID_REQUEST,
    },
    {
      name: "when its stable base was not persisted",
      client: "continuation" as const,
      phase: "ready" as const,
      freshRevision: "revision-1",
      basePersisted: false,
      code: ErrorCodes.INVALID_REQUEST,
    },
  ])("rejects a cron media continuation $name", async (testCase) => {
    mocks.agentCommand.mockClear();
    const sessionKey = "agent:main:cron:job-1:run:run-1";
    const entry: SessionEntry = {
      sessionId: "run-1",
      updatedAt: Date.now(),
      modelProvider: "openai",
      model: "gpt-5.4",
      cronRunContinuation: {
        lifecycleRevision: "revision-1",
        phase: testCase.phase,
        basePersisted:
          "basePersisted" in testCase ? testCase.basePersisted : testCase.phase === "ready",
        ...("ownerLifecycleGeneration" in testCase
          ? { ownerLifecycleGeneration: testCase.ownerLifecycleGeneration }
          : {}),
      },
    };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: sessionKey,
      entry,
    });
    const freshEntry = structuredClone(entry);
    if (!freshEntry.cronRunContinuation) {
      throw new Error("expected cron continuation fixture");
    }
    freshEntry.cronRunContinuation.lifecycleRevision = testCase.freshRevision;
    const store: Record<string, SessionEntry> = { [sessionKey]: freshEntry };
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => await updater(store));

    const respond = await invokeAgent(
      {
        message: "image generation finished",
        sessionKey,
        internalEvents: [cronMediaCompletionEvent()],
        idempotencyKey: `cron-media-rejected-${testCase.phase}-${testCase.freshRevision}`,
      },
      {
        flushDispatch: false,
        client:
          testCase.client === "continuation"
            ? cronContinuationGatewayClient()
            : testCase.client === "backend"
              ? backendGatewayClient()
              : operatorWriteGatewayClient(),
      },
    );

    expectRespondError(respond, { code: testCase.code });
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("claims an exact cron continuation until the admitted agent turn settles", async () => {
    mocks.agentCommand.mockClear();
    const sessionKey = "agent:main:cron:job-1:run:run-1";
    const baseSessionKey = "agent:main:cron:job-1";
    const entry: SessionEntry = {
      sessionId: "run-1",
      updatedAt: Date.now(),
      lifecycleRevision: "revision-1",
      modelProvider: "openai",
      model: "gpt-5.4",
      cronRunContinuation: {
        lifecycleRevision: "revision-1",
        phase: "ready" as const,
        basePersisted: true,
      },
    };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: sessionKey,
      entry,
    });
    const { cronRunContinuation: _cronRunContinuation, ...baseEntry } = structuredClone(entry);
    const store: Record<string, SessionEntry> = {
      [baseSessionKey]: baseEntry,
      [sessionKey]: structuredClone(entry),
    };
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => await updater(store));
    let finishFirstTurn: (result: { payloads: Array<{ text: string }> }) => void = () => {};
    mocks.agentCommand.mockImplementationOnce(
      async () =>
        await new Promise<{ payloads: Array<{ text: string }> }>((resolve) => {
          finishFirstTurn = resolve;
        }),
    );
    const context = makeContext();
    const first = await invokeAgent(
      {
        message: "first media completion",
        sessionKey,
        internalEvents: [cronMediaCompletionEvent()],
        idempotencyKey: "cron-media-first",
      },
      {
        reqId: "cron-media-first",
        client: cronContinuationGatewayClient(),
        context,
        flushDispatch: false,
      },
    );
    await waitForAgentCommandCall();
    expect(
      expectDefined(store[sessionKey], "store[sessionKey] test invariant").cronRunContinuation,
    ).toMatchObject({
      phase: "continuing",
      ownerRunId: "cron-media-first",
    });

    const second = await invokeAgent(
      {
        message: "second media completion",
        sessionKey,
        internalEvents: [cronMediaCompletionEvent()],
        idempotencyKey: "cron-media-second",
      },
      {
        reqId: "cron-media-second",
        client: cronContinuationGatewayClient(),
        context,
        flushDispatch: false,
      },
    );
    expectRespondError(second, {
      code: ErrorCodes.UNAVAILABLE,
      message: "cron run continuation changed before admission",
    });
    expect(mocks.agentCommand).toHaveBeenCalledTimes(1);
    expect(
      expectDefined(store[sessionKey], "store[sessionKey] test invariant").cronRunContinuation,
    ).toMatchObject({
      phase: "continuing",
      ownerRunId: "cron-media-first",
    });

    finishFirstTurn({ payloads: [{ text: "continued" }] });
    await waitForAssertion(() => {
      expect(
        expectDefined(store[sessionKey], "store[sessionKey] test invariant").cronRunContinuation,
      ).toEqual({
        lifecycleRevision: "revision-1",
        phase: "ready",
        basePersisted: true,
      });
    });
    expect(first).toHaveBeenCalledWith(true, expect.objectContaining({ status: "ok" }), undefined, {
      runId: "cron-media-first",
    });
  });

  it("keeps an exact continuation ready for later media when the stable row was deleted", async () => {
    mocks.agentCommand.mockClear();
    const sessionKey = "agent:main:cron:delete-after-run:run:run-1";
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
    const store: Record<string, SessionEntry> = { [sessionKey]: structuredClone(entry) };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: sessionKey,
      entry,
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => await updater(store));
    mocks.agentCommand.mockResolvedValue({ payloads: [{ text: "continued" }] });

    for (const reqId of ["cron-media-first", "cron-media-second"]) {
      await invokeAgent(
        {
          message: `${reqId} finished`,
          sessionKey,
          internalEvents: [cronMediaCompletionEvent()],
          idempotencyKey: reqId,
        },
        { reqId, client: cronContinuationGatewayClient() },
      );
      await waitForAssertion(() => {
        expect(store[sessionKey]?.cronRunContinuation).toEqual({
          lifecycleRevision: "revision-1",
          phase: "ready",
          basePersisted: true,
        });
      });
    }
    expect(mocks.agentCommand).toHaveBeenCalledTimes(2);
  });

  it("persists a fallback model after the continuation session id rotates", async () => {
    mocks.agentCommand.mockClear();
    const sessionKey = "agent:main:cron:job-1:run:run-1";
    const baseSessionKey = "agent:main:cron:job-1";
    const entry = {
      sessionId: "run-1",
      updatedAt: Date.now(),
      lifecycleRevision: "revision-1",
      modelProvider: "openai",
      model: "gpt-5.4",
      cronRunContinuation: {
        lifecycleRevision: "revision-1",
        phase: "ready" as const,
        basePersisted: true,
      },
    };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: sessionKey,
      entry,
    });
    const { cronRunContinuation: _cronRunContinuation, ...baseEntry } = structuredClone(entry);
    const store: Record<string, SessionEntry> = {
      [baseSessionKey]: baseEntry,
      [sessionKey]: structuredClone(entry),
    };
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => await updater(store));
    mocks.agentCommand.mockImplementation(async (call: AgentCommandCall) => {
      expectDefined(store[sessionKey], "store[sessionKey] test invariant").sessionId = "run-2";
      const onActiveModelSelected = call.onActiveModelSelected;
      if (typeof onActiveModelSelected !== "function") {
        throw new Error("expected active model callback");
      }
      await onActiveModelSelected({ provider: "anthropic", model: "claude-sonnet-4-6" });
      return { payloads: [{ text: "continued" }] };
    });

    await invokeAgent(
      {
        message: "media completion after compaction",
        sessionKey,
        internalEvents: [cronMediaCompletionEvent()],
        idempotencyKey: "cron-media-rotated",
      },
      {
        reqId: "cron-media-rotated",
        client: cronContinuationGatewayClient(),
      },
    );

    await waitForAssertion(() => {
      expect(store[sessionKey]).toMatchObject({
        sessionId: "run-2",
        modelProvider: "anthropic",
        model: "claude-sonnet-4-6",
        cronRunContinuation: {
          lifecycleRevision: "revision-1",
          phase: "ready",
        },
      });
      expect(store[baseSessionKey]).toMatchObject({
        sessionId: "run-2",
        modelProvider: "anthropic",
        model: "claude-sonnet-4-6",
      });
    });
  });

  it("does not promote a failed continuation candidate without committed media", async () => {
    mocks.agentCommand.mockClear();
    const sessionKey = "agent:main:cron:job-1:run:run-1";
    const baseSessionKey = "agent:main:cron:job-1";
    const entry: SessionEntry = {
      sessionId: "run-1",
      updatedAt: Date.now(),
      lifecycleRevision: "revision-1",
      modelProvider: "openai",
      model: "gpt-5.4",
      contextTokens: 128_000,
      agentHarnessId: "openclaw",
      cliSessionBindings: { "openai-cli": { sessionId: "native-a" } },
      cronRunContinuation: {
        lifecycleRevision: "revision-1",
        phase: "ready" as const,
        basePersisted: true,
      },
    };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: sessionKey,
      entry,
    });
    const { cronRunContinuation: _cronRunContinuation, ...baseEntry } = structuredClone(entry);
    const store: Record<string, SessionEntry> = {
      [baseSessionKey]: baseEntry,
      [sessionKey]: structuredClone(entry),
    };
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => await updater(store));
    mocks.agentCommand.mockImplementation(async (call: AgentCommandCall) => {
      const onActiveModelSelected = call.onActiveModelSelected;
      if (typeof onActiveModelSelected !== "function") {
        throw new Error("expected continuation model callback");
      }
      await onActiveModelSelected({ provider: "gemini-cli", model: "gemini-3" });
      expectDefined(store[sessionKey], "store[sessionKey] test invariant").contextTokens =
        1_000_000;
      expectDefined(store[sessionKey], "store[sessionKey] test invariant").contextBudgetStatus = {
        schemaVersion: 1,
        source: "pre-prompt-estimate",
        updatedAt: 2,
        provider: "gemini-cli",
        model: "gemini-3",
        route: "fits",
        shouldCompact: false,
        estimatedPromptTokens: 10,
        contextTokenBudget: 1_000_000,
        promptBudgetBeforeReserve: 900_000,
        reserveTokens: 100_000,
        effectiveReserveTokens: 100_000,
        remainingPromptBudgetTokens: 900_000,
        overflowTokens: 0,
        toolResultReducibleChars: 0,
        messageCount: 1,
        unwindowedMessageCount: 1,
      };
      expectDefined(store[sessionKey], "store[sessionKey] test invariant").agentHarnessId =
        "gemini";
      return { payloads: [], meta: { error: "candidate failed", stopReason: "error" } };
    });

    await invokeAgent(
      {
        message: "media continuation candidate fails",
        sessionKey,
        internalEvents: [cronMediaCompletionEvent()],
        idempotencyKey: "cron-media-failed-candidate",
      },
      { reqId: "cron-media-failed-candidate", client: cronContinuationGatewayClient() },
    );

    for (const persisted of [store[sessionKey], store[baseSessionKey]]) {
      expect(persisted).toMatchObject({
        modelProvider: "openai",
        model: "gpt-5.4",
        contextTokens: 128_000,
        agentHarnessId: "openclaw",
        cliSessionBindings: { "openai-cli": { sessionId: "native-a" } },
      });
      expect(
        expectDefined(persisted, "persisted test invariant").cliSessionBindings?.["gemini-cli"],
      ).toBeUndefined();
      expect(
        expectDefined(persisted, "persisted test invariant").contextBudgetStatus,
      ).toBeUndefined();
    }
  });

  it("recovers a continuation release after reporting a durable write failure", async () => {
    vi.useFakeTimers();
    resetGatewayWorkAdmission();
    try {
      mocks.agentCommand.mockClear();
      const { sessionKey, store } = setupCronContinuationReleaseFixture();
      const context = makeContext();
      let releaseAttempts = 0;
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        if (
          expectDefined(store[sessionKey], "store[sessionKey] test invariant").cronRunContinuation
            ?.phase === "continuing"
        ) {
          releaseAttempts += 1;
          if (releaseAttempts <= 3) {
            throw new Error("disk unavailable");
          }
        }
        return await updater(store);
      });
      mocks.agentCommand.mockResolvedValue({ payloads: [{ text: "continued" }], meta: {} });
      const request = {
        message: "media completion",
        sessionKey,
        internalEvents: [cronMediaCompletionEvent()],
        idempotencyKey: "cron-media-release-fails",
      };

      const respond = await invokeAgent(request, {
        reqId: "cron-media-release-fails",
        client: cronContinuationGatewayClient(),
        context,
        flushDispatch: false,
      });
      await vi.advanceTimersByTimeAsync(10);

      expect(releaseAttempts).toBe(3);
      expect(
        expectDefined(store[sessionKey], "store[sessionKey] test invariant").cronRunContinuation,
      ).toMatchObject({
        phase: "continuing",
        ownerRunId: "cron-media-release-fails",
      });
      expect(respond).toHaveBeenLastCalledWith(
        false,
        expect.objectContaining({
          status: "error",
          summary: "failed to persist cron continuation settlement",
        }),
        expect.objectContaining({ code: ErrorCodes.UNAVAILABLE }),
        expect.objectContaining({ runId: "cron-media-release-fails" }),
      );
      const busyPrepare = await invokeGatewaySuspendPrepare(context, "cron-media-release-backoff");
      expect(busyPrepare).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          status: "busy",
          reason: "active-work",
          blockers: expect.arrayContaining([expect.objectContaining({ kind: "root-request" })]),
        }),
      );

      await vi.advanceTimersByTimeAsync(250);

      expect(releaseAttempts).toBe(4);
      expect(
        expectDefined(store[sessionKey], "store[sessionKey] test invariant").cronRunContinuation,
      ).toEqual({
        lifecycleRevision: "revision-1",
        phase: "ready",
        basePersisted: true,
      });
      const readyPrepare = await invokeGatewaySuspendPrepare(
        context,
        "cron-media-release-recovered",
      );
      const readyPayload = readyPrepare.mock.calls.at(-1)?.[1] as
        | { status?: string; suspensionId?: string }
        | undefined;
      expect(readyPayload).toMatchObject({ status: "ready" });
      expect(resumeGatewaySuspend(readyPayload?.suspensionId ?? "missing")).toMatchObject({
        ok: true,
        status: "running",
      });
      const retryRespond = await invokeAgent(request, {
        reqId: "cron-media-release-retry",
        client: cronContinuationGatewayClient(),
        context,
      });
      expect(retryRespond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "ok", summary: "completed" }),
        undefined,
        { cached: true },
      );
      expect(mocks.agentCommand).toHaveBeenCalledOnce();
    } finally {
      resetGatewaySuspendCoordinatorForTest();
      resetGatewayWorkAdmission();
      vi.useRealTimers();
    }
  });

  it("releases suspension admission after continuation recovery exhausts", async () => {
    vi.useFakeTimers();
    resetGatewayWorkAdmission();
    try {
      const { sessionKey, store } = setupCronContinuationReleaseFixture();
      const context = makeContext();
      let releaseAttempts = 0;
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        if (
          expectDefined(store[sessionKey], "store[sessionKey] test invariant").cronRunContinuation
            ?.phase === "continuing"
        ) {
          releaseAttempts += 1;
          throw new Error("disk unavailable");
        }
        return await updater(store);
      });
      mocks.agentCommand.mockResolvedValue({ payloads: [{ text: "continued" }], meta: {} });

      await invokeAgent(
        {
          message: "media completion",
          sessionKey,
          internalEvents: [cronMediaCompletionEvent()],
          idempotencyKey: "cron-media-release-exhausts",
        },
        {
          reqId: "cron-media-release-exhausts",
          client: cronContinuationGatewayClient(),
          context,
          flushDispatch: false,
        },
      );
      await vi.advanceTimersByTimeAsync(10);

      expect(releaseAttempts).toBe(3);
      const busyPrepare = await invokeGatewaySuspendPrepare(
        context,
        "cron-media-release-exhaustion-backoff",
      );
      expect(busyPrepare).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          status: "busy",
          blockers: expect.arrayContaining([expect.objectContaining({ kind: "root-request" })]),
        }),
      );

      for (const delayMs of [250, 1_000, 4_000, 15_000]) {
        await vi.advanceTimersByTimeAsync(delayMs);
      }

      expect(releaseAttempts).toBe(15);
      expect(context.logGateway.warn).toHaveBeenCalledWith(
        "cron continuation release recovery exhausted for cron-media-release-exhausts",
      );
      const readyPrepare = await invokeGatewaySuspendPrepare(
        context,
        "cron-media-release-exhausted",
      );
      const readyPayload = readyPrepare.mock.calls.at(-1)?.[1] as
        | { status?: string; suspensionId?: string }
        | undefined;
      expect(readyPayload).toMatchObject({ status: "ready" });
      expect(resumeGatewaySuspend(readyPayload?.suspensionId ?? "missing")).toMatchObject({
        ok: true,
        status: "running",
      });
    } finally {
      resetGatewaySuspendCoordinatorForTest();
      resetGatewayWorkAdmission();
      vi.useRealTimers();
    }
  });

  it("stops continuation release recovery after gateway generation rotation", async () => {
    vi.useFakeTimers();
    resetGatewayWorkAdmission();
    try {
      const { sessionKey, store } = setupCronContinuationReleaseFixture();
      const context = makeContext();
      let releaseAttempts = 0;
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        if (
          expectDefined(store[sessionKey], "store[sessionKey] test invariant").cronRunContinuation
            ?.phase === "continuing"
        ) {
          releaseAttempts += 1;
          throw new Error("disk unavailable");
        }
        return await updater(store);
      });
      mocks.agentCommand.mockResolvedValue({ payloads: [{ text: "continued" }], meta: {} });

      await invokeAgent(
        {
          message: "media completion",
          sessionKey,
          internalEvents: [cronMediaCompletionEvent()],
          idempotencyKey: "cron-media-release-rotates",
        },
        {
          reqId: "cron-media-release-rotates",
          client: cronContinuationGatewayClient(),
          context,
          flushDispatch: false,
        },
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(releaseAttempts).toBe(3);
      const busyPrepare = await invokeGatewaySuspendPrepare(context, "cron-media-release-rotating");
      expect(busyPrepare).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          status: "busy",
          blockers: expect.arrayContaining([expect.objectContaining({ kind: "root-request" })]),
        }),
      );

      mocks.lifecycleGeneration = "post-restart-generation";
      await vi.advanceTimersByTimeAsync(250);

      expect(releaseAttempts).toBe(3);
      expect(
        expectDefined(store[sessionKey], "store[sessionKey] test invariant").cronRunContinuation,
      ).toMatchObject({
        phase: "continuing",
        ownerRunId: "cron-media-release-rotates",
      });
      const readyPrepare = await invokeGatewaySuspendPrepare(
        context,
        "cron-media-release-rotation-complete",
      );
      const readyPayload = readyPrepare.mock.calls.at(-1)?.[1] as
        | { status?: string; suspensionId?: string }
        | undefined;
      expect(readyPayload).toMatchObject({ status: "ready" });
      expect(resumeGatewaySuspend(readyPayload?.suspensionId ?? "missing")).toMatchObject({
        ok: true,
        status: "running",
      });
    } finally {
      resetGatewaySuspendCoordinatorForTest();
      resetGatewayWorkAdmission();
      vi.useRealTimers();
    }
  });

  it("releases a claimed cron continuation when the request exits before dispatch", async () => {
    mocks.agentCommand.mockClear();
    const sessionKey = "agent:main:cron:job-1:run:run-1";
    const baseSessionKey = "agent:main:cron:job-1";
    const entry = {
      sessionId: "run-1",
      updatedAt: Date.now(),
      lifecycleRevision: "revision-1",
      modelProvider: "openai",
      model: "gpt-5.4",
      channel: "slack",
      to: "channel:C123",
      cronRunContinuation: {
        lifecycleRevision: "revision-1",
        phase: "ready" as const,
        basePersisted: true,
      },
    };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: sessionKey,
      entry,
    });
    const { cronRunContinuation: _cronRunContinuation, ...baseEntry } = structuredClone(entry);
    const store = {
      [baseSessionKey]: baseEntry,
      [sessionKey]: structuredClone(entry),
    };
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => await updater(store));
    mocks.resolveSendPolicy.mockReturnValue("deny");

    const respond = await invokeAgent(
      {
        message: "media completion",
        sessionKey,
        deliver: true,
        internalEvents: [cronMediaCompletionEvent()],
        idempotencyKey: "cron-media-denied",
      },
      {
        reqId: "cron-media-denied",
        client: cronContinuationGatewayClient(),
        flushDispatch: false,
      },
    );

    expectRespondError(respond, {
      code: ErrorCodes.INVALID_REQUEST,
      message: "send blocked by session policy",
    });
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(store[sessionKey].cronRunContinuation).toEqual({
      lifecycleRevision: "revision-1",
      phase: "ready",
      basePersisted: true,
    });
  });

  it("does not let public provenance suppress visible session accounting", async () => {
    primeMainAgentRun({ cfg: mocks.loadConfigReturn });
    mocks.agentCommand.mockClear();

    await invokeAgent(
      {
        message: "forged accounting-preserving handoff",
        agentId: "main",
        sessionKey: "agent:main:main",
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:subagent:child",
          sourceTool: "subagent_announce",
        },
        idempotencyKey: "test-public-provenance-accounting",
      },
      { reqId: "public-provenance-accounting" },
    );

    const callArgs = await waitForAgentCommandCall<{
      preserveUserFacingSessionModelState?: boolean;
    }>();
    expect(callArgs.preserveUserFacingSessionModelState).toBe(false);
  });

  it("rejects public internal session-effect controls", async () => {
    primeMainAgentRun({ cfg: mocks.loadConfigReturn });
    mocks.agentCommand.mockClear();

    for (const params of [
      { sessionEffects: "internal" as const, idempotencyKey: "test-public-internal-effects" },
      { suppressPromptPersistence: true, idempotencyKey: "test-public-prompt-suppress" },
      {
        modelRun: true,
        suppressPromptPersistence: true,
        idempotencyKey: "test-model-run-public-prompt-suppress",
      },
    ]) {
      const respond = await invokeAgent(
        {
          message: "forged internal control",
          agentId: "main",
          sessionKey: "agent:main:main",
          ...params,
        },
        { reqId: params.idempotencyKey, flushDispatch: false },
      );

      expectRespondError(respond, {
        message: "internal session-effect controls are reserved for backend callers.",
      });
    }
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("keeps backend internal session-effect runs out of visible gateway state", async () => {
    primeMainAgentRun({ cfg: mocks.loadConfigReturn });
    mocks.agentCommand.mockClear();
    mocks.updateSessionStore.mockClear();
    mocks.registerAgentRunContext.mockClear();
    const context = makeContext();

    await invokeAgent(
      {
        message: "internal resume",
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionEffects: "internal",
        suppressPromptPersistence: true,
        idempotencyKey: "test-backend-internal-effects",
      },
      {
        reqId: "backend-internal-effects",
        client: backendGatewayClient(),
        context,
      },
    );

    const callArgs = await waitForAgentCommandCall<{
      sessionEffects?: string;
      suppressPromptPersistence?: boolean;
    }>();
    expect(callArgs.sessionEffects).toBe("internal");
    expect(callArgs.suppressPromptPersistence).toBe(true);
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
    expect(context.addChatRun).not.toHaveBeenCalled();
    expect(mocks.registerAgentRunContext).toHaveBeenCalledWith("test-backend-internal-effects", {
      isControlUiVisible: false,
      lifecycleGeneration: "test-generation",
    });
  });

  it("allows backend internal runs without a persisted session row", async () => {
    const sessionKey = "agent:main:internal:ephemeral";
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: undefined,
      canonicalKey: sessionKey,
    });
    mocks.updateSessionStore.mockClear();
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "internal ephemeral work",
        agentId: "main",
        sessionKey,
        sessionEffects: "internal",
        suppressPromptPersistence: true,
        idempotencyKey: "test-backend-internal-ephemeral",
      },
      {
        reqId: "backend-internal-ephemeral",
        client: backendGatewayClient(),
      },
    );

    const callArgs = await waitForAgentCommandCall<{ sessionId?: string; sessionKey?: string }>();
    expect(callArgs.sessionKey).toBe(sessionKey);
    expect(callArgs.sessionId).toEqual(expect.any(String));
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
  });

  it("forwards admin caller ownership to ingress agent runs", async () => {
    primeMainAgentRun({ cfg: mocks.loadConfigReturn });
    mocks.agentCommand.mockClear();

    await invokeAgent(
      {
        message: "owner tool check",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-admin-sender-owner",
      },
      {
        reqId: "admin-sender-owner",
        client: { connect: { scopes: ["operator.admin"] } } as AgentHandlerArgs["client"],
      },
    );

    expect((await waitForAgentCommandCall<{ senderIsOwner?: boolean }>()).senderIsOwner).toBe(true);

    mocks.agentCommand.mockClear();
    await invokeAgent(
      {
        message: "non-owner tool check",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-write-sender-owner",
      },
      {
        reqId: "write-sender-owner",
        client: backendGatewayClient(),
      },
    );

    expect((await waitForAgentCommandCall<{ senderIsOwner?: boolean }>()).senderIsOwner).toBe(
      false,
    );
  });

  it("enables Gateway-bound plugin runtimes for ingress agent runs", async () => {
    primeMainAgentRun({ cfg: mocks.loadConfigReturn });
    mocks.agentCommand.mockClear();

    await invokeAgent(
      {
        message: "plugin runtime check",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-gateway-plugin-runtime-binding",
      },
      {
        reqId: "gateway-plugin-runtime-binding",
        client: backendGatewayClient(),
      },
    );

    expect(
      (await waitForAgentCommandCall<{ allowGatewaySubagentBinding?: boolean }>())
        .allowGatewaySubagentBinding,
    ).toBe(true);
  });

  it("rejects public transcriptMessage overrides", async () => {
    primeMainAgentRun({ cfg: mocks.loadConfigReturn });
    mocks.agentCommand.mockClear();

    const respond = await invokeAgent(
      {
        message: "runtime-only announce bookkeeping",
        transcriptMessage: "",
        agentId: "main",
        sessionKey: "agent:main:main",
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:discord:source",
          sourceTool: "sessions_send",
        },
        idempotencyKey: "test-transcript-message",
      } as AgentParams,
      { reqId: "transcript-message", flushDispatch: false },
    );

    const error = expectRespondError(respond, {});
    expectStringFieldContains(error, "message", "invalid agent params");
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("logs attachment parse failures with stack details", async () => {
    primeMainAgentRun();
    mocks.agentCommand.mockClear();
    const context = makeContext();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "inspect this",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-agent-attachment-parse-stack",
        attachments: [
          {
            type: "file",
            mimeType: "image/png",
            fileName: "broken.png",
            content: "not-base64",
          },
        ],
      },
      { respond, context, reqId: "agent-attachment-parse-stack", flushDispatch: false },
    );

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    const error = expectRespondError(respond, {});
    expectStringFieldContains(error, "message", "attachment broken.png: invalid base64 content");
    const logError = context.logGateway.error as unknown as ReturnType<typeof vi.fn>;
    expect(mockCallArg(logError)).toBe("agent attachment parse failed");
    const logMeta = mockCallArg(logError, 0, 1) as Record<string, unknown>;
    expectStringFieldContains(
      logMeta,
      "consoleMessage",
      "agent attachment parse failed: Error: attachment broken.png",
    );
    expectStringFieldContains(
      logMeta,
      "error",
      "Error: attachment broken.png: invalid base64 content",
    );
    expectStringFieldContains(logMeta, "error", "\n    at ");
  });

  it("keeps model-run gateway prompts undecorated and forwards raw-run flags", async () => {
    setupNewYorkTimeConfig("2026-01-29T01:30:00.000Z");
    primeMainAgentRun({ cfg: mocks.loadConfigReturn });

    await invokeAgent(
      {
        message: "Reply exactly: pong",
        agentId: "main",
        provider: "ollama",
        model: "llama3.2:latest",
        modelRun: true,
        promptMode: "none",
        sessionKey: "agent:main:main",
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:discord:source",
          sourceTool: "sessions_send",
        },
        idempotencyKey: "test-model-run-raw",
      },
      {
        reqId: "model-run-raw",
        client: { connect: { scopes: ["operator.admin"] } } as AgentHandlerArgs["client"],
      },
    );

    const callArgs = await waitForAgentCommandCall<{
      message?: string;
      modelRun?: boolean;
      promptMode?: string;
    }>();
    expectRecordFields(callArgs, {
      message: "Reply exactly: pong",
      modelRun: true,
      promptMode: "none",
    });
    expect(callArgs.message).not.toContain("[Inter-session message]");

    resetTimeConfig();
  });

  it("forwards continuation metadata to the ingress agent command for backend callers", async () => {
    primeMainAgentRun();

    await invokeAgent(
      {
        message: "delegate finished",
        agentId: "main",
        sessionKey: "agent:main:main",
        continuationTrigger: "delegate-return",
        drainsContinuationDelegateQueue: true,
        idempotencyKey: "test-continuation-trigger-forward",
      },
      { reqId: "continuation-trigger-1", client: backendGatewayClient() },
    );

    await vi.waitFor(() => expect(mocks.agentCommand).toHaveBeenCalled());
    const call = mocks.agentCommand.mock.calls.at(-1)?.[0] as
      | { continuationTrigger?: string; drainsContinuationDelegateQueue?: boolean }
      | undefined;
    expect(call?.continuationTrigger).toBe("delegate-return");
    expect(call?.drainsContinuationDelegateQueue).toBe(true);
  });

  it("ignores internal continuation controls from non-backend callers", async () => {
    primeMainAgentRun();

    await invokeAgent(
      {
        message: "delegate finished",
        agentId: "main",
        sessionKey: "agent:main:main",
        continuationTrigger: "delegate-return",
        drainsContinuationDelegateQueue: true,
        traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
        idempotencyKey: "test-continuation-trigger-non-backend",
      },
      { reqId: "continuation-trigger-non-backend", client: operatorWriteGatewayClient() },
    );

    await vi.waitFor(() => expect(mocks.agentCommand).toHaveBeenCalled());
    const call = mocks.agentCommand.mock.calls.at(-1)?.[0] as
      | {
          continuationTrigger?: string;
          drainsContinuationDelegateQueue?: boolean;
          traceparent?: string;
        }
      | undefined;
    // Raw RPC clients cannot force continuation queue-drain / heartbeat-like
    // semantics or inject trace context (these fields are backend-only).
    expect(call?.continuationTrigger).toBeUndefined();
    expect(call?.drainsContinuationDelegateQueue).toBeUndefined();
    expect(call?.traceparent).toBeUndefined();
  });

  it("preserves core-spawned continuation controls with same-process traceparent handoff", async () => {
    primeMainAgentRun();
    const sessionKey = "agent:main:subagent:trusted-continuation";
    const idempotencyKey = "trusted-continuation-handoff";
    const traceparent = "00-2af7651916cd43dd8448eb211c80319c-d7ad6b7169203331-01";
    registerSubagentTraceparentHandoff({ idempotencyKey, sessionKey, traceparent });
    const existingEntry = buildExistingMainStoreEntry({
      spawnedBy: "agent:main:main",
    });
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: existingEntry,
      canonicalKey: sessionKey,
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, Record<string, unknown>> = {
        [sessionKey]: { ...existingEntry },
      };
      return await updater(store);
    });

    await invokeAgent(
      {
        message: "trusted continuation child",
        agentId: "main",
        sessionKey,
        continuationTrigger: "delegate-return",
        drainsContinuationDelegateQueue: true,
        idempotencyKey,
      },
      { reqId: "trusted-continuation-handoff", client: operatorWriteGatewayClient() },
    );

    const call = (await waitForAgentCommandCall()) as
      | {
          continuationTrigger?: string;
          drainsContinuationDelegateQueue?: boolean;
          traceparent?: string;
        }
      | undefined;
    expect(call?.continuationTrigger).toBe("delegate-return");
    expect(call?.drainsContinuationDelegateQueue).toBe(true);
    expect(call?.traceparent).toBe(traceparent);
  });

  it("honors a request traceparent from backend callers", async () => {
    primeMainAgentRun();
    const traceparent = "00-1af7651916cd43dd8448eb211c80319c-c7ad6b7169203331-01";

    await invokeAgent(
      {
        message: "delegate finished",
        agentId: "main",
        sessionKey: "agent:main:main",
        traceparent,
        idempotencyKey: "test-continuation-traceparent-backend",
      },
      { reqId: "continuation-traceparent-backend", client: backendGatewayClient() },
    );

    await vi.waitFor(() => expect(mocks.agentCommand).toHaveBeenCalled());
    const call = mocks.agentCommand.mock.calls.at(-1)?.[0] as { traceparent?: string } | undefined;
    expect(call?.traceparent).toBe(traceparent);
  });

  it.each([
    {
      name: "passes senderIsOwner=false for write-scoped gateway callers",
      scopes: ["operator.write"],
      idempotencyKey: "test-sender-owner-write",
      senderIsOwner: false,
    },
    {
      name: "passes senderIsOwner=true for admin-scoped gateway callers",
      scopes: ["operator.admin"],
      idempotencyKey: "test-sender-owner-admin",
      senderIsOwner: true,
    },
  ])("$name", async ({ scopes, idempotencyKey, senderIsOwner }) => {
    primeMainAgentRun();

    await invokeAgent(
      {
        message: "owner-tools check",
        sessionKey: "agent:main:main",
        idempotencyKey,
      },
      {
        client: {
          connect: {
            role: "operator",
            scopes,
            client: { id: "test-client", mode: "gateway" },
          },
        } as unknown as AgentHandlerArgs["client"],
      },
    );

    const callArgs = await waitForAgentCommandCall<{ senderIsOwner?: boolean }>();
    expect(callArgs.senderIsOwner).toBe(senderIsOwner);
  });

  it("rejects promptMode none without the stateless model-run contract", async () => {
    primeMainAgentRun({ cfg: mocks.loadConfigReturn });
    mocks.agentCommand.mockClear();

    const respond = await invokeAgent(
      {
        message: "unsafe raw run",
        agentId: "main",
        sessionKey: "agent:main:main",
        promptMode: "none",
        idempotencyKey: "test-raw-run-with-visible-session-effects",
      },
      { reqId: "raw-run-with-visible-session-effects", flushDispatch: false },
    );

    expectRespondError(respond, {
      code: ErrorCodes.INVALID_REQUEST,
      message:
        'promptMode="none" requires modelRun=true so the run cannot mutate a durable session.',
    });
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("keeps CLI model runs out of durable and visible gateway state", async () => {
    const sessionId = "model-run-123e4567-e89b-12d3-a456-426614174000";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: undefined,
      canonicalKey: sessionKey,
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "pong" }],
      meta: { durationMs: 100 },
    });
    mocks.updateSessionStore.mockClear();
    mocks.registerAgentRunContext.mockClear();
    mocks.getLatestSubagentRunByChildSessionKey.mockClear();
    mocks.replaceSubagentRunAfterSteer.mockClear();

    const defaultRuntime = getDetachedTaskLifecycleRuntime();
    const createRunningTaskRunSpy = vi.fn(
      (...args: Parameters<typeof defaultRuntime.createRunningTaskRun>) =>
        defaultRuntime.createRunningTaskRun(...args),
    );
    setDetachedTaskLifecycleRuntime({
      ...defaultRuntime,
      createRunningTaskRun: createRunningTaskRunSpy,
    });

    const context = makeContext();
    context.getSessionEventSubscriberConnIds = () => new Set(["conn-1"]);
    await invokeAgent(
      {
        message: "Reply exactly: pong",
        agentId: "main",
        sessionId,
        sessionKey,
        modelRun: true,
        promptMode: "none",
        idempotencyKey: "test-stateless-model-run",
      },
      {
        reqId: "stateless-model-run",
        client: operatorWriteCliClient(),
        context,
      },
    );

    const callArgs = await waitForAgentCommandCall<{
      modelRun?: boolean;
      promptMode?: string;
      sessionEffects?: string;
    }>();
    expectRecordFields(callArgs, {
      modelRun: true,
      promptMode: "none",
      sessionEffects: "internal",
    });
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
    expect(context.addChatRun).not.toHaveBeenCalled();
    expect(createRunningTaskRunSpy).not.toHaveBeenCalled();
    expect(context.broadcastToConnIds).not.toHaveBeenCalled();
    expect(mocks.getLatestSubagentRunByChildSessionKey).not.toHaveBeenCalled();
    expect(mocks.replaceSubagentRunAfterSteer).not.toHaveBeenCalled();
    expect(mocks.registerAgentRunContext).toHaveBeenCalledWith("test-stateless-model-run", {
      isControlUiVisible: false,
      lifecycleGeneration: "test-generation",
    });
  });

  it("respects explicit bestEffortDeliver=false for main session runs", async () => {
    mocks.agentCommand.mockClear();
    primeMainAgentRun();

    await invokeAgent(
      {
        message: "strict delivery",
        agentId: "main",
        sessionKey: "agent:main:main",
        deliver: true,
        replyChannel: "telegram",
        to: "123",
        bestEffortDeliver: false,
        idempotencyKey: "test-strict-delivery",
      },
      { reqId: "strict-1" },
    );

    const callArgs = await waitForAgentCommandCall();
    expect(callArgs.bestEffortDeliver).toBe(false);
  });

  it("rejects strict delivery with a missing target before dispatching the agent", async () => {
    mocks.agentCommand.mockClear();
    primeMainAgentRun();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "strict missing delivery target",
        agentId: "main",
        sessionKey: "agent:main:main",
        deliver: true,
        replyChannel: "telegram",
        bestEffortDeliver: false,
        idempotencyKey: "test-strict-delivery-missing-target",
      },
      {
        reqId: "strict-delivery-missing-target",
        respond,
        flushDispatch: false,
      },
    );

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    const error = expectRespondError(respond, {});
    expectStringFieldContains(error, "message", "requires target");
  });

  it("downgrades to session-only when bestEffortDeliver=true and no external channel is configured", async () => {
    mocks.agentCommand.mockClear();
    primeMainAgentRun();
    const respond = vi.fn();
    const logInfo = vi.fn();

    await invokeAgent(
      {
        message: "best effort delivery fallback",
        agentId: "main",
        sessionKey: "agent:main:main",
        deliver: true,
        bestEffortDeliver: true,
        idempotencyKey: "test-best-effort-delivery-fallback",
      },
      {
        reqId: "best-effort-delivery-fallback",
        respond,
        context: {
          dedupe: new Map(),
          addChatRun: vi.fn(),
          chatAbortControllers: new Map(),
          logGateway: { info: logInfo, error: vi.fn() },
          broadcastToConnIds: vi.fn(),
          getSessionEventSubscriberConnIds: () => new Set(),
          getRuntimeConfig: () => mocks.loadConfigReturn,
        } as unknown as GatewayRequestContext,
      },
    );

    await waitForAgentCommandCall();
    const accepted = respond.mock.calls.find(
      (call: unknown[]) =>
        call[0] === true && (call[1] as Record<string, unknown>)?.status === "accepted",
    );
    expectRecordFields(requireValue(accepted, "accepted response missing")[1], {
      status: "accepted",
    });
    const rejected = respond.mock.calls.find((call: unknown[]) => call[0] === false);
    expect(rejected).toBeUndefined();
    expect(logInfo).toHaveBeenCalledTimes(1);
    expect(mockCallArg(logInfo)).toContain(
      "agent delivery downgraded to session-only (bestEffortDeliver)",
    );
  });

  it("rejects public spawned-run metadata fields", async () => {
    primeMainAgentRun();
    mocks.agentCommand.mockClear();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "spawned run",
        sessionKey: "agent:main:main",
        spawnedBy: "agent:main:subagent:parent",
        workspaceDir: "/tmp/injected",
        idempotencyKey: "workspace-rejected",
      } as AgentParams,
      { reqId: "workspace-rejected-1", respond },
    );

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    const error = expectRespondError(respond, {});
    expectStringFieldContains(error, "message", "invalid agent params");
  });

  it("forwards one-shot bundle MCP cleanup from agent RPC into the runner", async () => {
    primeMainAgentRun();
    mocks.agentCommand.mockClear();

    await invokeAgent({
      message: "cleanup probe",
      sessionKey: "agent:main:subagent:cleanup-probe",
      idempotencyKey: "test-idem-agent-cleanup-bundle-mcp",
      cleanupBundleMcpOnRunEnd: true,
    });

    const call = await waitForAgentCommandCall();
    expect(call.cleanupBundleMcpOnRunEnd).toBe(true);
  });

  it.each(
    (["channel", "replyChannel"] as const).flatMap((field) =>
      (["heartbeat", "cron", "webhook", "voice"] as const).map(
        (channel) => [field, channel] as const,
      ),
    ),
  )("accepts internal non-delivery %s hint %s", async (field, channel) => {
    primeMainAgentRun();
    mocks.agentCommand.mockClear();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "spawn from internal source",
        agentId: "main",
        sessionKey: "agent:main:main",
        [field]: channel,
        idempotencyKey: `internal-channel-${field}-${channel}`,
      } as AgentParams,
      { reqId: `internal-channel-${field}-${channel}-1`, respond },
    );

    const rejection = respond.mock.calls.find(
      (call: unknown[]) =>
        call[0] === false &&
        typeof (call[2] as { message?: string } | undefined)?.message === "string" &&
        (call[2] as { message: string }).message.includes("unknown channel"),
    );
    expect(rejection).toBeUndefined();
  });

  it.each(["channel", "replyChannel"] as const)("rejects unknown %s hints", async (field) => {
    primeMainAgentRun();
    mocks.agentCommand.mockClear();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "bogus channel",
        agentId: "main",
        sessionKey: "agent:main:main",
        [field]: "not-a-real-channel",
        idempotencyKey: `unknown-${field}`,
      } as AgentParams,
      { reqId: `unknown-${field}-1`, respond },
    );

    const error = expectRespondError(respond, {});
    expectStringFieldContains(error, "message", "unknown channel: not-a-real-channel");
  });

  it("keeps voice-originated followups on the voice message channel without delivery", async () => {
    mockMainSessionEntry({ sessionId: "voice-session-id" });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "exec approval followup",
        sessionKey: "agent:main:main",
        channel: "voice",
        deliver: false,
        idempotencyKey: "exec-approval-followup:req-voice",
      } as AgentParams,
      { reqId: "exec-approval-followup-voice-1", client: backendGatewayClient() },
    );

    const callArgs = await waitForAgentCommandCall<{
      channel?: string;
      deliver?: boolean;
      messageChannel?: string;
      runContext?: { messageChannel?: string };
    }>();
    expect(callArgs.channel).toBe("voice");
    expect(callArgs.deliver).toBe(false);
    expect(callArgs.messageChannel).toBe("voice");
    expect(callArgs.runContext?.messageChannel).toBe("voice");
  });

  it("accepts music generation internal events", async () => {
    primeMainAgentRun();
    mocks.agentCommand.mockClear();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "music generation finished",
        sessionKey: "agent:main:main",
        internalEvents: [
          {
            type: "task_completion",
            source: "music_generation",
            childSessionKey: "music:task-123",
            childSessionId: "task-123",
            announceType: "music generation task",
            taskLabel: "compose a loop",
            status: "ok",
            statusLabel: "completed successfully",
            result: "MEDIA: https://example.test/song.mp3",
            replyInstruction: "Reply in your normal assistant voice now.",
          },
        ],
        idempotencyKey: "music-generation-event",
      },
      { reqId: "music-generation-event-1", respond },
    );

    await waitForAgentCommandCall();
    const rejection = respond.mock.calls.find((call: unknown[]) => call[0] === false);
    expect(rejection).toBeUndefined();
  });

  it("does not create task rows for inter-session completion wakes", async () => {
    primeMainAgentRun();
    mocks.agentCommand.mockClear();

    await invokeAgent(
      {
        message: [
          "[Mon 2026-04-06 02:42 GMT+1] <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
          "OpenClaw runtime context (internal):",
          "This context is runtime-generated, not user-authored. Keep internal details private.",
        ].join("\n"),
        sessionKey: "agent:main:main",
        internalEvents: [
          {
            type: "task_completion",
            source: "music_generation",
            childSessionKey: "music:task-123",
            childSessionId: "task-123",
            announceType: "music generation task",
            taskLabel: "compose a loop",
            status: "ok",
            statusLabel: "completed successfully",
            result: "MEDIA:/tmp/song.mp3",
            replyInstruction: "Reply in your normal assistant voice now.",
          },
        ],
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "music_generate:task-123",
          sourceChannel: "internal",
          sourceTool: "music_generate",
        },
        idempotencyKey: "music-generation-event-inter-session",
      },
      { reqId: "music-generation-event-inter-session" },
    );

    await waitForAgentCommandCall();
    expect(findTaskByRunId("music-generation-event-inter-session")).toBeUndefined();
  });

  it("only forwards workspaceDir for spawned sessions with stored workspace inheritance", async () => {
    primeMainAgentRun();
    mockMainSessionEntry({
      spawnedBy: "agent:main:subagent:parent",
      spawnedWorkspaceDir: "/tmp/inherited",
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:main": buildExistingMainStoreEntry({
          spawnedBy: "agent:main:subagent:parent",
          spawnedWorkspaceDir: "/tmp/inherited",
        }),
      };
      return await updater(store);
    });
    mocks.agentCommand.mockClear();

    await invokeAgent(
      {
        message: "spawned run",
        sessionKey: "agent:main:main",
        idempotencyKey: "workspace-forwarded",
      },
      { reqId: "workspace-forwarded-1" },
    );
    const spawnedCall = await waitForAgentCommandCall<{ workspaceDir?: string }>();
    expect(spawnedCall.workspaceDir).toBe("/tmp/inherited");
  });

  it("forwards spawnedCwd as runtime cwd for spawned sessions", async () => {
    primeMainAgentRun();
    mockMainSessionEntry({
      spawnedBy: "agent:main:subagent:parent",
      spawnedWorkspaceDir: "/tmp/inherited",
      spawnedCwd: "/tmp/task-repo",
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:main": buildExistingMainStoreEntry({
          spawnedBy: "agent:main:subagent:parent",
          spawnedWorkspaceDir: "/tmp/inherited",
          spawnedCwd: "/tmp/task-repo",
        }),
      };
      return await updater(store);
    });
    mocks.agentCommand.mockClear();

    await invokeAgent(
      {
        message: "spawned run",
        sessionKey: "agent:main:main",
        idempotencyKey: "cwd-forwarded",
      },
      { reqId: "cwd-forwarded-1" },
    );
    const spawnedCall = await waitForAgentCommandCall<{ cwd?: string; workspaceDir?: string }>();
    expect(spawnedCall.workspaceDir).toBe("/tmp/inherited");
    expect(spawnedCall.cwd).toBe("/tmp/task-repo");
  });

  it("uses a managed dashboard worktree as both workspace and runtime cwd", async () => {
    primeMainAgentRun();
    mockMainSessionEntry({ spawnedCwd: "/tmp/session-worktree" });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:main": buildExistingMainStoreEntry({
          spawnedCwd: "/tmp/session-worktree",
        }),
      };
      return await updater(store);
    });
    mocks.agentCommand.mockClear();

    await invokeAgent(
      {
        message: "worktree run",
        sessionKey: "agent:main:main",
        idempotencyKey: "worktree-workspace-forwarded",
      },
      { reqId: "worktree-workspace-forwarded-1" },
    );
    const worktreeCall = await waitForAgentCommandCall<{
      cwd?: string;
      workspaceDir?: string;
    }>();
    expect(worktreeCall.workspaceDir).toBe("/tmp/session-worktree");
    expect(worktreeCall.cwd).toBe("/tmp/session-worktree");
  });

  it("keeps origin messageChannel as webchat while delivery channel uses last session channel", async () => {
    mockMainSessionEntry({
      sessionId: "existing-session-id",
      lastChannel: "telegram",
      lastTo: "12345",
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:main": buildExistingMainStoreEntry({
          lastChannel: "telegram",
          lastTo: "12345",
        }),
      };
      return await updater(store);
    });

    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "webchat turn",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-webchat-origin-channel",
      },
      {
        reqId: "webchat-origin-1",
        client: {
          connect: {
            client: { id: "webchat-ui", mode: "webchat" },
          },
        } as AgentHandlerArgs["client"],
        isWebchatConnect: () => true,
      },
    );

    const callArgs = await waitForAgentCommandCall<{
      channel?: string;
      messageChannel?: string;
      runContext?: { messageChannel?: string };
    }>();
    expect(callArgs.channel).toBe("telegram");
    expect(callArgs.messageChannel).toBe("webchat");
    expect(callArgs.runContext?.messageChannel).toBe("webchat");
  });

  it("forwards elevated defaults only for valid exec approval runtime handoffs", async () => {
    const bashElevated = {
      enabled: true,
      allowed: true,
      defaultLevel: "on" as const,
    };
    const registration = registerExecApprovalFollowupRuntimeHandoff({
      approvalId: "req-elevated-75832",
      sessionKey: "agent:main:telegram:direct:123",
      bashElevated,
    });
    if (!registration) {
      throw new Error("expected runtime handoff id");
    }
    mockMainSessionEntry({
      sessionId: "existing-session-id",
      lastChannel: "telegram",
      lastTo: "123",
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "exec followup",
        sessionKey: "agent:main:telegram:direct:123",
        channel: "telegram",
        idempotencyKey: registration.idempotencyKey,
        internalRuntimeHandoffId: registration.handoffId,
      },
      { reqId: "exec-followup-elevated", client: backendGatewayClient() },
    );

    const callArgs = await waitForAgentCommandCall<{ bashElevated?: unknown }>();
    expect(callArgs.bashElevated).toEqual(bashElevated);
  });

  it("dedupes elevated exec approval followups across nonce idempotency keys", async () => {
    const bashElevated = {
      enabled: true,
      allowed: true,
      defaultLevel: "on" as const,
    };
    const firstRegistration = registerExecApprovalFollowupRuntimeHandoff({
      approvalId: "req-elevated-duplicate",
      sessionKey: "agent:main:telegram:direct:123",
      bashElevated,
    });
    const secondRegistration = registerExecApprovalFollowupRuntimeHandoff({
      approvalId: "req-elevated-duplicate",
      sessionKey: "agent:main:telegram:direct:123",
      bashElevated,
    });
    if (!firstRegistration || !secondRegistration) {
      throw new Error("expected runtime handoff ids");
    }
    mockMainSessionEntry({
      sessionId: "existing-session-id",
      lastChannel: "telegram",
      lastTo: "123",
    });
    mocks.agentCommand.mockImplementation(() => new Promise(() => {}));
    const context = makeContext();
    const agentCommandCallsBefore = mocks.agentCommand.mock.calls.length;

    await invokeAgent(
      {
        message: "exec followup",
        sessionKey: "agent:main:telegram:direct:123",
        channel: "telegram",
        idempotencyKey: firstRegistration.idempotencyKey,
        internalRuntimeHandoffId: firstRegistration.handoffId,
      },
      { reqId: "exec-followup-duplicate-1", client: backendGatewayClient(), context },
    );
    expect(mocks.agentCommand).toHaveBeenCalledTimes(agentCommandCallsBefore + 1);

    const secondRespond = await invokeAgent(
      {
        message: "exec followup duplicate",
        sessionKey: "agent:main:telegram:direct:123",
        channel: "telegram",
        idempotencyKey: secondRegistration.idempotencyKey,
        internalRuntimeHandoffId: secondRegistration.handoffId,
      },
      {
        reqId: "exec-followup-duplicate-2",
        client: backendGatewayClient(),
        context,
        flushDispatch: false,
      },
    );
    await flushScheduledDispatchStep();
    await flushScheduledDispatchStep();

    expect(mocks.agentCommand).toHaveBeenCalledTimes(agentCommandCallsBefore + 1);
    expect(mockCallArg(secondRespond, 0, 3)).toEqual({
      cached: true,
      runId: firstRegistration.idempotencyKey,
    });
  });

  it("reserves exec approval followup dedupe before awaited session work", async () => {
    const bashElevated = {
      enabled: true,
      allowed: true,
      defaultLevel: "on" as const,
    };
    const firstRegistration = registerExecApprovalFollowupRuntimeHandoff({
      approvalId: "req-elevated-overlap",
      sessionKey: "agent:main:telegram:direct:123",
      bashElevated,
    });
    const secondRegistration = registerExecApprovalFollowupRuntimeHandoff({
      approvalId: "req-elevated-overlap",
      sessionKey: "agent:main:telegram:direct:123",
      bashElevated,
    });
    if (!firstRegistration || !secondRegistration) {
      throw new Error("expected runtime handoff ids");
    }
    mockMainSessionEntry({
      sessionId: "existing-session-id",
      lastChannel: "telegram",
      lastTo: "123",
    });
    let releaseFirstSessionWrite: (() => void) | undefined;
    let sessionWriteCalls = 0;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      sessionWriteCalls += 1;
      if (sessionWriteCalls === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstSessionWrite = resolve;
        });
      }
      const store = {
        "agent:main:main": buildExistingMainStoreEntry({
          lastChannel: "telegram",
          lastTo: "123",
        }),
      };
      return await updater(store);
    });
    mocks.agentCommand.mockImplementation(() => new Promise(() => {}));
    const context = makeContext();
    const agentCommandCallsBefore = mocks.agentCommand.mock.calls.length;

    const first = invokeAgent(
      {
        message: "exec followup",
        sessionKey: "agent:main:telegram:direct:123",
        channel: "telegram",
        idempotencyKey: firstRegistration.idempotencyKey,
        internalRuntimeHandoffId: firstRegistration.handoffId,
      },
      {
        reqId: "exec-followup-overlap-1",
        client: backendGatewayClient(),
        context,
        flushDispatch: false,
      },
    );
    await waitForAssertion(() => expect(sessionWriteCalls).toBe(1));

    const secondRespond = await invokeAgent(
      {
        message: "exec followup duplicate",
        sessionKey: "agent:main:telegram:direct:123",
        channel: "telegram",
        idempotencyKey: secondRegistration.idempotencyKey,
        internalRuntimeHandoffId: secondRegistration.handoffId,
      },
      {
        reqId: "exec-followup-overlap-2",
        client: backendGatewayClient(),
        context,
        flushDispatch: false,
      },
    );

    expect(mocks.agentCommand).toHaveBeenCalledTimes(agentCommandCallsBefore);
    expect(sessionWriteCalls).toBe(1);
    expect(mockCallArg(secondRespond, 0, 1)).toMatchObject({
      runId: firstRegistration.idempotencyKey,
      status: "in_flight",
    });
    expect(mockCallArg(secondRespond, 0, 3)).toEqual({
      cached: true,
      runId: firstRegistration.idempotencyKey,
    });

    releaseFirstSessionWrite?.();
    await first;
    await flushScheduledDispatchStep();
    await flushScheduledDispatchStep();

    expect(mocks.agentCommand).toHaveBeenCalledTimes(agentCommandCallsBefore + 1);
  });

  it("clears reserved exec approval dedupe when pre-run session work fails", async () => {
    const bashElevated = {
      enabled: true,
      allowed: true,
      defaultLevel: "on" as const,
    };
    const firstRegistration = registerExecApprovalFollowupRuntimeHandoff({
      approvalId: "req-elevated-pre-run-fail",
      sessionKey: "agent:main:telegram:direct:123",
      bashElevated,
    });
    const secondRegistration = registerExecApprovalFollowupRuntimeHandoff({
      approvalId: "req-elevated-pre-run-fail",
      sessionKey: "agent:main:telegram:direct:123",
      bashElevated,
    });
    if (!firstRegistration || !secondRegistration) {
      throw new Error("expected runtime handoff ids");
    }
    mockMainSessionEntry({
      sessionId: "existing-session-id",
      lastChannel: "telegram",
      lastTo: "123",
    });
    const context = makeContext();
    const agentCommandCallsBefore = mocks.agentCommand.mock.calls.length;
    mocks.updateSessionStore.mockRejectedValueOnce(new Error("session write failed"));

    await expect(
      invokeAgent(
        {
          message: "exec followup",
          sessionKey: "agent:main:telegram:direct:123",
          channel: "telegram",
          idempotencyKey: firstRegistration.idempotencyKey,
          internalRuntimeHandoffId: firstRegistration.handoffId,
        },
        {
          reqId: "exec-followup-pre-run-fail-1",
          client: backendGatewayClient(),
          context,
          flushDispatch: false,
        },
      ),
    ).rejects.toThrow("session write failed");

    expect(context.dedupe.get(`agent:${firstRegistration.idempotencyKey}`)).toBeUndefined();
    expect(
      context.dedupe.get("agent:exec-approval-followup:req-elevated-pre-run-fail"),
    ).toBeUndefined();
    expect(mocks.agentCommand).toHaveBeenCalledTimes(agentCommandCallsBefore);

    const secondRespond = await invokeAgent(
      {
        message: "exec followup retry",
        sessionKey: "agent:main:telegram:direct:123",
        channel: "telegram",
        idempotencyKey: secondRegistration.idempotencyKey,
        internalRuntimeHandoffId: secondRegistration.handoffId,
      },
      {
        reqId: "exec-followup-pre-run-fail-2",
        client: backendGatewayClient(),
        context,
        flushDispatch: false,
      },
    );

    expect(mockCallArg(secondRespond, 0, 1)).toMatchObject({
      runId: secondRegistration.idempotencyKey,
      status: "accepted",
    });
    await flushScheduledDispatchStep();
    await flushScheduledDispatchStep();
    expect(mocks.agentCommand).toHaveBeenCalledTimes(agentCommandCallsBefore + 1);
  });

  it("does not consume exec approval runtime handoffs from non-backend callers", async () => {
    const bashElevated = {
      enabled: true,
      allowed: true,
      defaultLevel: "on" as const,
    };
    const registration = registerExecApprovalFollowupRuntimeHandoff({
      approvalId: "req-elevated-75832",
      sessionKey: "agent:main:telegram:direct:123",
      bashElevated,
    });
    if (!registration) {
      throw new Error("expected runtime handoff id");
    }
    mockMainSessionEntry({
      sessionId: "existing-session-id",
      lastChannel: "telegram",
      lastTo: "123",
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });
    const agentCommandCallsBefore = mocks.agentCommand.mock.calls.length;

    const respond = await invokeAgent(
      {
        message: "exec followup",
        sessionKey: "agent:main:telegram:direct:123",
        channel: "telegram",
        idempotencyKey: registration.idempotencyKey,
        internalRuntimeHandoffId: registration.handoffId,
      },
      { reqId: "exec-followup-non-backend", flushDispatch: false },
    );

    expect(mocks.agentCommand).toHaveBeenCalledTimes(agentCommandCallsBefore);
    expectRespondError(respond, {
      message: "exec approval followup idempotency keys are reserved for backend callers.",
    });
  });

  it("drops a stale exec approval followup at preflight without touching the rebound session (#59349)", async () => {
    const bashElevated = {
      enabled: true,
      allowed: true,
      defaultLevel: "on" as const,
    };
    const registration = registerExecApprovalFollowupRuntimeHandoff({
      approvalId: "req-rebound-followup",
      sessionKey: "agent:main:telegram:direct:123",
      bashElevated,
    });
    if (!registration) {
      throw new Error("expected runtime handoff id");
    }
    // Session was rebound by /new or /reset: current sessionId differs from the
    // approval-time sessionId carried on the request.
    mockMainSessionEntry({
      sessionId: "current-session-after-reset",
      lastChannel: "telegram",
      lastTo: "123",
    });
    const context = makeContext();
    const diagnostics: DiagnosticEventPayload[] = [];
    onDiagnosticEvent((event) => {
      diagnostics.push(event);
    });
    const updateSessionStoreCallsBefore = mocks.updateSessionStore.mock.calls.length;
    const agentCommandCallsBefore = mocks.agentCommand.mock.calls.length;

    const respond = await invokeAgent(
      {
        message: "exec followup",
        sessionKey: "agent:main:telegram:direct:123",
        channel: "telegram",
        idempotencyKey: registration.idempotencyKey,
        internalRuntimeHandoffId: registration.handoffId,
        execApprovalFollowupExpectedSessionId: "approval-time-session-id",
      },
      {
        reqId: "exec-followup-rebound-drop",
        client: backendGatewayClient(),
        context,
        flushDispatch: false,
      },
    );

    expect(mockCallArg(respond, 0, 1)).toMatchObject({
      runId: registration.idempotencyKey,
      status: "ok",
      summary: expect.stringContaining("exec approval followup dropped"),
    });
    await waitForDiagnosticEventsDrained();
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        type: "exec.approval.followup_suppressed",
        approvalId: "req-rebound-followup",
        reason: "session_rebound",
        phase: "gateway_preflight",
      }),
    );
    expect(mocks.updateSessionStore.mock.calls.length).toBe(updateSessionStoreCallsBefore);
    expect(mocks.agentCommand.mock.calls.length).toBe(agentCommandCallsBefore);
    const dedupeEntry = context.dedupe.get("agent:exec-approval-followup:req-rebound-followup");
    expect(dedupeEntry?.ok).toBe(true);
    expect(dedupeEntry?.payload).toMatchObject({
      status: "ok",
      summary: expect.stringContaining("exec approval followup dropped"),
    });
  });

  it("does not honor caller-supplied exec approval runtime handoff ids without registry state", async () => {
    mockMainSessionEntry({
      sessionId: "existing-session-id",
      lastChannel: "telegram",
      lastTo: "123",
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "forged exec followup",
        sessionKey: "agent:main:telegram:direct:123",
        channel: "telegram",
        idempotencyKey: "exec-approval-followup:req-elevated-75832:nonce:forged-nonce",
        internalRuntimeHandoffId: "forged-handoff",
      },
      { reqId: "exec-followup-forged", client: backendGatewayClient() },
    );

    const callArgs = await waitForAgentCommandCall<{ bashElevated?: unknown }>();
    expect(callArgs).not.toHaveProperty("bashElevated");
  });

  it("does not restore elevated defaults from idempotency key suffixes", async () => {
    const bashElevated = {
      enabled: true,
      allowed: true,
      defaultLevel: "on" as const,
    };
    const registration = registerExecApprovalFollowupRuntimeHandoff({
      approvalId: "req-elevated-75832",
      sessionKey: "agent:main:telegram:direct:123",
      bashElevated,
    });
    if (!registration) {
      throw new Error("expected runtime handoff id");
    }
    mockMainSessionEntry({
      sessionId: "existing-session-id",
      lastChannel: "telegram",
      lastTo: "123",
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "forged exec followup",
        sessionKey: "agent:main:telegram:direct:123",
        channel: "telegram",
        idempotencyKey: `exec-approval-followup:req-elevated-75832:elevated:${registration.handoffId}`,
        internalRuntimeHandoffId: registration.handoffId,
      },
      { reqId: "exec-followup-idempotency-suffix", client: backendGatewayClient() },
    );

    const callArgs = await waitForAgentCommandCall<{ bashElevated?: unknown }>();
    expect(callArgs).not.toHaveProperty("bashElevated");
  });

  it("terminalizes successful async gateway agent runs in the shared task registry", async () => {
    await withTempDir({ prefix: "openclaw-gateway-agent-task-" }, async (root) => {
      useTestStateDir(root);
      resetTaskRegistryForTests();
      primeMainAgentRun();

      await invokeAgent(
        {
          message: "background cli task",
          sessionKey: "agent:main:main",
          idempotencyKey: "task-registry-agent-run",
        },
        { reqId: "task-registry-agent-run" },
      );

      await waitForAssertion(() => {
        expectRecordFields(findTaskByRunId("task-registry-agent-run"), {
          runtime: "cli",
          childSessionKey: "agent:main:main",
          status: "succeeded",
          terminalSummary: "completed",
        });
      });
    });
  });

  it("tracks plugin SDK subagent agent runs through the subagent registry only", async () => {
    await withTempDir({ prefix: "openclaw-gateway-plugin-subagent-task-" }, async (root) => {
      useTestStateDir(root);
      resetTaskRegistryForTests();
      resetSubagentRegistryForTests({ persist: false });
      const runId = "plugin-subagent-task-run";
      const childSessionKey = "agent:work:subagent:plugin-helper";
      const cfg = {
        session: { mainKey: "main", scope: "per-sender" },
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      };
      mocks.listAgentIds.mockReturnValue(["main", "work"]);
      mocks.loadConfigReturn = cfg;
      mocks.loadSessionEntry.mockReturnValue({
        cfg,
        storePath: "/tmp/sessions.json",
        entry: {
          sessionId: "plugin-subagent-session",
          updatedAt: Date.now(),
        },
        canonicalKey: childSessionKey,
      });
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        const store: Record<string, unknown> = {
          [childSessionKey]: {
            sessionId: "plugin-subagent-session",
            updatedAt: Date.now(),
          },
        };
        return await updater(store);
      });
      mocks.agentCommand.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      });
      const context = makeContext();
      const baseClient = requireValue(backendGatewayClient(), "expected backend client");
      const pluginClient: AgentHandlerArgs["client"] = {
        connect: baseClient.connect,
        internal: {
          ...baseClient.internal,
          agentRunTracking: "plugin_subagent",
          pluginRuntimeOwnerId: "memory-core",
        },
      };

      await invokeAgent(
        {
          message: "background plugin subagent task",
          sessionKey: childSessionKey,
          idempotencyKey: runId,
        },
        {
          context,
          reqId: runId,
          client: pluginClient,
        },
      );

      await waitForAssertion(() => {
        const tasks = listTaskRecords().filter((task) => task.runId === runId);
        expect(tasks).toHaveLength(1);
        const task = requireValue(tasks[0], "expected one plugin subagent task");
        expectRecordFields(task, {
          runtime: "subagent",
          childSessionKey,
          ownerKey: "agent:work:main",
          label: "plugin:memory-core",
          task: "background plugin subagent task",
          deliveryStatus: "not_applicable",
        });
        expect(task.runtime).not.toBe("cli");
      });

      await waitForAssertion(() => {
        expectRecordFields(getSubagentRunByChildSessionKey(childSessionKey), {
          cleanupCompletedAt: expect.any(Number),
        });
      });
      const run = requireValue(
        getSubagentRunByChildSessionKey(childSessionKey),
        "expected subagent registry run",
      );
      expectRecordFields(run, {
        runId,
        childSessionKey,
        controllerSessionKey: "agent:work:main",
        requesterSessionKey: "agent:work:main",
        requesterDisplayKey: "main",
        cleanup: "keep",
        spawnMode: "run",
        label: "plugin:memory-core",
      });
      expectRecordFields(run.completion, { required: false });
      expectRecordFields(run.delivery, { status: "not_required" });

      const commandCallCount = mocks.agentCommand.mock.calls.length;
      const createdAt = run.createdAt;
      await invokeAgent(
        {
          message: "background plugin subagent task",
          sessionKey: childSessionKey,
          idempotencyKey: runId,
        },
        {
          context,
          reqId: `${runId}-retry`,
          client: pluginClient,
        },
      );

      expect(mocks.agentCommand).toHaveBeenCalledTimes(commandCallCount);
      const retryTasks = listTaskRecords().filter((task) => task.runId === runId);
      expect(retryTasks).toHaveLength(1);
      expect(getSubagentRunByChildSessionKey(childSessionKey)?.createdAt).toBe(createdAt);
    });
  });

  it("keeps plugin SDK subagent runs best-effort when registry persistence fails", async () => {
    await withTempDir(
      { prefix: "openclaw-gateway-plugin-subagent-registry-fail-" },
      async (root) => {
        useTestStateDir(root);
        resetTaskRegistryForTests();
        resetSubagentRegistryForTests({ persist: false });
        subagentRegistryTesting.setDepsForTest({
          persistSubagentRunsToDiskOrThrow: () => {
            throw new Error("disk full");
          },
        });
        const runId = "plugin-subagent-registry-fail";
        const childSessionKey = "agent:main:subagent:registry-fail";
        const cfg = {
          session: { mainKey: "main", scope: "per-sender" },
        };
        mocks.loadConfigReturn = cfg;
        mocks.loadSessionEntry.mockReturnValue({
          cfg,
          storePath: "/tmp/sessions.json",
          entry: {
            sessionId: "plugin-subagent-registry-fail-session",
            updatedAt: Date.now(),
          },
          canonicalKey: childSessionKey,
        });
        mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
          const store: Record<string, unknown> = {
            [childSessionKey]: {
              sessionId: "plugin-subagent-registry-fail-session",
              updatedAt: Date.now(),
            },
          };
          return await updater(store);
        });
        mocks.agentCommand.mockResolvedValue({
          payloads: [{ text: "ok" }],
          meta: { durationMs: 100 },
        });
        const context = makeContext();
        const baseClient = requireValue(backendGatewayClient(), "expected backend client");
        const commandCallCount = mocks.agentCommand.mock.calls.length;

        await invokeAgent(
          {
            message: "background plugin subagent task",
            sessionKey: childSessionKey,
            idempotencyKey: runId,
          },
          {
            context,
            reqId: runId,
            client: {
              connect: baseClient.connect,
              internal: {
                ...baseClient.internal,
                agentRunTracking: "plugin_subagent",
                pluginRuntimeOwnerId: "memory-core",
              },
            },
          },
        );

        expect(mocks.agentCommand).toHaveBeenCalledTimes(commandCallCount + 1);
        await waitForAssertion(() => {
          const task = requireValue(findTaskByRunId(runId), "expected fallback cli task");
          expectRecordFields(task, {
            runtime: "cli",
            childSessionKey,
            status: "succeeded",
            terminalSummary: "completed",
          });
        });
        expect(context.logGateway.warn).toHaveBeenCalledWith(
          expect.stringContaining("falling back to cli task tracking"),
        );
      },
    );
  });

  it("terminalizes failed async gateway agent runs in the shared task registry", async () => {
    await withTempDir({ prefix: "openclaw-gateway-agent-task-error-" }, async (root) => {
      useTestStateDir(root);
      resetTaskRegistryForTests();
      primeMainAgentRun();
      mocks.agentCommand.mockRejectedValueOnce(new Error("agent unavailable"));

      await invokeAgent(
        {
          message: "background cli task",
          sessionKey: "agent:main:main",
          idempotencyKey: "task-registry-agent-run-error",
        },
        { reqId: "task-registry-agent-run-error" },
      );

      await waitForAssertion(() => {
        expectRecordFields(findTaskByRunId("task-registry-agent-run-error"), {
          runtime: "cli",
          childSessionKey: "agent:main:main",
          status: "failed",
          error: "Error: agent unavailable",
        });
      });
    });
  });

  it("preserves aborted async gateway agent runs as timed out", async () => {
    await withTempDir({ prefix: "openclaw-gateway-agent-task-aborted-" }, async (root) => {
      useTestStateDir(root);
      resetTaskRegistryForTests();
      primeMainAgentRun();
      mocks.agentCommand.mockResolvedValueOnce({
        payloads: [],
        meta: { durationMs: 100, aborted: true },
      });
      const context = makeContext();

      await invokeAgent(
        {
          message: "background cli task",
          sessionKey: "agent:main:main",
          idempotencyKey: "task-registry-agent-run-aborted",
        },
        { context, reqId: "task-registry-agent-run-aborted" },
      );

      await waitForAssertion(() => {
        expectRecordFields(findTaskByRunId("task-registry-agent-run-aborted"), {
          runtime: "cli",
          childSessionKey: "agent:main:main",
          status: "timed_out",
          terminalSummary: "aborted",
        });
        expectRecordFields(context.dedupe.get("agent:task-registry-agent-run-aborted")?.payload, {
          runId: "task-registry-agent-run-aborted",
          status: "timeout",
          summary: "aborted",
        });
      });
    });
  });

  it("classifies aborted async gateway agent rejections as timed out", async () => {
    await withTempDir({ prefix: "openclaw-gateway-agent-task-abort-error-" }, async (root) => {
      useTestStateDir(root);
      resetTaskRegistryForTests();
      primeMainAgentRun();
      const abortError = new Error("This operation was aborted");
      abortError.name = "AbortError";
      const context = makeContext();
      const runId = "task-registry-agent-run-abort-error";
      // Abort the run's chat controller before the rejection bubbles so
      // isGatewayAgentAbortRejection sees signal.aborted=true. Without this
      // setup the test cannot distinguish operator-aborted runs from raw
      // AbortError rejections that originate inside the agent itself.
      mocks.agentCommand.mockImplementationOnce(() => {
        context.chatAbortControllers.get(runId)?.controller.abort();
        return Promise.reject(abortError);
      });

      await invokeAgent(
        {
          message: "background cli task",
          sessionKey: "agent:main:main",
          idempotencyKey: runId,
        },
        { context, reqId: runId },
      );

      await waitForAssertion(() => {
        expectRecordFields(findTaskByRunId("task-registry-agent-run-abort-error"), {
          runtime: "cli",
          childSessionKey: "agent:main:main",
          status: "timed_out",
          error: "AbortError: This operation was aborted",
        });
        expectRecordFields(
          context.dedupe.get("agent:task-registry-agent-run-abort-error")?.payload,
          {
            runId: "task-registry-agent-run-abort-error",
            status: "timeout",
            summary: "aborted",
            stopReason: "rpc",
          },
        );
      });
    });
  });

  it("preserves restart ownership for aborted async gateway agent rejections", async () => {
    await withTempDir({ prefix: "openclaw-gateway-agent-task-restart-abort-" }, async (root) => {
      useTestStateDir(root);
      resetTaskRegistryForTests();
      primeMainAgentRun();
      const abortError = createAgentRunRestartAbortError();
      const wrappedError = new Error("ACP turn failed before completion", {
        cause: abortError,
      });
      wrappedError.name = "AcpRuntimeError";
      const context = makeContext();
      const runId = "task-registry-agent-run-restart-abort";
      mocks.agentCommand.mockImplementationOnce(() => {
        context.chatAbortControllers.get(runId)?.controller.abort(abortError);
        return Promise.reject(wrappedError);
      });

      await invokeAgent(
        {
          message: "background cli task",
          sessionKey: "agent:main:main",
          idempotencyKey: runId,
        },
        { context, reqId: runId },
      );

      await waitForAssertion(() => {
        expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
          runId,
          status: "timeout",
          summary: "aborted",
          stopReason: "restart",
        });
      });
    });
  });

  it("classifies timeout async gateway agent rejections as timed out", async () => {
    await withTempDir({ prefix: "openclaw-gateway-agent-task-timeout-error-" }, async (root) => {
      useTestStateDir(root);
      resetTaskRegistryForTests();
      primeMainAgentRun();
      const timeoutError = new Error("chat run timed out");
      timeoutError.name = "TimeoutError";
      const context = makeContext();
      const runId = "task-registry-agent-run-timeout-error";
      mocks.agentCommand.mockImplementationOnce(() => {
        context.chatAbortControllers.get(runId)?.controller.abort(timeoutError);
        return Promise.reject(timeoutError);
      });

      await invokeAgent(
        {
          message: "background cli task",
          sessionKey: "agent:main:main",
          idempotencyKey: runId,
        },
        { context, reqId: runId },
      );

      await waitForAssertion(() => {
        expectRecordFields(findTaskByRunId("task-registry-agent-run-timeout-error"), {
          runtime: "cli",
          childSessionKey: "agent:main:main",
          status: "timed_out",
          error: "TimeoutError: chat run timed out",
        });
        expectRecordFields(
          context.dedupe.get("agent:task-registry-agent-run-timeout-error")?.payload,
          {
            runId: "task-registry-agent-run-timeout-error",
            status: "timeout",
            summary: "aborted",
            stopReason: "timeout",
          },
        );
      });
    });
  });

  it("classifies wrapped rejections after gateway timeout as timed out", async () => {
    await withTempDir(
      { prefix: "openclaw-gateway-agent-task-wrapped-timeout-error-" },
      async (root) => {
        useTestStateDir(root);
        resetTaskRegistryForTests();
        primeMainAgentRun();
        const timeoutReason = new Error("chat run timed out");
        timeoutReason.name = "TimeoutError";
        const wrappedError = new Error("fallback result classified terminal abort");
        wrappedError.name = "FailoverError";
        const context = makeContext();
        const runId = "task-registry-agent-run-wrapped-timeout-error";
        mocks.agentCommand.mockImplementationOnce(() => {
          context.chatAbortControllers.get(runId)?.controller.abort(timeoutReason);
          return Promise.reject(wrappedError);
        });

        await invokeAgent(
          {
            message: "background cli task",
            sessionKey: "agent:main:main",
            idempotencyKey: runId,
          },
          { context, reqId: runId },
        );

        await waitForAssertion(() => {
          expectRecordFields(findTaskByRunId("task-registry-agent-run-wrapped-timeout-error"), {
            runtime: "cli",
            childSessionKey: "agent:main:main",
            status: "timed_out",
            error: "FailoverError: fallback result classified terminal abort",
          });
          expectRecordFields(
            context.dedupe.get("agent:task-registry-agent-run-wrapped-timeout-error")?.payload,
            {
              runId: "task-registry-agent-run-wrapped-timeout-error",
              status: "timeout",
              summary: "aborted",
              stopReason: "timeout",
            },
          );
          expect(
            context.dedupe.get("agent:task-registry-agent-run-wrapped-timeout-error")?.ok,
          ).toBe(true);
        });
      },
    );
  });

  it("does not hide provider timeout async gateway agent rejections", async () => {
    await withTempDir({ prefix: "openclaw-gateway-agent-task-provider-timeout-" }, async (root) => {
      useTestStateDir(root);
      resetTaskRegistryForTests();
      primeMainAgentRun();
      const providerError = new Error("provider request timed out");
      providerError.name = "TimeoutError";
      mocks.agentCommand.mockRejectedValueOnce(providerError);
      const context = makeContext();

      await invokeAgent(
        {
          message: "background cli task",
          sessionKey: "agent:main:main",
          idempotencyKey: "task-registry-agent-run-provider-timeout",
        },
        { context, reqId: "task-registry-agent-run-provider-timeout" },
      );

      await waitForAssertion(() => {
        expectRecordFields(findTaskByRunId("task-registry-agent-run-provider-timeout"), {
          runtime: "cli",
          childSessionKey: "agent:main:main",
          status: "timed_out",
          error: "TimeoutError: provider request timed out",
        });
        expectRecordFields(
          context.dedupe.get("agent:task-registry-agent-run-provider-timeout")?.payload,
          {
            runId: "task-registry-agent-run-provider-timeout",
            status: "error",
            summary: "TimeoutError: provider request timed out",
          },
        );
        expect(context.dedupe.get("agent:task-registry-agent-run-provider-timeout")?.ok).toBe(
          false,
        );
      });
    });
  });

  it("does not overwrite operator-cancelled async gateway agent tasks after late completion", async () => {
    await withTempDir({ prefix: "openclaw-gateway-agent-task-cancelled-" }, async (root) => {
      useTestStateDir(root);
      resetTaskRegistryForTests();
      primeMainAgentRun();
      let resolveRun: (value: {
        payloads: Array<{ text: string }>;
        meta: { durationMs: number };
      }) => void;
      const pending = new Promise<{
        payloads: Array<{ text: string }>;
        meta: { durationMs: number };
      }>((resolve) => {
        resolveRun = resolve;
      });
      mocks.agentCommand.mockReturnValueOnce(pending);

      await invokeAgent(
        {
          message: "background cli task",
          sessionKey: "agent:main:main",
          idempotencyKey: "task-registry-agent-run-cancelled",
        },
        { reqId: "task-registry-agent-run-cancelled" },
      );

      const task = requireValue(
        findTaskByRunId("task-registry-agent-run-cancelled"),
        "task missing",
      );
      expectRecordFields(task, { status: "running" });
      const cancelledAt = (task?.startedAt ?? Date.now()) + 1;
      markTaskTerminalById({
        taskId: task.taskId,
        status: "cancelled",
        endedAt: cancelledAt,
        lastEventAt: cancelledAt,
        terminalSummary: "Cancelled by operator.",
      });

      resolveRun!({ payloads: [{ text: "ok" }], meta: { durationMs: 100 } });

      await waitForAssertion(() => {
        expectRecordFields(findTaskByRunId("task-registry-agent-run-cancelled"), {
          status: "cancelled",
          endedAt: cancelledAt,
          terminalSummary: "Cancelled by operator.",
        });
      });
    });
  });

  it("does not let --agent force the agent main session when --session-id is provided", async () => {
    mocks.resolveExplicitAgentSessionKey.mockReturnValue("agent:main:main");
    mockMainSessionEntry({ sessionId: "resume-whatsapp-session" });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "resume channel session",
        agentId: "main",
        sessionId: "resume-whatsapp-session",
        idempotencyKey: "session-id-agent-resume",
      },
      { reqId: "session-id-agent-resume" },
    );

    const call = await waitForAgentCommandCall<{
      agentId?: string;
      sessionId?: string;
      sessionKey?: string;
    }>();
    expect(call.agentId).toBe("main");
    expect(call.sessionId).toBe("resume-whatsapp-session");
    expect(call.sessionKey).toBeUndefined();
  });

  it("treats whitespace sessionId as absent before resolving the agent session key", async () => {
    mocks.resolveExplicitAgentSessionKey.mockReturnValue("agent:main:main");
    mockMainSessionEntry({ sessionId: "existing-session-id" });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "resume main",
        agentId: "main",
        sessionId: "   ",
        idempotencyKey: "blank-session-id-agent-resume",
      },
      { reqId: "blank-session-id-agent-resume" },
    );

    const call = await waitForAgentCommandCall<{
      agentId?: string;
      sessionId?: string;
      sessionKey?: string;
    }>();
    expect(call.agentId).toBe("main");
    expect(call.sessionId).toBe("existing-session-id");
    expect(call.sessionKey).toBe("agent:main:main");
  });

  it("uses an agent-scoped to value as the gateway session selector", async () => {
    const sessionKey = "agent:main:openclaw-weixin:direct:o9cq802hhmfc@im.wechat";
    mocks.resolveExplicitAgentSessionKey.mockReturnValue("agent:main:main");
    mocks.loadSessionEntry.mockImplementation((key: string) => ({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: key === sessionKey ? "wechat-session-id" : "main-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: key,
    }));
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, Record<string, unknown>> = {
        "agent:main:main": { sessionId: "main-session-id", updatedAt: Date.now() },
        [sessionKey]: { sessionId: "wechat-session-id", updatedAt: Date.now() },
      };
      return await updater(store);
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "callback result",
        to: sessionKey,
        idempotencyKey: "wechat-session-key-to",
      },
      { reqId: "wechat-session-key-to" },
    );

    const call = await waitForAgentCommandCall<{
      sessionId?: string;
      sessionKey?: string;
      to?: string;
    }>();
    expect(call.sessionId).toBe("wechat-session-id");
    expect(call.sessionKey).toBe(sessionKey);
    expect(call.to).toBeUndefined();
  });

  it("rolls stale gateway agent sessions even when updatedAt was recently touched", async () => {
    const now = Date.parse("2026-04-25T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      mocks.resolveExplicitAgentSessionKey.mockReturnValue("agent:main:main");
      mockMainSessionEntry(
        {
          sessionId: "stale-session-id",
          updatedAt: now,
          sessionStartedAt: now - 25 * 60 * 60_000,
          lastInteractionAt: now - 25 * 60 * 60_000,
        },
        {
          session: {
            reset: {
              mode: "daily",
              atHour: 4,
            },
          },
        },
      );
      const loaded = mocks.loadSessionEntry();
      let capturedEntry: Record<string, unknown> | undefined;
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        const store: Record<string, unknown> = {
          [loaded.canonicalKey]: structuredClone(loaded.entry),
        };
        const result = await updater(store);
        capturedEntry = result as Record<string, unknown>;
        return result;
      });
      mocks.agentCommand.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      });

      const broadcastToConnIds = vi.fn();
      await invokeAgent(
        {
          message: "daily rollover",
          agentId: "main",
          sessionKey: "agent:main:main",
          idempotencyKey: "daily-rollover-agent-session",
        },
        {
          reqId: "daily-rollover-agent-session",
          context: {
            ...makeContext(),
            broadcastToConnIds,
            getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
          },
        },
      );

      const call = await waitForAgentCommandCall<{
        sessionId?: string;
        sessionKey?: string;
      }>();
      expect(call.sessionKey).toBe("agent:main:main");
      expect(call.sessionId).not.toBe("stale-session-id");
      expect(capturedEntry?.sessionStartedAt).toBe(now);
      expect(capturedEntry?.lastInteractionAt).toBe(now);
      expect(mocks.emitGatewaySessionEndPluginHook).toHaveBeenCalledTimes(1);
      expectRecordFields(
        mockCallArg(mocks.emitGatewaySessionEndPluginHook) as Record<string, unknown>,
        {
          sessionKey: "agent:main:main",
          sessionId: "stale-session-id",
          reason: "daily",
          storePath: "/tmp/sessions.json",
          nextSessionId: call.sessionId,
          nextSessionKey: "agent:main:main",
        },
      );
      expect(mocks.emitGatewaySessionStartPluginHook).toHaveBeenCalledTimes(1);
      expectRecordFields(
        mockCallArg(mocks.emitGatewaySessionStartPluginHook) as Record<string, unknown>,
        {
          sessionKey: "agent:main:main",
          sessionId: call.sessionId,
          resumedFrom: "stale-session-id",
          storePath: "/tmp/sessions.json",
        },
      );
      expect(broadcastToConnIds.mock.calls.map((callValue) => callValue[1]?.reason)).toEqual([
        "create",
        "send",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a provider-owned CLI session across the daily default boundary on the gateway path", async () => {
    const now = Date.parse("2026-04-25T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      mocks.resolveExplicitAgentSessionKey.mockReturnValue("agent:main:main");
      mockMainSessionEntry({
        sessionId: "provider-owned-session-id",
        updatedAt: now,
        sessionStartedAt: now - 25 * 60 * 60_000,
        lastInteractionAt: now - 25 * 60 * 60_000,
        modelProvider: "claude-cli",
        cliSessionBindings: { "claude-cli": { sessionId: "claude-cli-conversation-123" } },
      });
      const loaded = mocks.loadSessionEntry();
      let capturedEntry: Record<string, unknown> | undefined;
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        const store: Record<string, unknown> = {
          [loaded.canonicalKey]: structuredClone(loaded.entry),
        };
        const result = await updater(store);
        capturedEntry = result as Record<string, unknown>;
        return result;
      });
      mocks.agentCommand.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      });

      await invokeAgent(
        {
          message: "provider-owned daily boundary",
          agentId: "main",
          sessionKey: "agent:main:main",
          idempotencyKey: "provider-owned-daily-boundary",
        },
        { reqId: "provider-owned-daily-boundary" },
      );

      const call = await waitForAgentCommandCall<{
        sessionId?: string;
        sessionKey?: string;
      }>();
      expect(call.sessionKey).toBe("agent:main:main");
      expect(call.sessionId).toBe("provider-owned-session-id");
      expect(capturedEntry?.sessionStartedAt).toBe(now - 25 * 60 * 60_000);
      expect(capturedEntry?.cliSessionBindings).toMatchObject({
        "claude-cli": { sessionId: "claude-cli-conversation-123" },
      });
      expect(mocks.emitGatewaySessionEndPluginHook).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a model-locked session across configured gateway expiry", async () => {
    const now = Date.parse("2026-04-25T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      mocks.resolveExplicitAgentSessionKey.mockReturnValue("agent:main:main");
      mockMainSessionEntry(
        {
          sessionId: "model-locked-session-id",
          updatedAt: now,
          sessionStartedAt: now - 25 * 60 * 60_000,
          lastInteractionAt: now - 25 * 60 * 60_000,
          agentHarnessId: "codex",
          modelSelectionLocked: true,
        },
        {
          session: {
            reset: {
              mode: "daily",
              atHour: 4,
            },
          },
        },
      );
      const loaded = mocks.loadSessionEntry();
      let capturedEntry: Record<string, unknown> | undefined;
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        const store: Record<string, unknown> = {
          [loaded.canonicalKey]: structuredClone(loaded.entry),
        };
        const result = await updater(store);
        capturedEntry = result as Record<string, unknown>;
        return result;
      });
      mocks.agentCommand.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      });

      await invokeAgent(
        {
          message: "model-locked daily boundary",
          agentId: "main",
          sessionKey: "agent:main:main",
          idempotencyKey: "model-locked-daily-boundary",
        },
        { reqId: "model-locked-daily-boundary" },
      );

      const call = await waitForAgentCommandCall<{
        sessionId?: string;
        sessionKey?: string;
      }>();
      expect(call.sessionKey).toBe("agent:main:main");
      expect(call.sessionId).toBe("model-locked-session-id");
      expect(capturedEntry?.sessionStartedAt).toBe(now - 25 * 60 * 60_000);
      expect(capturedEntry?.modelSelectionLocked).toBe(true);
      expect(mocks.emitGatewaySessionEndPluginHook).not.toHaveBeenCalled();
      expect(mocks.emitGatewaySessionStartPluginHook).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits idle lifecycle reason when inactivity rotates a gateway agent session", async () => {
    const now = Date.parse("2026-04-25T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      mocks.resolveExplicitAgentSessionKey.mockReturnValue("agent:main:main");
      mockMainSessionEntry(
        {
          sessionId: "idle-session-id",
          updatedAt: now,
          sessionStartedAt: now,
          lastInteractionAt: now - 60 * 60_000,
        },
        {
          session: {
            reset: {
              mode: "idle",
              idleMinutes: 5,
            },
          },
        },
      );
      const loaded = mocks.loadSessionEntry();
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        const store: Record<string, unknown> = {
          [loaded.canonicalKey]: structuredClone(loaded.entry),
        };
        return updater(store);
      });
      mocks.agentCommand.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      });

      await invokeAgent(
        {
          message: "idle rollover",
          agentId: "main",
          sessionKey: "agent:main:main",
          idempotencyKey: "idle-rollover-agent-session",
        },
        { reqId: "idle-rollover-agent-session" },
      );

      const call = await waitForAgentCommandCall<{
        sessionId?: string;
        sessionKey?: string;
      }>();
      expect(call.sessionKey).toBe("agent:main:main");
      expect(call.sessionId).not.toBe("idle-session-id");
      expectRecordFields(
        mockCallArg(mocks.emitGatewaySessionEndPluginHook) as Record<string, unknown>,
        {
          sessionKey: "agent:main:main",
          sessionId: "idle-session-id",
          reason: "idle",
          nextSessionId: call.sessionId,
          nextSessionKey: "agent:main:main",
        },
      );
      expectRecordFields(
        mockCallArg(mocks.emitGatewaySessionStartPluginHook) as Record<string, unknown>,
        {
          sessionKey: "agent:main:main",
          sessionId: call.sessionId,
          resumedFrom: "idle-session-id",
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits lifecycle hooks when a committed rotation later fails delivery validation", async () => {
    const now = Date.parse("2026-04-25T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      mocks.resolveExplicitAgentSessionKey.mockReturnValue("agent:main:main");
      mockMainSessionEntry(
        {
          sessionId: "stale-before-validation-id",
          updatedAt: now,
          sessionStartedAt: now - 25 * 60 * 60_000,
          lastInteractionAt: now - 25 * 60 * 60_000,
        },
        {
          session: {
            reset: {
              mode: "daily",
              atHour: 4,
            },
          },
        },
      );
      const loaded = mocks.loadSessionEntry();
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        const store: Record<string, unknown> = {
          [loaded.canonicalKey]: structuredClone(loaded.entry),
        };
        return updater(store);
      });
      mocks.agentCommand.mockClear();
      const respond = vi.fn();

      await invokeAgent(
        {
          message: "strict missing delivery target after rollover",
          agentId: "main",
          sessionKey: "agent:main:main",
          deliver: true,
          replyChannel: "telegram",
          bestEffortDeliver: false,
          idempotencyKey: "lifecycle-before-delivery-validation",
        },
        {
          reqId: "lifecycle-before-delivery-validation",
          respond,
          flushDispatch: false,
        },
      );

      expect(mocks.agentCommand).not.toHaveBeenCalled();
      const error = expectRespondError(respond, {});
      expectStringFieldContains(error, "message", "requires target");
      expect(mocks.emitGatewaySessionEndPluginHook).toHaveBeenCalledTimes(1);
      expectRecordFields(
        mockCallArg(mocks.emitGatewaySessionEndPluginHook) as Record<string, unknown>,
        {
          sessionKey: "agent:main:main",
          sessionId: "stale-before-validation-id",
          reason: "daily",
        },
      );
      expect(mocks.emitGatewaySessionStartPluginHook).toHaveBeenCalledTimes(1);
      expectRecordFields(
        mockCallArg(mocks.emitGatewaySessionStartPluginHook) as Record<string, unknown>,
        {
          sessionKey: "agent:main:main",
          resumedFrom: "stale-before-validation-id",
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits lifecycle hooks and sessions.changed when an explicit sessionId replaces a fresh session", async () => {
    const now = Date.parse("2026-04-25T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      mockMainSessionEntry({
        sessionId: "current-session-id",
        updatedAt: now,
        sessionStartedAt: now,
        lastInteractionAt: now,
      });
      const loaded = mocks.loadSessionEntry();
      let capturedEntry: Record<string, unknown> | undefined;
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        const store: Record<string, unknown> = {
          [loaded.canonicalKey]: structuredClone(loaded.entry),
        };
        const result = await updater(store);
        capturedEntry = result as Record<string, unknown>;
        return result;
      });
      mocks.agentCommand.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      });

      const broadcastToConnIds = vi.fn();
      await invokeAgent(
        {
          message: "explicit replacement",
          agentId: "main",
          sessionKey: "agent:main:main",
          sessionId: "caller-selected-session-id",
          idempotencyKey: "explicit-replacement-agent-session",
        },
        {
          reqId: "explicit-replacement-agent-session",
          context: {
            ...makeContext(),
            broadcastToConnIds,
            getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
          },
        },
      );

      const call = await waitForAgentCommandCall<{
        sessionId?: string;
        sessionKey?: string;
      }>();
      expect(call.sessionKey).toBe("agent:main:main");
      expect(call.sessionId).toBe("caller-selected-session-id");
      expect(capturedEntry?.sessionId).toBe("caller-selected-session-id");
      expect(capturedEntry?.sessionStartedAt).toBe(now);
      expect(mocks.emitGatewaySessionEndPluginHook).toHaveBeenCalledTimes(1);
      expectRecordFields(
        mockCallArg(mocks.emitGatewaySessionEndPluginHook) as Record<string, unknown>,
        {
          sessionKey: "agent:main:main",
          sessionId: "current-session-id",
          reason: "new",
          storePath: "/tmp/sessions.json",
          nextSessionId: "caller-selected-session-id",
          nextSessionKey: "agent:main:main",
        },
      );
      expect(mocks.emitGatewaySessionStartPluginHook).toHaveBeenCalledTimes(1);
      expectRecordFields(
        mockCallArg(mocks.emitGatewaySessionStartPluginHook) as Record<string, unknown>,
        {
          sessionKey: "agent:main:main",
          sessionId: "caller-selected-session-id",
          resumedFrom: "current-session-id",
          storePath: "/tmp/sessions.json",
        },
      );
      expect(broadcastToConnIds.mock.calls.map((callLocal) => callLocal[1]?.reason)).toEqual([
        "create",
        "send",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let explicit sessionId bypass stale gateway session freshness", async () => {
    const now = Date.parse("2026-04-25T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      mocks.resolveExplicitAgentSessionKey.mockReturnValue("agent:main:main");
      mockMainSessionEntry(
        {
          sessionId: "stale-session-id",
          updatedAt: now,
          sessionStartedAt: now - 25 * 60 * 60_000,
          lastInteractionAt: now - 25 * 60 * 60_000,
        },
        {
          session: {
            reset: {
              mode: "daily",
              atHour: 4,
            },
          },
        },
      );
      const loaded = mocks.loadSessionEntry();
      let capturedEntry: Record<string, unknown> | undefined;
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        const store: Record<string, unknown> = {
          [loaded.canonicalKey]: structuredClone(loaded.entry),
        };
        const result = await updater(store);
        capturedEntry = result as Record<string, unknown>;
        return result;
      });
      mocks.agentCommand.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      });

      await invokeAgent(
        {
          message: "daily rollover",
          agentId: "main",
          sessionKey: "agent:main:main",
          sessionId: "stale-session-id",
          idempotencyKey: "daily-rollover-agent-session-id",
        },
        { reqId: "daily-rollover-agent-session-id" },
      );

      const call = await waitForAgentCommandCall<{
        sessionId?: string;
        sessionKey?: string;
      }>();
      expect(call.sessionKey).toBe("agent:main:main");
      expect(call.sessionId).not.toBe("stale-session-id");
      expect(capturedEntry?.sessionStartedAt).toBe(now);
      expect(capturedEntry?.lastInteractionAt).toBe(now);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forwards the selected agent id with canonical global session keys", async () => {
    mocks.listAgentIds.mockReturnValue(["main", "ops"]);
    mocks.resolveExplicitAgentSessionKey.mockReturnValue("agent:ops:main");
    mocks.loadSessionEntry.mockReturnValue({
      cfg: { session: { scope: "global" } },
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "global-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: "global",
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        global: { sessionId: "global-session-id", updatedAt: Date.now() },
      };
      return await updater(store);
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "global session",
        agentId: "ops",
        idempotencyKey: "global-session-agent-id",
      },
      { reqId: "global-session-agent-id" },
    );

    const call = await waitForAgentCommandCall<{
      agentId?: string;
      sessionKey?: string;
    }>();
    expect(call.agentId).toBe("ops");
    expect(call.sessionKey).toBe("global");
    expect(mocks.loadSessionEntry).toHaveBeenCalledWith("agent:ops:main", {
      agentId: "ops",
      clone: false,
    });
  });

  it("accepts an explicit global session key with a selected agent id", async () => {
    mocks.listAgentIds.mockReturnValue(["main", "work"]);
    mocks.loadSessionEntry.mockReturnValue({
      cfg: { session: { scope: "global" } },
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "global-work-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: "global",
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        global: { sessionId: "global-work-session-id", updatedAt: Date.now() },
      };
      return await updater(store);
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "global session",
        sessionKey: "global",
        agentId: "work",
        idempotencyKey: "explicit-global-session-agent-id",
      },
      { reqId: "explicit-global-session-agent-id", respond },
    );

    expect(respond).not.toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: ErrorCodes.INVALID_REQUEST }),
    );
    const call = await waitForAgentCommandCall<{
      agentId?: string;
      sessionKey?: string;
    }>();
    expect(call.agentId).toBe("work");
    expect(call.sessionKey).toBe("global");
    expect(mocks.loadSessionEntry).toHaveBeenCalledWith("global", {
      agentId: "work",
      clone: false,
    });
  });

  it("routes bare global session keys to the configured default agent", async () => {
    mocks.listAgentIds.mockReturnValue(["main", "ops"]);
    mocks.loadConfigReturn = {
      agents: { list: [{ id: "main" }, { id: "ops", default: true }] },
      session: { scope: "global" },
    };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: mocks.loadConfigReturn,
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "global-ops-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: "global",
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        global: { sessionId: "global-ops-session-id", updatedAt: Date.now() },
      };
      return await updater(store);
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "bare global session",
        sessionKey: "global",
        idempotencyKey: "bare-global-default-agent-id",
      },
      { reqId: "bare-global-default-agent-id" },
    );

    const call = await waitForAgentCommandCall<{
      agentId?: string;
      sessionKey?: string;
    }>();
    expect(call.agentId).toBe("ops");
    expect(call.sessionKey).toBe("global");
    expect(mocks.loadSessionEntry).toHaveBeenCalledWith("global", {
      clone: false,
    });
  });

  it("infers selected-global agent id from agent-prefixed session aliases", async () => {
    mocks.listAgentIds.mockReturnValue(["main", "work"]);
    mocks.loadConfigReturn = {
      agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      session: { scope: "global" },
    };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: mocks.loadConfigReturn,
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "global-work-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: "global",
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        global: { sessionId: "global-work-session-id", updatedAt: Date.now() },
      };
      return await updater(store);
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "global alias session",
        sessionKey: "agent:work:main",
        idempotencyKey: "alias-global-session-agent-id",
      },
      { reqId: "alias-global-session-agent-id" },
    );

    const call = await waitForAgentCommandCall<{
      agentId?: string;
      sessionKey?: string;
    }>();
    expect(call.agentId).toBe("work");
    expect(call.sessionKey).toBe("global");
    expect(mocks.loadSessionEntry).toHaveBeenCalledWith("agent:work:main", {
      agentId: "work",
      clone: false,
    });
  });

  it("registers tool event recipients for active selected-global alias runs", async () => {
    mocks.listAgentIds.mockReturnValue(["main", "work"]);
    mocks.loadConfigReturn = {
      agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      session: { scope: "global" },
    };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: mocks.loadConfigReturn,
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "global-work-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: "global",
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        global: { sessionId: "global-work-session-id", updatedAt: Date.now() },
      };
      return await updater(store);
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });
    const context = makeContext();
    const registerToolEventRecipient = vi.fn();
    context.registerToolEventRecipient = registerToolEventRecipient;
    context.chatAbortControllers.set("run-existing", {
      controller: new AbortController(),
      sessionKey: "global",
      agentId: "work",
      clientRunId: "run-existing",
    } as never);

    await invokeAgent(
      {
        message: "global alias session",
        sessionKey: "agent:work:main",
        idempotencyKey: "alias-global-tool-events",
      },
      {
        reqId: "alias-global-tool-events",
        context,
        client: {
          connId: "conn-1",
          connect: { caps: ["tool-events"] },
        } as never,
      },
    );

    expect(registerToolEventRecipient).toHaveBeenCalledWith("alias-global-tool-events", "conn-1");
    expect(registerToolEventRecipient).toHaveBeenCalledWith("run-existing", "conn-1");
  });

  it("updates tracked agent session identity after compaction rotation", async () => {
    primeMainAgentRun();
    const context = makeContext();
    let trackedSessionId: string | undefined;
    mocks.agentCommand.mockImplementation(async (call: AgentCommandCall) => {
      const onSessionIdChanged = call.onSessionIdChanged;
      if (typeof onSessionIdChanged !== "function") {
        throw new Error("expected session id change callback");
      }
      onSessionIdChanged("rotated-session-id");
      trackedSessionId = context.chatAbortControllers.get("agent-session-rotation")?.sessionId;
      return {
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      };
    });

    await invokeAgent(
      {
        message: "rotate session",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: "agent-session-rotation",
      },
      {
        reqId: "agent-session-rotation",
        context,
      },
    );

    expect(trackedSessionId).toBe("rotated-session-id");
  });

  it("honors selected-global agent id when the request uses the main alias", async () => {
    mocks.listAgentIds.mockReturnValue(["main", "work"]);
    mocks.loadConfigReturn = {
      agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      session: { scope: "global" },
    };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: mocks.loadConfigReturn,
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "global-work-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: "global",
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        global: { sessionId: "global-work-session-id", updatedAt: Date.now() },
      };
      return await updater(store);
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "global main alias",
        agentId: "work",
        sessionKey: "main",
        idempotencyKey: "selected-global-main-alias-agent-id",
      },
      { reqId: "selected-global-main-alias-agent-id" },
    );

    const call = await waitForAgentCommandCall<{
      agentId?: string;
      sessionKey?: string;
    }>();
    expect(call.agentId).toBe("work");
    expect(call.sessionKey).toBe("global");
    expect(mocks.loadSessionEntry).toHaveBeenCalledWith("main", {
      agentId: "work",
      clone: false,
    });
  });

  it("preserves selected-global agent id on cached accepted responses", async () => {
    const context = makeContext();
    mocks.agentCommand.mockClear();
    context.dedupe.set("agent:cached-global-work", {
      ts: Date.now(),
      ok: true,
      payload: {
        runId: "cached-global-work",
        sessionKey: "global",
        agentId: "work",
        status: "accepted",
      },
    });
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "global session retry",
        sessionKey: "global",
        agentId: "work",
        idempotencyKey: "cached-global-work",
      },
      { context, respond, reqId: "cached-global-work" },
    );

    expectRecordFields(mockCallArg(respond, 0, 1), {
      runId: "cached-global-work",
      sessionKey: "global",
      agentId: "work",
      status: "in_flight",
    });
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("dispatches async gateway agent task creation through the detached task runtime seam", async () => {
    await withTempDir({ prefix: "openclaw-gateway-agent-seam-" }, async (root) => {
      useTestStateDir(root);
      resetTaskRegistryForTests();
      primeMainAgentRun();

      const defaultRuntime = getDetachedTaskLifecycleRuntime();
      const createRunningTaskRunSpy = vi.fn(
        (...args: Parameters<typeof defaultRuntime.createRunningTaskRun>) =>
          defaultRuntime.createRunningTaskRun(...args),
      );
      const finalizeTaskRunByRunIdSpy = vi.fn(
        (...args: Parameters<NonNullable<typeof defaultRuntime.finalizeTaskRunByRunId>>) =>
          defaultRuntime.finalizeTaskRunByRunId!(...args),
      );

      setDetachedTaskLifecycleRuntime({
        ...defaultRuntime,
        createRunningTaskRun: createRunningTaskRunSpy,
        finalizeTaskRunByRunId: finalizeTaskRunByRunIdSpy,
      });

      await invokeAgent(
        {
          message: "background cli seam task",
          sessionKey: "agent:main:main",
          idempotencyKey: "task-registry-agent-seam",
        },
        { reqId: "task-registry-agent-seam" },
      );

      expect(createRunningTaskRunSpy).toHaveBeenCalledTimes(1);
      expectRecordFields(mockCallArg(createRunningTaskRunSpy), {
        runtime: "cli",
        runId: "task-registry-agent-seam",
        childSessionKey: "agent:main:main",
        sourceId: "task-registry-agent-seam",
      });
      expectStringFieldContains(
        mockCallArg(createRunningTaskRunSpy) as Record<string, unknown>,
        "task",
        "background cli seam task",
      );
      expect(finalizeTaskRunByRunIdSpy).toHaveBeenCalledTimes(1);
      expectRecordFields(mockCallArg(finalizeTaskRunByRunIdSpy), {
        runtime: "cli",
        runId: "task-registry-agent-seam",
        status: "succeeded",
        terminalSummary: "completed",
      });
      expectRecordFields(findTaskByRunId("task-registry-agent-seam"), {
        runtime: "cli",
        childSessionKey: "agent:main:main",
        status: "succeeded",
        terminalSummary: "completed",
      });
    });
  });

  describe("ACP manual-spawn child turn task tracking", () => {
    function mockAcpChildSessionEntry(childSessionKey: string) {
      mocks.loadSessionEntry.mockReturnValue({
        cfg: {},
        storePath: "/tmp/sessions.json",
        entry: { sessionId: "acp-child-session", updatedAt: Date.now() },
        canonicalKey: childSessionKey,
      });
      mocks.updateSessionStore.mockResolvedValue(undefined);
      mocks.agentCommand.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      });
    }

    function spyDetachedCreateRunningTaskRun() {
      const defaultRuntime = getDetachedTaskLifecycleRuntime();
      const createRunningTaskRunSpy = vi.fn(
        (...args: Parameters<typeof defaultRuntime.createRunningTaskRun>) =>
          defaultRuntime.createRunningTaskRun(...args),
      );
      setDetachedTaskLifecycleRuntime({
        ...defaultRuntime,
        createRunningTaskRun: createRunningTaskRunSpy,
      });
      return createRunningTaskRunSpy;
    }

    const confirmedAcpMeta: NonNullable<ReturnType<typeof readAcpSessionMeta>> = {
      backend: "acpx",
      agent: "codex",
      runtimeSessionName: "runtime-1",
      mode: "persistent",
      state: "idle",
      lastActivityAt: Date.now(),
    };

    it("suppresses the gateway CLI task row for confirmed ACP manual-spawn child turns", async () => {
      await withTempDir({ prefix: "openclaw-gateway-acp-suppress-" }, async (root) => {
        useTestStateDir(root);
        resetTaskRegistryForTests();
        const childSessionKey = "agent:main:acp:child-confirmed";
        mockAcpChildSessionEntry(childSessionKey);
        mocks.readAcpSessionMeta.mockReturnValue(confirmedAcpMeta);
        const createRunningTaskRunSpy = spyDetachedCreateRunningTaskRun();

        await invokeAgent(
          {
            message: "acp manual spawn child turn",
            sessionKey: childSessionKey,
            acpTurnSource: "manual_spawn",
            idempotencyKey: "acp-manual-spawn-confirmed",
          },
          { reqId: "acp-manual-spawn-confirmed", client: backendGatewayClient() },
        );
        await waitForAgentCommandCall();

        expect(createRunningTaskRunSpy).not.toHaveBeenCalled();
        expect(findTaskByRunId("acp-manual-spawn-confirmed")).toBeUndefined();
      });
    });

    it("keeps CLI tracking when a non-backend operator-write caller sets acpTurnSource", async () => {
      await withTempDir({ prefix: "openclaw-gateway-acp-operator-write-" }, async (root) => {
        useTestStateDir(root);
        resetTaskRegistryForTests();
        const childSessionKey = "agent:main:acp:child-operator-write";
        mockAcpChildSessionEntry(childSessionKey);
        // Persisted ACP metadata is present and the turn looks like a manual
        // spawn, but the caller is an operator-write control-UI client, not the
        // in-process backend ACP spawn path. That caller never creates a
        // replacement `acp` row, so CLI tracking must stay on to avoid losing the
        // run entirely.
        mocks.readAcpSessionMeta.mockReturnValue(confirmedAcpMeta);
        const createRunningTaskRunSpy = spyDetachedCreateRunningTaskRun();

        await invokeAgent(
          {
            message: "operator-write acp manual spawn",
            sessionKey: childSessionKey,
            acpTurnSource: "manual_spawn",
            idempotencyKey: "acp-operator-write",
          },
          { reqId: "acp-operator-write", client: operatorWriteGatewayClient() },
        );
        await waitForAgentCommandCall();

        expect(createRunningTaskRunSpy).toHaveBeenCalledTimes(1);
        expectRecordFields(mockCallArg(createRunningTaskRunSpy), {
          runtime: "cli",
          runId: "acp-operator-write",
          childSessionKey,
        });
        await waitForAssertion(() => {
          expectRecordFields(findTaskByRunId("acp-operator-write"), {
            runtime: "cli",
            childSessionKey,
          });
        });
      });
    });

    it("keeps CLI tracking for ACP-shaped manual-spawn turns without persisted ACP metadata", async () => {
      await withTempDir({ prefix: "openclaw-gateway-acp-no-meta-" }, async (root) => {
        useTestStateDir(root);
        resetTaskRegistryForTests();
        const childSessionKey = "agent:main:acp:child-missing-meta";
        mockAcpChildSessionEntry(childSessionKey);
        mocks.readAcpSessionMeta.mockReturnValue(undefined);
        const createRunningTaskRunSpy = spyDetachedCreateRunningTaskRun();

        await invokeAgent(
          {
            message: "acp shaped turn without metadata",
            sessionKey: childSessionKey,
            acpTurnSource: "manual_spawn",
            idempotencyKey: "acp-manual-spawn-no-meta",
          },
          { reqId: "acp-manual-spawn-no-meta", client: backendGatewayClient() },
        );
        await waitForAgentCommandCall();

        expect(createRunningTaskRunSpy).toHaveBeenCalledTimes(1);
        expectRecordFields(mockCallArg(createRunningTaskRunSpy), {
          runtime: "cli",
          runId: "acp-manual-spawn-no-meta",
          childSessionKey,
        });
        await waitForAssertion(() => {
          expectRecordFields(findTaskByRunId("acp-manual-spawn-no-meta"), {
            runtime: "cli",
            childSessionKey,
          });
        });
      });
    });

    it("keeps dispatch and CLI tracking when ACP metadata read fails", async () => {
      await withTempDir({ prefix: "openclaw-gateway-acp-meta-throw-" }, async (root) => {
        useTestStateDir(root);
        resetTaskRegistryForTests();
        const childSessionKey = "agent:main:acp:child-meta-throw";
        mockAcpChildSessionEntry(childSessionKey);
        const metadataError = new Error("state db unavailable");
        mocks.readAcpSessionMeta.mockImplementation(() => {
          throw metadataError;
        });
        const createRunningTaskRunSpy = spyDetachedCreateRunningTaskRun();
        const context = makeContext();

        await invokeAgent(
          {
            message: "acp manual spawn metadata throw",
            sessionKey: childSessionKey,
            acpTurnSource: "manual_spawn",
            idempotencyKey: "acp-manual-spawn-meta-throw",
          },
          { reqId: "acp-manual-spawn-meta-throw", context, client: backendGatewayClient() },
        );
        await waitForAgentCommandCall();

        expect(createRunningTaskRunSpy).toHaveBeenCalledTimes(1);
        expectRecordFields(mockCallArg(createRunningTaskRunSpy), {
          runtime: "cli",
          runId: "acp-manual-spawn-meta-throw",
          childSessionKey,
        });
        await waitForAssertion(() => {
          expectRecordFields(findTaskByRunId("acp-manual-spawn-meta-throw"), {
            runtime: "cli",
            childSessionKey,
            status: "succeeded",
            terminalSummary: "completed",
          });
        });
        const warnMock = context.logGateway.warn as ReturnType<typeof vi.fn>;
        expect(
          warnMock.mock.calls.some(([message]) => {
            return (
              typeof message === "string" &&
              message.includes("failed to read ACP session metadata") &&
              message.includes("falling back to cli task tracking")
            );
          }),
        ).toBe(true);
      });
    });

    it("keeps CLI tracking for ACP-shaped turns that are not manual spawns", async () => {
      await withTempDir({ prefix: "openclaw-gateway-acp-not-manual-spawn-" }, async (root) => {
        useTestStateDir(root);
        resetTaskRegistryForTests();
        const childSessionKey = "agent:main:acp:child-not-spawn";
        mockAcpChildSessionEntry(childSessionKey);
        // Metadata is present but the turn lacks acpTurnSource, so the spawn
        // control plane does not own this row; CLI tracking must stay on.
        mocks.readAcpSessionMeta.mockReturnValue(confirmedAcpMeta);
        const createRunningTaskRunSpy = spyDetachedCreateRunningTaskRun();

        await invokeAgent(
          {
            message: "acp shaped non-spawn turn",
            sessionKey: childSessionKey,
            idempotencyKey: "acp-not-manual-spawn",
          },
          { reqId: "acp-not-manual-spawn", client: backendGatewayClient() },
        );
        await waitForAgentCommandCall();

        expect(createRunningTaskRunSpy).toHaveBeenCalledTimes(1);
        expectRecordFields(mockCallArg(createRunningTaskRunSpy), {
          runtime: "cli",
          runId: "acp-not-manual-spawn",
          childSessionKey,
        });
      });
    });

    it("does not affect plugin-subagent tracking for confirmed ACP conditions", async () => {
      await withTempDir({ prefix: "openclaw-gateway-acp-plugin-subagent-" }, async (root) => {
        useTestStateDir(root);
        resetTaskRegistryForTests();
        resetSubagentRegistryForTests({ persist: false });
        const childSessionKey = "agent:main:acp:plugin-child";
        const runId = "acp-plugin-subagent-run";
        mockAcpChildSessionEntry(childSessionKey);
        mocks.readAcpSessionMeta.mockReturnValue(confirmedAcpMeta);
        const createRunningTaskRunSpy = spyDetachedCreateRunningTaskRun();

        const baseClient = requireValue(backendGatewayClient(), "expected backend client");
        const pluginClient: AgentHandlerArgs["client"] = {
          connect: baseClient.connect,
          internal: {
            ...baseClient.internal,
            agentRunTracking: "plugin_subagent",
            pluginRuntimeOwnerId: "memory-core",
          },
        };

        await invokeAgent(
          {
            message: "plugin subagent over acp child",
            sessionKey: childSessionKey,
            acpTurnSource: "manual_spawn",
            idempotencyKey: runId,
          },
          { reqId: runId, client: pluginClient },
        );
        await waitForAgentCommandCall();

        // plugin_subagent precedence means the run is tracked through the
        // subagent registry as a `subagent` row, never a duplicate `cli` row.
        expect(createRunningTaskRunSpy).toHaveBeenCalledTimes(1);
        expectRecordFields(mockCallArg(createRunningTaskRunSpy), {
          runtime: "subagent",
          runId,
        });
        expect(
          listTaskRecords().some((task) => task.runId === runId && task.runtime === "cli"),
        ).toBe(false);
        await waitForAssertion(() => {
          expectRecordFields(getSubagentRunByChildSessionKey(childSessionKey), {
            runId,
            childSessionKey,
            label: "plugin:memory-core",
          });
        });
      });
    });
  });

  it("logs a swallowed finalize error without blocking the background run", async () => {
    await withTempDir({ prefix: "openclaw-gateway-agent-finalize-throw-" }, async (root) => {
      useTestStateDir(root);
      resetTaskRegistryForTests();
      primeMainAgentRun();

      const defaultRuntime = getDetachedTaskLifecycleRuntime();
      const finalizeError = new Error("finalize boom");
      const finalizeTaskRunByRunIdSpy = vi.fn(() => {
        throw finalizeError;
      });
      setDetachedTaskLifecycleRuntime({
        ...defaultRuntime,
        finalizeTaskRunByRunId: finalizeTaskRunByRunIdSpy,
      });

      const context = makeContext();
      const respond = vi.fn();

      await invokeAgent(
        {
          message: "finalize throw seam task",
          sessionKey: "agent:main:main",
          idempotencyKey: "task-registry-finalize-throw",
        },
        { context, respond, reqId: "task-registry-finalize-throw" },
      );

      // Finalize threw, but the run must still complete (second res frame with ok status).
      expect(finalizeTaskRunByRunIdSpy).toHaveBeenCalledTimes(1);
      const completed = respond.mock.calls.some(([ok, payload]) => {
        return ok === true && (payload as { status?: string } | undefined)?.status === "ok";
      });
      expect(completed).toBe(true);

      // The swallowed finalize error stays observable via a warn log.
      const warnMock = context.logGateway.warn as ReturnType<typeof vi.fn>;
      const loggedFinalizeError = warnMock.mock.calls.some(([message]) => {
        return (
          typeof message === "string" &&
          message.includes("failed to finalize tracked agent task") &&
          message.includes("finalize boom")
        );
      });
      expect(loggedFinalizeError).toBe(true);
    });
  });

  it("routes voice wake trigger to configured session target", async () => {
    mocks.loadVoiceWakeRoutingConfig.mockResolvedValue({
      version: 1,
      defaultTarget: { mode: "current" },
      routes: [],
      updatedAtMs: 0,
    });
    mocks.resolveVoiceWakeRouteByTrigger.mockReturnValue({ sessionKey: "agent:main:voice" });

    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "voice-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: "agent:main:voice",
    });
    mocks.updateSessionStore.mockResolvedValue(undefined);
    mocks.agentCommand.mockReturnValue(new Promise(() => {}));
    const respond = vi.fn();
    await invokeAgent(
      {
        message: "do thing",
        sessionKey: "main",
        voiceWakeTrigger: "robot wake",
        idempotencyKey: "test-voice-route",
      },
      {
        respond,
        context: makeContext(),
        reqId: "voice-1",
      },
    );

    const callArgs = await waitForAgentCommandCall<{ sessionKey?: string }>();
    expect(callArgs.sessionKey).toBe("agent:main:voice");
  });

  it("ignores voice wake session route targeting unknown agent", async () => {
    mocks.loadVoiceWakeRoutingConfig.mockResolvedValue({
      version: 1,
      defaultTarget: { mode: "current" },
      routes: [],
      updatedAtMs: 0,
    });
    mocks.resolveVoiceWakeRouteByTrigger.mockReturnValue({ sessionKey: "agent:ghost:main" });

    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "main-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: "agent:main:main",
    });
    mocks.updateSessionStore.mockResolvedValue(undefined);
    mocks.agentCommand.mockReturnValue(new Promise(() => {}));

    const respond = vi.fn();
    await invokeAgent(
      {
        message: "do thing",
        sessionKey: "main",
        voiceWakeTrigger: "robot wake",
        idempotencyKey: "test-voice-route-unknown",
      },
      {
        respond,
        context: makeContext(),
        reqId: "voice-2",
      },
    );

    const callArgs = await waitForAgentCommandCall<{ sessionKey?: string }>();
    expect(callArgs.sessionKey).toBe("agent:main:main");
  });

  it("applies default voice wake route when trigger field is present but empty", async () => {
    mocks.loadVoiceWakeRoutingConfig.mockResolvedValue({
      version: 1,
      defaultTarget: { sessionKey: "agent:main:voice" },
      routes: [],
      updatedAtMs: 0,
    });
    mocks.resolveVoiceWakeRouteByTrigger.mockReturnValue({ sessionKey: "agent:main:voice" });

    mocks.loadSessionEntry.mockImplementation((sessionKey: string) => ({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "voice-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: sessionKey === "main" ? "agent:main:main" : sessionKey,
    }));
    mocks.updateSessionStore.mockResolvedValue(undefined);
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    const respond = vi.fn();
    await invokeAgent(
      {
        message: "do thing",
        sessionKey: "main",
        voiceWakeTrigger: " ",
        idempotencyKey: "test-voice-route-default-target",
      },
      {
        respond,
        context: makeContext(),
        reqId: "voice-3",
      },
    );

    const callArgs = await waitForAgentCommandCall<{ sessionKey?: string }>();
    expect(callArgs.sessionKey).toBe("agent:main:voice");
    const routeCall = mocks.resolveVoiceWakeRouteByTrigger.mock.calls.find(([args]) => {
      return (args as Record<string, unknown>).trigger === undefined;
    });
    const routeArgs = expectRecordFields(requireValue(routeCall, "route call missing")[0], {
      trigger: undefined,
    });
    expect(typeof routeArgs.config).toBe("object");
  });

  it("trims whitespace-only delivery fields before disabling voice wake auto-routing", async () => {
    mocks.loadVoiceWakeRoutingConfig.mockResolvedValue({
      version: 1,
      defaultTarget: { sessionKey: "agent:main:voice" },
      routes: [],
      updatedAtMs: 0,
    });
    mocks.resolveVoiceWakeRouteByTrigger.mockReturnValue({ sessionKey: "agent:main:voice" });

    mocks.loadSessionEntry.mockImplementation((sessionKey: string) => ({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "voice-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: sessionKey === "main" ? "agent:main:main" : sessionKey,
    }));
    mocks.updateSessionStore.mockResolvedValue(undefined);
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    const respond = vi.fn();
    await invokeAgent(
      {
        message: "do thing",
        sessionKey: "main",
        to: "   ",
        replyTo: "   ",
        voiceWakeTrigger: "robot wake",
        idempotencyKey: "test-voice-route-whitespace-delivery",
      },
      {
        respond,
        context: makeContext(),
        reqId: "voice-4",
      },
    );

    const callArgs = await waitForAgentCommandCall<{ sessionKey?: string }>();
    expect(callArgs.sessionKey).toBe("agent:main:voice");
    const routeCall = mocks.resolveVoiceWakeRouteByTrigger.mock.calls.find(([args]) => {
      return (args as Record<string, unknown>).trigger === "robot wake";
    });
    const routeArgs = expectRecordFields(requireValue(routeCall, "route call missing")[0], {
      trigger: "robot wake",
    });
    expect(typeof routeArgs.config).toBe("object");
  });

  it("does not auto-route voice wake requests with an explicit session key", async () => {
    mocks.loadVoiceWakeRoutingConfig.mockResolvedValue({
      version: 1,
      defaultTarget: { sessionKey: "agent:main:voice" },
      routes: [],
      updatedAtMs: 0,
    });
    mocks.resolveVoiceWakeRouteByTrigger.mockReturnValue({ sessionKey: "agent:main:voice" });

    mocks.loadSessionEntry.mockImplementation((sessionKey: string) => ({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "voice-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: sessionKey,
    }));
    mocks.updateSessionStore.mockResolvedValue(undefined);
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });
    mocks.loadVoiceWakeRoutingConfig.mockClear();
    mocks.resolveVoiceWakeRouteByTrigger.mockClear();

    const respond = vi.fn();
    await invokeAgent(
      {
        message: "do thing",
        sessionKey: "agent:main:research",
        voiceWakeTrigger: "robot wake",
        idempotencyKey: "test-voice-route-explicit-session",
      },
      {
        respond,
        context: makeContext(),
        reqId: "voice-5",
      },
    );

    const callArgs = await waitForAgentCommandCall<{ sessionKey?: string }>();
    expect(callArgs.sessionKey).toBe("agent:main:research");
    expect(mocks.loadVoiceWakeRoutingConfig).not.toHaveBeenCalled();
    expect(mocks.resolveVoiceWakeRouteByTrigger).not.toHaveBeenCalled();
  });

  it("does not auto-route voice wake requests with another agent's explicit main session", async () => {
    const opsAgentCfg = { agents: { list: [{ id: "main" }, { id: "ops" }] } };
    mocks.listAgentIds.mockReturnValue(["main", "ops"]);
    mocks.loadVoiceWakeRoutingConfig.mockResolvedValue({
      version: 1,
      defaultTarget: { sessionKey: "agent:main:voice" },
      routes: [],
      updatedAtMs: 0,
    });
    mocks.resolveVoiceWakeRouteByTrigger.mockReturnValue({ sessionKey: "agent:main:voice" });

    mocks.loadSessionEntry.mockImplementation((sessionKey: string) => ({
      cfg: opsAgentCfg,
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "voice-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: sessionKey,
    }));
    mocks.updateSessionStore.mockResolvedValue(undefined);
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });
    mocks.loadVoiceWakeRoutingConfig.mockClear();
    mocks.resolveVoiceWakeRouteByTrigger.mockClear();
    mocks.agentCommand.mockClear();

    const respond = vi.fn();
    await invokeAgent(
      {
        message: "do thing",
        sessionKey: "agent:ops:main",
        voiceWakeTrigger: "robot wake",
        idempotencyKey: "test-voice-route-explicit-other-agent-main",
      },
      {
        respond,
        context: makeContext(),
        reqId: "voice-5b",
      },
    );

    const callArgs = await waitForAgentCommandCall<{ sessionKey?: string }>();
    expect(callArgs.sessionKey).toBe("agent:ops:main");
    expect(mocks.loadVoiceWakeRoutingConfig).not.toHaveBeenCalled();
    expect(mocks.resolveVoiceWakeRouteByTrigger).not.toHaveBeenCalled();
  });

  it("treats explicit sessionId as an opt-out for voice wake auto-routing", async () => {
    mocks.loadVoiceWakeRoutingConfig.mockResolvedValue({
      version: 1,
      defaultTarget: { sessionKey: "agent:main:voice" },
      routes: [],
      updatedAtMs: 0,
    });
    mocks.resolveVoiceWakeRouteByTrigger.mockReturnValue({ sessionKey: "agent:main:voice" });

    mocks.loadSessionEntry.mockImplementation((sessionKey: string) => ({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: sessionKey === "main" ? "main-session-id" : "voice-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: sessionKey === "main" ? "agent:main:main" : sessionKey,
    }));
    mocks.updateSessionStore.mockResolvedValue(undefined);
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });
    mocks.loadVoiceWakeRoutingConfig.mockClear();
    mocks.resolveVoiceWakeRouteByTrigger.mockClear();

    const respond = vi.fn();
    await invokeAgent(
      {
        message: "do thing",
        sessionKey: "main",
        sessionId: "caller-selected-session-id",
        voiceWakeTrigger: "robot wake",
        idempotencyKey: "test-voice-route-explicit-session-id",
      },
      {
        respond,
        context: makeContext(),
        reqId: "voice-6",
      },
    );

    const callArgs = await waitForAgentCommandCall<{ sessionKey?: string }>();
    expect(callArgs.sessionKey).toBe("agent:main:main");
    expect(mocks.loadVoiceWakeRoutingConfig).not.toHaveBeenCalled();
    expect(mocks.resolveVoiceWakeRouteByTrigger).not.toHaveBeenCalled();
  });

  it("handles missing cliSessionIds gracefully", async () => {
    mockMainSessionEntry({});

    const capturedEntry = await runMainAgentAndCaptureEntry("test-idem-2");
    // Should be undefined, not cause an error
    expect(capturedEntry.cliSessionIds).toBeUndefined();
    expect(capturedEntry.claudeCliSessionId).toBeUndefined();
  });
  it("prunes legacy main alias keys when writing a canonical session entry", async () => {
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {
        session: { mainKey: "work" },
        agents: { list: [{ id: "main", default: true }] },
      },
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "existing-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: "agent:main:work",
      storeKeys: ["agent:main:work", "agent:main:main"],
    });

    let capturedStore: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:work": { sessionId: "existing-session-id", updatedAt: 10 },
        "agent:main:main": { sessionId: "legacy-session-id", updatedAt: 5 },
      };
      await updater(store);
      capturedStore = store;
    });

    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "test",
        agentId: "main",
        sessionKey: "main",
        idempotencyKey: "test-idem-alias-prune",
      },
      { reqId: "3" },
    );

    expect(mocks.updateSessionStore).toHaveBeenCalled();
    const sessionStore = requireValue(capturedStore, "updated session store missing");
    expect(sessionStore).toHaveProperty("agent:main:work");
    expect(sessionStore["agent:main:main"]).toBeUndefined();
  });

  it("handles bare /new by resetting the same session without running the model", async () => {
    mockSessionResetSuccess({ reason: "new" });
    mocks.agentCommand.mockClear();

    const respond = await invokeAgent(
      {
        message: "/new",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-idem-new",
      },
      {
        reqId: "4",
        client: { connect: { scopes: ["operator.admin"] } } as AgentHandlerArgs["client"],
      },
    );

    expect(mocks.performGatewaySessionReset).toHaveBeenCalledTimes(1);
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mockCallArg(respond)).toBe(true);
    expectRecordFields(mockCallArg(respond, 0, 1), {
      runId: "test-idem-new",
      status: "ok",
      summary: "completed",
    });
    const result = expectRecordFields(mockCallArg(respond, 0, 1), {}).result as {
      payloads?: Array<{ text?: string }>;
      meta?: { agentMeta?: { sessionId?: string } };
    };
    expect(result.payloads?.[0]?.text).toBe("✅ New session started.");
    expect(result.meta?.agentMeta?.sessionId).toBe("reset-session-id");
  });

  it("persists the post-reset follow-up prompt in the canonical user-turn recorder", async () => {
    mockSessionResetSuccess({ reason: "new", sessionId: "reset-session-id" });
    mockMainSessionEntry({ sessionId: "reset-session-id" });
    mocks.performGatewaySessionReset.mockClear();
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "/new continue with this prompt",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-idem-new-followup-recorder",
      },
      {
        reqId: "4-new-followup-recorder",
        client: { connect: { scopes: ["operator.admin"] } } as AgentHandlerArgs["client"],
      },
    );

    const call = await waitForAgentCommandCall<{
      message?: string;
      userTurnTranscriptRecorder?: { message?: { content?: string } };
    }>();
    expect(call.message).toBe("continue with this prompt");
    expect(call.userTurnTranscriptRecorder?.message?.content).toBe("continue with this prompt");
  });

  it("handles bare /reset by resetting the same session without running the model", async () => {
    mockSessionResetSuccess({ reason: "reset" });
    mocks.performGatewaySessionReset.mockClear();
    mocks.agentCommand.mockClear();

    const respond = await invokeAgent(
      {
        message: "/reset",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-idem-reset",
      },
      {
        reqId: "4-reset",
        client: { connect: { scopes: ["operator.admin"] } } as AgentHandlerArgs["client"],
      },
    );

    expect(mocks.performGatewaySessionReset).toHaveBeenCalledTimes(1);
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mockCallArg(respond)).toBe(true);
    const result = expectRecordFields(mockCallArg(respond, 0, 1), {}).result as {
      payloads?: Array<{ text?: string }>;
    };
    expect(result.payloads?.[0]?.text).toBe("✅ Session reset.");
  });

  it("dedupes bare /reset retries after returning the terminal ack", async () => {
    mockSessionResetSuccess({ reason: "reset" });
    mocks.performGatewaySessionReset.mockClear();
    mocks.agentCommand.mockClear();
    const context = makeContext();
    const request = {
      message: "/reset",
      sessionKey: "agent:main:main",
      idempotencyKey: "test-idem-reset-retry",
    };
    const client = {
      connect: { scopes: ["operator.admin"] },
    } as AgentHandlerArgs["client"];

    const firstRespond = await invokeAgent(request, {
      reqId: "4-reset-retry-first",
      client,
      context,
    });
    const secondRespond = await invokeAgent(request, {
      reqId: "4-reset-retry-second",
      client,
      context,
    });

    expect(mocks.performGatewaySessionReset).toHaveBeenCalledTimes(1);
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mockCallArg(firstRespond)).toBe(true);
    expect(mockCallArg(secondRespond)).toBe(true);
    expect(mockCallArg(secondRespond, 0, 1)).toEqual(mockCallArg(firstRespond, 0, 1));
    expect(mockCallArg(secondRespond, 0, 3)).toEqual({ cached: true });
  });

  it("honors strict delivery validation for bare /reset without running the model", async () => {
    mockSessionResetSuccess({ reason: "reset" });
    mockMainSessionEntry({ sessionId: "reset-session-id" });
    mocks.performGatewaySessionReset.mockClear();
    mocks.agentCommand.mockClear();

    const respond = await invokeAgent(
      {
        message: "/reset",
        sessionKey: "agent:main:main",
        deliver: true,
        bestEffortDeliver: false,
        idempotencyKey: "test-idem-reset-deliver-missing-target",
      },
      {
        reqId: "4-reset-deliver-missing-target",
        client: { connect: { scopes: ["operator.admin"] } } as AgentHandlerArgs["client"],
      },
    );

    expect(mocks.performGatewaySessionReset).toHaveBeenCalledTimes(1);
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mockCallArg(respond)).toBe(false);
    expect(mockCallArg(respond, 0, 2)).toMatchObject({
      message: expect.stringContaining(
        "delivery channel is required: pass --channel/--reply-channel or use a main session with a previous channel",
      ),
    });
  });

  it("keeps main-session bare /reset delivery best-effort by default", async () => {
    mockSessionResetSuccess({ reason: "reset" });
    mockMainSessionEntry({ sessionId: "reset-session-id" });
    mocks.performGatewaySessionReset.mockClear();
    mocks.agentCommand.mockClear();

    const respond = await invokeAgent(
      {
        message: "/reset",
        sessionKey: "agent:main:main",
        deliver: true,
        idempotencyKey: "test-idem-reset-deliver-best-effort",
      },
      {
        reqId: "4-reset-deliver-best-effort",
        client: { connect: { scopes: ["operator.admin"] } } as AgentHandlerArgs["client"],
      },
    );

    expect(mocks.performGatewaySessionReset).toHaveBeenCalledTimes(1);
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mockCallArg(respond)).toBe(true);
    const result = expectRecordFields(mockCallArg(respond, 0, 1), {}).result as {
      deliveryStatus?: { requested?: boolean; reason?: string };
      payloads?: Array<{ text?: string }>;
    };
    expect(result.payloads?.[0]?.text).toBe("✅ Session reset.");
    expect(result.deliveryStatus).toMatchObject({
      requested: true,
      reason: "channel_resolved_to_internal",
    });
  });

  it("uses the selected session target for bare /reset delivery when to is an agent session key", async () => {
    const sessionKey = "agent:main:openclaw-weixin:direct:o9cq802hhmfc@im.wechat";
    mockSessionResetSuccess({ reason: "reset", key: sessionKey, sessionId: "wechat-session-id" });
    mocks.loadSessionEntry.mockImplementation((key: string) => ({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: key === sessionKey ? "wechat-session-id" : "main-session-id",
        updatedAt: Date.now(),
        lastChannel: "openclaw-weixin",
        lastTo: "o9cq802hhmfc@im.wechat",
      },
      canonicalKey: key,
    }));
    mocks.getChannelPlugin.mockImplementation((channel: string) =>
      channel === "openclaw-weixin"
        ? {
            id: "openclaw-weixin",
            meta: { label: "WeChat" },
            capabilities: { chatTypes: ["direct"] },
            config: {},
            outbound: {
              resolveTarget: ({ to }: { to?: string }) =>
                to === "o9cq802hhmfc@im.wechat"
                  ? { ok: true, to }
                  : { ok: false, error: new Error(`unexpected target: ${to ?? "none"}`) },
            },
          }
        : undefined,
    );
    mocks.sendDurableMessageBatch.mockResolvedValue({
      status: "sent",
      results: [],
      receipt: {},
    });
    mocks.performGatewaySessionReset.mockClear();
    mocks.agentCommand.mockClear();

    const respond = await invokeAgent(
      {
        message: "/reset",
        to: sessionKey,
        deliver: true,
        idempotencyKey: "test-idem-reset-deliver-session-key-to",
      },
      {
        reqId: "4-reset-deliver-session-key-to",
        client: { connect: { scopes: ["operator.admin"] } } as AgentHandlerArgs["client"],
        context: { ...makeContext(), deps: {} } as GatewayRequestContext,
      },
    );

    expect(mocks.performGatewaySessionReset).toHaveBeenCalledTimes(1);
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mockCallArg(respond)).toBe(true);
    const result = expectRecordFields(mockCallArg(respond, 0, 1), {}).result as {
      deliveryStatus?: { requested?: boolean; status?: string; succeeded?: boolean };
      payloads?: Array<{ text?: string }>;
    };
    expect(result.payloads?.[0]?.text).toBe("✅ Session reset.");
    expect(result.deliveryStatus).toMatchObject({
      requested: true,
      status: "sent",
      succeeded: true,
    });
    expect(mocks.sendDurableMessageBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "openclaw-weixin",
        to: "o9cq802hhmfc@im.wechat",
      }),
    );
  });

  it("resets the selected global agent session for bare /new without startup context", async () => {
    mocks.listAgentIds.mockReturnValue(["main", "work"]);
    mocks.loadConfigReturn = {
      agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      session: { scope: "global" },
    };
    mocks.performGatewaySessionReset.mockClear();
    mocks.performGatewaySessionReset.mockImplementation(
      async (opts: { key: string; agentId?: string; reason: string; commandSource: string }) => {
        expect(opts).toMatchObject({
          key: "global",
          agentId: "work",
          reason: "new",
          commandSource: "gateway:agent",
        });
        return {
          ok: true,
          key: "global",
          entry: { sessionId: "global-work-reset-session" },
        };
      },
    );

    const respond = await invokeAgent(
      {
        message: "/new",
        sessionKey: "global",
        agentId: "work",
        idempotencyKey: "test-idem-new-selected-global",
      },
      {
        reqId: "4c-startup",
        client: { connect: { scopes: ["operator.admin"] } } as AgentHandlerArgs["client"],
      },
    );

    expect(mocks.performGatewaySessionReset).toHaveBeenCalledTimes(1);
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mockCallArg(respond)).toBe(true);
    const result = expectRecordFields(mockCallArg(respond, 0, 1), {}).result as {
      payloads?: Array<{ text?: string }>;
      meta?: { agentMeta?: { sessionId?: string } };
    };
    expect(result.payloads?.[0]?.text).toBe("✅ New session started.");
    expect(result.meta?.agentMeta?.sessionId).toBe("global-work-reset-session");
  });

  it("uses /reset suffix as the post-reset message for LLM-boundary timestamping", async () => {
    setupNewYorkTimeConfig("2026-01-29T01:30:00.000Z");
    mockSessionResetSuccess({ reason: "reset" });
    mocks.performGatewaySessionReset.mockClear();
    primeMainAgentRun({
      sessionId: "reset-session-id",
      cfg: mocks.loadConfigReturn,
    });

    await invokeAgent(
      {
        message: "/reset check status",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-idem-reset-suffix",
      },
      {
        reqId: "4b",
        client: { connect: { scopes: ["operator.admin"] } } as AgentHandlerArgs["client"],
      },
    );

    const call = await expectResetCall("check status");
    expect(call?.sessionId).toBe("reset-session-id");

    resetTimeConfig();
  });

  it("resets the selected global agent session from agent commands", async () => {
    setupNewYorkTimeConfig("2026-01-29T01:30:00.000Z");
    mocks.listAgentIds.mockReturnValue(["main", "work"]);
    mocks.loadConfigReturn = {
      agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      session: { scope: "global" },
    };
    mocks.performGatewaySessionReset.mockClear();
    mocks.performGatewaySessionReset.mockImplementation(
      async (opts: { key: string; agentId?: string; reason: string; commandSource: string }) => {
        expect(opts).toMatchObject({
          key: "global",
          agentId: "work",
          reason: "reset",
          commandSource: "gateway:agent",
        });
        return {
          ok: true,
          key: "global",
          entry: { sessionId: "global-work-reset-session" },
        };
      },
    );
    mocks.loadSessionEntry.mockReturnValue({
      cfg: mocks.loadConfigReturn,
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "global-work-reset-session",
        updatedAt: Date.now(),
      },
      canonicalKey: "global",
    });
    mocks.updateSessionStore.mockResolvedValue(undefined);
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "/reset check status",
        sessionKey: "global",
        agentId: "work",
        idempotencyKey: "test-idem-reset-selected-global",
      },
      {
        reqId: "4c",
        client: { connect: { scopes: ["operator.admin"] } } as AgentHandlerArgs["client"],
      },
    );

    expect(mocks.performGatewaySessionReset).toHaveBeenCalledTimes(1);
    const call = await waitForAgentCommandCall<{ agentId?: string; sessionKey?: string }>();
    expect(call.agentId).toBe("work");
    expect(call.sessionKey).toBe("global");

    resetTimeConfig();
  });

  it("rejects malformed agent session keys early in agent handler", async () => {
    mocks.agentCommand.mockClear();
    const respond = await invokeAgent(
      {
        message: "test",
        sessionKey: "agent:main",
        idempotencyKey: "test-malformed-session-key",
      },
      { reqId: "4" },
    );

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    const error = expectRespondError(respond, {});
    expectStringFieldContains(error, "message", "malformed session key");
  });

  it.each(["/reset", "/new", "/reset check status"] as const)(
    "rejects %s for write-scoped gateway callers",
    async (message) => {
      mockMainSessionEntry({ sessionId: "existing-session-id" });
      mocks.performGatewaySessionReset.mockClear();
      mocks.agentCommand.mockClear();

      const respond = await invokeAgent(
        {
          message,
          sessionKey: "agent:main:main",
          idempotencyKey: `test-reset-write-scope-${message.replace(/\W+/g, "-")}`,
        },
        {
          reqId: "4c",
          client: { connect: { scopes: ["operator.write"] } } as AgentHandlerArgs["client"],
        },
      );

      expect(mocks.performGatewaySessionReset).not.toHaveBeenCalled();
      expect(mocks.agentCommand).not.toHaveBeenCalled();
      expectRespondError(respond, { message: "missing scope: operator.admin" });
    },
  );

  it("rejects malformed session keys in agent.identity.get", async () => {
    const respond = await invokeAgentIdentityGet(
      {
        sessionKey: "agent:main",
      },
      { reqId: "5" },
    );

    const error = expectRespondError(respond, {});
    expectStringFieldContains(error, "message", "malformed session key");
  });

  it("redacts unsafe avatar sources in agent.identity.get", async () => {
    mocks.loadConfigReturn = {
      agents: {
        defaults: { workspace: "/tmp/workspace" },
        list: [{ id: "main", identity: { avatar: "/Users/test/private/avatar.png" } }],
      },
    };

    const respond = await invokeAgentIdentityGet(
      {
        sessionKey: "agent:main:main",
      },
      { reqId: "5-avatar-source" },
    );

    expect(mockCallArg(respond)).toBe(true);
    expectRecordFields(mockCallArg(respond, 0, 1), {
      agentId: "main",
      avatar: "A",
      avatarSource: undefined,
      avatarStatus: "none",
      avatarReason: "outside_workspace",
    });
    expect(mockCallArg(respond, 0, 2)).toBeUndefined();
  });

  it("returns workspace-relative avatars as data URLs in agent.identity.get", async () => {
    await withTempDir({ prefix: "openclaw-agent-avatar-" }, async (workspace) => {
      await fs.mkdir(path.join(workspace, "avatars"), { recursive: true });
      await fs.writeFile(path.join(workspace, "avatars", "main.png"), "avatar", "utf8");
      mocks.loadConfigReturn = {
        agents: {
          defaults: { workspace },
          list: [{ id: "main", identity: { avatar: "avatars/main.png" } }],
        },
      };

      const respond = await invokeAgentIdentityGet(
        { sessionKey: "agent:main:main" },
        { reqId: "5-avatar-data" },
      );

      expectRecordFields(mockCallArg(respond, 0, 1), {
        agentId: "main",
        avatar: `data:image/png;base64,${Buffer.from("avatar").toString("base64")}`,
        avatarSource: "avatars/main.png",
        avatarStatus: "local",
      });
    });
  });

  it.each([
    ["remote", "https://example.com/avatar.png"],
    ["data", "data:image/png;base64,aaaa"],
    ["text", "PS"],
  ] as const)("preserves %s avatar values in agent.identity.get", async (_kind, avatar) => {
    mocks.loadConfigReturn = { ui: { assistant: { avatar } } };

    const respond = await invokeAgentIdentityGet(
      { sessionKey: "agent:main:main" },
      { reqId: `5-avatar-${_kind}` },
    );

    expect((mockCallArg(respond, 0, 1) as { avatar?: unknown }).avatar).toBe(avatar);
  });

  it("prefixes same-origin avatar routes in agent.identity.get when Control UI has a base path", async () => {
    mocks.loadConfigReturn = {
      gateway: { controlUi: { basePath: "/openclaw" } },
      ui: { assistant: { avatar: "/avatar/main" } },
    };

    const respond = await invokeAgentIdentityGet(
      { sessionKey: "agent:main:main" },
      { reqId: "5-avatar-route-base-path" },
    );

    expect((mockCallArg(respond, 0, 1) as { avatar?: unknown }).avatar).toBe(
      "/openclaw/avatar/main",
    );
  });

  it("replaces rejected local avatar paths with the default instead of a protected route", async () => {
    await withTempDir({ prefix: "openclaw-agent-avatar-missing-" }, async (workspace) => {
      mocks.loadConfigReturn = {
        agents: {
          defaults: { workspace },
          list: [{ id: "main", identity: { avatar: "avatars/missing.png" } }],
        },
      };

      const respond = await invokeAgentIdentityGet(
        { sessionKey: "agent:main:main" },
        { reqId: "5-avatar-missing" },
      );

      expectRecordFields(mockCallArg(respond, 0, 1), {
        avatar: "A",
        avatarSource: "avatars/missing.png",
        avatarStatus: "none",
        avatarReason: "missing",
      });
    });
  });

  it("inlines a workspace-local avatar in agent.identity.get (#97602)", async () => {
    await withTempDir({ prefix: "openclaw-agent-identity-avatar-" }, async (workspace) => {
      await fs.writeFile(`${workspace}/avatar.png`, REAL_PNG);
      mocks.loadConfigReturn = {
        agents: {
          defaults: { workspace },
          list: [{ id: "main", workspace, identity: { avatar: "avatar.png" } }],
        },
      };

      const respond = await invokeAgentIdentityGet(
        { sessionKey: "agent:main:main" },
        { reqId: "5-local-avatar" },
      );

      expect(mockCallArg(respond)).toBe(true);
      expectRecordFields(mockCallArg(respond, 0, 1), {
        agentId: "main",
        avatar: REAL_PNG_DATA_URL,
        avatarSource: "avatar.png",
        avatarStatus: "local",
      });
      expect(mockCallArg(respond, 0, 2)).toBeUndefined();
    });
  });

  it("reports a hardlinked avatar as unreadable in agent.identity.get", async () => {
    await withTempDir({ prefix: "openclaw-agent-identity-hardlink-" }, async (workspace) => {
      await fs.writeFile(`${workspace}/original.png`, REAL_PNG);
      await fs.link(`${workspace}/original.png`, `${workspace}/avatar.png`);
      mocks.loadConfigReturn = {
        agents: {
          defaults: { workspace },
          list: [{ id: "main", workspace, identity: { avatar: "avatar.png" } }],
        },
      };

      const respond = await invokeAgentIdentityGet(
        { sessionKey: "agent:main:main" },
        { reqId: "5-hardlinked-avatar" },
      );

      expect(mockCallArg(respond)).toBe(true);
      expectRecordFields(mockCallArg(respond, 0, 1), {
        agentId: "main",
        avatar: "A",
        avatarSource: "avatar.png",
        avatarStatus: "none",
        avatarReason: "unreadable",
      });
    });
  });

  it("bounds an agent.identity.get avatar that grows after its descriptor is pinned", async () => {
    await withTempDir({ prefix: "openclaw-agent-identity-growth-" }, async (workspace) => {
      const avatarPath = `${workspace}/avatar.png`;
      await fs.writeFile(avatarPath, REAL_PNG);
      mocks.loadConfigReturn = {
        agents: {
          defaults: { workspace },
          list: [{ id: "main", workspace, identity: { avatar: "avatar.png" } }],
        },
      };
      const originalFstatSync = fsSync.fstatSync;
      const fstatSync = vi.spyOn(fsSync, "fstatSync").mockImplementationOnce((fd) => {
        const stat = originalFstatSync(fd);
        fsSync.appendFileSync(avatarPath, Buffer.alloc(AVATAR_MAX_BYTES));
        return stat;
      });

      try {
        const respond = await invokeAgentIdentityGet(
          { sessionKey: "agent:main:main" },
          { reqId: "5-growing-avatar" },
        );

        expect(mockCallArg(respond)).toBe(true);
        expectRecordFields(mockCallArg(respond, 0, 1), {
          agentId: "main",
          avatar: "A",
          avatarSource: "avatar.png",
          avatarStatus: "none",
          avatarReason: "unreadable",
        });
      } finally {
        fstatSync.mockRestore();
      }
    });
  });

  it("keeps configured emoji precedence free of file metadata in agent.identity.get", async () => {
    await withTempDir({ prefix: "openclaw-agent-identity-emoji-" }, async (workspace) => {
      await fs.writeFile(`${workspace}/identity.png`, REAL_PNG);
      await fs.writeFile(`${workspace}/IDENTITY.md`, "- Avatar: identity.png\n");
      mocks.loadConfigReturn = {
        agents: {
          defaults: { workspace },
          list: [{ id: "main", workspace, identity: { emoji: "🦞" } }],
        },
      };

      const respond = await invokeAgentIdentityGet(
        { sessionKey: "agent:main:main" },
        { reqId: "5-emoji-avatar" },
      );

      expect(mockCallArg(respond)).toBe(true);
      expectRecordFields(mockCallArg(respond, 0, 1), {
        agentId: "main",
        avatar: "🦞",
        avatarSource: undefined,
        avatarStatus: undefined,
        avatarReason: undefined,
      });
    });
  });

  it("allows non-delivery agent invocations when sendPolicy is deny", async () => {
    mocks.agentCommand.mockClear();
    primeMainAgentRun();
    mocks.resolveSendPolicy.mockReturnValue("deny");

    const respond = await runMainAgent("smoke", "non-delivery-deny");

    expect(mocks.resolveSendPolicy).not.toHaveBeenCalled();
    const rejection = respond.mock.calls.find(
      (call: unknown[]) =>
        call[0] === false &&
        (call[2] as Record<string, unknown> | undefined)?.message ===
          "send blocked by session policy",
    );
    expect(rejection).toBeUndefined();
    await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalledTimes(1));
  });

  it("blocks delivery agent invocations when sendPolicy is deny", async () => {
    primeMainAgentRun();
    mocks.resolveSendPolicy.mockReturnValue("deny");
    mocks.agentCommand.mockClear();

    const respond = vi.fn();
    await invokeAgent(
      {
        message: "smoke",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: "delivery-deny",
        deliver: true,
      },
      { respond, reqId: "delivery-deny" },
    );

    expectRespondError(respond, { message: "send blocked by session policy" });
    const sendPolicyArgs = expectRecordFields(mockCallArg(mocks.resolveSendPolicy), {
      sessionKey: "agent:main:main",
    });
    expectRecordFields(sendPolicyArgs.entry, { sessionId: "existing-session-id" });
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  describe("groupId session-entry persistence validation", () => {
    async function captureGroupEntryFields(
      sessionKey: string,
      entry: Record<string, unknown>,
      requestGroupId?: string,
    ) {
      mocks.loadSessionEntry.mockReturnValue({
        cfg: {},
        storePath: "/tmp/sessions.json",
        entry: { sessionId: "existing-session-id", updatedAt: Date.now(), ...entry },
        canonicalKey: sessionKey,
      });
      let capturedEntry: Record<string, unknown> | undefined;
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        const store: Record<string, unknown> = {
          [sessionKey]: { sessionId: "existing-session-id", ...entry },
        };
        await updater(store);
        capturedEntry = store[sessionKey] as Record<string, unknown>;
      });
      mocks.agentCommand.mockResolvedValue({ payloads: [{ text: "ok" }], meta: { durationMs: 1 } });
      await invokeAgent({
        message: "hi",
        agentId: "main",
        sessionKey,
        idempotencyKey: `group-persist-${sessionKey}-${requestGroupId ?? "none"}`,
        ...(requestGroupId !== undefined ? { groupId: requestGroupId } : {}),
      });
      return capturedEntry;
    }

    it("drops forged groupId on non-group session before writing session entry", async () => {
      const entry = await captureGroupEntryFields("agent:main:main", {}, "trusted-group");
      expect(entry?.groupId).toBeUndefined();
    });

    it("preserves groupId when session key encodes matching group membership", async () => {
      const entry = await captureGroupEntryFields(
        "agent:main:slack:group:trusted-group",
        {},
        "trusted-group",
      );
      expect(entry?.groupId).toBe("trusted-group");
    });

    it("clears a previously forged groupId from the session entry on reconnection", async () => {
      // Entry carries a forged groupId from a prior request; new request supplies none.
      const entry = await captureGroupEntryFields(
        "agent:main:main",
        { groupId: "trusted-group" },
        undefined,
      );
      expect(entry?.groupId).toBeUndefined();
    });

    it("trusts groupId when spawnedBy session key encodes the matching group", async () => {
      const entry = await captureGroupEntryFields(
        "agent:main:main",
        { spawnedBy: "agent:main:slack:group:trusted-group" },
        "trusted-group",
      );
      expect(entry?.groupId).toBe("trusted-group");
    });
  });
});

describe("gateway agent handler chat.abort integration", () => {
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
    resetExecApprovalFollowupRuntimeHandoffsForTests();
  }

  beforeEach(() => {
    resetIntegrationState();
  });

  afterEach(() => {
    resetIntegrationState();
  });

  function prime(sessionId = "existing-session-id", cfg: Record<string, unknown> = {}) {
    mockMainSessionEntry({ sessionId }, cfg);
    mocks.updateSessionStore.mockResolvedValue(undefined);
  }

  it("registers an abort controller into chatAbortControllers for an agent run", async () => {
    prime();
    const pending = new Promise(() => {});
    mocks.agentCommand.mockReturnValueOnce(pending);

    const context = makeContext();
    const runId = "idem-abort-register";
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      {
        context,
        reqId: runId,
        client: { connId: "conn-1" } as AgentHandlerArgs["client"],
      },
    );

    const entry = context.chatAbortControllers.get(runId);
    const abortEntry = requireValue(entry, "chat abort entry missing");
    expect(abortEntry.sessionKey).toBe("agent:main:main");
    expect(abortEntry.sessionId).toBe("existing-session-id");
    expect(abortEntry.ownerConnId).toBe("conn-1");
    expect(abortEntry.controller.signal.aborted).toBe(false);
    expect(abortEntry.expiresAtMs - abortEntry.startedAtMs).toBeGreaterThan(24 * 60 * 60_000);
  });

  it("keeps selected-global goals on agent session change events", async () => {
    const goal = {
      schemaVersion: 1,
      id: "goal-work-global",
      objective: "Finish work global task",
      status: "active",
      createdAt: 1,
      updatedAt: 2,
      tokenStart: 0,
      tokensUsed: 5,
      continuationTurns: 0,
    };
    mocks.listAgentIds.mockReturnValue(["main", "work"]);
    mocks.resolveExplicitAgentSessionKey.mockReturnValue("global");
    mocks.loadSessionEntry.mockReturnValue({
      cfg: { agents: { list: [{ id: "main" }, { id: "work" }] }, session: { scope: "global" } },
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "global-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: "global",
    });
    mocks.loadGatewaySessionRow.mockReturnValue({
      key: "global",
      sessionId: "global-session-id",
      kind: "global",
      updatedAt: Date.now(),
      goal,
    });
    mocks.updateSessionStore.mockResolvedValue(undefined);
    mocks.agentCommand.mockReturnValue(new Promise(() => {}));

    const context = makeContext();
    context.getSessionEventSubscriberConnIds = () => new Set(["conn-1"]);
    const runId = "idem-agent-global-goal-event";
    await invokeAgent(
      {
        message: "hi",
        agentId: "work",
        idempotencyKey: runId,
      },
      { context, reqId: runId },
    );

    await waitForAssertion(() => {
      expect(mocks.loadGatewaySessionRow).toHaveBeenCalledWith("global", { agentId: "work" });
      expect(context.addChatRun).toHaveBeenCalledWith(
        runId,
        expect.objectContaining({ sessionKey: "global", agentId: "work" }),
      );
      expect(context.chatAbortControllers.get(runId)?.agentId).toBe("work");
      expect(context.broadcastToConnIds).toHaveBeenCalledWith(
        "sessions.changed",
        expect.objectContaining({
          sessionKey: "global",
          agentId: "work",
          goal: expect.objectContaining({ id: "goal-work-global" }),
        }),
        new Set(["conn-1"]),
        { dropIfSlow: true },
      );
    });
  });

  it("yields after the accepted ack before dispatching heavy agent work", async () => {
    prime();
    mocks.agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-yield-before-dispatch";
    const pending = invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );
    await pending;

    expect(mockCallArg(respond)).toBe(true);
    const acceptedPayload = expectRecordFields(mockCallArg(respond, 0, 1), {
      runId,
      status: "accepted",
    });
    expect(acceptedPayload).not.toHaveProperty("dedupeKeys");
    expect(acceptedPayload).not.toHaveProperty("ownerConnId");
    expect(acceptedPayload).not.toHaveProperty("ownerDeviceId");
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      status: "accepted",
      dedupeKeys: [`agent:${runId}`],
    });
    expect(mockCallArg(respond, 0, 2)).toBeUndefined();
    expect(mockCallArg(respond, 0, 3)).toEqual({ runId });
    expect(mocks.agentCommand).not.toHaveBeenCalled();

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalledTimes(1));

    expect(mocks.agentCommand).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch when chat.abort lands during the accepted ack yield", async () => {
    prime();
    mocks.agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-abort-before-dispatch";
    const pending = invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );
    await waitForAssertion(() => {
      expect(respond).toHaveBeenCalled();
      expect(mocks.agentCommand).not.toHaveBeenCalled();
    });

    expectRecordFields(mockCallArg(respond, 0, 1), {
      runId,
      sessionKey: "agent:main:main",
      status: "accepted",
    });
    expect(context.chatAbortControllers.has(runId)).toBe(true);

    const abortRespond = vi.fn();
    await expectDefined(
      chatHandlers["chat.abort"],
      'chatHandlers["chat.abort"] test invariant',
    )({
      params: { sessionKey: "agent:main:main", runId },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-req", method: "chat.abort" },
      client: null,
      isWebchatConnect: () => false,
    });

    expectRecordFields(mockCallArg(abortRespond, 0, 1), {
      aborted: true,
      runIds: [runId],
    });
    expect(context.chatAbortControllers.has(runId)).toBe(false);
    await pending;

    await flushScheduledDispatchStep();

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      status: "timeout",
      summary: "aborted",
      stopReason: "rpc",
      timeoutPhase: "queue",
      providerStarted: false,
    });
    const finalResponse = respond.mock.calls.find(
      (call: unknown[]) => (call[1] as { status?: unknown } | undefined)?.status === "timeout",
    );
    expectRecordFields(requireValue(finalResponse, "terminal response missing")[1], {
      runId,
      status: "timeout",
      stopReason: "rpc",
      timeoutPhase: "queue",
      providerStarted: false,
    });
  });

  it("preserves stop-command reason when /stop lands during the accepted ack yield", async () => {
    prime();
    mocks.agentCommand.mockReturnValueOnce(new Promise(() => {}));

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-stop-before-dispatch";
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );

    expectRecordFields(mockCallArg(respond, 0, 1), {
      runId,
      sessionKey: "agent:main:main",
      status: "accepted",
    });
    expect(context.chatAbortControllers.has(runId)).toBe(true);

    const stopRespond = vi.fn();
    await expectDefined(
      chatHandlers["chat.send"],
      'chatHandlers["chat.send"] test invariant',
    )({
      params: {
        sessionKey: "agent:main:main",
        message: "/stop",
        idempotencyKey: "idem-stop-command-before-dispatch",
      },
      respond: stopRespond as never,
      context,
      req: { type: "req", id: "stop-req", method: "chat.send" },
      client: null,
      isWebchatConnect: () => false,
    });

    expectRecordFields(mockCallArg(stopRespond, 0, 1), {
      aborted: true,
      runIds: [runId],
    });
    expect(context.chatAbortControllers.has(runId)).toBe(false);

    await flushScheduledDispatchStep();

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      status: "timeout",
      summary: "aborted",
      stopReason: "stop",
    });
    const finalResponse = respond.mock.calls.find(
      (call: unknown[]) => (call[1] as { status?: unknown } | undefined)?.status === "timeout",
    );
    expectRecordFields(requireValue(finalResponse, "terminal response missing")[1], {
      runId,
      status: "timeout",
      stopReason: "stop",
    });
  });

  it("does not dispatch when chat.abort lands during pre-accept setup", async () => {
    prime();
    const requestedSessionKey = "agent:main:legacy-main";
    let releaseSessionWrite: (() => void) | undefined;
    let sessionWriteCalls = 0;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      sessionWriteCalls += 1;
      if (sessionWriteCalls === 1) {
        await new Promise<void>((resolve) => {
          releaseSessionWrite = resolve;
        });
      }
      const store = {
        "agent:main:main": buildExistingMainStoreEntry(),
      };
      return await updater(store);
    });
    mocks.agentCommand.mockReturnValueOnce(new Promise(() => {}));

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-abort-before-registration";
    const pending = invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: requestedSessionKey,
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );
    await waitForAssertion(() => expect(sessionWriteCalls).toBe(1));
    expect(context.chatAbortControllers.has(runId)).toBe(false);
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      sessionKey: requestedSessionKey,
      status: "accepted",
    });

    const abortRespond = vi.fn();
    await expectDefined(
      chatHandlers["chat.abort"],
      'chatHandlers["chat.abort"] test invariant',
    )({
      params: { sessionKey: requestedSessionKey, runId },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-req", method: "chat.abort" },
      client: null,
      isWebchatConnect: () => false,
    });

    expectRecordFields(mockCallArg(abortRespond, 0, 1), {
      aborted: true,
      runIds: [runId],
    });
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      sessionKey: requestedSessionKey,
      status: "timeout",
      summary: "aborted",
      stopReason: "rpc",
    });

    releaseSessionWrite?.();
    await pending;
    await flushScheduledDispatchStep();

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(context.chatAbortControllers.has(runId)).toBe(false);
    const finalResponse = respond.mock.calls.find(
      (call: unknown[]) => (call[1] as { status?: unknown } | undefined)?.status === "timeout",
    );
    expectRecordFields(requireValue(finalResponse, "terminal response missing")[1], {
      runId,
      status: "timeout",
      stopReason: "rpc",
    });
  });

  it("keeps selected-global alias scope when aborting during pre-accept setup", async () => {
    mocks.listAgentIds.mockReturnValue(["main", "work"]);
    mocks.loadConfigReturn = {
      agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      session: { scope: "global" },
    };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: mocks.loadConfigReturn,
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "global-work-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: "global",
    });
    const requestedSessionKey = "agent:work:main";
    let releaseSessionWrite: (() => void) | undefined;
    let sessionWriteCalls = 0;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      sessionWriteCalls += 1;
      if (sessionWriteCalls === 1) {
        await new Promise<void>((resolve) => {
          releaseSessionWrite = resolve;
        });
      }
      const store = {
        global: {
          sessionId: "global-work-session-id",
          updatedAt: Date.now(),
        },
      };
      return await updater(store);
    });
    mocks.agentCommand.mockReturnValueOnce(new Promise(() => {}));

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-selected-global-alias-abort-before-registration";
    const pending = invokeAgent(
      {
        message: "hi",
        agentId: "work",
        sessionKey: requestedSessionKey,
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );
    await waitForAssertion(() => expect(sessionWriteCalls).toBe(1));
    expect(context.chatAbortControllers.has(runId)).toBe(false);
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      sessionKey: "global",
      agentId: "work",
      status: "accepted",
    });

    const abortRespond = vi.fn();
    await expectDefined(
      chatHandlers["chat.abort"],
      'chatHandlers["chat.abort"] test invariant',
    )({
      params: { sessionKey: "global", agentId: "work", runId },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-selected-global-alias-req", method: "chat.abort" },
      client: null,
      isWebchatConnect: () => false,
    });

    expectRecordFields(mockCallArg(abortRespond, 0, 1), {
      aborted: true,
      runIds: [runId],
    });
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      sessionKey: "global",
      agentId: "work",
      status: "timeout",
      summary: "aborted",
      stopReason: "rpc",
    });

    releaseSessionWrite?.();
    await pending;
    await flushScheduledDispatchStep();

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(context.chatAbortControllers.has(runId)).toBe(false);
    const finalResponse = respond.mock.calls.find(
      (call: unknown[]) => (call[1] as { status?: unknown } | undefined)?.status === "timeout",
    );
    expectRecordFields(requireValue(finalResponse, "terminal response missing")[1], {
      runId,
      status: "timeout",
      stopReason: "rpc",
    });
  });

  it("does not dispatch when a stop command lands during pre-accept setup", async () => {
    prime();
    const requestedSessionKey = "agent:main:legacy-main";
    let releaseSessionWrite: (() => void) | undefined;
    let sessionWriteCalls = 0;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      sessionWriteCalls += 1;
      if (sessionWriteCalls === 1) {
        await new Promise<void>((resolve) => {
          releaseSessionWrite = resolve;
        });
      }
      const store = {
        "agent:main:main": buildExistingMainStoreEntry(),
      };
      return await updater(store);
    });
    mocks.agentCommand.mockReturnValueOnce(new Promise(() => {}));

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-stop-before-registration";
    const pending = invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: requestedSessionKey,
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );
    await waitForAssertion(() => expect(sessionWriteCalls).toBe(1));
    expect(context.chatAbortControllers.has(runId)).toBe(false);
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      sessionKey: requestedSessionKey,
      status: "accepted",
    });

    const stopRespond = vi.fn();
    await expectDefined(
      chatHandlers["chat.send"],
      'chatHandlers["chat.send"] test invariant',
    )({
      params: {
        sessionKey: requestedSessionKey,
        message: "/stop",
        idempotencyKey: "idem-stop-command-before-registration",
      },
      respond: stopRespond as never,
      context,
      req: { type: "req", id: "stop-req", method: "chat.send" },
      client: null,
      isWebchatConnect: () => false,
    });

    expectRecordFields(mockCallArg(stopRespond, 0, 1), {
      aborted: true,
      runIds: [runId],
    });
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      sessionKey: requestedSessionKey,
      status: "timeout",
      summary: "aborted",
      stopReason: "stop",
    });

    releaseSessionWrite?.();
    await pending;
    await flushScheduledDispatchStep();

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(context.chatAbortControllers.has(runId)).toBe(false);
    const finalResponse = respond.mock.calls.find(
      (call: unknown[]) => (call[1] as { status?: unknown } | undefined)?.status === "timeout",
    );
    expectRecordFields(requireValue(finalResponse, "terminal response missing")[1], {
      runId,
      status: "timeout",
      stopReason: "stop",
    });
  });

  it("does not dispatch when session-level chat.abort lands during pre-accept setup", async () => {
    prime();
    let releaseSessionWrite: (() => void) | undefined;
    let sessionWriteCalls = 0;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      sessionWriteCalls += 1;
      if (sessionWriteCalls === 1) {
        await new Promise<void>((resolve) => {
          releaseSessionWrite = resolve;
        });
      }
      const store = {
        "agent:main:main": buildExistingMainStoreEntry(),
      };
      return await updater(store);
    });
    mocks.agentCommand.mockReturnValueOnce(new Promise(() => {}));

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-session-level-abort-before-registration";
    const pending = invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );
    await waitForAssertion(() => expect(sessionWriteCalls).toBe(1));
    expect(context.chatAbortControllers.has(runId)).toBe(false);

    const abortRespond = vi.fn();
    await expectDefined(
      chatHandlers["chat.abort"],
      'chatHandlers["chat.abort"] test invariant',
    )({
      params: { sessionKey: "agent:main:main" },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-req", method: "chat.abort" },
      client: null,
      isWebchatConnect: () => false,
    });

    expectRecordFields(mockCallArg(abortRespond, 0, 1), {
      aborted: true,
      runIds: [runId],
    });
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      sessionKey: "agent:main:main",
      status: "timeout",
      summary: "aborted",
      stopReason: "rpc",
    });

    releaseSessionWrite?.();
    await pending;
    await flushScheduledDispatchStep();

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(context.chatAbortControllers.has(runId)).toBe(false);
    const finalResponse = respond.mock.calls.find(
      (call: unknown[]) => (call[1] as { status?: unknown } | undefined)?.status === "timeout",
    );
    expectRecordFields(requireValue(finalResponse, "terminal response missing")[1], {
      runId,
      status: "timeout",
      stopReason: "rpc",
    });
  });

  it("does not dispatch when chat.abort lands during slow attachment setup", async () => {
    mockMainSessionEntry({
      sessionId: "existing-session-id",
      model: "vision-model",
      modelProvider: "test",
      providerOverride: "test",
      modelOverride: "vision-model",
    });
    mocks.updateSessionStore.mockResolvedValue(undefined);
    mocks.agentCommand.mockReturnValueOnce(new Promise(() => {}));

    let releaseCatalog: (() => void) | undefined;
    const context = {
      ...makeContext(),
      loadGatewayModelCatalog: vi.fn(
        async () =>
          await new Promise((resolve) => {
            releaseCatalog = () =>
              resolve([
                {
                  id: "vision-model",
                  name: "vision-model",
                  provider: "test",
                  input: ["image"],
                },
              ]);
          }),
      ),
    } as unknown as GatewayRequestContext;
    const respond = vi.fn();
    const runId = "idem-abort-during-attachment-setup";
    const pending = invokeAgent(
      {
        message: "inspect this",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
        attachments: [
          {
            type: "file",
            mimeType: "image/png",
            fileName: "pixel.png",
            content: Buffer.from("not really a png").toString("base64"),
          },
        ],
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );

    await waitForAssertion(() =>
      expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
        runId,
        sessionKey: "agent:main:main",
        status: "accepted",
      }),
    );
    expect(context.chatAbortControllers.has(runId)).toBe(false);

    const abortRespond = vi.fn();
    await expectDefined(
      chatHandlers["chat.abort"],
      'chatHandlers["chat.abort"] test invariant',
    )({
      params: { sessionKey: "agent:main:main", runId },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-req", method: "chat.abort" },
      client: null,
      isWebchatConnect: () => false,
    });

    expectRecordFields(mockCallArg(abortRespond, 0, 1), {
      aborted: true,
      runIds: [runId],
    });
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      sessionKey: "agent:main:main",
      status: "timeout",
      summary: "aborted",
      stopReason: "rpc",
    });

    releaseCatalog?.();
    await pending;
    await flushScheduledDispatchStep();

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(context.chatAbortControllers.has(runId)).toBe(false);
    const finalResponse = respond.mock.calls.find(
      (call: unknown[]) => (call[1] as { status?: unknown } | undefined)?.status === "timeout",
    );
    expectRecordFields(requireValue(finalResponse, "terminal response missing")[1], {
      runId,
      status: "timeout",
      stopReason: "rpc",
    });
  });

  it("does not recreate a session deleted during slow attachment setup", async () => {
    const sessionKey = "agent:main:main";
    const persistedEntry = {
      sessionId: "existing-session-id",
      updatedAt: Date.now(),
      model: "vision-model",
      modelProvider: "test",
      providerOverride: "test",
      modelOverride: "vision-model",
    };
    let deleted = false;
    mocks.loadSessionEntry.mockImplementation(() => ({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: deleted ? undefined : persistedEntry,
      canonicalKey: sessionKey,
    }));
    mocks.updateSessionStore.mockClear();
    mocks.agentCommand.mockClear();

    let releaseCatalog: (() => void) | undefined;
    const context = {
      ...makeContext(),
      loadGatewayModelCatalog: vi.fn(
        async () =>
          await new Promise((resolve) => {
            releaseCatalog = () =>
              resolve([
                {
                  id: "vision-model",
                  name: "vision-model",
                  provider: "test",
                  input: ["image"],
                },
              ]);
          }),
      ),
    } as unknown as GatewayRequestContext;
    const respond = vi.fn();
    const runId = "idem-delete-during-attachment-setup";
    const pending = invokeAgent(
      {
        message: "inspect this",
        agentId: "main",
        sessionKey,
        idempotencyKey: runId,
        attachments: [
          {
            type: "file",
            mimeType: "image/png",
            fileName: "pixel.png",
            content: Buffer.from("not really a png").toString("base64"),
          },
        ],
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );

    await waitForAssertion(() => expect(context.loadGatewayModelCatalog).toHaveBeenCalled());
    deleted = true;
    releaseCatalog?.();
    await pending;

    expectRespondError(respond, {
      message: `Session "${sessionKey}" was deleted while starting work. Retry.`,
    });
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("does not dispatch into a session reset during slow attachment setup", async () => {
    const sessionKey = "agent:main:main";
    const persistedEntry = {
      sessionId: "existing-session-id",
      updatedAt: Date.now(),
      model: "vision-model",
      modelProvider: "test",
      providerOverride: "test",
      modelOverride: "vision-model",
    };
    let currentEntry = persistedEntry;
    mocks.loadSessionEntry.mockImplementation(() => ({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: currentEntry,
      canonicalKey: sessionKey,
    }));
    mocks.updateSessionStore.mockClear();
    mocks.agentCommand.mockClear();

    let releaseCatalog: (() => void) | undefined;
    const context = {
      ...makeContext(),
      loadGatewayModelCatalog: vi.fn(
        async () =>
          await new Promise((resolve) => {
            releaseCatalog = () =>
              resolve([
                {
                  id: "vision-model",
                  name: "vision-model",
                  provider: "test",
                  input: ["image"],
                },
              ]);
          }),
      ),
    } as unknown as GatewayRequestContext;
    const respond = vi.fn();
    const runId = "idem-reset-during-attachment-setup";
    const pending = invokeAgent(
      {
        message: "inspect this",
        agentId: "main",
        sessionKey,
        idempotencyKey: runId,
        attachments: [
          {
            type: "file",
            mimeType: "image/png",
            fileName: "pixel.png",
            content: Buffer.from("not really a png").toString("base64"),
          },
        ],
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );

    await waitForAssertion(() => expect(context.loadGatewayModelCatalog).toHaveBeenCalled());
    currentEntry = { ...persistedEntry, sessionId: "reset-session-id" };
    releaseCatalog?.();
    await pending;

    expectRespondError(respond, {
      message: `Session "${sessionKey}" changed while starting work. Retry.`,
    });
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("keeps selected-global agent scope while aborting during attachment setup", async () => {
    mocks.listAgentIds.mockReturnValue(["main", "work"]);
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "work-global-session-id",
        updatedAt: Date.now(),
        modelProvider: "test",
        model: "vision-model",
        providerOverride: "test",
        modelOverride: "vision-model",
      },
      canonicalKey: "global",
    });
    mocks.updateSessionStore.mockResolvedValue(undefined);
    mocks.agentCommand.mockReturnValueOnce(new Promise(() => {}));

    let releaseCatalog: (() => void) | undefined;
    const context = {
      ...makeContext(),
      loadGatewayModelCatalog: vi.fn(
        async () =>
          await new Promise((resolve) => {
            releaseCatalog = () =>
              resolve([
                {
                  id: "vision-model",
                  name: "vision-model",
                  provider: "test",
                  input: ["image"],
                },
              ]);
          }),
      ),
    } as unknown as GatewayRequestContext;
    const respond = vi.fn();
    const runId = "idem-selected-global-abort-during-attachment-setup";
    const pending = invokeAgent(
      {
        message: "inspect this",
        agentId: "work",
        sessionKey: "global",
        idempotencyKey: runId,
        attachments: [
          {
            type: "file",
            mimeType: "image/png",
            fileName: "pixel.png",
            content: Buffer.from("not really a png").toString("base64"),
          },
        ],
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );

    await waitForAssertion(() =>
      expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
        runId,
        sessionKey: "global",
        agentId: "work",
        status: "accepted",
      }),
    );
    await waitForAssertion(() => expect(context.loadGatewayModelCatalog).toHaveBeenCalled());
    expect(mocks.loadSessionEntry).toHaveBeenCalledWith("global", {
      agentId: "work",
      clone: false,
    });
    expect(context.chatAbortControllers.has(runId)).toBe(false);

    const abortRespond = vi.fn();
    await expectDefined(
      chatHandlers["chat.abort"],
      'chatHandlers["chat.abort"] test invariant',
    )({
      params: { sessionKey: "global", agentId: "work", runId },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-selected-global-req", method: "chat.abort" },
      client: null,
      isWebchatConnect: () => false,
    });

    expectRecordFields(mockCallArg(abortRespond, 0, 1), {
      aborted: true,
      runIds: [runId],
    });
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      sessionKey: "global",
      agentId: "work",
      status: "timeout",
      summary: "aborted",
      stopReason: "rpc",
    });

    releaseCatalog?.();
    await pending;
    await flushScheduledDispatchStep();

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(context.chatAbortControllers.has(runId)).toBe(false);
    const finalResponse = respond.mock.calls.find(
      (call: unknown[]) => (call[1] as { status?: unknown } | undefined)?.status === "timeout",
    );
    expectRecordFields(requireValue(finalResponse, "terminal response missing")[1], {
      runId,
      status: "timeout",
      stopReason: "rpc",
    });
  });

  it("does not dispatch when chat.abort lands before voice wake reroutes the session", async () => {
    let releaseRouting: (() => void) | undefined;
    mocks.loadVoiceWakeRoutingConfig.mockImplementation(
      async () =>
        await new Promise((resolve) => {
          releaseRouting = () =>
            resolve({
              version: 1,
              defaultTarget: { mode: "current" },
              routes: [],
              updatedAtMs: 0,
            });
        }),
    );
    mocks.resolveVoiceWakeRouteByTrigger.mockReturnValue({ sessionKey: "agent:main:voice" });
    mocks.loadSessionEntry.mockImplementation((sessionKey: string) => ({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: sessionKey === "agent:main:voice" ? "voice-session-id" : "main-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: sessionKey === "agent:main:voice" ? "agent:main:voice" : "agent:main:main",
    }));
    mocks.updateSessionStore.mockResolvedValue(undefined);
    mocks.agentCommand.mockReturnValueOnce(new Promise(() => {}));

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-abort-before-voice-route";
    const pending = invokeAgent(
      {
        message: "wake up",
        sessionKey: "agent:main:main",
        voiceWakeTrigger: "robot wake",
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );

    await waitForAssertion(() =>
      expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
        runId,
        sessionKey: "agent:main:main",
        status: "accepted",
      }),
    );
    expect(context.chatAbortControllers.has(runId)).toBe(false);

    const abortRespond = vi.fn();
    await expectDefined(
      chatHandlers["chat.abort"],
      'chatHandlers["chat.abort"] test invariant',
    )({
      params: { sessionKey: "agent:main:main", runId },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-req", method: "chat.abort" },
      client: null,
      isWebchatConnect: () => false,
    });

    expectRecordFields(mockCallArg(abortRespond, 0, 1), {
      aborted: true,
      runIds: [runId],
    });
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      sessionKey: "agent:main:main",
      status: "timeout",
      summary: "aborted",
      stopReason: "rpc",
    });

    releaseRouting?.();
    await pending;
    await flushScheduledDispatchStep();

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(context.chatAbortControllers.has(runId)).toBe(false);
    const finalResponse = respond.mock.calls.find(
      (call: unknown[]) => (call[1] as { status?: unknown } | undefined)?.status === "timeout",
    );
    expectRecordFields(requireValue(finalResponse, "terminal response missing")[1], {
      runId,
      status: "timeout",
      stopReason: "rpc",
    });
  });

  it("does not register or dispatch agent work prepared across a gateway restart", async () => {
    mocks.registerAgentRunContext.mockClear();
    let releaseRouting: (() => void) | undefined;
    mocks.loadVoiceWakeRoutingConfig.mockImplementation(
      async () =>
        await new Promise((resolve) => {
          releaseRouting = () =>
            resolve({
              version: 1,
              defaultTarget: { mode: "current" },
              routes: [],
              updatedAtMs: 0,
            });
        }),
    );
    mocks.resolveVoiceWakeRouteByTrigger.mockReturnValue({ sessionKey: "agent:main:voice" });
    mocks.loadSessionEntry.mockImplementation((sessionKey: string) => ({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: sessionKey === "agent:main:voice" ? "voice-session-id" : "main-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: sessionKey === "agent:main:voice" ? "agent:main:voice" : "agent:main:main",
    }));
    mocks.updateSessionStore.mockResolvedValue(undefined);

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-restart-during-voice-route";
    const pending = invokeAgent(
      {
        message: "wake up",
        sessionKey: "agent:main:main",
        voiceWakeTrigger: "robot wake",
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );
    await waitForAssertion(() => expect(releaseRouting).toBeTypeOf("function"));

    mocks.lifecycleGeneration = "post-restart-generation";
    releaseRouting?.();
    await pending;

    expect(context.chatAbortControllers.has(runId)).toBe(false);
    expect(mocks.registerAgentRunContext).not.toHaveBeenCalled();
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      sessionKey: "agent:main:voice",
      status: "timeout",
      stopReason: "restart",
      timeoutPhase: "queue",
      providerStarted: false,
    });
  });

  it("does not mutate a session after losing lifecycle ownership while waiting for its store", async () => {
    prime();
    let releaseSessionWrite: (() => void) | undefined;
    let updaterCompleted = false;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      await new Promise<void>((resolve) => {
        releaseSessionWrite = resolve;
      });
      const store = {
        "agent:main:main": buildExistingMainStoreEntry(),
      };
      const result = await updater(store);
      updaterCompleted = true;
      return result;
    });

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-restart-during-session-write";
    const pending = invokeAgent(
      {
        message: "hi",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );
    await waitForAssertion(() => expect(releaseSessionWrite).toBeTypeOf("function"));

    mocks.lifecycleGeneration = "post-restart-generation";
    releaseSessionWrite?.();
    await pending;

    expect(updaterCompleted).toBe(false);
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      sessionKey: "agent:main:main",
      status: "timeout",
      stopReason: "restart",
    });
  });

  it("does not acknowledge a bare reset that loses lifecycle ownership", async () => {
    prime();
    let releaseReset: (() => void) | undefined;
    mocks.performGatewaySessionReset.mockImplementation(
      async (opts: { assertCurrent?: () => void }) => {
        await new Promise<void>((resolve) => {
          releaseReset = resolve;
        });
        opts.assertCurrent?.();
        return {
          ok: true,
          key: "agent:main:main",
          entry: { sessionId: "reset-session-id" },
        };
      },
    );

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-restart-during-bare-reset";
    const pending = invokeAgent(
      {
        message: "/reset",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      {
        context,
        respond,
        reqId: runId,
        client: { connect: { scopes: ["operator.admin"] } } as AgentHandlerArgs["client"],
      },
    );
    await waitForAssertion(() => expect(releaseReset).toBeTypeOf("function"));

    mocks.lifecycleGeneration = "post-restart-generation";
    releaseReset?.();
    await pending;

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      sessionKey: "agent:main:main",
      status: "timeout",
      stopReason: "restart",
    });
    expect(
      respond.mock.calls.some(
        (call: unknown[]) => (call[1] as { result?: unknown } | undefined)?.result !== undefined,
      ),
    ).toBe(false);
  });

  it("acknowledges a committed reset when restart prevents its follow-up", async () => {
    prime();
    mocks.performGatewaySessionReset.mockImplementation(
      async (opts: { onCommitted?: (commit: { key: string; sessionId: string }) => void }) => {
        opts.onCommitted?.({
          key: "agent:main:main",
          sessionId: "reset-session-id",
        });
        mocks.lifecycleGeneration = "post-restart-generation";
        return {
          ok: true,
          key: "agent:main:main",
          entry: { sessionId: "reset-session-id" },
        };
      },
    );

    const context = makeContext();
    const respond = await invokeAgent(
      {
        message: "/reset check status",
        sessionKey: "agent:main:main",
        idempotencyKey: "idem-restart-after-reset-commit",
      },
      {
        context,
        reqId: "restart-after-reset-commit",
        client: { connect: { scopes: ["operator.admin"] } } as AgentHandlerArgs["client"],
      },
    );

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mockCallArg(respond)).toBe(true);
    const result = expectRecordFields(mockCallArg(respond, 0, 1), {
      status: "ok",
      summary: "completed",
    }).result as { payloads?: Array<{ text?: string }> };
    expect(result.payloads?.[0]?.text).toContain("Session reset.");
    expect(result.payloads?.[0]?.text).toContain("send the follow-up message again");
    expectRecordFields(context.dedupe.get("agent:idem-restart-after-reset-commit")?.payload, {
      status: "ok",
      summary: "completed",
    });
  });

  it("acknowledges a committed bare reset after lifecycle rotation", async () => {
    prime();
    mocks.performGatewaySessionReset.mockImplementation(
      async (opts: { onCommitted?: (commit: { key: string; sessionId: string }) => void }) => {
        opts.onCommitted?.({
          key: "agent:main:main",
          sessionId: "reset-session-id",
        });
        mocks.lifecycleGeneration = "post-restart-generation";
        return {
          ok: true,
          key: "agent:main:main",
          entry: { sessionId: "reset-session-id" },
        };
      },
    );

    const context = makeContext();
    const respond = await invokeAgent(
      {
        message: "/reset",
        sessionKey: "agent:main:main",
        idempotencyKey: "idem-restart-after-bare-reset",
      },
      {
        context,
        reqId: "restart-after-bare-reset",
        client: { connect: { scopes: ["operator.admin"] } } as AgentHandlerArgs["client"],
      },
    );

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mockCallArg(respond)).toBe(true);
    const result = expectRecordFields(mockCallArg(respond, 0, 1), {
      status: "ok",
      summary: "completed",
    }).result as { payloads?: Array<{ text?: string }> };
    expect(result.payloads?.[0]?.text).toBe("✅ Session reset.");
    expectRecordFields(context.dedupe.get("agent:idem-restart-after-bare-reset")?.payload, {
      status: "ok",
      summary: "completed",
    });
  });

  it("acknowledges a committed reset when post-commit work fails after rotation", async () => {
    prime();
    mocks.performGatewaySessionReset.mockImplementation(
      async (opts: { onCommitted?: (commit: { key: string; sessionId: string }) => void }) => {
        opts.onCommitted?.({
          key: "agent:main:main",
          sessionId: "reset-session-id",
        });
        mocks.lifecycleGeneration = "post-restart-generation";
        throw new Error("post-commit cleanup failed");
      },
    );

    const context = makeContext();
    const respond = await invokeAgent(
      {
        message: "/reset",
        sessionKey: "agent:main:main",
        idempotencyKey: "idem-post-commit-reset-failure",
      },
      {
        context,
        reqId: "post-commit-reset-failure",
        client: { connect: { scopes: ["operator.admin"] } } as AgentHandlerArgs["client"],
      },
    );

    expect(mockCallArg(respond)).toBe(true);
    const result = expectRecordFields(mockCallArg(respond, 0, 1), {
      status: "ok",
      summary: "completed",
    }).result as { payloads?: Array<{ text?: string }> };
    expect(result.payloads?.[0]?.text).toBe("✅ Session reset.");
    expectRecordFields(context.dedupe.get("agent:idem-post-commit-reset-failure")?.payload, {
      status: "ok",
      summary: "completed",
    });
  });

  it("acknowledges a committed reset when restart wins during later session persistence", async () => {
    prime();
    mockSessionResetSuccess({ reason: "reset" });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store = {
        "agent:main:main": buildExistingMainStoreEntry(),
      };
      const result = await updater(store);
      mocks.lifecycleGeneration = "post-restart-generation";
      return result;
    });

    const context = makeContext();
    const respond = await invokeAgent(
      {
        message: "/reset check status",
        sessionKey: "agent:main:main",
        idempotencyKey: "idem-restart-after-reset-later",
      },
      {
        context,
        reqId: "restart-after-reset-later",
        client: { connect: { scopes: ["operator.admin"] } } as AgentHandlerArgs["client"],
      },
    );

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mockCallArg(respond)).toBe(true);
    const result = expectRecordFields(mockCallArg(respond, 0, 1), {
      status: "ok",
      summary: "completed",
    }).result as { payloads?: Array<{ text?: string }> };
    expect(result.payloads?.[0]?.text).toContain("send the follow-up message again");
    expectRecordFields(context.dedupe.get("agent:idem-restart-after-reset-later")?.payload, {
      status: "ok",
      summary: "completed",
    });
  });

  it("rejects unauthorized chat.abort during pre-accept setup", async () => {
    prime();
    let releaseSessionWrite: (() => void) | undefined;
    let sessionWriteCalls = 0;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      sessionWriteCalls += 1;
      if (sessionWriteCalls === 1) {
        await new Promise<void>((resolve) => {
          releaseSessionWrite = resolve;
        });
      }
      const store = {
        "agent:main:main": buildExistingMainStoreEntry(),
      };
      return await updater(store);
    });
    mocks.agentCommand.mockReturnValueOnce(new Promise(() => {}));

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-abort-before-registration-unauthorized";
    const pending = invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      {
        context,
        respond,
        reqId: runId,
        flushDispatch: false,
        client: { connId: "owner-conn" } as AgentHandlerArgs["client"],
      },
    );
    await waitForAssertion(() => expect(sessionWriteCalls).toBe(1));
    expect(context.chatAbortControllers.has(runId)).toBe(false);

    const abortRespond = vi.fn();
    await expectDefined(
      chatHandlers["chat.abort"],
      'chatHandlers["chat.abort"] test invariant',
    )({
      params: { sessionKey: "agent:main:main", runId },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-req", method: "chat.abort" },
      client: { connId: "other-conn" } as AgentHandlerArgs["client"],
      isWebchatConnect: () => false,
    });

    expect(mockCallArg(abortRespond, 0, 0)).toBe(false);
    expectRecordFields(mockCallArg(abortRespond, 0, 2), {
      code: "INVALID_REQUEST",
      message: "unauthorized",
    });
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      sessionKey: "agent:main:main",
      status: "accepted",
    });

    releaseSessionWrite?.();
    await pending;
    await flushScheduledDispatchStep();

    expect(mocks.agentCommand).toHaveBeenCalledTimes(1);
    expect(context.chatAbortControllers.has(runId)).toBe(true);
  });

  it("updates exec approval followup aliases when chat.abort lands during pre-accept setup", async () => {
    const bashElevated = {
      enabled: true,
      allowed: true,
      defaultLevel: "on" as const,
    };
    const firstRegistration = registerExecApprovalFollowupRuntimeHandoff({
      approvalId: "req-elevated-preaccept-abort",
      sessionKey: "agent:main:telegram:direct:123",
      bashElevated,
    });
    const secondRegistration = registerExecApprovalFollowupRuntimeHandoff({
      approvalId: "req-elevated-preaccept-abort",
      sessionKey: "agent:main:telegram:direct:123",
      bashElevated,
    });
    if (!firstRegistration || !secondRegistration) {
      throw new Error("expected runtime handoff ids");
    }
    mockMainSessionEntry({
      sessionId: "existing-session-id",
      lastChannel: "telegram",
      lastTo: "123",
    });
    let releaseSessionWrite: (() => void) | undefined;
    let sessionWriteCalls = 0;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      sessionWriteCalls += 1;
      if (sessionWriteCalls === 1) {
        await new Promise<void>((resolve) => {
          releaseSessionWrite = resolve;
        });
      }
      const store = {
        "agent:main:main": buildExistingMainStoreEntry({
          lastChannel: "telegram",
          lastTo: "123",
        }),
      };
      return await updater(store);
    });
    mocks.agentCommand.mockImplementation(() => new Promise(() => {}));
    const context = makeContext();
    const runId = firstRegistration.idempotencyKey;
    const aliasKey = "agent:exec-approval-followup:req-elevated-preaccept-abort";

    const pending = invokeAgent(
      {
        message: "exec followup",
        sessionKey: "agent:main:telegram:direct:123",
        channel: "telegram",
        idempotencyKey: runId,
        internalRuntimeHandoffId: firstRegistration.handoffId,
      },
      {
        reqId: "exec-followup-preaccept-abort-1",
        client: backendGatewayClient(),
        context,
        flushDispatch: false,
      },
    );
    await waitForAssertion(() => expect(sessionWriteCalls).toBe(1));
    expectRecordFields(context.dedupe.get(aliasKey)?.payload, {
      runId,
      sessionKey: "agent:main:telegram:direct:123",
      status: "accepted",
    });

    const abortRespond = vi.fn();
    await expectDefined(
      chatHandlers["chat.abort"],
      'chatHandlers["chat.abort"] test invariant',
    )({
      params: { sessionKey: "agent:main:telegram:direct:123", runId },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-req", method: "chat.abort" },
      client: backendGatewayClient(),
      isWebchatConnect: () => false,
    });

    expectRecordFields(mockCallArg(abortRespond, 0, 1), {
      aborted: true,
      runIds: [runId],
    });
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      status: "timeout",
      stopReason: "rpc",
    });
    expectRecordFields(context.dedupe.get(aliasKey)?.payload, {
      runId,
      status: "timeout",
      stopReason: "rpc",
    });

    releaseSessionWrite?.();
    await pending;

    const retryRespond = await invokeAgent(
      {
        message: "exec followup duplicate",
        sessionKey: "agent:main:telegram:direct:123",
        channel: "telegram",
        idempotencyKey: secondRegistration.idempotencyKey,
        internalRuntimeHandoffId: secondRegistration.handoffId,
      },
      {
        reqId: "exec-followup-preaccept-abort-2",
        client: backendGatewayClient(),
        context,
        flushDispatch: false,
      },
    );

    expect(mockCallArg(retryRespond, 0, 1)).toMatchObject({
      runId,
      status: "timeout",
      stopReason: "rpc",
    });
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("uses the explicit no-timeout agent expiry instead of the chat 24h cap", async () => {
    prime();
    mocks.agentCommand.mockImplementation(() => new Promise(() => {}));

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-abort-no-timeout";
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
        timeout: 0,
      },
      { context, respond, reqId: runId },
    );

    const entry = context.chatAbortControllers.get(runId);
    const abortEntry = requireValue(entry, "chat abort entry missing");
    expect(abortEntry.expiresAtMs - abortEntry.startedAtMs).toBeGreaterThan(24 * 60 * 60_000);
  });

  it("sets the maintenance expiry to the configured agent timeout, not the 24h chat default", async () => {
    prime();
    const pending = new Promise(() => {});
    mocks.agentCommand.mockReturnValueOnce(pending);

    mocks.loadConfigReturn = {
      agents: { defaults: { timeoutSeconds: 48 * 60 * 60 } },
    };
    const context = makeContext();
    const runId = "idem-abort-expires";
    const before = Date.now();
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, reqId: runId },
    );
    mocks.loadConfigReturn = {};

    const entry = context.chatAbortControllers.get(runId);
    const abortEntry = requireValue(entry, "chat abort entry missing");
    // 48h configured timeout must not be silently truncated to the 24h
    // chat.send default cap baked into resolveChatRunExpiresAtMs. Assert
    // at least 25h to leave headroom above the 24h cap; the expected
    // value is ~48h.
    const TWENTY_FIVE_HOURS_MS = 25 * 60 * 60 * 1_000;
    expect(abortEntry.expiresAtMs - before).toBeGreaterThan(TWENTY_FIVE_HOURS_MS);
  });

  it("chat.abort by runId aborts the agent run's signal and removes the entry", async () => {
    prime();
    const pending = new Promise(() => {});
    let capturedSignal: AbortSignal | undefined;
    mocks.agentCommand.mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
      capturedSignal = opts.abortSignal;
      return pending;
    });

    const context = makeContext();
    const runId = "idem-abort-run";
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, reqId: runId },
    );

    expect(context.chatAbortControllers.has(runId)).toBe(true);
    expect(capturedSignal?.aborted).toBe(false);

    const abortRespond = vi.fn();
    await expectDefined(
      chatHandlers["chat.abort"],
      'chatHandlers["chat.abort"] test invariant',
    )({
      params: { sessionKey: "agent:main:main", runId },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-req", method: "chat.abort" },
      client: null,
      isWebchatConnect: () => false,
    });

    expect(mockCallArg(abortRespond)).toBe(true);
    expectRecordFields(mockCallArg(abortRespond, 0, 1), {
      aborted: true,
      runIds: [runId],
    });
    expect(capturedSignal?.aborted).toBe(true);
    expect(context.chatAbortControllers.has(runId)).toBe(false);
  });

  it("chat.abort by runId allows the owner connection to use a stale session key", async () => {
    prime();
    const pending = new Promise(() => {});
    let capturedSignal: AbortSignal | undefined;
    mocks.agentCommand.mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
      capturedSignal = opts.abortSignal;
      return pending;
    });

    const context = makeContext();
    const runId = "idem-abort-stale-session-key";
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      {
        context,
        reqId: runId,
        client: { connId: "owner-conn" } as AgentHandlerArgs["client"],
      },
    );

    const active = requireValue(context.chatAbortControllers.get(runId), "active run missing");
    context.chatAbortControllers.set(runId, {
      ...active,
      sessionKey: "agent:main:canonical",
    });

    const abortRespond = vi.fn();
    await expectDefined(
      chatHandlers["chat.abort"],
      'chatHandlers["chat.abort"] test invariant',
    )({
      params: { sessionKey: "agent:main:main", runId },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-req", method: "chat.abort" },
      client: { connId: "owner-conn" } as AgentHandlerArgs["client"],
      isWebchatConnect: () => false,
    });

    expect(mockCallArg(abortRespond)).toBe(true);
    expectRecordFields(mockCallArg(abortRespond, 0, 1), {
      aborted: true,
      runIds: [runId],
    });
    expect(capturedSignal?.aborted).toBe(true);
    expect(context.chatAbortControllers.has(runId)).toBe(false);
  });

  it("keeps the sessions.abort wait snapshot after late agent completion", async () => {
    prime();
    let capturedSignal: AbortSignal | undefined;
    let resolveRun:
      | ((value: { payloads: Array<{ text: string }>; meta: { durationMs: number } }) => void)
      | undefined;
    mocks.agentCommand.mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
      capturedSignal = opts.abortSignal;
      return new Promise((resolve) => {
        resolveRun = resolve;
      });
    });

    const context = makeContext();
    const runId = "idem-abort-snapshot-wins";
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, reqId: runId },
    );

    const abortRespond = vi.fn();
    await expectDefined(
      chatHandlers["chat.abort"],
      'chatHandlers["chat.abort"] test invariant',
    )({
      params: { sessionKey: "agent:main:main", runId },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-req", method: "chat.abort" },
      client: null,
      isWebchatConnect: () => false,
    });
    expect(capturedSignal?.aborted).toBe(true);

    setGatewayDedupeEntry({
      dedupe: context.dedupe,
      key: `agent:${runId}`,
      entry: {
        ts: 100,
        ok: true,
        payload: {
          runId,
          status: "timeout",
          stopReason: "rpc",
          endedAt: 100,
        },
      },
    });

    resolveRun?.({ payloads: [{ text: "late ok" }], meta: { durationMs: 1 } });

    await waitForAssertion(() => {
      expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
        runId,
        status: "timeout",
        stopReason: "rpc",
        endedAt: 100,
      });
    });
  });

  it("chat.abort without runId aborts the active agent run for the sessionKey", async () => {
    prime();
    let capturedSignal: AbortSignal | undefined;
    mocks.agentCommand.mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
      capturedSignal = opts.abortSignal;
      return new Promise(() => {});
    });

    const context = makeContext();
    const runId = "idem-abort-session";
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, reqId: runId },
    );

    const abortRespond = vi.fn();
    await expectDefined(
      chatHandlers["chat.abort"],
      'chatHandlers["chat.abort"] test invariant',
    )({
      params: { sessionKey: "agent:main:main" },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-req", method: "chat.abort" },
      client: null,
      isWebchatConnect: () => false,
    });

    expect(mockCallArg(abortRespond)).toBe(true);
    expectRecordFields(mockCallArg(abortRespond, 0, 1), {
      aborted: true,
      runIds: [runId],
    });
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("removes the chatAbortControllers entry after the run completes successfully", async () => {
    prime();
    mocks.agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 1 },
    });

    const context = makeContext();
    const runId = "idem-abort-cleanup-ok";
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, reqId: runId },
    );

    await waitForAssertion(() => {
      expect(context.chatAbortControllers.has(runId)).toBe(false);
    });
  });

  it("retains agent RPC registration until terminal persistence settles", async () => {
    prime();
    let resolveAgent: (value: {
      payloads: Array<{ text: string }>;
      meta: { durationMs: number };
    }) => void = () => undefined;
    const agentResult = new Promise<{
      payloads: Array<{ text: string }>;
      meta: { durationMs: number };
    }>((resolve) => {
      resolveAgent = resolve;
    });
    mocks.agentCommand.mockReturnValueOnce(agentResult);

    const context = makeContext();
    const runId = "idem-abort-cleanup-persisting";
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, reqId: runId },
    );

    const entry = requireValue(context.chatAbortControllers.get(runId), "chat abort entry missing");
    let resolvePersistence: () => void = () => undefined;
    entry.projectSessionTerminalPersistence = new Promise<void>((resolve) => {
      resolvePersistence = resolve;
    });
    resolveAgent({ payloads: [{ text: "ok" }], meta: { durationMs: 1 } });

    await waitForAssertion(() => {
      expect(context.chatAbortControllers.has(runId)).toBe(true);
    });
    resolvePersistence();
    await waitForAssertion(() => {
      expect(context.chatAbortControllers.has(runId)).toBe(false);
    });
  });

  it("removes the chatAbortControllers entry after the run errors", async () => {
    prime();
    mocks.clearAgentRunContext.mockClear();
    mocks.agentCommand.mockRejectedValueOnce(new Error("boom"));

    const context = makeContext();
    const runId = "idem-abort-cleanup-err";
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, reqId: runId },
    );

    await waitForAssertion(() => {
      expect(context.chatAbortControllers.has(runId)).toBe(false);
      expect(mocks.clearAgentRunContext).toHaveBeenCalledWith(runId, "test-generation");
    });
  });

  it("removes the chatAbortControllers entry if pre-dispatch reactivation fails", async () => {
    prime("reactivation-session");
    mocks.getLatestSubagentRunByChildSessionKey.mockReturnValueOnce({
      runId: "previous-run",
      childSessionKey: "agent:main:main",
      controllerSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      requesterDisplayKey: "main",
      task: "old task",
      cleanup: "keep",
      createdAt: 1,
      startedAt: 2,
      endedAt: 3,
      outcome: { status: "ok" },
    });
    mocks.replaceSubagentRunAfterSteer.mockRejectedValueOnce(new Error("reactivate boom"));

    const context = makeContext();
    const runId = "idem-abort-reactivation-fails";
    const respond = vi.fn();
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, reqId: runId, respond },
    );

    expect(context.chatAbortControllers.has(runId)).toBe(false);
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    const errorCall = respond.mock.calls.find((call: unknown[]) => call[0] === false);
    const errorArgs = requireValue(errorCall, "error response missing");
    expectRecordFields(errorArgs[1], { runId, status: "error" });
    expectRecordFields(errorArgs[2], { code: "UNAVAILABLE" });
    expectRecordFields(errorArgs[3], { runId });
  });

  it("does not dispatch a duplicate agent run when dedupe was evicted but the run is active", async () => {
    prime();
    mocks.agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 1 },
    });

    const context = makeContext();
    const runId = "idem-abort-collision";
    const preExisting = {
      controller: new AbortController(),
      sessionId: "chat-send-session",
      sessionKey: "agent:main:main",
      startedAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
      ownerConnId: "chat-send-conn",
      ownerDeviceId: undefined,
    };
    context.chatAbortControllers.set(runId, preExisting);
    context.dedupe.delete(`agent:${runId}`);
    mocks.registerAgentRunContext.mockClear();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, reqId: runId, respond },
    );

    expect(context.chatAbortControllers.get(runId)).toBe(preExisting);
    expect(context.dedupe.has(`agent:${runId}`)).toBe(false);
    expect(context.addChatRun).not.toHaveBeenCalled();
    expect(mocks.registerAgentRunContext).not.toHaveBeenCalled();
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(true, { runId, status: "in_flight" }, undefined, {
      cached: true,
      runId,
    });
  });

  it("returns in_flight instead of replaying cached accepted agent replies", async () => {
    prime();
    mocks.agentCommand.mockImplementationOnce(
      () =>
        new Promise(() => {
          // Keep the first run pending so the dedupe entry remains accepted.
        }),
    );

    const context = makeContext();
    const runId = "idem-cached-accepted";
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, reqId: runId, flushDispatch: false },
    );

    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      status: "accepted",
      sessionKey: "agent:main:main",
    });

    const duplicateRespond = vi.fn();
    await invokeAgent(
      {
        message: "hi again",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, reqId: `${runId}-duplicate`, respond: duplicateRespond },
    );

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(duplicateRespond).toHaveBeenCalledWith(
      true,
      { runId, status: "in_flight", sessionKey: "agent:main:main" },
      undefined,
      {
        cached: true,
        runId,
      },
    );
  });
});

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
