import { describe, expect, it, vi } from "vitest";
import { wake } from "./timer.js";

function createState() {
  const enqueueSystemEvent = vi.fn();
  const requestHeartbeat = vi.fn();
  return {
    state: {
      deps: {
        enqueueSystemEvent,
        requestHeartbeat,
      },
    } as unknown as Parameters<typeof wake>[0],
    enqueueSystemEvent,
    requestHeartbeat,
  };
}

describe("wake (cron timer)", () => {
  it("returns ok:false on empty text without enqueueing or waking", () => {
    const { state, enqueueSystemEvent, requestHeartbeat } = createState();
    expect(wake(state, { mode: "now", text: "   " })).toEqual({ ok: false });
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeat).not.toHaveBeenCalled();
  });

  it("enqueues without sessionKey when omitted", () => {
    const { state, enqueueSystemEvent, requestHeartbeat } = createState();
    expect(wake(state, { mode: "now", text: "ping" })).toEqual({ ok: true });
    expect(enqueueSystemEvent).toHaveBeenCalledWith("ping", undefined);
    expect(requestHeartbeat).toHaveBeenCalledWith({
      source: "manual",
      intent: "immediate",
      reason: "wake",
    });
  });

  it("threads sessionKey to both enqueue and heartbeat on mode=now", () => {
    const { state, enqueueSystemEvent, requestHeartbeat } = createState();
    expect(
      wake(state, {
        mode: "now",
        text: "ping",
        sessionKey: "agent:main:telegram:dm:42",
      }),
    ).toEqual({ ok: true });
    expect(enqueueSystemEvent).toHaveBeenCalledWith("ping", {
      sessionKey: "agent:main:telegram:dm:42",
    });
    expect(requestHeartbeat).toHaveBeenCalledWith({
      source: "manual",
      intent: "immediate",
      reason: "wake",
      sessionKey: "agent:main:telegram:dm:42",
    });
  });

  it("threads sessionKey to enqueue and fires a targeted immediate wake on mode=next-heartbeat", () => {
    // next-heartbeat + sessionKey collapses to immediate-targeted behavior:
    // the regularly-scheduled heartbeat fires for agent-main and never peeks
    // a non-main session queue, and an "event"-intent wake is not retried by
    // the heartbeat runner. Targeted immediate is the only reliable path.
    const { state, enqueueSystemEvent, requestHeartbeat } = createState();
    expect(
      wake(state, {
        mode: "next-heartbeat",
        text: "ping",
        sessionKey: "agent:main:slack:42",
      }),
    ).toEqual({ ok: true });
    expect(enqueueSystemEvent).toHaveBeenCalledWith("ping", {
      sessionKey: "agent:main:slack:42",
    });
    expect(requestHeartbeat).toHaveBeenCalledWith({
      source: "manual",
      intent: "immediate",
      reason: "wake",
      sessionKey: "agent:main:slack:42",
    });
  });

  it("does not fire a wake on mode=next-heartbeat when no sessionKey is supplied", () => {
    const { state, enqueueSystemEvent, requestHeartbeat } = createState();
    expect(wake(state, { mode: "next-heartbeat", text: "ping" })).toEqual({ ok: true });
    expect(enqueueSystemEvent).toHaveBeenCalledWith("ping", undefined);
    expect(requestHeartbeat).not.toHaveBeenCalled();
  });

  it("treats whitespace-only sessionKey as omitted", () => {
    const { state, enqueueSystemEvent, requestHeartbeat } = createState();
    wake(state, { mode: "now", text: "ping", sessionKey: "   " });
    expect(enqueueSystemEvent).toHaveBeenCalledWith("ping", undefined);
    expect(requestHeartbeat).toHaveBeenCalledWith({
      source: "manual",
      intent: "immediate",
      reason: "wake",
    });
  });

  it("rejects subagent sessionKey targets without enqueueing or waking", () => {
    const { state, enqueueSystemEvent, requestHeartbeat } = createState();
    expect(
      wake(state, {
        mode: "now",
        text: "ping",
        sessionKey: "agent:main:subagent:worker",
      }),
    ).toEqual({ ok: false, reason: "unwakeable-session-key" });
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeat).not.toHaveBeenCalled();
  });
});
