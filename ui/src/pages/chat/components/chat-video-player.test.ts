/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import "./chat-video-player.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ChatVideoPlayer", () => {
  it("starts metadata loading only when the video card reaches the viewport", async () => {
    let intersect: IntersectionObserverCallback | undefined;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersect = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    const player = document.createElement("openclaw-chat-video-player");
    player.src = "https://example.com/clip.mp4";
    player.sourceIdentity = "media:clip-metadata";
    player.label = "clip.mp4";
    document.body.append(player);
    await player.updateComplete;

    const video = player.querySelector("video");
    expect(video?.preload).toBe("metadata");
    expect(video?.hasAttribute("src")).toBe(false);

    intersect?.(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
    await player.updateComplete;

    expect(video?.getAttribute("src")).toBe("https://example.com/clip.mp4");
  });

  it("preserves a portrait attachment aspect ratio", async () => {
    const player = document.createElement("openclaw-chat-video-player");
    player.src = "https://example.com/portrait.mp4";
    player.sourceIdentity = "media:portrait";
    player.label = "portrait.mp4";
    player.mediaWidth = 9;
    player.mediaHeight = 16;
    document.body.append(player);
    await player.updateComplete;

    expect(player.querySelector("video")?.style.aspectRatio).toBe("9 / 16");
  });

  it("applies a renewed ticket when playback resumes", async () => {
    const player = document.createElement("openclaw-chat-video-player");
    player.src = "/media/clip.mp4?mediaTicket=A";
    player.sourceIdentity = "media:renewing-clip";
    player.label = "clip.mp4";
    document.body.append(player);
    await player.updateComplete;
    const video = player.querySelector("video")!;
    let paused = true;
    let currentTime = 12;
    const play = vi.spyOn(video, "play").mockImplementation(async () => {
      paused = false;
    });
    Object.defineProperties(video, {
      currentTime: {
        configurable: true,
        get: () => currentTime,
        set: (value: number) => {
          currentTime = value;
        },
      },
      paused: { configurable: true, get: () => paused },
    });

    player.src = "/media/clip.mp4?mediaTicket=B";
    await player.updateComplete;
    expect(video.getAttribute("src")).toContain("mediaTicket=A");

    paused = false;
    video.dispatchEvent(new Event("play"));

    expect(video.getAttribute("src")).toContain("mediaTicket=B");
    video.dispatchEvent(new Event("loadedmetadata"));
    expect(play).toHaveBeenCalledOnce();
  });

  it("keeps one video element mounted across 202 preparation", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const player = document.createElement("openclaw-chat-video-player");
    player.src = "/__openclaw__/assistant-media?source=clip.avi&mediaTicket=ticket";
    player.sourceIdentity = "media:clip";
    player.label = "clip.avi";
    player.playback = "transcode";
    document.body.append(player);
    await player.updateComplete;
    const video = player.querySelector("video");
    await vi.waitFor(() => expect(player.textContent).toContain("Preparing playback…"));
    expect(player.querySelector("video")).toBe(video);

    await vi.advanceTimersByTimeAsync(2_000);
    await player.updateComplete;

    expect(player.querySelector("video")).toBe(video);
    expect(video?.getAttribute("src")).toContain("mediaTicket=ticket&playback=1");
  });

  it("does not preserve a previous attachment when a new rendition fails", async () => {
    const player = document.createElement("openclaw-chat-video-player");
    player.src = "https://example.com/first.mp4";
    player.sourceIdentity = "media:first";
    player.label = "first.mp4";
    document.body.append(player);
    await player.updateComplete;
    expect(player.querySelector("video")?.getAttribute("src")).toBe(
      "https://example.com/first.mp4",
    );

    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    player.src = "/__openclaw__/assistant-media?source=second.caf&mediaTicket=ticket";
    player.sourceIdentity = "media:second";
    player.label = "second.caf";
    player.playback = "transcode";
    await player.updateComplete;
    expect(player.querySelector("video")?.hasAttribute("src")).toBe(false);
    await vi.waitFor(() =>
      expect(player.querySelector(".chat-assistant-attachment-card--compact")).not.toBeNull(),
    );
    expect(player.querySelector(".chat-assistant-attachment-card__reason")).toBeNull();
    expect(player.querySelector("video")).toBeNull();

    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    player.src = "/__openclaw__/assistant-media?source=second.caf&mediaTicket=recovered";
    await player.updateComplete;
    await vi.waitFor(() =>
      expect(player.querySelector("video")?.getAttribute("src")).toContain(
        "mediaTicket=recovered&playback=1",
      ),
    );
    expect(player.querySelector(".chat-assistant-attachment-card--compact")).toBeNull();
  });

  it("hides a previous attachment while the replacement HEAD is stalled", async () => {
    const player = document.createElement("openclaw-chat-video-player");
    player.src = "https://example.com/first.mp4";
    player.sourceIdentity = "media:first-stalled";
    player.label = "first.mp4";
    document.body.append(player);
    await player.updateComplete;

    const fetchMock = vi.fn<typeof fetch>(async () => await new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    player.src = "/__openclaw__/assistant-media?source=second.caf&mediaTicket=ticket";
    player.sourceIdentity = "media:second-stalled";
    player.label = "second.caf";
    player.playback = "transcode";
    await player.updateComplete;

    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(player.textContent).toContain("Preparing playback…"));
    expect(player.querySelector("video")?.hasAttribute("src")).toBe(false);
  });

  it("pauses and clears the source when disconnected while playing", async () => {
    const player = document.createElement("openclaw-chat-video-player");
    player.src = "https://example.com/playing.mp4";
    player.sourceIdentity = "media:playing";
    player.label = "playing.mp4";
    document.body.append(player);
    await player.updateComplete;
    const video = player.querySelector("video")!;
    let paused = false;
    Object.defineProperty(video, "paused", { configurable: true, get: () => paused });
    const pause = vi.spyOn(video, "pause").mockImplementation(() => {
      paused = true;
    });

    player.remove();

    expect(pause).toHaveBeenCalledOnce();
    expect(paused).toBe(true);
    expect(video.hasAttribute("src")).toBe(false);

    document.body.append(player);
    await vi.waitFor(() =>
      expect(video.getAttribute("src")).toBe("https://example.com/playing.mp4"),
    );
  });
});
