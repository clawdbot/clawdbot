// Tests for node wake state tracking and testing seam.
import { beforeEach, describe, expect, it } from "vitest";
import {
  NODE_WAKE_RECONNECT_WAIT_MS,
  NODE_WAKE_RECONNECT_RETRY_WAIT_MS,
  NODE_WAKE_RECONNECT_POLL_MS,
  clearNodeWakeState,
  nodeWakeById,
  nodeWakeNudgeById,
} from "./nodes-wake-state.js";

beforeEach(() => {
  nodeWakeById.clear();
  nodeWakeNudgeById.clear();
});

describe("constants", () => {
  it("exports expected wait/poll constants", () => {
    expect(NODE_WAKE_RECONNECT_WAIT_MS).toBe(3_000);
    expect(NODE_WAKE_RECONNECT_RETRY_WAIT_MS).toBe(12_000);
    expect(NODE_WAKE_RECONNECT_POLL_MS).toBe(150);
  });
});

describe("nodeWakeById", () => {
  it("starts empty", () => {
    expect(nodeWakeById.size).toBe(0);
  });

  it("stores NodeWakeState entries", () => {
    const now = Date.now();
    nodeWakeById.set("node-1", { lastWakeAtMs: now });
    expect(nodeWakeById.size).toBe(1);
    expect(nodeWakeById.get("node-1")?.lastWakeAtMs).toBe(now);
  });

  it("stores multiple entries", () => {
    nodeWakeById.set("a", { lastWakeAtMs: 100 });
    nodeWakeById.set("b", { lastWakeAtMs: 200 });
    nodeWakeById.set("c", { lastWakeAtMs: 300 });
    expect(nodeWakeById.size).toBe(3);
  });

  it("overwrites existing entry when key is reused", () => {
    nodeWakeById.set("node-1", { lastWakeAtMs: 100 });
    nodeWakeById.set("node-1", { lastWakeAtMs: 200 });
    expect(nodeWakeById.size).toBe(1);
  });

  it("supports inFlight promise property", () => {
    const promise = Promise.resolve({
      available: true,
      throttled: false,
      path: "sent" as const,
      durationMs: 50,
    });
    nodeWakeById.set("node-1", { lastWakeAtMs: Date.now(), inFlight: promise });
    expect(nodeWakeById.get("node-1")?.inFlight).toBe(promise);
  });
});

describe("nodeWakeNudgeById", () => {
  it("starts empty", () => {
    expect(nodeWakeNudgeById.size).toBe(0);
  });

  it("stores nudge timestamps", () => {
    nodeWakeNudgeById.set("node-1", 1000);
    expect(nodeWakeNudgeById.size).toBe(1);
    expect(nodeWakeNudgeById.get("node-1")).toBe(1000);
  });

  it("independently tracked from nodeWakeById", () => {
    nodeWakeById.set("node-1", { lastWakeAtMs: 500 });
    nodeWakeNudgeById.set("node-1", 1000);
    expect(nodeWakeById.size).toBe(1);
    expect(nodeWakeNudgeById.size).toBe(1);
  });
});

describe("clearNodeWakeState", () => {
  it("removes the wake entry and nudge for the given node", () => {
    nodeWakeById.set("node-1", { lastWakeAtMs: 100 });
    nodeWakeNudgeById.set("node-1", 200);
    clearNodeWakeState("node-1");
    expect(nodeWakeById.has("node-1")).toBe(false);
    expect(nodeWakeNudgeById.has("node-1")).toBe(false);
  });

  it("is a no-op when the node id does not exist", () => {
    expect(() => clearNodeWakeState("ghost")).not.toThrow();
    expect(nodeWakeById.size).toBe(0);
    expect(nodeWakeNudgeById.size).toBe(0);
  });

  it("only removes the specified node, leaving others intact", () => {
    nodeWakeById.set("a", { lastWakeAtMs: 1 });
    nodeWakeById.set("b", { lastWakeAtMs: 2 });
    nodeWakeNudgeById.set("a", 10);
    nodeWakeNudgeById.set("b", 20);
    clearNodeWakeState("a");
    expect(nodeWakeById.has("a")).toBe(false);
    expect(nodeWakeById.has("b")).toBe(true);
    expect(nodeWakeNudgeById.has("a")).toBe(false);
    expect(nodeWakeNudgeById.has("b")).toBe(true);
  });
});
