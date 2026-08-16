/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import "./chat-audio-player.ts";
import { CHAT_AUDIO_WAVEFORM_MAX_BYTES } from "./chat-audio-waveform.ts";

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
  vi.useRealTimers();
  vi.unstubAllGlobals();
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
    await vi.waitFor(() => expect(play).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(player.querySelector(".chat-audio-player__toggle")?.getAttribute("aria-label")).toBe(
        "Pause",
      ),
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

  it("shows preparing, retries a 202 rendition, and then plays", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const player = document.createElement("openclaw-chat-audio-player");
    player.src = "/__openclaw__/assistant-media?source=voice.caf&mediaTicket=ticket";
    player.sourceIdentity = "/tmp/voice.caf";
    player.label = "voice.caf";
    player.playback = "transcode";
    document.body.append(player);
    await player.updateComplete;
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await player.updateComplete;

    expect(player.textContent).toContain("Preparing playback…");
    await vi.advanceTimersByTimeAsync(2_000);
    await player.updateComplete;

    const media = player.querySelector("audio")!;
    let paused = true;
    Object.defineProperty(media, "paused", { configurable: true, get: () => paused });
    const play = vi.spyOn(media, "play").mockImplementation(async () => {
      paused = false;
      media.dispatchEvent(new Event("play"));
    });
    expect(media.getAttribute("src")).toContain("mediaTicket=ticket&playback=1");
    player.querySelector<HTMLButtonElement>(".chat-audio-player__toggle")!.click();
    await vi.advanceTimersByTimeAsync(0);
    await player.updateComplete;
    expect(play).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to download after rendition retries are exhausted", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response(null, { status: 202 })),
    );
    const player = document.createElement("openclaw-chat-audio-player");
    player.src = "/__openclaw__/assistant-media?source=voice.caf&mediaTicket=ticket";
    player.sourceIdentity = "/tmp/voice.caf";
    player.label = "voice.caf";
    player.playback = "transcode";
    document.body.append(player);
    await player.updateComplete;
    await vi.runAllTimersAsync();
    await player.updateComplete;

    expect(player.querySelector(".chat-assistant-attachment-card__reason")?.textContent).toContain(
      "Can't play this format — download instead.",
    );
    expect(
      player
        .querySelector<HTMLAnchorElement>(".chat-assistant-attachment-card__reason a")
        ?.getAttribute("href"),
    ).not.toContain("playback=1");
  });

  it("reuses the waveform fetch as the audio element Blob source", async () => {
    const samples = new Float32Array([0, 0.5, -1, 0.25]);
    const decodeAudioData = vi.fn(async () => ({
      duration: 4,
      length: samples.length,
      numberOfChannels: 1,
      getChannelData: () => samples,
    }));
    const close = vi.fn(async () => undefined);
    vi.stubGlobal(
      "AudioContext",
      class {
        decodeAudioData = decodeAudioData;
        close = close;
      },
    );
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        await new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:waveform-audio");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const player = await createPlayer("waveform-reuse");
    player.serverDurationMs = 4_000;
    const media = player.querySelector("audio")!;
    let paused = true;
    Object.defineProperty(media, "paused", { configurable: true, get: () => paused });
    const play = vi.spyOn(media, "play").mockImplementation(async () => {
      paused = false;
      media.dispatchEvent(new Event("play"));
    });
    vi.spyOn(media, "pause").mockImplementation(() => {
      paused = true;
      media.dispatchEvent(new Event("pause"));
    });

    player.querySelector<HTMLButtonElement>(".chat-audio-player__toggle")!.click();
    expect(play).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    resolveFetch?.(
      new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { "Content-Type": "audio/mpeg", "Content-Length": "4" },
      }),
    );
    await vi.waitFor(() =>
      expect(player.querySelectorAll(".chat-audio-player__waveform rect")).toHaveLength(96),
    );
    await player.updateComplete;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(decodeAudioData).toHaveBeenCalledOnce();
    expect(media.getAttribute("src")).toBe("https://example.com/waveform-reuse.mp3");

    media.pause();
    player.querySelector<HTMLButtonElement>(".chat-audio-player__toggle")!.click();
    await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(2));
    expect(media.getAttribute("src")).toBe("blob:waveform-audio");
    expect(fetchMock).toHaveBeenCalledOnce();

    player.authToken = "new-principal";
    await player.updateComplete;
    expect(media.getAttribute("src")).toBe("https://example.com/waveform-reuse.mp3");

    player.remove();
    const refreshed = document.createElement("openclaw-chat-audio-player");
    refreshed.src = "https://example.com/waveform-reuse.mp3?mediaTicket=fresh";
    refreshed.sourceIdentity = "media://waveform-reuse";
    refreshed.authToken = "different-principal";
    refreshed.label = "waveform-reuse.mp3";
    refreshed.serverDurationMs = 4_000;
    document.body.append(refreshed);
    await refreshed.updateComplete;
    const refreshedMedia = refreshed.querySelector("audio")!;
    Object.defineProperty(refreshedMedia, "paused", { configurable: true, value: true });
    vi.spyOn(refreshedMedia, "play").mockResolvedValue(undefined);
    refreshed.querySelector<HTMLButtonElement>(".chat-audio-player__toggle")!.click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    resolveFetch?.(new Response(null, { status: 500 }));
  });

  it("skips waveform work without a server-probed duration", async () => {
    const decodeAudioData = vi.fn();
    vi.stubGlobal(
      "AudioContext",
      class {
        decodeAudioData = decodeAudioData;
        close = vi.fn(async () => undefined);
      },
    );
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const player = await createPlayer("unknown-duration");
    const media = player.querySelector("audio")!;
    Object.defineProperty(media, "paused", { configurable: true, value: true });
    vi.spyOn(media, "play").mockResolvedValue(undefined);

    player.querySelector<HTMLButtonElement>(".chat-audio-player__toggle")!.click();
    await vi.waitFor(() =>
      expect((player as unknown as { playRequest: unknown }).playRequest).toBeNull(),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(decodeAudioData).not.toHaveBeenCalled();
    expect(player.querySelector(".chat-audio-player__waveform")).toBeNull();
  });

  it("discards waveform peaks when decoded duration exceeds the server gate by 20 percent", async () => {
    const samples = new Float32Array([0, 0.5, -1, 0.25]);
    const decodeAudioData = vi.fn(async () => ({
      duration: 121,
      length: samples.length,
      numberOfChannels: 1,
      getChannelData: () => samples,
    }));
    const AudioContextMock = vi.fn(function (options?: AudioContextOptions) {
      expect(options?.sampleRate).toBe(16_000);
      return { decodeAudioData, close: vi.fn(async () => undefined) };
    });
    vi.stubGlobal("AudioContext", AudioContextMock);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () =>
          new Response(new Uint8Array([1, 2, 3, 4]), {
            status: 200,
            headers: { "Content-Type": "audio/mpeg", "Content-Length": "4" },
          }),
      ),
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:duration-mismatch");
    const player = await createPlayer("duration-mismatch");
    player.serverDurationMs = 100_000;
    const media = player.querySelector("audio")!;
    Object.defineProperty(media, "paused", { configurable: true, value: true });
    setMediaNumber(media, "duration", 100);
    media.dispatchEvent(new Event("loadedmetadata"));
    await player.updateComplete;
    vi.spyOn(media, "play").mockResolvedValue(undefined);

    player.querySelector<HTMLButtonElement>(".chat-audio-player__toggle")!.click();
    await vi.waitFor(() =>
      expect((player as unknown as { playRequest: unknown }).playRequest).toBeNull(),
    );

    expect(decodeAudioData).toHaveBeenCalledOnce();
    expect(player.querySelector(".chat-audio-player__waveform")).toBeNull();
    expect(
      Array.from(player.querySelectorAll(".chat-audio-player__time span"), (item) =>
        item.textContent?.trim(),
      ),
    ).toEqual(["0:00", "1:40"]);
  });

  it("does not buffer or cache a chunked waveform response above 8 MiB", async () => {
    const decodeAudioData = vi.fn();
    vi.stubGlobal(
      "AudioContext",
      class {
        decodeAudioData = decodeAudioData;
        close = vi.fn(async () => undefined);
      },
    );
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(CHAT_AUDIO_WAVEFORM_MAX_BYTES + 1));
              controller.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "audio/mpeg" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const createObjectURL = vi.spyOn(URL, "createObjectURL");
    const player = await createPlayer("oversized-waveform");
    player.serverDurationMs = 4_000;
    const media = player.querySelector("audio")!;
    Object.defineProperty(media, "paused", { configurable: true, value: true });
    const play = vi.spyOn(media, "play").mockResolvedValue(undefined);

    player.querySelector<HTMLButtonElement>(".chat-audio-player__toggle")!.click();
    expect(play).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect((player as unknown as { playRequest: unknown }).playRequest).toBeNull(),
    );

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(decodeAudioData).not.toHaveBeenCalled();
    expect(player.querySelector(".chat-audio-player__waveform")).toBeNull();
    expect(media.getAttribute("src")).toBe("https://example.com/oversized-waveform.mp3");
  });

  it("transfers Blob ownership when AudioContext construction fails", async () => {
    const FailingAudioContext = vi.fn(function () {
      throw new Error("audio context limit reached");
    });
    vi.stubGlobal("AudioContext", FailingAudioContext);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () =>
          new Response(new Uint8Array([1, 2, 3, 4]), {
            status: 200,
            headers: { "Content-Type": "audio/mpeg", "Content-Length": "4" },
          }),
      ),
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:context-fallback");
    const player = await createPlayer("context-fallback");
    player.serverDurationMs = 4_000;
    const media = player.querySelector("audio")!;
    let paused = true;
    Object.defineProperty(media, "paused", { configurable: true, get: () => paused });
    const play = vi.spyOn(media, "play").mockImplementation(async () => {
      paused = false;
      media.dispatchEvent(new Event("play"));
    });
    vi.spyOn(media, "pause").mockImplementation(() => {
      paused = true;
      media.dispatchEvent(new Event("pause"));
    });

    player.querySelector<HTMLButtonElement>(".chat-audio-player__toggle")!.click();
    await vi.waitFor(() =>
      expect((player as unknown as { playRequest: unknown }).playRequest).toBeNull(),
    );
    media.pause();
    player.querySelector<HTMLButtonElement>(".chat-audio-player__toggle")!.click();

    expect(play).toHaveBeenCalledTimes(2);
    expect(media.getAttribute("src")).toBe("blob:context-fallback");
  });

  it("cancels the old source when identity changes during rendition preparation", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () =>
          await new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );
    const player = await createPlayer("identity-before");
    const media = player.querySelector("audio")!;
    let paused = false;
    Object.defineProperty(media, "paused", { configurable: true, get: () => paused });
    setMediaNumber(media, "currentTime", 20);
    setMediaNumber(media, "duration", 80);
    const play = vi.spyOn(media, "play").mockResolvedValue(undefined);
    const pause = vi.spyOn(media, "pause").mockImplementation(() => {
      paused = true;
    });

    player.src = "/__openclaw__/assistant-media?source=after.caf&mediaTicket=ticket";
    player.sourceIdentity = "media://identity-after";
    player.label = "after.caf";
    player.playback = "transcode";
    await vi.waitFor(() => expect(player.textContent).toContain("Preparing playback…"));

    expect(pause).toHaveBeenCalledOnce();
    expect(media.hasAttribute("src")).toBe(false);
    resolveFetch?.(new Response(null, { status: 200 }));
    await vi.waitFor(() => expect(media.getAttribute("src")).toContain("playback=1"));
    media.dispatchEvent(new Event("loadedmetadata"));
    expect(play).not.toHaveBeenCalled();
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
