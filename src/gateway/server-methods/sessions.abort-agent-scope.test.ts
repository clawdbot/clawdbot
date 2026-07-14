/**
 * Tests that session abort requests stay scoped to the targeted agent.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

const chatAbortMock = vi.fn();
const resolveSessionKeyForRunMock = vi.fn();
const listSessionsFromStoreAsyncMock = vi.fn();
const loadCombinedSessionStoreForGatewayMock = vi.fn();
const isEmbeddedAgentRunActiveMock = vi.fn();
const loadSessionEntryMock = vi.fn((sessionKey: string, _opts?: { agentId?: string }) => ({
  canonicalKey: sessionKey,
}));

vi.mock("../server-session-key.js", () => ({
  resolveSessionKeyForRun: (...args: unknown[]) => resolveSessionKeyForRunMock(...args),
}));

vi.mock("./chat.js", () => ({
  chatHandlers: {
    "chat.abort": (...args: unknown[]) => chatAbortMock(...args),
  },
}));

vi.mock("../worker-environments/session-target.js", () => ({
  resolveWorkerSessionTarget: () => ({
    agentId: "work",
    sessionKey: "agent:work:dashboard:worker",
  }),
}));

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    listSessionsFromStoreAsync: (...args: unknown[]) => listSessionsFromStoreAsyncMock(...args),
    loadCombinedSessionStoreForGateway: (...args: unknown[]) =>
      loadCombinedSessionStoreForGatewayMock(...args),
    loadSessionEntry: (...args: unknown[]) =>
      loadSessionEntryMock(...(args as [string, { agentId?: string }?])),
  };
});

vi.mock("../../agents/embedded-agent-runner/runs.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/embedded-agent-runner/runs.js")>(
    "../../agents/embedded-agent-runner/runs.js",
  );
  return {
    ...actual,
    isEmbeddedAgentRunActive: (...args: unknown[]) => isEmbeddedAgentRunActiveMock(...args),
  };
});

import { sessionsHandlers } from "./sessions.js";

function createActiveRun(sessionKey: string, params: { agentId?: string } = {}) {
  const now = Date.now();
  return {
    controller: new AbortController(),
    sessionId: "sess-active",
    sessionKey,
    agentId: params.agentId,
    startedAtMs: now,
    expiresAtMs: now + 30_000,
    kind: "chat-send" as const,
  };
}

type ActiveRun = ReturnType<typeof createActiveRun>;
type TestAgentConfig = { id: string; default?: boolean };

function createDefaultAgents(): TestAgentConfig[] {
  return [{ id: "main", default: true }, { id: "work" }];
}

function createContext(
  options: {
    activeRuns?: ReadonlyArray<readonly [string, ActiveRun]>;
    agents?: TestAgentConfig[];
    globalScope?: boolean;
    extra?: Partial<GatewayRequestContext>;
  } = {},
): GatewayRequestContext {
  const cfg = {
    agents: { list: options.agents ?? createDefaultAgents() },
    ...(options.globalScope ? { session: { scope: "global" as const } } : {}),
  };
  return {
    chatAbortControllers: new Map(options.activeRuns ?? []),
    getRuntimeConfig: () => cfg,
    ...options.extra,
  } as unknown as GatewayRequestContext;
}

function createRespond(): RespondFn {
  return vi.fn() as unknown as RespondFn;
}

function createBetaRunContext(activeRun: ActiveRun): GatewayRequestContext {
  return createContext({
    activeRuns: [["run-beta", activeRun]],
    agents: [{ id: "main", default: true }, { id: "beta" }],
  });
}

function createGlobalWorkRunContext(activeRun: ActiveRun): GatewayRequestContext {
  return createContext({
    activeRuns: [["run-global", activeRun]],
    globalScope: true,
  });
}

async function callSessions(
  method: keyof typeof sessionsHandlers,
  params: Record<string, unknown>,
  options: {
    context: GatewayRequestContext;
    respond?: RespondFn;
    reqId?: string;
    client?: GatewayClient | null;
  },
): Promise<RespondFn> {
  const respond = options.respond ?? createRespond();
  await expectDefined(
    sessionsHandlers[method],
    "sessionsHandlers[method] test invariant",
  )({
    req: { id: options.reqId ?? `req-${method}` } as never,
    params,
    respond,
    context: options.context,
    client: options.client ?? null,
    isWebchatConnect: () => false,
  });
  return respond;
}

function expectChatAbortParams(params: Record<string, unknown>): void {
  expect(chatAbortMock).toHaveBeenCalledTimes(1);
  expect(chatAbortMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ params }));
}

function expectRespondErrorMessage(respond: RespondFn, message: string): void {
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ message }));
}

function mockChatSuccess(mock: typeof chatAbortMock, payload: Record<string, unknown>): void {
  mock.mockImplementationOnce(({ respond }: { respond: RespondFn }) => respond(true, payload));
}

function expectSessionsListActiveRun(respond: RespondFn, hasActiveRun: boolean): void {
  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({
      sessions: [expect.objectContaining({ key: "global", hasActiveRun })],
    }),
    undefined,
  );
}

async function expectListedGlobalSessionActiveRun(params: {
  activeRun: ActiveRun;
  runId: string;
  agentId: string;
  hasActiveRun: boolean;
  reqId: string;
}): Promise<void> {
  const context = createContext({
    activeRuns: [[params.runId, params.activeRun]],
    globalScope: true,
    extra: { loadGatewayModelCatalog: vi.fn().mockResolvedValue([]) },
  });
  listSessionsFromStoreAsyncMock.mockResolvedValue({
    sessions: [{ key: "global", hasActiveRun: false }],
  });
  const respond = await callSessions(
    "sessions.list",
    { includeGlobal: true, agentId: params.agentId },
    { context, reqId: params.reqId },
  );

  expectSessionsListActiveRun(respond, params.hasActiveRun);
}

describe("sessions.abort agent scope", () => {
  beforeEach(() => {
    chatAbortMock.mockReset();
    resolveSessionKeyForRunMock.mockReset();
    listSessionsFromStoreAsyncMock.mockReset();
    listSessionsFromStoreAsyncMock.mockResolvedValue({ sessions: [] });
    loadCombinedSessionStoreForGatewayMock.mockReset();
    loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath: "/tmp/openclaw-sessions.json",
      store: {},
    });
    loadSessionEntryMock.mockClear();
    isEmbeddedAgentRunActiveMock.mockReset();
    isEmbeddedAgentRunActiveMock.mockReturnValue(false);
  });

  it("does not abort an active run whose session key belongs to another requested agent", async () => {
    const activeRun = createActiveRun("agent:beta:dashboard:target");
    const context = createBetaRunContext(activeRun);
    resolveSessionKeyForRunMock.mockReturnValue(undefined);
    const respond = await callSessions(
      "sessions.abort",
      { runId: "run-beta", agentId: "main" },
      { context, reqId: "req-1" },
    );

    expect(resolveSessionKeyForRunMock).toHaveBeenCalledWith("run-beta", { agentId: "main" });
    expect(chatAbortMock).not.toHaveBeenCalled();
    expect(activeRun.controller.signal.aborted).toBe(false);
    expect(respond).toHaveBeenCalledWith(true, {
      ok: true,
      abortedRunId: null,
      status: "no-active-run",
    });
  });

  it("marks listed sessions active when the embedded or channel reply run registry owns the session id", async () => {
    const context = createContext({
      extra: { loadGatewayModelCatalog: vi.fn().mockResolvedValue([]) },
    });
    listSessionsFromStoreAsyncMock.mockResolvedValue({
      sessions: [{ key: "agent:main:openclaw-weixin:direct:user", sessionId: "sess-weixin" }],
    });
    isEmbeddedAgentRunActiveMock.mockImplementation(
      (sessionId: string) => sessionId === "sess-weixin",
    );

    const respond = await callSessions(
      "sessions.list",
      { agentId: "main" },
      { context, reqId: "req-channel-active" },
    );

    expect(isEmbeddedAgentRunActiveMock).toHaveBeenCalledWith("sess-weixin");
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        sessions: [
          expect.objectContaining({
            key: "agent:main:openclaw-weixin:direct:user",
            sessionId: "sess-weixin",
            hasActiveRun: true,
          }),
        ],
      }),
      undefined,
    );
  });

  it("preserves runId-only aborts for active non-default agent runs", async () => {
    const activeRun = createActiveRun("agent:beta:dashboard:target");
    const context = createBetaRunContext(activeRun);
    resolveSessionKeyForRunMock.mockReturnValue(undefined);

    await callSessions("sessions.abort", { runId: "run-beta" }, { context, reqId: "req-2" });

    expect(resolveSessionKeyForRunMock).not.toHaveBeenCalled();
    expectChatAbortParams({ sessionKey: "agent:beta:dashboard:target", runId: "run-beta" });
  });

  it("resolves runId-only worker aborts to the owning session", async () => {
    const resolveInferenceSessionForRunId = vi.fn(() => "session-worker");
    mockChatSuccess(chatAbortMock, { ok: true, aborted: true, runIds: ["run-worker"] });
    const context = createContext({
      extra: {
        workerEnvironmentService: { resolveInferenceSessionForRunId } as never,
        dedupe: new Map(),
        getSessionEventSubscriberConnIds: () => new Set(),
      },
    });

    await callSessions("sessions.abort", { runId: "run-worker" }, { context });

    expectChatAbortParams({
      sessionKey: "agent:work:dashboard:worker",
      runId: "run-worker",
    });
    expect(context.dedupe?.size).toBe(0);
  });

  it("aborts global-scope active runs for non-default agents", async () => {
    const activeRun = createActiveRun("global", { agentId: "work" });
    const context = createGlobalWorkRunContext(activeRun);
    resolveSessionKeyForRunMock.mockReturnValue(undefined);

    await callSessions(
      "sessions.abort",
      { runId: "run-global", agentId: "work" },
      { context, reqId: "req-global" },
    );

    expect(resolveSessionKeyForRunMock).not.toHaveBeenCalled();
    expectChatAbortParams({ sessionKey: "global", runId: "run-global", agentId: "work" });
  });

  it("uses the active run agent for key and runId global aborts without agentId", async () => {
    const activeRun = createActiveRun("global", { agentId: "work" });
    const context = createGlobalWorkRunContext(activeRun);
    resolveSessionKeyForRunMock.mockReturnValue(undefined);

    await callSessions(
      "sessions.abort",
      { key: "global", runId: "run-global" },
      { context, reqId: "req-global-key-run" },
    );

    expect(resolveSessionKeyForRunMock).not.toHaveBeenCalled();
    expectChatAbortParams({ sessionKey: "global", runId: "run-global", agentId: "work" });
  });

  it("emits selected global abort changes with agent scope", async () => {
    const activeRun = createActiveRun("global", { agentId: "work" });
    const broadcastToConnIds = vi.fn();
    chatAbortMock.mockImplementationOnce(
      async ({ respond: abortRespond }: { respond: RespondFn }) => {
        abortRespond(true, { ok: true, aborted: true, runIds: ["run-global"] });
      },
    );
    const context = createContext({
      activeRuns: [["run-global", activeRun]],
      globalScope: true,
      extra: {
        getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
        broadcastToConnIds,
        dedupe: new Map(),
      },
    });
    resolveSessionKeyForRunMock.mockReturnValue(undefined);

    await callSessions(
      "sessions.abort",
      { key: "global", runId: "run-global" },
      { context, reqId: "req-global-abort-event" },
    );

    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({
        sessionKey: "global",
        agentId: "work",
        reason: "abort",
      }),
      new Set(["conn-1"]),
      { dropIfSlow: true },
    );
  });

  it("forwards selected-agent scope for key-based global aborts", async () => {
    const context = createContext({ globalScope: true });

    await callSessions(
      "sessions.abort",
      { key: "global", agentId: "work" },
      { context, reqId: "req-global-key" },
    );

    expectChatAbortParams({ sessionKey: "global", runId: undefined, agentId: "work" });
  });

  it("infers selected-agent global aborts from agent-prefixed aliases", async () => {
    loadSessionEntryMock.mockImplementationOnce(() => ({ canonicalKey: "global" }));
    const context = createContext({ globalScope: true });

    await callSessions(
      "sessions.abort",
      { key: "agent:work:main" },
      { context, reqId: "req-global-key-alias" },
    );

    expect(loadSessionEntryMock).toHaveBeenCalledWith("agent:work:main", { agentId: "work" });
    expectChatAbortParams({ sessionKey: "global", runId: undefined, agentId: "work" });
  });

  it("marks selected-agent global session rows active only for their own agent", async () => {
    await expectListedGlobalSessionActiveRun({
      activeRun: createActiveRun("global", { agentId: "main" }),
      runId: "run-main-global",
      agentId: "work",
      hasActiveRun: false,
      reqId: "req-list-global",
    });
  });

  it("marks unscoped global runs active for the configured default agent", async () => {
    await expectListedGlobalSessionActiveRun({
      activeRun: createActiveRun("global"),
      runId: "run-default-global",
      agentId: "main",
      hasActiveRun: true,
      reqId: "req-list-default-global",
    });
  });

  it("subscribes selected-agent global message events on an agent-scoped key", async () => {
    const subscribeSessionMessageEvents = vi.fn();
    const context = createContext({
      globalScope: true,
      extra: { subscribeSessionMessageEvents },
    });
    const respond = await callSessions(
      "sessions.messages.subscribe",
      { key: "global", agentId: "work" },
      {
        context,
        reqId: "req-sub-global",
        client: { connId: "conn-work" } as GatewayClient,
      },
    );

    expect(subscribeSessionMessageEvents).toHaveBeenCalledWith("conn-work", "agent:work:global");
    expect(respond).toHaveBeenCalledWith(true, { subscribed: true, key: "global" }, undefined);
  });

  it("subscribes bare global message events on the configured default agent key", async () => {
    const subscribeSessionMessageEvents = vi.fn();
    const context = createContext({
      agents: [{ id: "main" }, { id: "work", default: true }],
      globalScope: true,
      extra: { subscribeSessionMessageEvents },
    });
    const respond = await callSessions(
      "sessions.messages.subscribe",
      { key: "global" },
      {
        context,
        reqId: "req-sub-global-default",
        client: { connId: "conn-default" } as GatewayClient,
      },
    );

    expect(subscribeSessionMessageEvents).toHaveBeenCalledWith("conn-default", "agent:work:global");
    expect(respond).toHaveBeenCalledWith(true, { subscribed: true, key: "global" }, undefined);
  });

  it("infers selected-agent global subscriptions from agent-prefixed aliases", async () => {
    loadSessionEntryMock.mockImplementationOnce(() => ({ canonicalKey: "global" }));
    const subscribeSessionMessageEvents = vi.fn();
    const context = createContext({
      globalScope: true,
      extra: { subscribeSessionMessageEvents },
    });
    const respond = await callSessions(
      "sessions.messages.subscribe",
      { key: "agent:work:main" },
      {
        context,
        reqId: "req-sub-global-alias",
        client: { connId: "conn-work-alias" } as GatewayClient,
      },
    );

    expect(loadSessionEntryMock).toHaveBeenCalledWith("agent:work:main", { agentId: "work" });
    expect(subscribeSessionMessageEvents).toHaveBeenCalledWith(
      "conn-work-alias",
      "agent:work:global",
    );
    expect(respond).toHaveBeenCalledWith(true, { subscribed: true, key: "global" }, undefined);
  });

  it("aborts an active legacy-key run owned by the configured default agent", async () => {
    const activeRun = createActiveRun("main");
    const context = createContext({
      activeRuns: [["run-work", activeRun]],
      agents: [{ id: "work", default: true }],
    });
    resolveSessionKeyForRunMock.mockReturnValue(undefined);

    await callSessions("sessions.abort", { runId: "run-work" }, { context, reqId: "req-3" });

    expect(resolveSessionKeyForRunMock).not.toHaveBeenCalled();
    expectChatAbortParams({ sessionKey: "main", runId: "run-work" });
  });

  it("rejects key-based aborts when key agent does not match agentId", async () => {
    const context = createContext({
      agents: [{ id: "main", default: true }, { id: "beta" }],
    });
    const respond = await callSessions(
      "sessions.abort",
      { key: "agent:beta:main", agentId: "main" },
      { context, reqId: "req-4" },
    );

    expect(chatAbortMock).not.toHaveBeenCalled();
    expectRespondErrorMessage(respond, "session key agent does not match agentId");
  });

  it("rejects explicit agentId mismatches before session mutations", async () => {
    const context = createContext({ globalScope: true });

    for (const [method, params] of [
      ["sessions.patch", { key: "agent:main:main", agentId: "work", label: "Work" }],
      ["sessions.delete", { key: "agent:main:main", agentId: "work" }],
      ["sessions.compact", { key: "agent:main:main", agentId: "work" }],
    ] as const) {
      const respond = await callSessions(method, params, { context, reqId: `req-${method}` });

      expectRespondErrorMessage(respond, "session key agent does not match agentId");
    }
  });

  it("rejects unknown explicit agentId before session mutations", async () => {
    const context = createContext({ agents: [{ id: "main", default: true }] });
    const respond = await callSessions(
      "sessions.patch",
      { key: "global", agentId: "work", label: "Work" },
      { context, reqId: "req-unknown-agent-patch" },
    );

    expectRespondErrorMessage(respond, 'Unknown agent id "work"');
  });

  it("rejects unknown inferred selected-global aliases before session mutations", async () => {
    const context = createContext({ globalScope: true });

    for (const [method, params] of [
      ["sessions.patch", { key: "agent:typo:main", label: "Typo" }],
      ["sessions.delete", { key: "agent:typo:main" }],
      ["sessions.compact", { key: "agent:typo:main" }],
    ] as const) {
      const respond = await callSessions(method, params, {
        context,
        reqId: `req-${method}-unknown-alias`,
      });

      expectRespondErrorMessage(respond, 'Unknown agent id "typo"');
    }
  });

  it("applies agentId to legacy key-based abort aliases", async () => {
    const context = createContext();

    await callSessions(
      "sessions.abort",
      { key: "main", agentId: "work" },
      { context, reqId: "req-5" },
    );

    expectChatAbortParams({ sessionKey: "agent:work:main", runId: undefined });
  });

  it("does not use a raw legacy key alias that belongs to another agent", async () => {
    const activeRun = createActiveRun("main");
    const context = createContext({ activeRuns: [["run-work", activeRun]] });

    await callSessions(
      "sessions.abort",
      { key: "main", agentId: "work" },
      { context, reqId: "req-6" },
    );

    expectChatAbortParams({ sessionKey: "agent:work:main", runId: undefined });
  });

  it("keeps the raw legacy key alias when it belongs to the requested agent", async () => {
    const activeRun = createActiveRun("main");
    const context = createContext({
      activeRuns: [["run-work", activeRun]],
      agents: [{ id: "work", default: true }, { id: "main" }],
    });

    await callSessions(
      "sessions.abort",
      { key: "main", agentId: "work" },
      { context, reqId: "req-7" },
    );

    expectChatAbortParams({ sessionKey: "main", runId: undefined });
  });
});
