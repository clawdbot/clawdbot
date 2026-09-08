import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendChatMediaPlaybackParam, waitForChatMediaPlayback } from "./chat-media-playback.ts";

const EXPECTED_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 20_000];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(0));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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

  it("retries at the default delays until the rendition is ready", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = waitForChatMediaPlayback({
      source: "/media?playback=1",
      authToken: "secret-token",
      signal: new AbortController().signal,
    });

    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe("ready");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const firstRequest = fetchMock.mock.calls[0];
    expect(firstRequest?.[0]).toBe("/media?playback=1");
    expect(firstRequest?.[1]?.method).toBe("HEAD");
    expect(new Headers(firstRequest?.[1]?.headers).get("Authorization")).toBe(
      "Bearer secret-token",
    );
  });

  it("stops after the bounded two-minute retry schedule", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = waitForChatMediaPlayback({
      source: "/media?playback=1",
      signal: new AbortController().signal,
    });

    for (const [attempt, delay] of EXPECTED_RETRY_DELAYS_MS.entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(fetchMock).toHaveBeenCalledTimes(attempt + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(attempt + 2);
    }
    await expect(pending).resolves.toBe("unavailable");
    expect(Date.now()).toBe(110_000);
  });

  it("performs a definitive final HEAD after the last backoff", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    for (let attempt = 0; attempt < 7; attempt += 1) {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 202 }));
    }
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = waitForChatMediaPlayback({
      source: "/media?playback=1",
      signal: new AbortController().signal,
    });

    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe("ready");
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it("fails a stalled readiness request at its request deadline", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => await new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const pending = waitForChatMediaPlayback({
      source: "/media?playback=1",
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(pending).resolves.toBe("unavailable");
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("clamps a retry sleep to the remaining overall deadline", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      vi.setSystemTime(new Date(119_000));
      return new Response(null, { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const pending = waitForChatMediaPlayback({
      source: "/media?playback=1",
      signal: new AbortController().signal,
    });
    let settled = false;
    void pending.then(() => (settled = true));

    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe("unavailable");
    expect(Date.now()).toBe(120_000);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
