import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const chatAbortMock = vi.fn();
const resolveSessionKeyForRunMock = vi.fn();
const listSessionsFromStoreAsyncMock = vi.fn();
const loadCombinedSessionStoreForGatewayMock = vi.fn();
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
  });

  it("does not abort an active run whose session key belongs to another requested agent", async () => {
    const activeRun = createActiveRun("agent:beta:dashboard:target");
    const context = {
      chatAbortControllers: new Map([["run-beta", activeRun]]),
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main", default: true }, { id: "beta" }] },
      }),
    } as unknown as GatewayRequestContext;
    resolveSessionKeyForRunMock.mockReturnValue(undefined);
    const respond = vi.fn() as unknown as RespondFn;

    await sessionsHandlers["sessions.abort"]({
      req: { id: "req-1" } as never,
      params: { runId: "run-beta", agentId: "main" },
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(resolveSessionKeyForRunMock).toHaveBeenCalledWith("run-beta", { agentId: "main" });
    expect(chatAbortMock).not.toHaveBeenCalled();
    expect(activeRun.controller.signal.aborted).toBe(false);
    expect(respond).toHaveBeenCalledWith(true, {
      ok: true,
      abortedRunId: null,
      status: "no-active-run",
    });
  });

  it("preserves runId-only aborts for active non-default agent runs", async () => {
    const activeRun = createActiveRun("agent:beta:dashboard:target");
    const context = {
      chatAbortControllers: new Map([["run-beta", activeRun]]),
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main", default: true }, { id: "beta" }] },
      }),
    } as unknown as GatewayRequestContext;
    resolveSessionKeyForRunMock.mockReturnValue(undefined);
    const respond = vi.fn() as unknown as RespondFn;

    await sessionsHandlers["sessions.abort"]({
      req: { id: "req-2" } as never,
      params: { runId: "run-beta" },
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(resolveSessionKeyForRunMock).not.toHaveBeenCalled();
    expect(chatAbortMock).toHaveBeenCalledTimes(1);
    expect(chatAbortMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        params: { sessionKey: "agent:beta:dashboard:target", runId: "run-beta" },
      }),
    );
  });

  it("aborts global-scope active runs for non-default agents", async () => {
    const activeRun = createActiveRun("global", { agentId: "work" });
    const context = {
      chatAbortControllers: new Map([["run-global", activeRun]]),
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
        session: { scope: "global" },
      }),
    } as unknown as GatewayRequestContext;
    resolveSessionKeyForRunMock.mockReturnValue(undefined);
    const respond = vi.fn() as unknown as RespondFn;

    await sessionsHandlers["sessions.abort"]({
      req: { id: "req-global" } as never,
      params: { runId: "run-global", agentId: "work" },
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(resolveSessionKeyForRunMock).not.toHaveBeenCalled();
    expect(chatAbortMock).toHaveBeenCalledTimes(1);
    expect(chatAbortMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        params: { sessionKey: "global", runId: "run-global", agentId: "work" },
      }),
    );
  });

  it("uses the active run agent for key and runId global aborts without agentId", async () => {
    const activeRun = createActiveRun("global", { agentId: "work" });
    const context = {
      chatAbortControllers: new Map([["run-global", activeRun]]),
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
        session: { scope: "global" },
      }),
    } as unknown as GatewayRequestContext;
    resolveSessionKeyForRunMock.mockReturnValue(undefined);
    const respond = vi.fn() as unknown as RespondFn;

    await sessionsHandlers["sessions.abort"]({
      req: { id: "req-global-key-run" } as never,
      params: { key: "global", runId: "run-global" },
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(resolveSessionKeyForRunMock).not.toHaveBeenCalled();
    expect(chatAbortMock).toHaveBeenCalledTimes(1);
    expect(chatAbortMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        params: { sessionKey: "global", runId: "run-global", agentId: "work" },
      }),
    );
  });

  it("emits selected global abort changes with agent scope", async () => {
    const activeRun = createActiveRun("global", { agentId: "work" });
    const broadcastToConnIds = vi.fn();
    chatAbortMock.mockImplementationOnce(
      async ({ respond: abortRespond }: { respond: RespondFn }) => {
        abortRespond(true, { ok: true, aborted: true, runIds: ["run-global"] });
      },
    );
    const context = {
      chatAbortControllers: new Map([["run-global", activeRun]]),
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
        session: { scope: "global" },
      }),
      getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
      broadcastToConnIds,
      dedupe: new Map(),
    } as unknown as GatewayRequestContext;
    resolveSessionKeyForRunMock.mockReturnValue(undefined);
    const respond = vi.fn() as unknown as RespondFn;

    await sessionsHandlers["sessions.abort"]({
      req: { id: "req-global-abort-event" } as never,
      params: { key: "global", runId: "run-global" },
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });

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
    const context = {
      chatAbortControllers: new Map(),
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
        session: { scope: "global" },
      }),
    } as unknown as GatewayRequestContext;
    const respond = vi.fn() as unknown as RespondFn;

    await sessionsHandlers["sessions.abort"]({
      req: { id: "req-global-key" } as never,
      params: { key: "global", agentId: "work" },
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(chatAbortMock).toHaveBeenCalledTimes(1);
    expect(chatAbortMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        params: { sessionKey: "global", runId: undefined, agentId: "work" },
      }),
    );
  });

  it("infers selected-agent global aborts from agent-prefixed aliases", async () => {
    loadSessionEntryMock.mockImplementationOnce(() => ({ canonicalKey: "global" }));
    const context = {
      chatAbortControllers: new Map(),
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
        session: { scope: "global" },
      }),
    } as unknown as GatewayRequestContext;
    const respond = vi.fn() as unknown as RespondFn;

    await sessionsHandlers["sessions.abort"]({
      req: { id: "req-global-key-alias" } as never,
      params: { key: "agent:work:main" },
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(loadSessionEntryMock).toHaveBeenCalledWith("agent:work:main", { agentId: "work" });
    expect(chatAbortMock).toHaveBeenCalledTimes(1);
    expect(chatAbortMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        params: { sessionKey: "global", runId: undefined, agentId: "work" },
      }),
    );
  });

  it("marks selected-agent global session rows active only for their own agent", async () => {
    const activeRun = createActiveRun("global", { agentId: "main" });
    const context = {
      chatAbortControllers: new Map([["run-main-global", activeRun]]),
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
        session: { scope: "global" },
      }),
      loadGatewayModelCatalog: vi.fn().mockResolvedValue([]),
    } as unknown as GatewayRequestContext;
    listSessionsFromStoreAsyncMock.mockResolvedValue({
      sessions: [{ key: "global", hasActiveRun: false }],
    });
    const respond = vi.fn() as unknown as RespondFn;

    await sessionsHandlers["sessions.list"]({
      req: { id: "req-list-global" } as never,
      params: { includeGlobal: true, agentId: "work" },
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        sessions: [expect.objectContaining({ key: "global", hasActiveRun: false })],
      }),
      undefined,
    );
  });

  it("marks unscoped global runs active for the configured default agent", async () => {
    const activeRun = createActiveRun("global");
    const context = {
      chatAbortControllers: new Map([["run-default-global", activeRun]]),
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
        session: { scope: "global" },
      }),
      loadGatewayModelCatalog: vi.fn().mockResolvedValue([]),
    } as unknown as GatewayRequestContext;
    listSessionsFromStoreAsyncMock.mockResolvedValue({
      sessions: [{ key: "global", hasActiveRun: false }],
    });
    const respond = vi.fn() as unknown as RespondFn;

    await sessionsHandlers["sessions.list"]({
      req: { id: "req-list-default-global" } as never,
      params: { includeGlobal: true, agentId: "main" },
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        sessions: [expect.objectContaining({ key: "global", hasActiveRun: true })],
      }),
      undefined,
    );
  });

  it("subscribes selected-agent global message events on an agent-scoped key", async () => {
    const subscribeSessionMessageEvents = vi.fn();
    const context = {
      subscribeSessionMessageEvents,
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
        session: { scope: "global" },
      }),
    } as unknown as GatewayRequestContext;
    const respond = vi.fn() as unknown as RespondFn;

    await sessionsHandlers["sessions.messages.subscribe"]({
      req: { id: "req-sub-global" } as never,
      params: { key: "global", agentId: "work" },
      respond,
      context,
      client: { connId: "conn-work" } as never,
      isWebchatConnect: () => false,
    });

    expect(subscribeSessionMessageEvents).toHaveBeenCalledWith("conn-work", "agent:work:global");
    expect(respond).toHaveBeenCalledWith(true, { subscribed: true, key: "global" }, undefined);
  });

  it("subscribes bare global message events on the configured default agent key", async () => {
    const subscribeSessionMessageEvents = vi.fn();
    const context = {
      subscribeSessionMessageEvents,
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main" }, { id: "work", default: true }] },
        session: { scope: "global" },
      }),
    } as unknown as GatewayRequestContext;
    const respond = vi.fn() as unknown as RespondFn;

    await sessionsHandlers["sessions.messages.subscribe"]({
      req: { id: "req-sub-global-default" } as never,
      params: { key: "global" },
      respond,
      context,
      client: { connId: "conn-default" } as never,
      isWebchatConnect: () => false,
    });

    expect(subscribeSessionMessageEvents).toHaveBeenCalledWith("conn-default", "agent:work:global");
    expect(respond).toHaveBeenCalledWith(true, { subscribed: true, key: "global" }, undefined);
  });

  it("infers selected-agent global subscriptions from agent-prefixed aliases", async () => {
    loadSessionEntryMock.mockImplementationOnce(() => ({ canonicalKey: "global" }));
    const subscribeSessionMessageEvents = vi.fn();
    const context = {
      subscribeSessionMessageEvents,
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
        session: { scope: "global" },
      }),
    } as unknown as GatewayRequestContext;
    const respond = vi.fn() as unknown as RespondFn;

    await sessionsHandlers["sessions.messages.subscribe"]({
      req: { id: "req-sub-global-alias" } as never,
      params: { key: "agent:work:main" },
      respond,
      context,
      client: { connId: "conn-work-alias" } as never,
      isWebchatConnect: () => false,
    });

    expect(loadSessionEntryMock).toHaveBeenCalledWith("agent:work:main", { agentId: "work" });
    expect(subscribeSessionMessageEvents).toHaveBeenCalledWith(
      "conn-work-alias",
      "agent:work:global",
    );
    expect(respond).toHaveBeenCalledWith(true, { subscribed: true, key: "global" }, undefined);
  });

  it("aborts an active legacy-key run owned by the configured default agent", async () => {
    const activeRun = createActiveRun("main");
    const context = {
      chatAbortControllers: new Map([["run-work", activeRun]]),
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "work", default: true }] },
      }),
    } as unknown as GatewayRequestContext;
    resolveSessionKeyForRunMock.mockReturnValue(undefined);
    const respond = vi.fn() as unknown as RespondFn;

    await sessionsHandlers["sessions.abort"]({
      req: { id: "req-3" } as never,
      params: { runId: "run-work" },
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(resolveSessionKeyForRunMock).not.toHaveBeenCalled();
    expect(chatAbortMock).toHaveBeenCalledTimes(1);
    expect(chatAbortMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        params: { sessionKey: "main", runId: "run-work" },
      }),
    );
  });

  it("rejects key-based aborts when key agent does not match agentId", async () => {
    const context = {
      chatAbortControllers: new Map(),
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main", default: true }, { id: "beta" }] },
      }),
    } as unknown as GatewayRequestContext;
    const respond = vi.fn() as unknown as RespondFn;

    await sessionsHandlers["sessions.abort"]({
      req: { id: "req-4" } as never,
      params: { key: "agent:beta:main", agentId: "main" },
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(chatAbortMock).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "session key agent does not match agentId",
      }),
    );
  });

  it("rejects explicit agentId mismatches before session mutations", async () => {
    const context = {
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
        session: { scope: "global" },
      }),
    } as unknown as GatewayRequestContext;

    for (const [method, params] of [
      ["sessions.patch", { key: "agent:main:main", agentId: "work", label: "Work" }],
      ["sessions.delete", { key: "agent:main:main", agentId: "work" }],
      ["sessions.compact", { key: "agent:main:main", agentId: "work" }],
    ] as const) {
      const respond = vi.fn() as unknown as RespondFn;

      await sessionsHandlers[method]({
        req: { id: `req-${method}` } as never,
        params,
        respond,
        context,
        client: null,
        isWebchatConnect: () => false,
      });

      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          message: "session key agent does not match agentId",
        }),
      );
    }
  });

  it("rejects unknown explicit agentId before session mutations", async () => {
    const context = {
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main", default: true }] },
      }),
    } as unknown as GatewayRequestContext;
    const respond = vi.fn() as unknown as RespondFn;

    await sessionsHandlers["sessions.patch"]({
      req: { id: "req-unknown-agent-patch" } as never,
      params: { key: "global", agentId: "work", label: "Work" },
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: 'Unknown agent id "work"',
      }),
    );
  });

  it("rejects unknown inferred selected-global aliases before session mutations", async () => {
    const context = {
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
        session: { scope: "global" },
      }),
    } as unknown as GatewayRequestContext;

    for (const [method, params] of [
      ["sessions.patch", { key: "agent:typo:main", label: "Typo" }],
      ["sessions.delete", { key: "agent:typo:main" }],
      ["sessions.compact", { key: "agent:typo:main" }],
    ] as const) {
      const respond = vi.fn() as unknown as RespondFn;

      await sessionsHandlers[method]({
        req: { id: `req-${method}-unknown-alias` } as never,
        params,
        respond,
        context,
        client: null,
        isWebchatConnect: () => false,
      });

      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          message: 'Unknown agent id "typo"',
        }),
      );
    }
  });

  it("applies agentId to legacy key-based abort aliases", async () => {
    const context = {
      chatAbortControllers: new Map(),
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      }),
    } as unknown as GatewayRequestContext;
    const respond = vi.fn() as unknown as RespondFn;

    await sessionsHandlers["sessions.abort"]({
      req: { id: "req-5" } as never,
      params: { key: "main", agentId: "work" },
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(chatAbortMock).toHaveBeenCalledTimes(1);
    expect(chatAbortMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        params: { sessionKey: "agent:work:main", runId: undefined },
      }),
    );
  });

  it("does not use a raw legacy key alias that belongs to another agent", async () => {
    const activeRun = createActiveRun("main");
    const context = {
      chatAbortControllers: new Map([["run-work", activeRun]]),
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      }),
    } as unknown as GatewayRequestContext;
    const respond = vi.fn() as unknown as RespondFn;

    await sessionsHandlers["sessions.abort"]({
      req: { id: "req-6" } as never,
      params: { key: "main", agentId: "work" },
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(chatAbortMock).toHaveBeenCalledTimes(1);
    expect(chatAbortMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        params: { sessionKey: "agent:work:main", runId: undefined },
      }),
    );
  });

  it("keeps the raw legacy key alias when it belongs to the requested agent", async () => {
    const activeRun = createActiveRun("main");
    const context = {
      chatAbortControllers: new Map([["run-work", activeRun]]),
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "work", default: true }, { id: "main" }] },
      }),
    } as unknown as GatewayRequestContext;
    const respond = vi.fn() as unknown as RespondFn;

    await sessionsHandlers["sessions.abort"]({
      req: { id: "req-7" } as never,
      params: { key: "main", agentId: "work" },
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(chatAbortMock).toHaveBeenCalledTimes(1);
    expect(chatAbortMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        params: { sessionKey: "main", runId: undefined },
      }),
    );
  });
});
