import { describe, expect, it, vi } from "vitest";
import { waitForDiscordGatewayStop } from "./monitor.gateway.js";
import type { DiscordGatewayEvent } from "./monitor/gateway-supervisor.js";

function createGatewayEvent(
  type: DiscordGatewayEvent["type"],
  message: string,
): DiscordGatewayEvent {
  const err = new Error(message);
  return {
    type,
    err,
    message: String(err),
    shouldStopLifecycle: type !== "other",
  };
}

function createGatewayWaitHarness() {
  let lifecycleHandler: ((event: DiscordGatewayEvent) => void) | undefined;
  const disconnect = vi.fn();
  const abort = new AbortController();
  const attachLifecycle = vi.fn((handler: (event: DiscordGatewayEvent) => void) => {
    lifecycleHandler = handler;
  });
  const detachLifecycle = vi.fn(() => {
    lifecycleHandler = undefined;
  });
  return {
    abort,
    attachLifecycle,
    detachLifecycle,
    disconnect,
    emitGatewayEvent: (event: DiscordGatewayEvent) => {
      lifecycleHandler?.(event);
    },
    gatewaySupervisor: {
      attachLifecycle,
      detachLifecycle,
    },
  };
}

function startGatewayWait(params?: {
  disconnect?: () => void;
  onGatewayEvent?: (event: DiscordGatewayEvent) => "continue" | "stop";
  registerForceStop?: (fn: (error: unknown) => void) => void;
}) {
  const harness = createGatewayWaitHarness();
  if (params?.disconnect) {
    harness.disconnect.mockImplementation(params.disconnect);
  }
  const promise = waitForDiscordGatewayStop({
    gateway: { disconnect: harness.disconnect },
    abortSignal: harness.abort.signal,
    gatewaySupervisor: harness.gatewaySupervisor,
    ...(params?.onGatewayEvent ? { onGatewayEvent: params.onGatewayEvent } : {}),
    ...(params?.registerForceStop ? { registerForceStop: params.registerForceStop } : {}),
  });
  return { ...harness, promise };
}

async function expectAbortToResolve(params: {
  abort: AbortController;
  attachLifecycle: ReturnType<typeof vi.fn>;
  detachLifecycle: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  promise: Promise<void>;
  expectedDisconnectBeforeAbort?: number;
}) {
  if (params.expectedDisconnectBeforeAbort !== undefined) {
    expect(params.disconnect).toHaveBeenCalledTimes(params.expectedDisconnectBeforeAbort);
  }
  expect(params.attachLifecycle).toHaveBeenCalledTimes(1);
  params.abort.abort();
  await expect(params.promise).resolves.toBeUndefined();
  expect(params.disconnect).toHaveBeenCalledTimes(1);
  expect(params.detachLifecycle).toHaveBeenCalledTimes(1);
}

describe("waitForDiscordGatewayStop", () => {
  it("resolves on abort and disconnects gateway", async () => {
    const { abort, attachLifecycle, detachLifecycle, disconnect, promise } = startGatewayWait();
    await expectAbortToResolve({ abort, attachLifecycle, detachLifecycle, disconnect, promise });
  });

  it("rejects on lifecycle stop events and disconnects", async () => {
    const fatalEvent = createGatewayEvent("fatal", "boom");
    const { detachLifecycle, disconnect, emitGatewayEvent, promise } = startGatewayWait();

    emitGatewayEvent(fatalEvent);

    await expect(promise).rejects.toThrow("discord gateway fatal: Error: boom");
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(detachLifecycle).toHaveBeenCalledTimes(1);
  });

  it("ignores transient gateway events when instructed", async () => {
    const transientEvent = createGatewayEvent("other", "transient");
    const onGatewayEvent = vi.fn(() => "continue" as const);
    const { abort, attachLifecycle, detachLifecycle, disconnect, emitGatewayEvent, promise } =
      startGatewayWait({
        onGatewayEvent,
      });

    emitGatewayEvent(transientEvent);
    expect(onGatewayEvent).toHaveBeenCalledWith(transientEvent);
    await expectAbortToResolve({
      abort,
      attachLifecycle,
      detachLifecycle,
      disconnect,
      promise,
      expectedDisconnectBeforeAbort: 0,
    });
  });

  it("resolves on abort without a gateway", async () => {
    const abort = new AbortController();
    const promise = waitForDiscordGatewayStop({
      abortSignal: abort.signal,
    });

    abort.abort();

    await expect(promise).resolves.toBeUndefined();
  });

  it("rejects via registerForceStop and disconnects gateway", async () => {
    let forceStop: ((err: unknown) => void) | undefined;
    const { detachLifecycle, disconnect, promise } = startGatewayWait({
      registerForceStop: (handler) => {
        forceStop = handler;
      },
    });

    forceStop?.(new Error("runtime-not-ready"));

    await expect(promise).rejects.toThrow("runtime-not-ready");
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(detachLifecycle).toHaveBeenCalledTimes(1);
  });

  it("keeps the lifecycle handler active until disconnect returns on abort", async () => {
    const onGatewayEvent = vi.fn(() => "stop" as const);
    const fatalEvent = createGatewayEvent("fatal", "disconnect emitted error");
    let emitFromDisconnect: ((event: DiscordGatewayEvent) => void) | undefined;
    const { abort, detachLifecycle, disconnect, emitGatewayEvent, promise } = startGatewayWait({
      onGatewayEvent,
      disconnect: () => {
        emitFromDisconnect?.(fatalEvent);
      },
    });
    emitFromDisconnect = emitGatewayEvent;

    abort.abort();

    await expect(promise).resolves.toBeUndefined();
    expect(onGatewayEvent).toHaveBeenCalledWith(fatalEvent);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(detachLifecycle).toHaveBeenCalledTimes(1);
  });

  it("keeps the original rejection when disconnect emits another stop event", async () => {
    const firstEvent = createGatewayEvent("fatal", "first failure");
    const secondEvent = createGatewayEvent("fatal", "second failure");
    const seenEvents: DiscordGatewayEvent[] = [];
    let emitFromDisconnect: ((event: DiscordGatewayEvent) => void) | undefined;
    const { emitGatewayEvent, promise } = startGatewayWait({
      onGatewayEvent: (event) => {
        seenEvents.push(event);
        return "stop";
      },
      disconnect: () => {
        emitFromDisconnect?.(secondEvent);
      },
    });
    emitFromDisconnect = emitGatewayEvent;

    emitGatewayEvent(firstEvent);

    await expect(promise).rejects.toThrow("discord gateway fatal: Error: first failure");
    expect(seenEvents.map((event) => event.message)).toEqual([
      firstEvent.message,
      secondEvent.message,
    ]);
  });
});
