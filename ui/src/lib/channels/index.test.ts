// Channels domain tests.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelsStatusSnapshot } from "../../api/types.ts";
import {
  createChannelCapability,
  loadChannels,
  waitWhatsAppLogin,
  type ChannelsState,
} from "./index.ts";

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

function createState(): ChannelsState {
  return {
    client: {
      request: vi.fn(),
    } as never,
    connected: true,
    channelsLoading: false,
    channelsSnapshot: null,
    channelsError: null,
    channelsLastSuccess: null,
    whatsappLoginMessage: null,
    whatsappLoginQrDataUrl: "data:image/png;base64,current-qr",
    whatsappLoginConnected: false,
    whatsappBusy: false,
  };
}

function requireClientRequest(state: ChannelsState) {
  const request = state.client?.["request"];
  if (!request) {
    throw new Error("Expected channels controller client request");
  }
  return vi.mocked(request);
}

describe("channels controller WhatsApp wait", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes the currently displayed QR and replaces it when the login QR rotates", async () => {
    const state = createState();
    const request = requireClientRequest(state);
    request.mockResolvedValueOnce({
      connected: false,
      message: "QR refreshed. Scan the latest code in WhatsApp → Linked Devices.",
      qrDataUrl: "data:image/png;base64,next-qr",
    });

    await waitWhatsAppLogin(state);

    expect(request).toHaveBeenCalledWith("web.login.wait", {
      timeoutMs: 120000,
      currentQrDataUrl: "data:image/png;base64,current-qr",
    });
    expect(state.whatsappLoginMessage).toBe(
      "QR refreshed. Scan the latest code in WhatsApp → Linked Devices.",
    );
    expect(state.whatsappLoginConnected).toBe(false);
    expect(state.whatsappLoginQrDataUrl).toBe("data:image/png;base64,next-qr");
    expect(state.whatsappBusy).toBe(false);
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

describe("loadChannels", () => {
  it("keeps a stale slow probe from replacing a newer non-probe snapshot", async () => {
    const state = createState();
    const request = vi.mocked(state.client!["request"]);
    const slowProbe = createDeferred<ChannelsStatusSnapshot | null>();
    const fastRuntime = createDeferred<ChannelsStatusSnapshot | null>();
    request.mockImplementation(async (_method: string, params?: unknown) => {
      if ((params as { probe?: boolean } | undefined)?.probe) {
        return slowProbe.promise;
      }
      return fastRuntime.promise;
    });

    const probeLoad = loadChannels(state, true, { softTimeoutMs: 1 });
    await probeLoad;
    const runtimeLoad = loadChannels(state, false);
    expect(request).toHaveBeenCalledTimes(2);

    fastRuntime.resolve(createChannelsSnapshot("fresh"));
    await runtimeLoad;
    expect(state.channelsSnapshot?.channelLabels.test).toBe("fresh");

    slowProbe.resolve(createChannelsSnapshot("stale"));
    await Promise.resolve();

    expect(state.channelsSnapshot?.channelLabels.test).toBe("fresh");
    expect(state.channelsLoading).toBe(false);
  });

  it("returns after a soft timeout while preserving the stale snapshot", async () => {
    vi.useFakeTimers();
    try {
      const state = createState();
      const previous: ChannelsStatusSnapshot = {
        ts: 1,
        channelOrder: ["nostr"],
        channelLabels: { nostr: "Nostr" },
        channels: {},
        channelAccounts: {},
        channelDefaultAccountId: {},
      };
      const next: ChannelsStatusSnapshot = {
        ...previous,
        ts: 2,
      };
      const deferred = createDeferred<ChannelsStatusSnapshot | null>();
      const request = requireClientRequest(state);
      request.mockReturnValueOnce(deferred.promise);
      state.channelsSnapshot = previous;
      state.channelsLastSuccess = 10;

      const load = loadChannels(state, true, { softTimeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(100);
      await load;

      expect(state.channelsLoading).toBe(true);
      expect(state.channelsSnapshot).toBe(previous);
      expect(state.channelsLastSuccess).toBe(10);

      deferred.resolve(next);
      await Promise.resolve();
      await Promise.resolve();

      expect(state.channelsLoading).toBe(false);
      expect(state.channelsSnapshot).toBe(next);
      expect(state.channelsLastSuccess).toBeGreaterThan(10);
    } finally {
      vi.useRealTimers();
    }
  });
});
