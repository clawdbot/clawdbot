// Agent method tests cover run/steer/reset/wait behavior, task/subagent state,
// approval followups, lifecycle hooks, and emitted gateway events.
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import {
  registerExecApprovalFollowupRuntimeHandoff,
  resetExecApprovalFollowupRuntimeHandoffsForTests,
} from "../../agents/bash-tools.exec-approval-followup-state.js";
import {
  getSubagentRunByChildSessionKey,
  resetSubagentRegistryForTests,
  testing as subagentRegistryTesting,
} from "../../agents/subagent-registry.js";
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
import { setGatewayDedupeEntry } from "./agent-wait-dedupe.js";
import { agentHandlers } from "./agent.js";
import { chatHandlers } from "./chat.js";
import { expectSubagentFollowupReactivation } from "./subagent-followup.test-helpers.js";
import type { GatewayRequestContext } from "./types.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

const mocks = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
  loadGatewaySessionRow: vi.fn(),
  updateSessionStore: vi.fn(),
  agentCommand: vi.fn(),
  registerAgentRunContext: vi.fn(),
  emitAgentEvent: vi.fn(),
  performGatewaySessionReset: vi.fn(),
  emitGatewaySessionEndPluginHook: vi.fn(),
  emitGatewaySessionStartPluginHook: vi.fn(),
  getLatestSubagentRunByChildSessionKey: vi.fn(),
  replaceSubagentRunAfterSteer: vi.fn(),
  resolveExplicitAgentSessionKey: vi.fn(),
  listAgentIds: vi.fn(() => ["main"]),
  loadConfigReturn: {} as Record<string, unknown>,
  loadVoiceWakeRoutingConfig: vi.fn(),
  resolveVoiceWakeRouteByTrigger: vi.fn(),
  resolveSendPolicy: vi.fn((_args?: { entry?: { sendPolicy?: string } }) => "allow"),
  resolveSessionLifecycleTimestamps: vi.fn(
    ({ entry }: { entry?: { sessionStartedAt?: number; lastInteractionAt?: number } }) => ({
      sessionStartedAt: entry?.sessionStartedAt,
      lastInteractionAt: entry?.lastInteractionAt,
    }),
  ),
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

vi.mock("../../commands/agent.js", () => ({
  agentCommand: mocks.agentCommand,
  agentCommandFromIngress: mocks.agentCommand,
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: () => mocks.loadConfigReturn,
  };
});

vi.mock("../../agents/agent-scope.js", () => ({
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
}));

vi.mock("../../infra/agent-events.js", () => ({
  emitAgentEvent: mocks.emitAgentEvent,
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

vi.mock("../../sessions/send-policy.js", () => ({
  resolveSendPolicy: (...args: unknown[]) =>
    (mocks.resolveSendPolicy as (...args: unknown[]) => unknown)(...args),
}));

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

type AgentHandlerArgs = Parameters<typeof agentHandlers.agent>[0];
type AgentParams = AgentHandlerArgs["params"];
type AgentCommandCall = Record<string, unknown>;

type AgentIdentityGetHandlerArgs = Parameters<(typeof agentHandlers)["agent.identity.get"]>[0];
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
  await agentHandlers.agent({
    params,
    respond: respond as never,
    context: options?.context ?? makeContext(),
    req: { type: "req", id: options?.reqId ?? "agent-test-req", method: "agent" },
    client: options?.client ?? null,
    isWebchatConnect: options?.isWebchatConnect ?? (() => false),
  });
  if (options?.flushDispatch !== false) {
    await waitForAcceptedRunDispatch(respond);
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
  await agentHandlers["agent.identity.get"]({
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
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    resetDetachedTaskLifecycleRuntimeForTests();
    resetTaskRegistryForTests();
    resetSubagentRegistryForTests({ persist: false });
    subagentRegistryTesting.setDepsForTest();
    mocks.loadConfigReturn = {};
    mocks.emitGatewaySessionEndPluginHook.mockReset();
    mocks.emitGatewaySessionStartPluginHook.mockReset();
    mocks.resolveExplicitAgentSessionKey.mockReset().mockReturnValue(undefined);
    mocks.listAgentIds.mockReset().mockReturnValue(["main"]);
    mocks.resolveSendPolicy.mockReset().mockReturnValue("allow");
    mocks.resolveSessionLifecycleTimestamps
      .mockReset()
      .mockImplementation(
        ({ entry }: { entry?: { sessionStartedAt?: number; lastInteractionAt?: number } }) => ({
          sessionStartedAt: entry?.sessionStartedAt,
          lastInteractionAt: entry?.lastInteractionAt,
        }),
      );
    dateOnlyFakeClockActive = false;
    vi.useRealTimers();
    resetExecApprovalFollowupRuntimeHandoffsForTests();
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

  it("uses single-entry persistence for ordinary gateway admission touches", async () => {
    mockMainSessionEntry({});
    let capturedOptions:
      | {
          resolveSingleEntryPersistence?: (result: unknown) => unknown;
        }
      | undefined;
    let persistedResult: unknown;
    mocks.updateSessionStore.mockImplementation(async (_path, updater, opts) => {
      const store: Record<string, Record<string, unknown>> = {
        "agent:main:main": buildExistingMainStoreEntry(),
      };
      persistedResult = await updater(store);
      capturedOptions = opts;
      return persistedResult;
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await runMainAgent("hi", "idem-single-entry-persist");

    expect(capturedOptions?.resolveSingleEntryPersistence?.(persistedResult)).toMatchObject({
      sessionKey: "agent:main:main",
      entry: persistedResult,
    });
  });

  it("disables single-entry persistence when admission prunes legacy store keys", async () => {
    mockMainSessionEntry({});
    let capturedOptions:
      | {
          resolveSingleEntryPersistence?: (result: unknown) => unknown;
        }
      | undefined;
    let persistedResult: unknown;
    mocks.updateSessionStore.mockImplementation(async (_path, updater, opts) => {
      const store: Record<string, Record<string, unknown>> = {
        "agent:main:main": buildExistingMainStoreEntry({ updatedAt: 100 }),
        "Agent:main:main": buildExistingMainStoreEntry({ updatedAt: 50 }),
      };
      persistedResult = await updater(store);
      capturedOptions = opts;
      return persistedResult;
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await runMainAgent("hi", "idem-single-entry-legacy-prune");

    expect(capturedOptions?.resolveSingleEntryPersistence?.(persistedResult)).toBeUndefined();
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
    expect(capturedEntry?.sessionFile).toBeUndefined();
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
    expect(capturedEntry?.sessionFile).toBeUndefined();
  });

  it.each([
    { name: "status terminal row", status: "done" as const },
    { name: "endedAt-only terminal row" },
  ])(
    "rotates a terminal main session from a $name when its transcript is newer",
    async (scenario) => {
      const now = Date.parse("2026-05-18T09:47:00.000Z");
      vi.useFakeTimers({ toFake: ["Date"] });
      dateOnlyFakeClockActive = true;
      vi.setSystemTime(now);

      await withTempDir(
        { prefix: "openclaw-gateway-terminal-main-newer-transcript-" },
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
          expect(call.sessionId).not.toBe("terminal-main-session");
          expect(capturedEntry?.sessionId).not.toBe("terminal-main-session");
          expect(capturedEntry?.status).toBeUndefined();
          expect(capturedEntry?.startedAt).toBeUndefined();
          expect(capturedEntry?.endedAt).toBeUndefined();
          expect(capturedEntry?.runtimeMs).toBeUndefined();
          expect(capturedEntry?.sessionFile).toBeUndefined();
          expect(capturedEntry?.cliSessionBindings).toBeUndefined();
          expect(capturedEntry?.cliSessionIds).toBeUndefined();
          expect(capturedEntry?.claudeCliSessionId).toBeUndefined();
        },
      );
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
      expect(capturedEntry?.sessionFile).toBe(sessionFile);
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
        expect(capturedEntry?.sessionFile).toBe(sessionFile);
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
          expect(capturedEntry?.sessionFile).toBe(sessionFile);
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
    expect(capturedEntry?.sessionFile).toBeUndefined();
  });

  it("keeps a failed session reusable when its default transcript exists", async () => {
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
      expect(capturedEntry?.status).toBe("failed");
      expect(capturedEntry?.sessionFile).toBeUndefined();
    });
  });

  it("keeps a failed session reusable when its relative transcript resolves and exists", async () => {
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
      expect(capturedEntry?.status).toBe("failed");
      expect(capturedEntry?.sessionFile).toBe("relative-present.jsonl");
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
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: undefined,
      canonicalKey: sessionKey,
    });

    let capturedEntry: Record<string, unknown> | undefined;
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
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: undefined,
      canonicalKey: sessionKey,
    });

    let capturedEntry: Record<string, unknown> | undefined;
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
      sessionFile: "/tmp/fresh-session.jsonl",
    });
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

    const callArgs = await waitForAgentCommandCall<{ message?: string }>();
    expect(callArgs.message).toMatch(/^\[Inter-session message\]/);
    expect(callArgs.message).toContain("isUser=false");
    expect(callArgs.message).toContain("forwarded reply");
    expect(callArgs.message).not.toContain("[Wed 2026-01-28 20:30 EST]");

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
    });
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
      process.env.OPENCLAW_STATE_DIR = root;
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
      process.env.OPENCLAW_STATE_DIR = root;
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
        process.env.OPENCLAW_STATE_DIR = root;
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
      process.env.OPENCLAW_STATE_DIR = root;
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
      process.env.OPENCLAW_STATE_DIR = root;
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
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      primeMainAgentRun();
      const abortError = new Error("This operation was aborted");
      abortError.name = "AbortError";
      const context = makeContext();
      const runId = "task-registry-agent-run-abort-error";
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

  it("classifies timeout async gateway agent rejections as timed out", async () => {
    await withTempDir({ prefix: "openclaw-gateway-agent-task-timeout-error-" }, async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
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
        process.env.OPENCLAW_STATE_DIR = root;
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
      process.env.OPENCLAW_STATE_DIR = root;
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
      process.env.OPENCLAW_STATE_DIR = root;
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
      process.env.OPENCLAW_STATE_DIR = root;
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
    });

    let capturedStore: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:work": { sessionId: "existing-session-id", updatedAt: 10 },
        "agent:main:MAIN": { sessionId: "legacy-session-id", updatedAt: 5 },
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
    expect(sessionStore["agent:main:MAIN"]).toBeUndefined();
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
      avatarSource: undefined,
      avatarStatus: "none",
      avatarReason: "outside_workspace",
    });
    expect(mockCallArg(respond, 0, 2)).toBeUndefined();
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
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    resetDetachedTaskLifecycleRuntimeForTests();
    resetTaskRegistryForTests();
    mocks.agentCommand.mockReset();
    mocks.loadConfigReturn = {};
    mocks.loadGatewaySessionRow.mockReset();
    mocks.loadSessionEntry.mockReset();
    mocks.updateSessionStore.mockReset();
    mocks.emitGatewaySessionEndPluginHook.mockReset();
    mocks.emitGatewaySessionStartPluginHook.mockReset();
    mocks.getLatestSubagentRunByChildSessionKey.mockReset();
    mocks.replaceSubagentRunAfterSteer.mockReset();
    mocks.resolveExplicitAgentSessionKey.mockReset().mockReturnValue(undefined);
    mocks.listAgentIds.mockReset().mockReturnValue(["main"]);
    mocks.loadVoiceWakeRoutingConfig.mockReset();
    mocks.resolveVoiceWakeRouteByTrigger.mockReset();
    mocks.resolveSendPolicy.mockReset().mockReturnValue("allow");
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
    mocks.agentCommand.mockReturnValueOnce(new Promise(() => {}));

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

    await Promise.resolve();
    await Promise.resolve();

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
    await pending;

    expect(mocks.agentCommand).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch when chat.abort lands during the accepted ack yield", async () => {
    prime();
    mocks.agentCommand.mockReturnValueOnce(new Promise(() => {}));

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-abort-before-dispatch";
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

    const abortRespond = vi.fn();
    await chatHandlers["chat.abort"]({
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
    await chatHandlers["chat.send"]({
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
    await chatHandlers["chat.abort"]({
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
    await chatHandlers["chat.abort"]({
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
    await chatHandlers["chat.send"]({
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
    await chatHandlers["chat.abort"]({
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
    await chatHandlers["chat.abort"]({
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
    await chatHandlers["chat.abort"]({
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
    await chatHandlers["chat.abort"]({
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
    await chatHandlers["chat.abort"]({
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
    await chatHandlers["chat.abort"]({
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
    await chatHandlers["chat.abort"]({
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
    await chatHandlers["chat.abort"]({
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
    await chatHandlers["chat.abort"]({
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
    await chatHandlers["chat.abort"]({
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

  it("removes the chatAbortControllers entry after the run errors", async () => {
    prime();
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
