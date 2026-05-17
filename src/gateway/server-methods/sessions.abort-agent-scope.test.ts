import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const chatAbortMock = vi.fn();
const resolveSessionKeyForRunMock = vi.fn();

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
    loadSessionEntry: (sessionKey: string) => ({ canonicalKey: sessionKey }),
  };
});

import { sessionsHandlers } from "./sessions.js";

function createActiveRun(sessionKey: string) {
  const now = Date.now();
  return {
    controller: new AbortController(),
    sessionId: "sess-active",
    sessionKey,
    startedAtMs: now,
    expiresAtMs: now + 30_000,
    kind: "chat-send" as const,
  };
}

describe("sessions.abort agent scope", () => {
  beforeEach(() => {
    chatAbortMock.mockReset();
    resolveSessionKeyForRunMock.mockReset();
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
    const activeRun = createActiveRun("global");
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
        params: { sessionKey: "global", runId: "run-global" },
      }),
    );
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
