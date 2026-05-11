import { beforeAll, describe, expect, it, vi } from "vitest";

let DiscordMessageListener: typeof import("./listeners.js").DiscordMessageListener;
let DiscordInteractionListener: typeof import("./listeners.js").DiscordInteractionListener;

beforeAll(async () => {
  ({ DiscordMessageListener, DiscordInteractionListener } = await import("./listeners.js"));
});

function createLogger() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
  };
}

function fakeEvent(channelId: string) {
  return { channel_id: channelId } as never;
}

function createDeferred() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("DiscordMessageListener", () => {
  it("returns immediately without awaiting handler completion", async () => {
    let resolveHandler: (() => void) | undefined;
    const handlerDone = new Promise<void>((resolve) => {
      resolveHandler = resolve;
    });
    const handler = vi.fn(async () => {
      await handlerDone;
    });
    const logger = createLogger();
    const listener = new DiscordMessageListener(handler as never, logger as never);

    await expect(listener.handle(fakeEvent("ch-1"), {} as never)).resolves.toBeUndefined();
    // Handler was dispatched but may not have been called yet (fire-and-forget).
    // Wait for the microtask to flush so the handler starts.
    await flushAsyncWork();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();

    resolveHandler?.();
    await handlerDone;
  });

  it("runs handlers for the same channel concurrently (no per-channel serialization)", async () => {
    const order: string[] = [];
    const deferredA = createDeferred();
    const deferredB = createDeferred();
    let callCount = 0;
    const handler = vi.fn(async () => {
      callCount += 1;
      const id = callCount;
      order.push(`start:${id}`);
      if (id === 1) {
        await deferredA.promise;
      } else {
        await deferredB.promise;
      }
      order.push(`end:${id}`);
    });
    const listener = new DiscordMessageListener(handler as never, createLogger() as never);

    // Both messages target the same channel — previously serialized, now concurrent.
    await listener.handle(fakeEvent("ch-1"), {} as never);
    await listener.handle(fakeEvent("ch-1"), {} as never);

    await flushAsyncWork();
    expect(handler).toHaveBeenCalledTimes(2);
    // Both handlers started without waiting for the first to finish.
    expect(order).toContain("start:1");
    expect(order).toContain("start:2");

    deferredB.resolve?.();
    await flushAsyncWork();
    expect(order).toContain("end:2");
    // First handler is still running — no serialization.
    expect(order).not.toContain("end:1");

    deferredA.resolve?.();
    await flushAsyncWork();
    expect(order).toContain("end:1");
  });

  it("runs handlers for different channels in parallel", async () => {
    const deferredA = createDeferred();
    const deferredB = createDeferred();
    const order: string[] = [];
    const handler = vi.fn(async (data: { channel_id: string }) => {
      order.push(`start:${data.channel_id}`);
      if (data.channel_id === "ch-a") {
        await deferredA.promise;
      } else {
        await deferredB.promise;
      }
      order.push(`end:${data.channel_id}`);
    });
    const listener = new DiscordMessageListener(handler as never, createLogger() as never);

    await listener.handle(fakeEvent("ch-a"), {} as never);
    await listener.handle(fakeEvent("ch-b"), {} as never);

    await flushAsyncWork();
    expect(handler).toHaveBeenCalledTimes(2);
    expect(order).toContain("start:ch-a");
    expect(order).toContain("start:ch-b");

    deferredB.resolve?.();
    await flushAsyncWork();
    expect(order).toContain("end:ch-b");
    expect(order).not.toContain("end:ch-a");

    deferredA.resolve?.();
    await flushAsyncWork();
    expect(order).toContain("end:ch-a");
  });

  it("logs async handler failures", async () => {
    const handler = vi.fn(async () => {
      throw new Error("boom");
    });
    const logger = createLogger();
    const listener = new DiscordMessageListener(handler as never, logger as never);

    await expect(listener.handle(fakeEvent("ch-1"), {} as never)).resolves.toBeUndefined();
    await flushAsyncWork();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]).toHaveLength(1);
    expect(String(logger.error.mock.calls[0]?.[0])).toContain(
      "discord handler failed: Error: boom",
    );
  });

  it("calls onEvent callback for each message", async () => {
    const handler = vi.fn(async () => {});
    const onEvent = vi.fn();
    const listener = new DiscordMessageListener(handler as never, undefined, onEvent);

    await listener.handle(fakeEvent("ch-1"), {} as never);
    await listener.handle(fakeEvent("ch-2"), {} as never);

    expect(onEvent).toHaveBeenCalledTimes(2);
  });
});

describe("DiscordInteractionListener", () => {
  it("returns immediately without awaiting Discord interaction handling", async () => {
    const handlerDone = createDeferred();
    const handleInteraction = vi.fn(async () => {
      await handlerDone.promise;
    });
    const logger = createLogger();
    const listener = new DiscordInteractionListener(logger as never);

    await expect(
      listener.handle({ id: "interaction-1" } as never, { handleInteraction } as never),
    ).resolves.toBeUndefined();
    await flushAsyncWork();
    expect(handleInteraction).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();

    handlerDone.resolve?.();
    await flushAsyncWork();
  });

  it("logs async interaction failures", async () => {
    const handleInteraction = vi.fn(async () => {
      throw new Error("interaction boom");
    });
    const logger = createLogger();
    const listener = new DiscordInteractionListener(logger as never);

    await listener.handle({ id: "interaction-1" } as never, { handleInteraction } as never);
    await flushAsyncWork();

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]).toHaveLength(1);
    expect(String(logger.error.mock.calls[0]?.[0])).toContain(
      "discord interaction handler failed: Error: interaction boom",
    );
  });

  it("calls onEvent callback for each interaction", async () => {
    const handleInteraction = vi.fn(async () => {});
    const onEvent = vi.fn();
    const listener = new DiscordInteractionListener(undefined, onEvent);

    await listener.handle({ id: "interaction-1" } as never, { handleInteraction } as never);
    await listener.handle({ id: "interaction-2" } as never, { handleInteraction } as never);

    expect(onEvent).toHaveBeenCalledTimes(2);
  });
});
