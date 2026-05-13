import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

// Regression coverage for #57790: the bounded shutdown drain must fire a
// typed `session_end` for every session the tracker has noted, must skip
// sessions that have already been finalized through replace / reset /
// delete / compaction (so we never double-fire), must respect the
// configured total timeout, and must propagate the reason ("shutdown" or
// "restart") into the plugin hook payload.

type SessionEndHookEvent = {
  reason?: string;
  sessionId?: string;
  sessionKey?: string;
};

const runSessionEndMock = vi.fn(async (_event: SessionEndHookEvent) => undefined);
const hasHooksMock = vi.fn((name: string) => name === "session_end");
const getGlobalHookRunnerMock = vi.fn(() => ({
  hasHooks: hasHooksMock,
  runSessionEnd: runSessionEndMock,
  runSessionStart: vi.fn(async () => undefined),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: getGlobalHookRunnerMock,
}));

vi.mock("./session-transcript-files.fs.js", () => ({
  resolveStableSessionEndTranscript: vi.fn(() => ({
    sessionFile: undefined,
    transcriptArchived: false,
  })),
  archiveSessionTranscriptsDetailed: vi.fn(() => []),
}));

vi.mock("../auto-reply/reply/session-hooks.js", () => ({
  buildSessionEndHookPayload: vi.fn(
    (params: { sessionId: string; reason: string; sessionKey: string }) => ({
      event: { sessionId: params.sessionId, reason: params.reason, sessionKey: params.sessionKey },
      context: { sessionId: params.sessionId, reason: params.reason },
    }),
  ),
  buildSessionStartHookPayload: vi.fn(() => ({ event: {}, context: {} })),
}));

const {
  drainActiveSessionsForShutdown,
  emitGatewaySessionEndPluginHook,
  emitGatewaySessionStartPluginHook,
} = await import("./session-reset-service.js");
const { clearActiveSessionsForShutdownTracker, listActiveSessionsForShutdown } =
  await import("./active-sessions-shutdown-tracker.js");

const cfg: OpenClawConfig = {};

const requireSessionEndHookEvent = (index: number): SessionEndHookEvent => {
  const call = runSessionEndMock.mock.calls[index];
  if (!call) {
    throw new Error(`Expected session_end hook call ${index}`);
  }
  return call[0];
};

beforeEach(() => {
  clearActiveSessionsForShutdownTracker();
  runSessionEndMock.mockClear();
  hasHooksMock.mockClear();
  hasHooksMock.mockImplementation((name: string) => name === "session_end");
});

afterEach(() => {
  clearActiveSessionsForShutdownTracker();
});

describe("drainActiveSessionsForShutdown", () => {
  it("returns an empty result and skips hook emission when no sessions are tracked", async () => {
    const result = await drainActiveSessionsForShutdown({ reason: "shutdown" });

    expect(result).toEqual({ emittedSessionIds: [], timedOut: false });
    expect(runSessionEndMock).not.toHaveBeenCalled();
  });

  it("fires session_end with reason=shutdown for every tracked session and clears them", async () => {
    emitGatewaySessionStartPluginHook({
      cfg,
      sessionKey: "agent:main:main",
      sessionId: "sess-A",
      storePath: "/tmp/store.json",
    });
    emitGatewaySessionStartPluginHook({
      cfg,
      sessionKey: "agent:main:other",
      sessionId: "sess-B",
      storePath: "/tmp/store.json",
    });

    const result = await drainActiveSessionsForShutdown({ reason: "shutdown" });

    expect(result.timedOut).toBe(false);
    expect(result.emittedSessionIds.toSorted()).toEqual(["sess-A", "sess-B"]);
    expect(runSessionEndMock).toHaveBeenCalledTimes(2);
    const reasons = runSessionEndMock.mock.calls.map(
      ([event]) => (event as { reason?: string }).reason,
    );
    expect(reasons.every((reason) => reason === "shutdown")).toBe(true);
    // After the drain, the tracker forgets every emitted session (the emit
    // helper calls `forgetActiveSessionForShutdown`), so a second drain is a
    // no-op and we never double-fire on restart loops.
    expect(listActiveSessionsForShutdown()).toEqual([]);
  });

  it("propagates reason=restart when called for a restart shutdown", async () => {
    emitGatewaySessionStartPluginHook({
      cfg,
      sessionKey: "agent:main:main",
      sessionId: "sess-A",
      storePath: "/tmp/store.json",
    });

    await drainActiveSessionsForShutdown({ reason: "restart" });

    expect(runSessionEndMock).toHaveBeenCalledTimes(1);
    expect(requireSessionEndHookEvent(0).reason).toBe("restart");
  });

  it("does not double-fire for a session already finalized by reset/delete/compaction", async () => {
    emitGatewaySessionStartPluginHook({
      cfg,
      sessionKey: "agent:main:main",
      sessionId: "sess-A",
      storePath: "/tmp/store.json",
    });
    emitGatewaySessionStartPluginHook({
      cfg,
      sessionKey: "agent:main:other",
      sessionId: "sess-B",
      storePath: "/tmp/store.json",
    });
    // Simulate sess-A being finalized through the normal reset path before
    // the gateway is shut down: the matching `session_end` is fired with
    // reason="reset" and the tracker forgets it.
    emitGatewaySessionEndPluginHook({
      cfg,
      sessionKey: "agent:main:main",
      sessionId: "sess-A",
      storePath: "/tmp/store.json",
      reason: "reset",
    });
    runSessionEndMock.mockClear();

    await drainActiveSessionsForShutdown({ reason: "shutdown" });

    expect(runSessionEndMock).toHaveBeenCalledTimes(1);
    expect(requireSessionEndHookEvent(0).sessionId).toBe("sess-B");
  });

  it("awaits each session_end handler so the bounded timeout actually races real plugin work", async () => {
    let resolveHandler: (() => void) | undefined;
    const handlerLatch = new Promise<void>((resolve) => {
      resolveHandler = resolve;
    });
    runSessionEndMock.mockImplementationOnce(async () => {
      await handlerLatch;
    });
    emitGatewaySessionStartPluginHook({
      cfg,
      sessionKey: "agent:main:main",
      sessionId: "sess-A",
      storePath: "/tmp/store.json",
    });

    let drainSettled = false;
    const drainPromise = drainActiveSessionsForShutdown({ reason: "shutdown" }).then((value) => {
      drainSettled = true;
      return value;
    });

    // Yield twice so the drain can call `runSessionEnd`, then assert that
    // it is still pending: this is the regression check for the fire-and-
    // forget bug that the bot flagged on the original PR.
    await Promise.resolve();
    await Promise.resolve();
    expect(drainSettled).toBe(false);
    expect(runSessionEndMock).toHaveBeenCalledTimes(1);

    resolveHandler?.();
    const result = await drainPromise;
    expect(result.timedOut).toBe(false);
    expect(result.emittedSessionIds).toEqual(["sess-A"]);
  });

  it("returns timedOut=true while still starting later emissions when one handler hangs", async () => {
    runSessionEndMock.mockImplementation(async (event: SessionEndHookEvent) => {
      if (event.sessionId === "sess-A") {
        await new Promise<void>(() => undefined);
      }
    });
    emitGatewaySessionStartPluginHook({
      cfg,
      sessionKey: "agent:main:main",
      sessionId: "sess-A",
      storePath: "/tmp/store.json",
    });
    emitGatewaySessionStartPluginHook({
      cfg,
      sessionKey: "agent:main:other",
      sessionId: "sess-B",
      storePath: "/tmp/store.json",
    });

    const result = await drainActiveSessionsForShutdown({
      reason: "shutdown",
      totalTimeoutMs: 120,
    });

    expect(result.timedOut).toBe(true);
    expect(result.emittedSessionIds.toSorted()).toEqual(["sess-A", "sess-B"]);
    expect(runSessionEndMock).toHaveBeenCalledTimes(2);
    expect(
      runSessionEndMock.mock.calls.map(([event]) => (event as { sessionId?: string }).sessionId),
    ).toEqual(["sess-A", "sess-B"]);
  });

  it("still records the session as forgotten when no `session_end` plugins are registered", async () => {
    hasHooksMock.mockImplementation(() => false);
    emitGatewaySessionStartPluginHook({
      cfg,
      sessionKey: "agent:main:main",
      sessionId: "sess-A",
      storePath: "/tmp/store.json",
    });
    // session_end fires while no plugin listens: hook is not run, but the
    // shutdown tracker must still forget the session so the later drain
    // does not pick it up.
    emitGatewaySessionEndPluginHook({
      cfg,
      sessionKey: "agent:main:main",
      sessionId: "sess-A",
      storePath: "/tmp/store.json",
      reason: "deleted",
    });

    expect(listActiveSessionsForShutdown()).toEqual([]);
    const result = await drainActiveSessionsForShutdown({ reason: "shutdown" });

    expect(result.emittedSessionIds).toEqual([]);
  });
});
