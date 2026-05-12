import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerExecApprovalFollowupRuntimeHandoff,
  resetExecApprovalFollowupRuntimeHandoffsForTests,
} from "../../agents/bash-tools.exec-approval-followup-state.js";
import { BARE_SESSION_RESET_PROMPT } from "../../auto-reply/reply/session-reset-prompt.js";
import {
  getDetachedTaskLifecycleRuntime,
  resetDetachedTaskLifecycleRuntimeForTests,
  setDetachedTaskLifecycleRuntime,
} from "../../tasks/detached-task-runtime.js";
import {
  findTaskByRunId,
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
  getLatestSubagentRunByChildSessionKey: vi.fn(),
  replaceSubagentRunAfterSteer: vi.fn(),
  resolveExplicitAgentSessionKey: vi.fn(),
  resolveBareResetBootstrapFileAccess: vi.fn(() => true),
  listAgentIds: vi.fn(() => ["main"]),
  loadConfigReturn: {} as Record<string, unknown>,
  loadVoiceWakeRoutingConfig: vi.fn(),
  resolveVoiceWakeRouteByTrigger: vi.fn(),
  resolveSendPolicy: vi.fn(() => "allow"),
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
  resolveDefaultAgentId: () => "main",
  resolveAgentConfig: (cfg: { agents?: { list?: Array<{ id?: string }> } }, agentId: string) =>
    cfg.agents?.list?.find((agent) => agent.id === agentId),
  resolveAgentWorkspaceDir: (cfg: { agents?: { defaults?: { workspace?: string } } }) =>
    cfg?.agents?.defaults?.workspace ?? "/tmp/workspace",
  resolveAgentEffectiveModelPrimary: () => undefined,
}));

vi.mock("../../auto-reply/reply/session-reset-prompt.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../auto-reply/reply/session-reset-prompt.js")
  >("../../auto-reply/reply/session-reset-prompt.js");
  return {
    ...actual,
    resolveBareResetBootstrapFileAccess: mocks.resolveBareResetBootstrapFileAccess,
  };
});

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
    chatAbortedRuns: new Map(),
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
  return new Promise<void>((resolve) => realSetTimeout(resolve, ms));
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
  throw lastError ?? new Error("assertion did not pass in time");
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
  return mocks.agentCommand.mock.calls.at(-1)?.[0] as AgentCommandCall | undefined;
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
    mocks.loadConfigReturn = {};
    mocks.resolveExplicitAgentSessionKey.mockReset().mockReturnValue(undefined);
    mocks.resolveBareResetBootstrapFileAccess.mockReset().mockReturnValue(true);
    mocks.listAgentIds.mockReset().mockReturnValue(["main"]);
    mocks.resolveSendPolicy.mockReset().mockReturnValue("allow");
    dateOnlyFakeClockActive = false;
    vi.useRealTimers();
    resetExecApprovalFollowupRuntimeHandoffsForTests();
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
    await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalled());
    const callArgs = mocks.agentCommand.mock.calls.at(-1)?.[0] as {
      groupChannel?: string;
      groupSpace?: string;
      runContext?: { groupChannel?: string; groupSpace?: string };
    };
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
    await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalled());
    const callArgs = mocks.agentCommand.mock.calls.at(-1)?.[0] as {
      groupChannel?: string;
      groupSpace?: string;
      runContext?: { groupChannel?: string; groupSpace?: string };
    };
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
      senderIsOwner: false,
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
  it("reactivates completed subagent sessions and broadcasts send updates", async () => {
    const childSessionKey = "agent:main:subagent:followup";
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
        updatedAt: Date.now(),
      },
      canonicalKey: childSessionKey,
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        [childSessionKey]: {
          sessionId: "sess-followup",
          updatedAt: Date.now(),
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
    mockMainSessionEntry({
      sessionId: "sess-main",
      updatedAt: Date.now(),
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

  it("injects a timestamp into the message passed to agentCommand", async () => {
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
    expect(callArgs.message).toBe("[Wed 2026-01-28 20:30 EST] Is it the weekend?");

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
      { reqId: "subagent-announce-suppress-prompt" },
    );

    const callArgs = await waitForAgentCommandCall<{
      suppressPromptPersistence?: boolean;
      message?: string;
    }>();
    expect(callArgs.suppressPromptPersistence).toBe(true);
    expect(callArgs.message).toMatch(/^\[Inter-session message\]/);
    expect(callArgs.message).toContain("sourceTool=subagent_announce");
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
      mocks.agentCommand.mockRejectedValueOnce(abortError);
      const context = makeContext();

      await invokeAgent(
        {
          message: "background cli task",
          sessionKey: "agent:main:main",
          idempotencyKey: "task-registry-agent-run-abort-error",
        },
        { context, reqId: "task-registry-agent-run-abort-error" },
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
          },
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

      await invokeAgent(
        {
          message: "daily rollover",
          agentId: "main",
          sessionKey: "agent:main:main",
          idempotencyKey: "daily-rollover-agent-session",
        },
        { reqId: "daily-rollover-agent-session" },
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

  it("does not forward a non-main agent id with canonical global session keys", async () => {
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
    expect(call.agentId).toBeUndefined();
    expect(call.sessionKey).toBe("global");
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
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });
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
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

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

  it("handles bare /new by resetting the same session and sending reset greeting prompt", async () => {
    mockSessionResetSuccess({ reason: "new" });

    primeMainAgentRun({ sessionId: "reset-session-id" });

    await invokeAgent(
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
    const call = await waitForAgentCommandCall();
    // Message is now dynamically built with current date — check key substrings
    expect(call?.message).toContain("Execute your Session Startup sequence now");
    expect(call?.message).toContain("Current time:");
    expect(call?.message).not.toBe(BARE_SESSION_RESET_PROMPT);
    expect(call?.sessionId).toBe("reset-session-id");
  });

  it("prepends runtime-loaded startup memory to bare /new agent runs", async () => {
    await withTempDir({ prefix: "openclaw-gateway-reset-startup-" }, async (workspaceDir) => {
      await fs.mkdir(`${workspaceDir}/memory`, { recursive: true });
      await fs.writeFile(`${workspaceDir}/memory/2026-01-28.md`, "today gateway note", "utf-8");
      await fs.writeFile(`${workspaceDir}/memory/2026-01-27.md`, "yesterday gateway note", "utf-8");
      setupNewYorkTimeConfig("2026-01-28T20:30:00.000Z");
      mocks.loadConfigReturn = {
        agents: {
          defaults: {
            userTimezone: "America/New_York",
            workspace: workspaceDir,
          },
        },
      };
      mockSessionResetSuccess({ reason: "new" });
      primeMainAgentRun({ sessionId: "reset-session-id", cfg: mocks.loadConfigReturn });

      await invokeAgent(
        {
          message: "/new",
          sessionKey: "agent:main:main",
          idempotencyKey: "test-idem-new-startup-context",
        },
        {
          reqId: "4-startup",
          client: { connect: { scopes: ["operator.admin"] } } as AgentHandlerArgs["client"],
        },
      );

      const call = await waitForAgentCommandCall();
      expect(call?.message).toContain("[Startup context loaded by runtime]");
      expect(call?.message).toContain("[Untrusted daily memory: memory/2026-01-28.md]");
      expect(call?.message).toContain("today gateway note");
      expect(call?.message).toContain("[Untrusted daily memory: memory/2026-01-27.md]");
      expect(call?.message).toContain("yesterday gateway note");
      resetTimeConfig();
    });
  });

  it("uses shared bootstrap reset wording for bare /new when workspace bootstrap is pending", async () => {
    await withTempDir({ prefix: "openclaw-gateway-reset-bootstrap-" }, async (workspaceDir) => {
      await fs.writeFile(`${workspaceDir}/BOOTSTRAP.md`, "bootstrap ritual", "utf-8");
      mocks.loadConfigReturn = {
        agents: {
          defaults: {
            workspace: workspaceDir,
          },
        },
      };
      mockSessionResetSuccess({ reason: "new" });
      primeMainAgentRun({ sessionId: "reset-session-id", cfg: mocks.loadConfigReturn });

      await invokeAgent(
        {
          message: "/new",
          sessionKey: "agent:main:main",
          idempotencyKey: "test-idem-new-bootstrap-pending",
        },
        {
          reqId: "4-bootstrap",
          client: { connect: { scopes: ["operator.admin"] } } as AgentHandlerArgs["client"],
        },
      );

      const call = await waitForAgentCommandCall();
      expect(call?.message).toContain("while bootstrap is still pending for this workspace");
      expect(call?.message).toContain("Please read BOOTSTRAP.md from the workspace now");
      expect(call?.message).not.toContain("Today memory context");
    });
  });

  it("resolves bare /new bootstrap state from the effective spawned workspace", async () => {
    await withTempDir(
      { prefix: "openclaw-gateway-reset-default-" },
      async (defaultWorkspaceDir) => {
        await withTempDir(
          { prefix: "openclaw-gateway-reset-spawned-" },
          async (spawnedWorkspaceDir) => {
            await fs.writeFile(`${spawnedWorkspaceDir}/BOOTSTRAP.md`, "bootstrap ritual", "utf-8");
            mocks.loadConfigReturn = {
              agents: {
                defaults: {
                  workspace: defaultWorkspaceDir,
                },
              },
            };
            mockSessionResetSuccess({ reason: "new" });
            mocks.loadSessionEntry.mockReturnValue({
              cfg: mocks.loadConfigReturn,
              storePath: "/tmp/sessions.json",
              entry: {
                sessionId: "reset-session-id",
                updatedAt: Date.now(),
                spawnedBy: "agent:main:controller",
                spawnedWorkspaceDir,
              },
              canonicalKey: "agent:main:main",
            });
            mocks.updateSessionStore.mockResolvedValue(undefined);
            mocks.agentCommand.mockResolvedValue({
              payloads: [{ text: "ok" }],
              meta: { durationMs: 100 },
            });

            await invokeAgent(
              {
                message: "/new",
                sessionKey: "agent:main:main",
                idempotencyKey: "test-idem-new-bootstrap-spawned-workspace",
              },
              {
                reqId: "4-bootstrap-spawned",
                client: { connect: { scopes: ["operator.admin"] } } as AgentHandlerArgs["client"],
              },
            );

            const call = await waitForAgentCommandCall();
            expect(call?.message).toContain("while bootstrap is still pending for this workspace");
            expect(call?.message).toContain(
              "cannot safely complete the full BOOTSTRAP.md workflow here",
            );
            expect(call?.message).toContain("switching to a primary interactive run");
          },
        );
      },
    );
  });

  it("suppresses full bootstrap wording for bare /new on subagent sessions", async () => {
    await withTempDir({ prefix: "openclaw-gateway-reset-subagent-" }, async (workspaceDir) => {
      await fs.writeFile(`${workspaceDir}/BOOTSTRAP.md`, "bootstrap ritual", "utf-8");
      mocks.loadConfigReturn = {
        agents: {
          defaults: {
            workspace: workspaceDir,
          },
        },
      };
      mockSessionResetSuccess({
        reason: "new",
        key: "agent:main:subagent:worker",
      });
      mocks.loadSessionEntry.mockReturnValue({
        cfg: mocks.loadConfigReturn,
        storePath: "/tmp/sessions.json",
        entry: {
          sessionId: "reset-session-id",
          updatedAt: Date.now(),
        },
        canonicalKey: "agent:main:subagent:worker",
      });
      mocks.updateSessionStore.mockResolvedValue(undefined);
      mocks.agentCommand.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      });

      await invokeAgent(
        {
          message: "/new",
          sessionKey: "agent:main:subagent:worker",
          idempotencyKey: "test-idem-new-subagent-bootstrap-suppressed",
        },
        {
          reqId: "4-bootstrap-subagent",
          client: { connect: { scopes: ["operator.admin"] } } as AgentHandlerArgs["client"],
        },
      );

      const call = await waitForAgentCommandCall();
      expect(call?.message).toContain("Execute your Session Startup sequence now");
      expect(call?.message).not.toContain("while bootstrap is still pending for this workspace");
    });
  });

  it.each(["all", "non-main"] as const)(
    "does not preload startup memory from inherited workspaces for spawned sandboxed sessions in %s mode",
    async (sandboxMode) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-27T12:00:00.000Z"));
      try {
        await withTempDir(
          { prefix: "openclaw-gateway-startup-canonical-" },
          async (canonicalWorkspaceDir) => {
            await withTempDir(
              { prefix: "openclaw-gateway-startup-inherited-" },
              async (inheritedWorkspaceDir) => {
                await fs.mkdir(`${inheritedWorkspaceDir}/memory`, { recursive: true });
                const inheritedMarker = "OC_INHERITED_WORKSPACE_MEMORY_MARKER";
                await fs.writeFile(
                  `${inheritedWorkspaceDir}/memory/2026-04-27.md`,
                  inheritedMarker,
                  "utf-8",
                );
                mocks.loadConfigReturn = {
                  agents: {
                    defaults: {
                      workspace: canonicalWorkspaceDir,
                      userTimezone: "UTC",
                      startupContext: {
                        enabled: true,
                        applyOn: ["new"],
                        dailyMemoryDays: 1,
                      },
                      sandbox: {
                        mode: sandboxMode,
                        scope: "session",
                        workspaceAccess: "none",
                      },
                    },
                  },
                };
                mockSessionResetSuccess({
                  reason: "new",
                  key: "agent:main:subagent:sandbox-child",
                });
                mocks.loadSessionEntry.mockReturnValue({
                  cfg: mocks.loadConfigReturn,
                  storePath: "/tmp/sessions.json",
                  entry: {
                    sessionId: "existing-child-session",
                    updatedAt: Date.now(),
                    spawnedBy: "agent:main:main",
                    spawnedWorkspaceDir: inheritedWorkspaceDir,
                  },
                  canonicalKey: "agent:main:subagent:sandbox-child",
                });
                mocks.updateSessionStore.mockResolvedValue(undefined);
                mocks.agentCommand.mockResolvedValue({
                  payloads: [{ text: "ok" }],
                  meta: { durationMs: 100 },
                });

                await invokeAgent(
                  {
                    message: "/new",
                    sessionKey: "agent:main:subagent:sandbox-child",
                    idempotencyKey: `test-idem-new-spawned-sandbox-memory-${sandboxMode}`,
                  },
                  {
                    reqId: `4-startup-spawned-sandbox-memory-${sandboxMode}`,
                    client: {
                      connect: { scopes: ["operator.admin"] },
                    } as AgentHandlerArgs["client"],
                  },
                );

                await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalled());
                const call = readLastAgentCommandCall();
                expect(call?.message).toContain("Execute your Session Startup sequence now");
                expect(call?.message).not.toContain("[Startup context loaded by runtime]");
                expect(call?.message).not.toContain(inheritedMarker);
              },
            );
          },
        );
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("uses /reset suffix as the post-reset message and still injects timestamp", async () => {
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

    const call = await expectResetCall("[Wed 2026-01-28 20:30 EST] check status");
    expect(call?.sessionId).toBe("reset-session-id");

    resetTimeConfig();
  });

  it("uses request model override when resolving bare /new bootstrap file access", async () => {
    await withTempDir(
      { prefix: "openclaw-gateway-reset-model-override-" },
      async (workspaceDir) => {
        await fs.writeFile(`${workspaceDir}/BOOTSTRAP.md`, "bootstrap ritual", "utf-8");
        mocks.loadConfigReturn = {
          agents: {
            defaults: {
              workspace: workspaceDir,
            },
          },
        };
        mockSessionResetSuccess({ reason: "new" });
        primeMainAgentRun({ sessionId: "reset-session-id", cfg: mocks.loadConfigReturn });

        await invokeAgent(
          {
            message: "/new",
            sessionKey: "agent:main:main",
            provider: "openai",
            model: "gpt-5.4-mini",
            idempotencyKey: "test-idem-new-bootstrap-model-override",
          },
          {
            reqId: "4-bootstrap-model-override",
            client: {
              connect: { scopes: ["operator.admin"] },
              internal: { allowModelOverride: true },
            } as AgentHandlerArgs["client"],
          },
        );

        await waitForAssertion(() =>
          expect(mocks.resolveBareResetBootstrapFileAccess).toHaveBeenCalled(),
        );
        expectRecordFields(mockCallArg(mocks.resolveBareResetBootstrapFileAccess), {
          modelProvider: "openai",
          modelId: "gpt-5.4-mini",
        });
      },
    );
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

  it("rejects /reset for write-scoped gateway callers", async () => {
    mockMainSessionEntry({ sessionId: "existing-session-id" });
    mocks.performGatewaySessionReset.mockClear();
    mocks.agentCommand.mockClear();

    const respond = await invokeAgent(
      {
        message: "/reset",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-reset-write-scope",
      },
      {
        reqId: "4c",
        client: { connect: { scopes: ["operator.write"] } } as AgentHandlerArgs["client"],
      },
    );

    expect(mocks.performGatewaySessionReset).not.toHaveBeenCalled();
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expectRespondError(respond, { message: "missing scope: operator.admin" });
  });

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
          [sessionKey]: { sessionId: "existing-session-id" },
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
  afterEach(() => {
    mocks.agentCommand.mockReset();
    mocks.getLatestSubagentRunByChildSessionKey.mockReset();
    mocks.replaceSubagentRunAfterSteer.mockReset();
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

  it("yields after the accepted ack before dispatching heavy agent work", async () => {
    prime();
    mocks.agentCommand.mockReturnValueOnce(new Promise(() => {}));

    const respond = vi.fn();
    const runId = "idem-yield-before-dispatch";
    const pending = invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { respond, reqId: runId, flushDispatch: false },
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(mockCallArg(respond)).toBe(true);
    expectRecordFields(mockCallArg(respond, 0, 1), {
      runId,
      status: "accepted",
    });
    expect(mockCallArg(respond, 0, 2)).toBeUndefined();
    expect(mockCallArg(respond, 0, 3)).toEqual({ runId });
    expect(mocks.agentCommand).not.toHaveBeenCalled();

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalledTimes(1));
    await pending;

    expect(mocks.agentCommand).toHaveBeenCalledTimes(1);
  });

  it("uses the explicit no-timeout agent expiry instead of the chat 24h cap", async () => {
    prime();
    mocks.agentCommand.mockReturnValueOnce(new Promise(() => {}));

    const context = makeContext();
    const runId = "idem-abort-no-timeout";
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
        timeout: 0,
      },
      { context, reqId: runId },
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
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(true, { runId, status: "in_flight" }, undefined, {
      cached: true,
      runId,
    });
  });
});
