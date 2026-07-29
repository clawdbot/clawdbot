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

  it("clears authorized video while a new principal is checked", async () => {
    let resolveRefresh: ((response: Response) => void) | undefined;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockImplementationOnce(
        async () =>
          await new Promise<Response>((resolve) => {
            resolveRefresh = resolve;
          }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const player = document.createElement("openclaw-chat-video-player");
    player.src = "/__openclaw__/assistant-media?source=clip.avi&mediaTicket=ticket";
    player.sourceIdentity = "media:principal-clip";
    player.authToken = "principal-one";
    player.label = "clip.avi";
    player.playback = "transcode";
    document.body.append(player);
    await vi.waitFor(() =>
      expect(player.querySelector("video")?.getAttribute("src")).toContain("playback=1"),
    );

    player.authToken = "principal-two";
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(player.textContent).toContain("Preparing playback…"));
    expect(player.querySelector("video")?.hasAttribute("src")).toBe(false);
    resolveRefresh?.(new Response(null, { status: 500 }));
  });

  it("clears a failed rendition after reconnect succeeds", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const player = document.createElement("openclaw-chat-video-player");
    player.src = "/__openclaw__/assistant-media?source=clip.avi&mediaTicket=ticket";
    player.sourceIdentity = "media:retry-clip";
    player.label = "clip.avi";
    player.playback = "transcode";
    document.body.append(player);
    await vi.waitFor(() =>
      expect(
        player
          .querySelector(".chat-assistant-attachment-card--video")
          ?.hasAttribute("data-unplayable"),
      ).toBe(true),
    );

    player.remove();
    document.body.append(player);
    await vi.waitFor(() =>
      expect(player.querySelector("video")?.getAttribute("src")).toContain("playback=1"),
    );
    expect(
      player
        .querySelector(".chat-assistant-attachment-card--video")
        ?.hasAttribute("data-unplayable"),
    ).toBe(false);
  });
});
