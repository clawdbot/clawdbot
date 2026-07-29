/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
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

describe("ChatMediaSourceController", () => {
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
    expect(controller.queuedSource).toBe("/media?mediaTicket=fresh");

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
    expect(controller.currentSource).toBe("");
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
    expect(controller.queuedSource).toBe("");
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
    expect(controller.queuedSource).toBe("");
  });
});
