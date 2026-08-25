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
  it("limits passive video loading to metadata", async () => {
    const player = document.createElement("openclaw-chat-video-player");
    player.src = "https://example.com/clip.mp4";
    player.sourceIdentity = "media:clip-metadata";
    player.label = "clip.mp4";
    document.body.append(player);
    await player.updateComplete;

    expect(player.querySelector("video")?.preload).toBe("metadata");
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

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response(null, { status: 500 })),
    );
    player.src = "/__openclaw__/assistant-media?source=second.caf&mediaTicket=ticket";
    player.sourceIdentity = "media:second";
    player.label = "second.caf";
    player.playback = "transcode";
    await player.updateComplete;
    expect(player.querySelector("video")?.hasAttribute("src")).toBe(false);
    await vi.waitFor(() =>
      expect(
        player
          .querySelector(".chat-assistant-attachment-card--video")
          ?.hasAttribute("data-unplayable"),
      ).toBe(true),
    );

    expect(player.querySelector(".chat-assistant-video-fallback")?.textContent).toContain(
      "Can't play this format — download instead.",
    );
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
