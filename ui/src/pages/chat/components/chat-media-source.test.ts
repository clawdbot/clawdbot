/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatMediaSourceController } from "./chat-media-source.ts";

function mockMediaState(
  media: HTMLMediaElement,
  state: { currentTime: number; duration: number; paused: boolean; ended?: boolean },
) {
  let currentTime = state.currentTime;
  Object.defineProperties(media, {
    currentTime: {
      configurable: true,
      get: () => currentTime,
      set: (value: number) => {
        currentTime = value;
      },
    },
    duration: { configurable: true, get: () => state.duration },
    paused: { configurable: true, get: () => state.paused },
    ended: { configurable: true, get: () => state.ended === true },
  });
  return {
    currentTime: () => currentTime,
    rejectSeek: () => {
      Object.defineProperty(media, "currentTime", {
        configurable: true,
        get: () => currentTime,
        set: () => {
          throw new DOMException("media range unavailable", "InvalidStateError");
        },
      });
    },
    allowSeek: () => {
      Object.defineProperty(media, "currentTime", {
        configurable: true,
        get: () => currentTime,
        set: (value: number) => {
          currentTime = value;
        },
      });
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ChatMediaSourceController", () => {
  it("normalizes and applies native playback immediately", () => {
    const media = document.createElement("audio");
    const controller = new ChatMediaSourceController();

    expect(controller.sync(media, "  /media/native.mp3  ", "  media:native  ", "native")).toBe(
      null,
    );

    expect(controller.readiness).toBe("ready");
    expect(controller.readySource).toBe("/media/native.mp3");
    expect(controller.currentIdentity).toBe("media:native");
    expect(media.getAttribute("src")).toBe("/media/native.mp3");
  });

  it("keeps preparation pending across a 202 and applies the ready rendition", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const media = document.createElement("video");
    const controller = new ChatMediaSourceController();

    const pending = controller.sync(
      media,
      "/media/clip.avi?mediaTicket=ticket",
      "media:clip",
      "transcode",
    );
    expect(controller.readiness).toBe("preparing");
    expect(media.hasAttribute("src")).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    await pending;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(controller.readiness).toBe("ready");
    expect(media.getAttribute("src")).toContain("mediaTicket=ticket&playback=1");
  });

  it("aborts preparation and starts it again after reconnect", async () => {
    let firstSignal: AbortSignal | undefined;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        async (_source, init) =>
          await new Promise<Response>((_resolve, reject) => {
            firstSignal = init?.signal ?? undefined;
            firstSignal?.addEventListener(
              "abort",
              () => reject(new DOMException("disconnected", "AbortError")),
              { once: true },
            );
          }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const media = document.createElement("audio");
    const controller = new ChatMediaSourceController();
    const source = "/media/voice.caf?mediaTicket=ticket";

    const first = controller.sync(media, source, "media:voice", "transcode");
    controller.cancel();
    expect(firstSignal?.aborted).toBe(true);
    expect(controller.readiness).toBe("idle");

    const second = controller.sync(media, source, "media:voice", "transcode");
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(controller.readiness).toBe("ready");
    expect(media.getAttribute("src")).toContain("playback=1");
  });

  it("suppresses a stale completion after the readiness identity changes", async () => {
    let resolveOld: ((response: Response) => void) | undefined;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        async () =>
          await new Promise<Response>((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const media = document.createElement("video");
    const controller = new ChatMediaSourceController();

    const oldRequest = controller.sync(
      media,
      "/media/old.avi?mediaTicket=old",
      "media:old",
      "transcode",
      "old-token",
    );
    const newRequest = controller.sync(
      media,
      "/media/new.avi?mediaTicket=new",
      "media:new",
      "transcode",
      "new-token",
    );
    await newRequest;
    resolveOld?.(new Response(null, { status: 200 }));
    await oldRequest;

    expect(controller.currentIdentity).toBe("media:new");
    expect(media.getAttribute("src")).toContain("mediaTicket=new&playback=1");
  });

  it("keeps a usable same-identity source when a refresh is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response(null, { status: 500 })),
    );
    const media = document.createElement("audio");
    const controller = new ChatMediaSourceController();
    void controller.sync(media, "/media/voice.mp3?mediaTicket=old", "media:voice", "native");
    expect(controller.handleError(media)).toBe(false);
    void controller.sync(media, "/media/voice.mp3?mediaTicket=old", "media:voice", "native");

    const pending = controller.sync(
      media,
      "/media/voice.mp3?mediaTicket=fresh",
      "media:voice",
      "transcode",
    );
    expect(controller.readiness).toBe("ready");
    await pending;

    expect(controller.readiness).toBe("ready");
    expect(controller.readySource).toContain("mediaTicket=old");
    expect(media.getAttribute("src")).toContain("mediaTicket=old");
  });

  it("reports an unavailable rendition when there is no usable fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response(null, { status: 500 })),
    );
    const media = document.createElement("audio");
    const controller = new ChatMediaSourceController();
    void controller.sync(media, "/media/voice.caf?mediaTicket=old", "media:voice", "native");
    expect(controller.handleError(media)).toBe(false);

    await controller.sync(
      media,
      "/media/voice.caf?mediaTicket=refresh",
      "media:voice",
      "transcode",
    );

    expect(controller.readiness).toBe("unavailable");
    expect(controller.readySource).toBe("");
    expect(media.getAttribute("src")).toContain("mediaTicket=old");
  });

  it.each([
    {
      boundary: "authentication",
      source: "/media/protected.caf?mediaTicket=refresh",
      identity: "media:protected",
      authToken: "principal-b",
    },
    {
      boundary: "source identity",
      source: "/media/replacement.caf?mediaTicket=refresh",
      identity: "media:replacement",
      authToken: "principal-a",
    },
  ])("removes the old source when a changed $boundary is unavailable", async (next) => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response(null, { status: 500 })),
    );
    const media = document.createElement("video");
    const controller = new ChatMediaSourceController();
    void controller.sync(
      media,
      "/media/protected.mp4?mediaTicket=old",
      "media:protected",
      "native",
      "principal-a",
    );

    const pending = controller.sync(media, next.source, next.identity, "transcode", next.authToken);
    expect(media.hasAttribute("src")).toBe(false);
    await pending;

    expect(controller.readiness).toBe("unavailable");
    expect(media.hasAttribute("src")).toBe(false);
  });

  it("queues a refreshed ticket while paused mid-stream and restores it after failure", async () => {
    const media = document.createElement("audio");
    const state = { currentTime: 0, duration: 120, paused: true };
    const clock = mockMediaState(media, state);
    const play = vi.spyOn(media, "play").mockResolvedValue(undefined);
    const controller = new ChatMediaSourceController();

    controller.updateSource(media, "/media?mediaTicket=old", "/tmp/audio.mp3");
    expect(media.getAttribute("src")).toBe("/media?mediaTicket=old");

    media.currentTime = 42;
    controller.updateSource(media, "/media?mediaTicket=fresh", "/tmp/audio.mp3");

    expect(media.getAttribute("src")).toBe("/media?mediaTicket=old");

    expect(controller.handleError(media)).toBe(true);
    expect(media.getAttribute("src")).toBe("/media?mediaTicket=fresh");
    media.currentTime = 0;
    controller.handleLoadedMetadata(media);

    expect(clock.currentTime()).toBe(42);
    expect(play).not.toHaveBeenCalled();
  });

  it("preserves playing state when a failed seek applies the fresh ticket", async () => {
    const media = document.createElement("video");
    document.body.append(media);
    const state = { currentTime: 10, duration: 90, paused: false };
    const clock = mockMediaState(media, state);
    const play = vi.spyOn(media, "play").mockResolvedValue(undefined);
    const controller = new ChatMediaSourceController();

    controller.updateSource(media, "/media?mediaTicket=old", "/tmp/video.mp4");
    controller.updateSource(media, "/media?mediaTicket=fresh", "/tmp/video.mp4");
    clock.rejectSeek();

    expect(controller.seek(media, 55)).toBe(true);
    expect(media.getAttribute("src")).toBe("/media?mediaTicket=fresh");
    clock.allowSeek();
    controller.handleLoadedMetadata(media);

    expect(clock.currentTime()).toBe(55);
    expect(play).toHaveBeenCalledOnce();
    media.remove();
  });

  it("applies a queued ticket once playback is idle at the end", () => {
    const media = document.createElement("audio");
    const state = { currentTime: 80, duration: 80, paused: true, ended: false };
    mockMediaState(media, state);
    const controller = new ChatMediaSourceController();

    controller.updateSource(media, "/media?mediaTicket=old", "/tmp/audio.mp3");
    controller.updateSource(media, "/media?mediaTicket=fresh", "/tmp/audio.mp3");
    state.ended = true;

    expect(controller.handleEnded(media)).toBe(true);
    expect(media.getAttribute("src")).toBe("/media?mediaTicket=fresh");
  });

  it("applies a queued Blob before a paused player resumes", () => {
    const media = document.createElement("audio");
    const state = { currentTime: 18, duration: 80, paused: false };
    mockMediaState(media, state);
    const controller = new ChatMediaSourceController();
    controller.updateSource(media, "/media?mediaTicket=old", "/tmp/audio.mp3");
    controller.updateSource(media, "blob:waveform", "/tmp/audio.mp3");
    state.paused = true;

    expect(controller.applyPendingSource(media)).toBe(true);
    expect(media.getAttribute("src")).toBe("blob:waveform");
    expect(controller.currentIdentity).toBe("/tmp/audio.mp3");
  });

  it("resets an applied source across an authentication boundary", () => {
    const media = document.createElement("audio");
    const state = { currentTime: 18, duration: 80, paused: true };
    mockMediaState(media, state);
    const load = vi.spyOn(media, "load").mockImplementation(() => undefined);
    const controller = new ChatMediaSourceController();
    controller.updateSource(media, "blob:protected-audio", "/tmp/audio.mp3");

    controller.reset(media);

    expect(media.hasAttribute("src")).toBe(false);
    expect(load).toHaveBeenCalledOnce();
    expect(controller.currentIdentity).toBe("");
  });

  it("applies a fresh ticket that arrives after the old source has already failed", () => {
    const media = document.createElement("audio");
    const state = { currentTime: 0, duration: 80, paused: true, error: null as MediaError | null };
    const clock = mockMediaState(media, state);
    Object.defineProperty(media, "error", { configurable: true, get: () => state.error });
    const controller = new ChatMediaSourceController();

    controller.updateSource(media, "/media?mediaTicket=old", "/tmp/audio.mp3");
    media.currentTime = 30;
    state.error = { code: 2, message: "ticket expired" } as MediaError;
    controller.updateSource(media, "/media?mediaTicket=fresh", "/tmp/audio.mp3");

    expect(media.getAttribute("src")).toBe("/media?mediaTicket=fresh");
    media.currentTime = 0;
    state.error = null;
    controller.handleLoadedMetadata(media);
    expect(clock.currentTime()).toBe(30);
  });

  it("replaces a different attachment immediately instead of treating it as a ticket refresh", () => {
    const media = document.createElement("audio");
    const state = { currentTime: 20, duration: 80, paused: false };
    mockMediaState(media, state);
    const pause = vi.spyOn(media, "pause").mockImplementation(() => {
      state.paused = true;
    });
    const controller = new ChatMediaSourceController();

    controller.updateSource(media, "/media?mediaTicket=first", "/tmp/first.mp3");
    controller.updateSource(media, "/media?mediaTicket=second", "/tmp/second.mp3");

    expect(pause).toHaveBeenCalledOnce();
    expect(media.getAttribute("src")).toBe("/media?mediaTicket=second");
  });
});
