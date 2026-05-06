import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelsStatusSnapshot } from "../types.ts";
import { loadChannels, waitWhatsAppLogin, type ChannelsState } from "./channels.ts";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

describe("channels controller WhatsApp wait", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes the currently displayed QR and replaces it when the login QR rotates", async () => {
    const state = createState();
    const request = vi.mocked(state.client!.request);
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
});

describe("loadChannels", () => {
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
      const request = vi.mocked(state.client!.request);
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
      expect(state.channelsLastSuccess).toEqual(expect.any(Number));
    } finally {
      vi.useRealTimers();
    }
  });
});
