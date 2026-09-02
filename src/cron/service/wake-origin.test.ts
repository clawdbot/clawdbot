// Regression coverage for cron wake origin capture (openclaw/openclaw#46886,
// #64556): wake must thread sessionKey + agentId through to enqueueSystemEvent
// and the heartbeat request so multi-agent / non-main-session wakes land on the
// originating conversation lane. Base sessionKey threading and the no-origin
// default shape are covered by wake.test.ts; these tests pin the agentId half.
import { describe, expect, it, vi } from "vitest";
import type { CronServiceState } from "./state.js";
import { wake } from "./wake.js";

// Minimal CronServiceState shim — `wake` only touches `state.deps` so the
// other state fields aren't relevant. Cast through `unknown` to avoid
// pulling in the full state factory just to exercise two callbacks.
function makeStateWithMocks(): {
  state: CronServiceState;
  enqueueSystemEvent: ReturnType<typeof vi.fn>;
  requestHeartbeat: ReturnType<typeof vi.fn>;
} {
  const enqueueSystemEvent = vi.fn();
  const requestHeartbeat = vi.fn();
  const state = {
    deps: { enqueueSystemEvent, requestHeartbeat },
  } as unknown as CronServiceState;
  return { state, enqueueSystemEvent, requestHeartbeat };
}

describe("cron service wake() origin capture", () => {
  it("forwards sessionKey + agentId to enqueueSystemEvent so the event lands on the originating session", () => {
    // Prior to this change the wake function forwarded only sessionKey, so
    // multi-agent setups routed every wake to the default agent regardless
    // of which agent owned the originating session.
    const { state, enqueueSystemEvent, requestHeartbeat } = makeStateWithMocks();
    const result = wake(state, {
      mode: "now",
      text: "follow up on the report",
      sessionKey: "agent:main:telegram:8661849123:topic:4052",
      agentId: "main",
    });
    expect(result).toEqual({ ok: true });
    expect(enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith("follow up on the report", {
      sessionKey: "agent:main:telegram:8661849123:topic:4052",
      agentId: "main",
    });
    expect(requestHeartbeat).toHaveBeenCalledExactlyOnceWith({
      source: "manual",
      intent: "immediate",
      reason: "wake",
      sessionKey: "agent:main:telegram:8661849123:topic:4052",
      agentId: "main",
    });
  });

  it("threads sessionKey + agentId into the targeted-immediate heartbeat for next-heartbeat+sessionKey too", () => {
    // wake() collapses --mode now and --mode next-heartbeat into the same
    // targeted-immediate behavior when sessionKey is present — the regularly
    // scheduled heartbeat fires for the agent's main session, so a non-main
    // wake needs an explicit targeted nudge to peek the session's queue.
    // agentId must thread through that nudge too.
    const { state, enqueueSystemEvent, requestHeartbeat } = makeStateWithMocks();
    const result = wake(state, {
      mode: "next-heartbeat",
      text: "check the queue",
      sessionKey: "agent:coding:discord:thread123",
      agentId: "coding",
    });
    expect(result).toEqual({ ok: true });
    expect(enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith("check the queue", {
      sessionKey: "agent:coding:discord:thread123",
      agentId: "coding",
    });
    expect(requestHeartbeat).toHaveBeenCalledExactlyOnceWith({
      source: "manual",
      intent: "immediate",
      reason: "wake",
      sessionKey: "agent:coding:discord:thread123",
      agentId: "coding",
    });
  });

  it("forwards an agentId-only wake so the event reaches that agent's default lane", () => {
    // Caught by mutation testing: `sessionKey || agentId` -> `&&` survived
    // because no test exercised agentId without sessionKey. An agentId-only
    // wake must still build enqueue opts (the gateway resolves the agent's
    // default session from agentId) rather than fall back to the global
    // default lane.
    const { state, enqueueSystemEvent, requestHeartbeat } = makeStateWithMocks();
    const result = wake(state, { mode: "now", text: "agent only", agentId: "ops" });
    expect(result).toEqual({ ok: true });
    expect(enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith("agent only", {
      agentId: "ops",
    });
    expect(requestHeartbeat).toHaveBeenCalledExactlyOnceWith({
      source: "manual",
      intent: "immediate",
      reason: "wake",
      agentId: "ops",
    });
  });

  it("drops whitespace-only sessionKey / agentId rather than routing to a meaningless lane", () => {
    // Defence-in-depth: gateway handler already trims, but the wake function
    // is also reachable directly by other in-process call sites. Empty /
    // whitespace fields must fall through to default routing, not route
    // the event to a session named " " (which would silently drop it).
    const { state, enqueueSystemEvent, requestHeartbeat } = makeStateWithMocks();
    wake(state, {
      mode: "now",
      text: "x",
      sessionKey: "   ",
      agentId: "\t",
    });
    expect(enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith("x", undefined);
    expect(requestHeartbeat).toHaveBeenCalledExactlyOnceWith({
      source: "manual",
      intent: "immediate",
      reason: "wake",
    });
  });
});
