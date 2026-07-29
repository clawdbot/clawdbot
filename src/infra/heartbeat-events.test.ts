// Tests heartbeat event emission and listener cleanup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitHeartbeatEvent,
  getLastHeartbeatEvent,
  onHeartbeatEvent,
  resetHeartbeatEventsForTest,
  resolveIndicatorType,
} from "./heartbeat-events.js";

type HeartbeatEventsModule = typeof import("./heartbeat-events.js");

const heartbeatEventsModuleUrl = new URL("./heartbeat-events.ts", import.meta.url).href;

async function importHeartbeatEventsModule(cacheBust: string): Promise<HeartbeatEventsModule> {
  return (await import(`${heartbeatEventsModuleUrl}?t=${cacheBust}`)) as HeartbeatEventsModule;
}

describe("resolveIndicatorType", () => {
  it("maps heartbeat statuses to indicator types", () => {
    expect(resolveIndicatorType("ok-empty")).toBe("ok");
    expect(resolveIndicatorType("ok-token")).toBe("ok");
    expect(resolveIndicatorType("sent")).toBe("alert");
    expect(resolveIndicatorType("failed")).toBe("error");
    expect(resolveIndicatorType("skipped")).toBeUndefined();
  });
});

describe("heartbeat events", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-09T12:00:00Z"));
  });

  afterEach(() => {
    resetHeartbeatEventsForTest();
    vi.useRealTimers();
  });

  it("stores the last event and timestamps emitted payloads", () => {
    emitHeartbeatEvent({ status: "sent", to: "+123", preview: "ping" });

    expect(getLastHeartbeatEvent()).toEqual({
      ts: 1767960000000,
      status: "sent",
      to: "+123",
      preview: "ping",
    });
  });

  it("delivers events to listeners, isolates listener failures, and supports unsubscribe", () => {
    const seen: string[] = [];
    const unsubscribeFirst = onHeartbeatEvent((evt) => {
      seen.push(`first:${evt.status}`);
    });
    onHeartbeatEvent(() => {
      throw new Error("boom");
    });
    const unsubscribeThird = onHeartbeatEvent((evt) => {
      seen.push(`third:${evt.status}`);
    });

    emitHeartbeatEvent({ status: "ok-empty" });
    unsubscribeFirst();
    unsubscribeThird();
    emitHeartbeatEvent({ status: "failed" });

    expect(seen).toEqual(["first:ok-empty", "third:ok-empty"]);
  });

  it("shares heartbeat state across duplicate module instances", async () => {
    const first = await importHeartbeatEventsModule(`first-${Date.now()}`);
    const second = await importHeartbeatEventsModule(`second-${Date.now()}`);

    first.resetHeartbeatEventsForTest();

    const seen: string[] = [];
    const stop = first.onHeartbeatEvent((evt) => {
      seen.push(evt.status);
    });

    second.emitHeartbeatEvent({ status: "ok-token", preview: "pong" });

    expect(first.getLastHeartbeatEvent()).toEqual({
      ts: 1767960000000,
      status: "ok-token",
      preview: "pong",
    });
    expect(seen).toEqual(["ok-token"]);

    stop();
    first.resetHeartbeatEventsForTest();
  });
});
