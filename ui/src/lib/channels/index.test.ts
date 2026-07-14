// Channels domain tests.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelsStatusSnapshot } from "../../api/types.ts";
import { createChannelCapability } from "./index.ts";

function createDeferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  if (!resolve || !reject) {
    throw new Error("Expected deferred callbacks to be initialized");
  }
  return { promise, resolve, reject };
}

function createChannelsSnapshot(label: string): ChannelsStatusSnapshot {
  return {
    ts: Date.now(),
    channelOrder: ["test"],
    channelLabels: { test: label },
    channels: {},
    channelAccounts: {},
    channelDefaultAccountId: {},
  };
}

describe("channels controller WhatsApp wait", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a stale login result after reconnecting with the same client", async () => {
    const staleWait = createDeferred<{
      message: string;
      connected: boolean;
      qrDataUrl: string;
    }>();
    const freshWait = createDeferred<{
      message: string;
      connected: boolean;
      qrDataUrl: string;
    }>();
    let waitCount = 0;
    const request = vi.fn((method: string) => {
      if (method === "web.login.wait") {
        waitCount += 1;
        return waitCount === 1 ? staleWait.promise : freshWait.promise;
      }
      return Promise.resolve(createChannelsSnapshot("fresh"));
    });
    const client = { request };
    let snapshot = { client, connected: true };
    const listeners = new Set<(next: typeof snapshot) => void>();
    const gateway = {
      get snapshot() {
        return snapshot;
      },
      subscribe(listener: (next: typeof snapshot) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const channels = createChannelCapability(gateway as never);

    const stale = channels.waitWhatsApp();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    snapshot = { client, connected: false };
    for (const listener of listeners) {
      listener(snapshot);
    }
    snapshot = { client, connected: true };
    for (const listener of listeners) {
      listener(snapshot);
    }

    const fresh = channels.waitWhatsApp();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    freshWait.resolve({
      message: "fresh login",
      connected: false,
      qrDataUrl: "data:image/png;base64,fresh-qr",
    });
    await fresh;

    staleWait.resolve({
      message: "stale login",
      connected: true,
      qrDataUrl: "data:image/png;base64,stale-qr",
    });
    await stale;

    expect(channels.state.whatsappLoginMessage).toBe("fresh login");
    expect(channels.state.whatsappLoginQrDataUrl).toBe("data:image/png;base64,fresh-qr");
    expect(request.mock.calls.filter(([method]) => method === "channels.status")).toHaveLength(1);
    channels.dispose();
  });

  it("does not apply or refresh a login result after its capability is disposed", async () => {
    const pending = createDeferred<{
      message: string;
      connected: boolean;
      qrDataUrl: string;
    }>();
    const request = vi.fn(() => pending.promise);
    const client = { request };
    const gateway = {
      snapshot: { client, connected: true },
      subscribe: () => () => undefined,
    };
    const channels = createChannelCapability(gateway as never);

    const wait = channels.waitWhatsApp();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    channels.dispose();
    pending.resolve({
      message: "stale login",
      connected: true,
      qrDataUrl: "data:image/png;base64,stale-qr",
    });
    await wait;

    expect(channels.state.whatsappLoginMessage).toBeNull();
    expect(channels.state.whatsappLoginQrDataUrl).toBeNull();
    expect(request).toHaveBeenCalledOnce();

    await channels.waitWhatsApp();
    expect(request).toHaveBeenCalledOnce();
  });
});

describe("channel refresh sequencing", () => {
  it("keeps a stale slow probe from replacing a newer runtime snapshot", async () => {
    const slowProbe = createDeferred<ChannelsStatusSnapshot | null>();
    const fastRuntime = createDeferred<ChannelsStatusSnapshot | null>();
    const request = vi.fn(async (_method: string, params?: unknown) =>
      (params as { probe?: boolean } | undefined)?.probe ? slowProbe.promise : fastRuntime.promise,
    );
    const channels = createChannelCapability({
      snapshot: { client: { request }, connected: true },
      subscribe: () => () => undefined,
    } as never);

    const probeLoad = channels.refresh(true, { softTimeoutMs: 1 });
    await probeLoad;
    const runtimeLoad = channels.refresh(false);
    expect(request).toHaveBeenCalledTimes(2);

    fastRuntime.resolve(createChannelsSnapshot("fresh"));
    await runtimeLoad;
    slowProbe.resolve(createChannelsSnapshot("stale"));
    await Promise.resolve();

    expect(channels.state.channelsSnapshot?.channelLabels.test).toBe("fresh");
    expect(channels.state.channelsLoading).toBe(false);
    channels.dispose();
  });

  it("returns after a soft timeout while retaining the in-flight loading state", async () => {
    vi.useFakeTimers();
    try {
      const pending = createDeferred<ChannelsStatusSnapshot | null>();
      const request = vi.fn(() => pending.promise);
      const channels = createChannelCapability({
        snapshot: { client: { request }, connected: true },
        subscribe: () => () => undefined,
      } as never);
      const previous = createChannelsSnapshot("previous");
      channels.state.channelsSnapshot = previous;
      channels.state.channelsLastSuccess = 10;

      const refresh = channels.refresh(true, { softTimeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(100);
      await refresh;

      expect(channels.state.channelsLoading).toBe(true);
      expect(channels.state.channelsSnapshot).toBe(previous);
      pending.resolve(createChannelsSnapshot("next"));
      await vi.waitFor(() => expect(channels.state.channelsLoading).toBe(false));
      expect(channels.state.channelsSnapshot?.channelLabels.test).toBe("next");
      channels.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
