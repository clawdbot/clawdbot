// Node connection notification routing tests cover active-first delivery and fallback fanout.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  disposeNodeConnectionNotifications,
  scheduleNodeConnectionNotification,
} from "./node-connection-notifications.js";
import type { NodeSession } from "./node-registry.js";

const PRIMARY_DELAY_MS = 750;
const FALLBACK_DELAY_MS = 5_000;
const testRegistries: object[] = [];

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

function registry<T extends object>(params: T): T {
  testRegistries.push(params);
  return params;
}

function schedule(registryValue: object, source: NodeSession): void {
  scheduleNodeConnectionNotification(registryValue as never, source, {
    isFirstConnection: true,
  });
}

afterEach(() => {
  for (const registryValue of testRegistries) {
    disposeNodeConnectionNotifications(registryValue as never);
  }
  testRegistries.length = 0;
  vi.useRealTimers();
});

describe("node connection notification routing", () => {
  it("does not alert when a previously connected node reconnects", async () => {
    vi.useFakeTimers();
    const source = node("known-node");
    const desk = node("desk");
    const invoke = vi.fn(async () => ({ ok: true }));
    const registryValue = registry({ listConnected: () => [source, desk], invoke });

    scheduleNodeConnectionNotification(registryValue as never, source, {
      isFirstConnection: false,
    });
    await vi.advanceTimersByTimeAsync(PRIMARY_DELAY_MS + FALLBACK_DELAY_MS);

    expect(invoke).not.toHaveBeenCalled();
  });

  it("delivers only to the most recently active Mac when primary delivery succeeds", async () => {
    vi.useFakeTimers();
    const source = node("new-node", { lastActiveAtMs: 50 });
    const desk = node("desk", { lastActiveAtMs: 100 });
    const laptop = node("laptop", { lastActiveAtMs: 200 });
    const invoke = vi.fn(async (_params: { nodeId: string }) => ({ ok: true }));
    const registryValue = registry({ listConnected: () => [source, desk, laptop], invoke });

    schedule(registryValue, source);
    await vi.advanceTimersByTimeAsync(PRIMARY_DELAY_MS);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      nodeId: "laptop",
      command: "system.notify",
    });
    await vi.advanceTimersByTimeAsync(FALLBACK_DELAY_MS);
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
    const registryValue = registry({ listConnected: () => [source, desk, laptop], invoke });

    schedule(registryValue, source);
    await vi.advanceTimersByTimeAsync(PRIMARY_DELAY_MS);
    expect(invoke.mock.calls.map((call) => call[0].nodeId)).toEqual(["laptop"]);

    await vi.advanceTimersByTimeAsync(FALLBACK_DELAY_MS - 1);
    expect(invoke).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(invoke.mock.calls.map((call) => call[0].nodeId).toSorted()).toEqual([
      "desk",
      "laptop",
      "new-node",
    ]);
  });

  it("delays fanout without activity and keeps later reconnects silent", async () => {
    vi.useFakeTimers();
    const source = node("new-node");
    const desk = node("desk");
    const invoke = vi.fn(async (_params: { nodeId: string }) => ({ ok: true }));
    const registryValue = registry({ listConnected: () => [source, desk], invoke });

    schedule(registryValue, source);
    schedule(registryValue, source);
    await vi.advanceTimersByTimeAsync(PRIMARY_DELAY_MS + FALLBACK_DELAY_MS - 1);
    expect(invoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(invoke).toHaveBeenCalledTimes(2);

    scheduleNodeConnectionNotification(registryValue as never, source, {
      isFirstConnection: false,
    });
    await vi.advanceTimersByTimeAsync(PRIMARY_DELAY_MS + FALLBACK_DELAY_MS);
    expect(invoke).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    scheduleNodeConnectionNotification(registryValue as never, source, {
      isFirstConnection: false,
    });
    await vi.advanceTimersByTimeAsync(PRIMARY_DELAY_MS + FALLBACK_DELAY_MS);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("drops stale timers and lets a replacement connection take ownership", async () => {
    vi.useFakeTimers();
    const oldSource = node("new-node");
    const replacement = { ...node("new-node"), connId: "conn-new-node-replacement" };
    const desk = node("desk", { lastActiveAtMs: 100 });
    let connected = [oldSource, desk];
    const invoke = vi.fn(async (_params: { nodeId: string }) => ({ ok: true }));
    const registryValue = registry({ listConnected: () => connected, invoke });

    schedule(registryValue, oldSource);
    connected = [replacement, desk];
    scheduleNodeConnectionNotification(registryValue as never, replacement, {
      isFirstConnection: false,
    });
    await vi.advanceTimersByTimeAsync(PRIMARY_DELAY_MS);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({ nodeId: "desk" });
  });

  it("resolves the current source session when replacement races persistence", async () => {
    vi.useFakeTimers();
    const oldSource = node("new-node");
    const replacement = {
      ...node("new-node"),
      connId: "conn-new-node-replacement",
      displayName: "Replacement Mac",
    };
    const desk = node("desk", { lastActiveAtMs: 100 });
    let connected = [oldSource, desk];
    const invoke = vi.fn(async (_params: { nodeId: string; params: { body: string } }) => ({
      ok: true,
    }));
    const registryValue = registry({ listConnected: () => connected, invoke });

    schedule(registryValue, oldSource);
    connected = [replacement, desk];
    await vi.advanceTimersByTimeAsync(PRIMARY_DELAY_MS);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      nodeId: "desk",
      params: { body: "Replacement Mac connected to OpenClaw." },
    });
  });

  it("cancels the first-connection claim when the node is gone at delivery", async () => {
    vi.useFakeTimers();
    const source = node("new-node");
    let connected: NodeSession[] = [source];
    const invoke = vi.fn(async () => ({ ok: true }));
    const registryValue = registry({ listConnected: () => connected, invoke });

    schedule(registryValue, source);
    connected = [];
    await vi.advanceTimersByTimeAsync(PRIMARY_DELAY_MS);

    connected = [source];
    scheduleNodeConnectionNotification(registryValue as never, source, {
      isFirstConnection: false,
    });
    await vi.advanceTimersByTimeAsync(PRIMARY_DELAY_MS + FALLBACK_DELAY_MS);
    expect(invoke).not.toHaveBeenCalled();
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
    const registryValue = registry({ listConnected: () => connected, invoke });

    schedule(registryValue, oldSource);
    await vi.advanceTimersByTimeAsync(PRIMARY_DELAY_MS);
    expect(invoke).toHaveBeenCalledTimes(1);

    connected = [replacement, desk];
    scheduleNodeConnectionNotification(registryValue as never, replacement, {
      isFirstConnection: false,
    });
    resolveInvoke?.({ ok: true });
    await vi.advanceTimersByTimeAsync(PRIMARY_DELAY_MS);

    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("cancels staged alerts when disposed", async () => {
    vi.useFakeTimers();
    const source = node("new-node");
    const invoke = vi.fn(async () => ({ ok: true }));
    const registryValue = registry({ listConnected: () => [source], invoke });

    schedule(registryValue, source);
    disposeNodeConnectionNotifications(registryValue as never);
    await vi.advanceTimersByTimeAsync(PRIMARY_DELAY_MS + FALLBACK_DELAY_MS);

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
    const registryValue = registry({ listConnected: () => connected, invoke });

    schedule(registryValue, source);
    await vi.advanceTimersByTimeAsync(PRIMARY_DELAY_MS + FALLBACK_DELAY_MS);

    expect(invoke.mock.calls.map((call) => call[0].expectedConnId)).toEqual([
      oldDesk.connId,
      newDesk.connId,
    ]);
  });
});
