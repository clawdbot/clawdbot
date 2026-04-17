import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BARE_SESSION_RESET_PROMPT } from "../../auto-reply/reply/session-reset-prompt.js";
import { findTaskByRunId, resetTaskRegistryForTests } from "../../tasks/task-registry.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import { agentHandlers } from "./agent.js";
import { expectSubagentFollowupReactivation } from "./subagent-followup.test-helpers.js";
import type { GatewayRequestContext } from "./types.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

const mocks = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
  loadGatewaySessionRow: vi.fn(),
  updateSessionStore: vi.fn(),
  agentCommand: vi.fn(),
  registerAgentRunContext: vi.fn(),
  performGatewaySessionReset: vi.fn(),
  getLatestSubagentRunByChildSessionKey: vi.fn(),
  replaceSubagentRunAfterSteer: vi.fn(),
  loadConfigReturn: {} as Record<string, unknown>,
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
    resolveAgentIdFromSessionKey: () => "main",
    resolveExplicitAgentSessionKey: () => undefined,
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
    loadConfig: () => mocks.loadConfigReturn,
  };
});

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: () => ["main"],
  resolveAgentWorkspaceDir: (cfg: { agents?: { defaults?: { workspace?: string } } }) =>
    cfg?.agents?.defaults?.workspace ?? "/tmp/workspace",
}));

vi.mock("../../infra/agent-events.js", () => ({
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

vi.mock("../../sessions/send-policy.js", () => ({
  resolveSendPolicy: () => "allow",
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
    logGateway: { info: vi.fn(), error: vi.fn() },
    broadcastToConnIds: vi.fn(),
    getSessionEventSubscriberConnIds: () => new Set(),
  }) as unknown as GatewayRequestContext;

type AgentHandlerArgs = Parameters<typeof agentHandlers.agent>[0];
type AgentParams = AgentHandlerArgs["params"];

type AgentIdentityGetHandlerArgs = Parameters<(typeof agentHandlers)["agent.identity.get"]>[0];
type AgentIdentityGetParams = AgentIdentityGetHandlerArgs["params"];

async function waitForAssertion(assertion: () => void, timeoutMs = 2_000, stepMs = 5) {
  vi.useFakeTimers();
  try {
    let lastError: unknown;
    for (let elapsed = 0; elapsed <= timeoutMs; elapsed += stepMs) {
      try {
        assertion();
        return;
      } catch (error) {
        lastError = error;
      }
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(stepMs);
    }
    throw lastError ?? new Error("assertion did not pass in time");
  } finally {
    vi.useRealTimers();
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
  vi.useFakeTimers();
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
  vi.useRealTimers();
}

async function expectResetCall(expectedMessage: string) {
  await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalled());
  expect(mocks.performGatewaySessionReset).toHaveBeenCalledTimes(1);
  const call = readLastAgentCommandCall();
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
  return capturedEntry;
}

function readLastAgentCommandCall():
  | {
      message?: string;
      sessionId?: string;
    }
  | undefined {
  return mocks.agentCommand.mock.calls.at(-1)?.[0] as
    | { message?: string; sessionId?: string }
    | undefined;
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
    resetTaskRegistryForTests();
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
    expect(capturedEntry).toBeDefined();
    expect(capturedEntry?.acp).toEqual(existingAcpMeta);
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

    const lastCall = mocks.agentCommand.mock.calls.at(-1);
    expect(lastCall?.[0]).toEqual(
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-haiku-4-5",
      }),
    );
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
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "provider/model overrides are not authorized for this caller.",
      }),
    );
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

    const lastCall = mocks.agentCommand.mock.calls.at(-1);
    expect(lastCall?.[0]).toEqual(
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-haiku-4-5",
        senderIsOwner: false,
      }),
    );
  });

  it("preserves cliSessionIds from existing session entry", async () => {
    const existingCliSessionIds = { "claude-cli": "abc-123-def" };
    const existingClaudeCliSessionId = "abc-123-def";

    mockMainSessionEntry({
      cliSessionIds: existingCliSessionIds,
      claudeCliSessionId: existingClaudeCliSessionId,
    });

    const capturedEntry = await runMainAgentAndCaptureEntry("test-idem");
    expect(capturedEntry).toBeDefined();
    expect(capturedEntry?.cliSessionIds).toEqual(existingCliSessionIds);
    expect(capturedEntry?.claudeCliSessionId).toBe(existingClaudeCliSessionId);
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
          logGateway: { info: vi.fn(), error: vi.fn() },
          broadcastToConnIds,
          getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
        } as unknown as GatewayRequestContext,
      },
    );

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        runId: "run-new",
        status: "accepted",
      }),
      undefined,
      { runId: "run-new" },
    );
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
          logGateway: { info: vi.fn(), error: vi.fn() },
          broadcastToConnIds,
          getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
        } as unknown as GatewayRequestContext,
      },
    );

    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({
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
      }),
      new Set(["conn-1"]),
      { dropIfSlow: true },
    );
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

    // Wait for the async agentCommand call
    await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalled());

    const callArgs = mocks.agentCommand.mock.calls[0][0];
    expect(callArgs.message).toBe("[Wed 2026-01-28 20:30 EST] Is it the weekend?");

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

    await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalled());
    const callArgs = mocks.agentCommand.mock.calls.at(-1)?.[0] as
      | { senderIsOwner?: boolean }
      | undefined;
    expect(callArgs?.senderIsOwner).toBe(senderIsOwner);
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

    await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalled());
    const callArgs = mocks.agentCommand.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(callArgs.bestEffortDeliver).toBe(false);
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
          logGateway: { info: logInfo, error: vi.fn() },
          broadcastToConnIds: vi.fn(),
          getSessionEventSubscriberConnIds: () => new Set(),
        } as unknown as GatewayRequestContext,
      },
    );

    await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalled());
    const accepted = respond.mock.calls.find(
      (call: unknown[]) =>
        call[0] === true && (call[1] as Record<string, unknown>)?.status === "accepted",
    );
    expect(accepted).toBeDefined();
    const rejected = respond.mock.calls.find((call: unknown[]) => call[0] === false);
    expect(rejected).toBeUndefined();
    expect(logInfo).toHaveBeenCalledTimes(1);
    expect(logInfo).toHaveBeenCalledWith(
      expect.stringContaining("agent delivery downgraded to session-only (bestEffortDeliver)"),
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
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("invalid agent params"),
      }),
    );
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

    await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalled());
    expect(respond).not.toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("invalid agent params"),
      }),
    );
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

    await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalled());
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
    await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalled());
    const spawnedCall = mocks.agentCommand.mock.calls.at(-1)?.[0] as { workspaceDir?: string };
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

    await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalled());
    const callArgs = mocks.agentCommand.mock.calls.at(-1)?.[0] as {
      channel?: string;
      messageChannel?: string;
      runContext?: { messageChannel?: string };
    };
    expect(callArgs.channel).toBe("telegram");
    expect(callArgs.messageChannel).toBe("webchat");
    expect(callArgs.runContext?.messageChannel).toBe("webchat");
  });

  it("tracks async gateway agent runs in the shared task registry", async () => {
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

      expect(findTaskByRunId("task-registry-agent-run")).toMatchObject({
        runtime: "cli",
        childSessionKey: "agent:main:main",
        status: "running",
      });
    });
  });

  it("handles missing cliSessionIds gracefully", async () => {
    mockMainSessionEntry({});

    const capturedEntry = await runMainAgentAndCaptureEntry("test-idem-2");
    expect(capturedEntry).toBeDefined();
    // Should be undefined, not cause an error
    expect(capturedEntry?.cliSessionIds).toBeUndefined();
    expect(capturedEntry?.claudeCliSessionId).toBeUndefined();
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
    expect(capturedStore).toBeDefined();
    expect(capturedStore?.["agent:main:work"]).toBeDefined();
    expect(capturedStore?.["agent:main:MAIN"]).toBeUndefined();
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

    await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalled());
    expect(mocks.performGatewaySessionReset).toHaveBeenCalledTimes(1);
    const call = readLastAgentCommandCall();
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

      await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalled());
      const call = readLastAgentCommandCall();
      expect(call?.message).toContain("[Startup context loaded by runtime]");
      expect(call?.message).toContain("[Untrusted daily memory: memory/2026-01-28.md]");
      expect(call?.message).toContain("today gateway note");
      expect(call?.message).toContain("[Untrusted daily memory: memory/2026-01-27.md]");
      expect(call?.message).toContain("yesterday gateway note");
      resetTimeConfig();
    });
  });

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
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("malformed session key"),
      }),
    );
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
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "missing scope: operator.admin",
      }),
    );
  });

  it("rejects malformed session keys in agent.identity.get", async () => {
    const respond = await invokeAgentIdentityGet(
      {
        sessionKey: "agent:main",
      },
      { reqId: "5" },
    );

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("malformed session key"),
      }),
    );
  });
});
