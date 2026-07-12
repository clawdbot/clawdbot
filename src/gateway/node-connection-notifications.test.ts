// Node connection notification routing tests cover active-first delivery and fallback fanout.
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeConnectionNotificationRouter } from "./node-connection-notifications.js";
import type { NodeSession } from "./node-registry.js";

function node(
  nodeId: string,
  options: { lastActiveAtMs?: number; presenceUpdatedAtMs?: number } = {},
): NodeSession {
  return {
    nodeId,
    connId: `conn-${nodeId}`,
    displayName: nodeId,
    platform: "darwin",
    commands: ["system.notify"],
    lastActiveAtMs: options.lastActiveAtMs,
    presenceUpdatedAtMs: options.presenceUpdatedAtMs,
  } as NodeSession;
}

afterEach(() => vi.useRealTimers());

describe("NodeConnectionNotificationRouter", () => {
  it("delivers only to the most recently active Mac when primary delivery succeeds", async () => {
    vi.useFakeTimers();
    const source = node("new-node", { lastActiveAtMs: 50 });
    const desk = node("desk", { lastActiveAtMs: 100 });
    const laptop = node("laptop", { lastActiveAtMs: 200 });
    const invoke = vi.fn(async (_params: { nodeId: string }) => ({ ok: true }));
    const router = new NodeConnectionNotificationRouter(
      { listConnected: () => [source, desk, laptop], invoke } as never,
      { primaryDelayMs: 10, fallbackDelayMs: 20, now: () => 1_000_000 },
    );

    router.onConnected(source);
    await vi.advanceTimersByTimeAsync(10);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({ nodeId: "laptop", command: "system.notify" });
    await vi.advanceTimersByTimeAsync(20);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("waits before falling back to the remaining Macs after primary failure", async () => {
    vi.useFakeTimers();
    const source = node("new-node", { lastActiveAtMs: 50 });
    const desk = node("desk", { lastActiveAtMs: 100 });
    const laptop = node("laptop", { lastActiveAtMs: 200 });
    const invoke = vi.fn(async (params: { nodeId: string }) => ({
      ok: params.nodeId !== "laptop",
    }));
    const router = new NodeConnectionNotificationRouter(
      { listConnected: () => [source, desk, laptop], invoke } as never,
      { primaryDelayMs: 10, fallbackDelayMs: 20, now: () => 1_000_000 },
    );

    router.onConnected(source);
    await vi.advanceTimersByTimeAsync(10);
    expect(invoke.mock.calls.map((call) => call[0].nodeId)).toEqual(["laptop"]);

    await vi.advanceTimersByTimeAsync(19);
    expect(invoke).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(invoke.mock.calls.map((call) => call[0].nodeId).toSorted()).toEqual([
      "desk",
      "laptop",
      "new-node",
    ]);
  });

  it("delays fanout when no Mac has reported activity and suppresses reconnect churn", async () => {
    vi.useFakeTimers();
    const source = node("new-node");
    const desk = node("desk");
    const invoke = vi.fn(async () => ({ ok: true }));
    let now = 1_000_000;
    const router = new NodeConnectionNotificationRouter(
      { listConnected: () => [source, desk], invoke } as never,
      {
        primaryDelayMs: 10,
        fallbackDelayMs: 20,
        reconnectCooldownMs: 100,
        now: () => now,
      },
    );

    router.onConnected(source);
    router.onConnected(source);
    await vi.advanceTimersByTimeAsync(29);
    expect(invoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(invoke).toHaveBeenCalledTimes(2);

    now += 101;
    router.onConnected(source);
    await vi.advanceTimersByTimeAsync(30);
    expect(invoke).toHaveBeenCalledTimes(4);
  });

  it("drops stale timers and lets a replacement connection take ownership", async () => {
    vi.useFakeTimers();
    const oldSource = node("new-node");
    const replacement = { ...node("new-node"), connId: "conn-new-node-replacement" };
    const desk = node("desk", { lastActiveAtMs: 100 });
    let connected = [oldSource, desk];
    const invoke = vi.fn(async (_params: { nodeId: string }) => ({ ok: true }));
    const router = new NodeConnectionNotificationRouter(
      { listConnected: () => connected, invoke } as never,
      { primaryDelayMs: 10, fallbackDelayMs: 20, now: () => 1_000_000 },
    );

    router.onConnected(oldSource);
    connected = [replacement, desk];
    router.onConnected(replacement);
    await vi.advanceTimersByTimeAsync(10);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({ nodeId: "desk" });
  });

  it("does not let an in-flight stale attempt cancel its replacement", async () => {
    vi.useFakeTimers();
    const oldSource = node("new-node");
    const replacement = { ...node("new-node"), connId: "conn-new-node-replacement" };
    const desk = node("desk", { lastActiveAtMs: 100 });
    let connected = [oldSource, desk];
    let resolveInvoke: ((result: { ok: boolean }) => void) | undefined;
    const firstInvoke = new Promise<{ ok: boolean }>((resolve) => {
      resolveInvoke = resolve;
    });
    const invoke = vi.fn(async () => await firstInvoke);
    const router = new NodeConnectionNotificationRouter(
      { listConnected: () => connected, invoke } as never,
      { primaryDelayMs: 10, fallbackDelayMs: 20, now: () => 1_000_000 },
    );

    router.onConnected(oldSource);
    await vi.advanceTimersByTimeAsync(10);
    expect(invoke).toHaveBeenCalledTimes(1);

    connected = [replacement, desk];
    router.onConnected(replacement);
    resolveInvoke?.({ ok: true });
    await vi.advanceTimersByTimeAsync(10);

    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("cancels staged alerts when disposed", async () => {
    vi.useFakeTimers();
    const source = node("new-node");
    const invoke = vi.fn(async () => ({ ok: true }));
    const router = new NodeConnectionNotificationRouter(
      { listConnected: () => [source], invoke } as never,
      { primaryDelayMs: 10, fallbackDelayMs: 20 },
    );

    router.onConnected(source);
    router.dispose();
    await vi.advanceTimersByTimeAsync(30);

    expect(invoke).not.toHaveBeenCalled();
  });

  it("retries a primary Mac through its replacement connection", async () => {
    vi.useFakeTimers();
    const source = { ...node("new-node", { lastActiveAtMs: 50 }), platform: "linux" };
    const oldDesk = node("desk", { lastActiveAtMs: 100 });
    const newDesk = { ...oldDesk, connId: "conn-desk-replacement" };
    let connected = [source, oldDesk];
    const invoke = vi.fn(async (params: { expectedConnId: string }) => {
      if (params.expectedConnId === oldDesk.connId) {
        connected = [source, newDesk];
        return { ok: false };
      }
      return { ok: true };
    });
    const router = new NodeConnectionNotificationRouter(
      { listConnected: () => connected, invoke } as never,
      { primaryDelayMs: 10, fallbackDelayMs: 20, now: () => 1_000_000 },
    );

    router.onConnected(source);
    await vi.advanceTimersByTimeAsync(30);

    expect(invoke.mock.calls.map((call) => call[0].expectedConnId)).toEqual([
      oldDesk.connId,
      newDesk.connId,
    ]);
  });
});
