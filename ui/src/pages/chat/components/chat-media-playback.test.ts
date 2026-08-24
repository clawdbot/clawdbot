import { describe, expect, it, vi } from "vitest";
import { appendChatMediaPlaybackParam, waitForChatMediaPlayback } from "./chat-media-playback.ts";

const EXPECTED_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 20_000];

describe("chat media playback renditions", () => {
  it("appends playback=1 without dropping assistant or managed media tickets", () => {
    expect(
      appendChatMediaPlaybackParam(
        "/__openclaw__/assistant-media?source=%2Ftmp%2Fvoice.caf&mediaTicket=assistant",
      ),
    ).toBe(
      "/__openclaw__/assistant-media?source=%2Ftmp%2Fvoice.caf&mediaTicket=assistant&playback=1",
    );
    expect(
      appendChatMediaPlaybackParam(
        "/api/chat/media/outgoing/agent%3Amain%3Amain/audio/full?mediaTicket=managed",
      ),
    ).toBe(
      "/api/chat/media/outgoing/agent%3Amain%3Amain/audio/full?mediaTicket=managed&playback=1",
    );
    expect(appendChatMediaPlaybackParam("media/clip.avi?mediaTicket=relative#preview")).toBe(
      "media/clip.avi?mediaTicket=relative&playback=1#preview",
    );
    expect(appendChatMediaPlaybackParam("//cdn.example/clip.avi?mediaTicket=cdn")).toBe(
      "//cdn.example/clip.avi?mediaTicket=cdn&playback=1",
    );
  });

  it("reports preparing and retries until the rendition is ready", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const waitImpl = vi.fn<(delayMs: number, signal: AbortSignal) => Promise<void>>(
      async () => undefined,
    );
    const onPreparing = vi.fn();

    await expect(
      waitForChatMediaPlayback({
        source: "/media?playback=1",
        authToken: "secret-token",
        signal: new AbortController().signal,
        fetchImpl,
        waitImpl,
        onPreparing,
      }),
    ).resolves.toBe("ready");

    expect(onPreparing).toHaveBeenCalledTimes(2);
    expect(waitImpl.mock.calls.map(([delay]) => delay)).toEqual([2_000, 4_000]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const firstRequest = fetchImpl.mock.calls[0];
    expect(firstRequest?.[0]).toBe("/media?playback=1");
    expect(firstRequest?.[1]?.method).toBe("HEAD");
    expect(new Headers(firstRequest?.[1]?.headers).get("Authorization")).toBe(
      "Bearer secret-token",
    );
  });

  it("stops after the bounded two-minute retry schedule", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
    const waitImpl = vi.fn<(delayMs: number, signal: AbortSignal) => Promise<void>>(
      async () => undefined,
    );

    await expect(
      waitForChatMediaPlayback({
        source: "/media?playback=1",
        signal: new AbortController().signal,
        fetchImpl,
        waitImpl,
      }),
    ).resolves.toBe("unavailable");

    expect(waitImpl.mock.calls.map(([delay]) => delay)).toEqual(EXPECTED_RETRY_DELAYS_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(EXPECTED_RETRY_DELAYS_MS.length + 1);
    expect(EXPECTED_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0)).toBe(110_000);
  });

  it("performs a definitive final HEAD after the last backoff", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn<typeof fetch>();
      for (let attempt = 0; attempt < 7; attempt += 1) {
        fetchImpl.mockResolvedValueOnce(new Response(null, { status: 202 }));
      }
      fetchImpl.mockResolvedValueOnce(new Response(null, { status: 200 }));
      const pending = waitForChatMediaPlayback({
        source: "/media?playback=1",
        signal: new AbortController().signal,
        fetchImpl,
      });

      await vi.runAllTimersAsync();
      await expect(pending).resolves.toBe("ready");
      expect(fetchImpl).toHaveBeenCalledTimes(8);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails a stalled readiness request at its request deadline", async () => {
    vi.useFakeTimers();
    try {
      const pending = waitForChatMediaPlayback({
        source: "/media?playback=1",
        signal: new AbortController().signal,
        requestTimeoutMs: 10,
        fetchImpl: vi.fn<typeof fetch>(async () => await new Promise<Response>(() => {})),
      });
      await vi.advanceTimersByTimeAsync(10);
      await expect(pending).resolves.toBe("unavailable");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clamps a retry sleep to the remaining overall deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    try {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockImplementationOnce(async () => {
          vi.setSystemTime(new Date(119_000));
          return new Response(null, { status: 202 });
        })
        .mockResolvedValueOnce(new Response(null, { status: 500 }));
      const waitImpl = vi.fn<(delayMs: number, signal: AbortSignal) => Promise<void>>(
        async () => undefined,
      );

      await expect(
        waitForChatMediaPlayback({
          source: "/media?playback=1",
          signal: new AbortController().signal,
          fetchImpl,
          waitImpl,
        }),
      ).resolves.toBe("unavailable");
      expect(waitImpl).toHaveBeenCalledWith(1_000, expect.any(AbortSignal));
    } finally {
      vi.useRealTimers();
    }
  });
});
