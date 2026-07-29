/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import "./chat-audio-player.ts";

type ChatAudioPlayer = HTMLElementTagNameMap["openclaw-chat-audio-player"];

function setMediaNumber(
  media: HTMLMediaElement,
  property: "currentTime" | "duration",
  value: number,
) {
  Object.defineProperty(media, property, { configurable: true, writable: true, value });
}

async function createPlayer(label: string): Promise<ChatAudioPlayer> {
  const player = document.createElement("openclaw-chat-audio-player");
  player.src = `https://example.com/${label}.mp3`;
  player.sourceIdentity = `media://${label}`;
  player.label = `${label}.mp3`;
  document.body.append(player);
  await player.updateComplete;
  return player;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("ChatAudioPlayer", () => {
  it("formats elapsed and total media time", async () => {
    const player = await createPlayer("timing");
    expect(
      Array.from(player.querySelectorAll(".chat-audio-player__time span"), (item) =>
        item.textContent?.trim(),
      ),
    ).toEqual(["0:00", "0:00"]);

    const media = player.querySelector("audio")!;
    setMediaNumber(media, "currentTime", 65.9);
    setMediaNumber(media, "duration", 3_665);
    media.dispatchEvent(new Event("loadedmetadata"));
    await player.updateComplete;

    expect(
      Array.from(player.querySelectorAll(".chat-audio-player__time span"), (item) =>
        item.textContent?.trim(),
      ),
    ).toEqual(["1:05", "61:05"]);
  });

  it("drives play, pause, seek, and keyboard state through the hidden audio element", async () => {
    const player = await createPlayer("briefing");
    const media = player.querySelector("audio")!;
    let paused = true;
    Object.defineProperty(media, "paused", { configurable: true, get: () => paused });
    setMediaNumber(media, "duration", 125);
    setMediaNumber(media, "currentTime", 0);
    const play = vi.spyOn(media, "play").mockImplementation(async () => {
      paused = false;
      media.dispatchEvent(new Event("play"));
    });
    const pause = vi.spyOn(media, "pause").mockImplementation(() => {
      paused = true;
      media.dispatchEvent(new Event("pause"));
    });

    media.dispatchEvent(new Event("loadedmetadata"));
    await player.updateComplete;
    expect(player.querySelector(".chat-audio-player__time")?.textContent).toContain("2:05");

    player.querySelector<HTMLButtonElement>(".chat-audio-player__toggle")!.click();
    await player.updateComplete;
    expect(play).toHaveBeenCalledOnce();
    expect(player.querySelector(".chat-audio-player__toggle")?.getAttribute("aria-label")).toBe(
      "Pause",
    );
    expect(
      player
        .querySelector<HTMLAnchorElement>(".chat-assistant-attachment-card__download")
        ?.getAttribute("download"),
    ).toBe("briefing.mp3");

    const seek = player.querySelector<HTMLInputElement>(".chat-audio-player__seek")!;
    seek.value = "35";
    seek.dispatchEvent(new Event("input", { bubbles: true }));
    expect(media.currentTime).toBe(35);

    const controls = player.querySelector<HTMLElement>(".chat-audio-player")!;
    controls.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(media.currentTime).toBe(40);
    controls.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(pause).toHaveBeenCalledOnce();
  });

  it("pauses the previous player when another chat audio starts", async () => {
    const first = await createPlayer("first");
    const second = await createPlayer("second");
    const firstMedia = first.querySelector("audio")!;
    const secondMedia = second.querySelector("audio")!;
    const pauseFirst = vi.spyOn(firstMedia, "pause").mockImplementation(() => undefined);

    firstMedia.dispatchEvent(new Event("play"));
    secondMedia.dispatchEvent(new Event("play"));

    expect(pauseFirst).toHaveBeenCalledOnce();
  });

  it("pauses active audio when its message leaves the page", async () => {
    const player = await createPlayer("detached");
    const media = player.querySelector("audio")!;
    Object.defineProperty(media, "paused", { configurable: true, value: false });
    const pause = vi.spyOn(media, "pause").mockImplementation(() => undefined);

    player.remove();

    expect(pause).toHaveBeenCalledOnce();
  });

  it("releases playback and shows the fallback after an unrecovered media error", async () => {
    const first = await createPlayer("broken");
    const firstMedia = first.querySelector("audio")!;
    let paused = true;
    Object.defineProperty(firstMedia, "paused", { configurable: true, get: () => paused });
    const play = vi.spyOn(firstMedia, "play").mockImplementation(async () => {
      paused = false;
      firstMedia.dispatchEvent(new Event("play"));
    });
    const pauseFirst = vi.spyOn(firstMedia, "pause").mockImplementation(() => {
      paused = true;
    });

    first.querySelector<HTMLButtonElement>(".chat-audio-player__toggle")!.click();
    await first.updateComplete;
    expect(play).toHaveBeenCalledOnce();
    expect((first as unknown as { playing: boolean }).playing).toBe(true);

    firstMedia.dispatchEvent(new Event("error"));
    await first.updateComplete;
    expect((first as unknown as { playing: boolean }).playing).toBe(false);
    expect(first.querySelector(".chat-assistant-attachment-card__reason")?.textContent).toContain(
      "Can't play this format — download instead.",
    );
    expect(
      first
        .querySelector<HTMLAnchorElement>(".chat-assistant-attachment-card__reason a")
        ?.getAttribute("download"),
    ).toBe("broken.mp3");

    const second = await createPlayer("working");
    second.querySelector("audio")!.dispatchEvent(new Event("play"));
    expect(pauseFirst).not.toHaveBeenCalled();
  });

  it("does not auto-resume a refreshed source after disconnecting before metadata", async () => {
    const player = await createPlayer("disconnect-resume");
    const media = player.querySelector("audio")!;
    let paused = false;
    Object.defineProperty(media, "paused", { configurable: true, get: () => paused });
    setMediaNumber(media, "currentTime", 20);
    setMediaNumber(media, "duration", 80);
    const play = vi.spyOn(media, "play").mockResolvedValue(undefined);
    vi.spyOn(media, "pause").mockImplementation(() => {
      paused = true;
    });

    player.src = "https://example.com/disconnect-resume-fresh.mp3";
    await player.updateComplete;
    media.dispatchEvent(new Event("error"));
    player.remove();
    document.body.append(player);
    media.currentTime = 0;
    media.dispatchEvent(new Event("loadedmetadata"));

    expect(play).not.toHaveBeenCalled();
  });

  it("does not auto-resume after another player supersedes the pending restore", async () => {
    const first = await createPlayer("superseded-resume");
    const firstMedia = first.querySelector("audio")!;
    let paused = false;
    Object.defineProperty(firstMedia, "paused", { configurable: true, get: () => paused });
    setMediaNumber(firstMedia, "currentTime", 20);
    setMediaNumber(firstMedia, "duration", 80);
    const playFirst = vi.spyOn(firstMedia, "play").mockResolvedValue(undefined);
    vi.spyOn(firstMedia, "pause").mockImplementation(() => {
      paused = true;
    });
    firstMedia.dispatchEvent(new Event("play"));

    first.src = "https://example.com/superseded-resume-fresh.mp3";
    await first.updateComplete;
    firstMedia.dispatchEvent(new Event("error"));

    const second = await createPlayer("superseding-player");
    second.querySelector("audio")!.dispatchEvent(new Event("play"));
    second.remove();
    firstMedia.currentTime = 0;
    firstMedia.dispatchEvent(new Event("loadedmetadata"));

    expect(playFirst).not.toHaveBeenCalled();
  });
});
