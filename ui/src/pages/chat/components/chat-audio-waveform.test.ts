import { describe, expect, it } from "vitest";
import {
  cacheAndRetainChatAudioBlob,
  canDecodeChatAudioWaveform,
  CHAT_AUDIO_WAVEFORM_MAX_BYTES,
  computeChatAudioWaveformPeaks,
  shouldFetchChatAudioWaveform,
} from "./chat-audio-waveform.ts";

describe("chat audio waveform", () => {
  it("caps waveform decoding by byte size and duration", () => {
    expect(
      canDecodeChatAudioWaveform({
        sizeBytes: CHAT_AUDIO_WAVEFORM_MAX_BYTES,
        durationSeconds: 300,
      }),
    ).toBe(true);
    expect(canDecodeChatAudioWaveform({ sizeBytes: CHAT_AUDIO_WAVEFORM_MAX_BYTES + 1 })).toBe(
      false,
    );
    expect(
      canDecodeChatAudioWaveform({
        sizeBytes: CHAT_AUDIO_WAVEFORM_MAX_BYTES,
        durationSeconds: 301,
      }),
    ).toBe(false);
    expect(shouldFetchChatAudioWaveform({})).toBe(false);
    expect(canDecodeChatAudioWaveform({ sizeBytes: CHAT_AUDIO_WAVEFORM_MAX_BYTES })).toBe(false);
    expect(
      canDecodeChatAudioWaveform({
        sizeBytes: CHAT_AUDIO_WAVEFORM_MAX_BYTES,
        durationSeconds: Number.NaN,
      }),
    ).toBe(false);
  });

  it("computes normalized peak buckets", () => {
    const channels = [new Float32Array([0.1, -0.5, 0.2, 0.4, -0.25, 0.75, 0, -1])];
    const peaks = computeChatAudioWaveformPeaks(
      {
        length: channels[0]!.length,
        numberOfChannels: channels.length,
        getChannelData: (channel) => channels[channel]!,
      },
      4,
    );

    expect(peaks).toHaveLength(4);
    expect(peaks[0]).toBeCloseTo(0.5);
    expect(peaks[1]).toBeCloseTo(0.4);
    expect(peaks[2]).toBeCloseTo(0.75);
    expect(peaks[3]).toBe(1);
  });

  it("includes peaks carried only by a non-first channel", () => {
    const channels = [new Float32Array([0, 0, 0, 0]), new Float32Array([0, 0.25, 0, 1])];
    const peaks = computeChatAudioWaveformPeaks(
      {
        length: channels[0]!.length,
        numberOfChannels: channels.length,
        getChannelData: (channel) => channels[channel]!,
      },
      2,
    );

    expect(peaks).toEqual([0.25, 1]);
  });

  it("declines a new Blob when all 32 cache entries are retained", () => {
    const releases: Array<() => void> = [];
    for (let index = 0; index < 32; index += 1) {
      const retained = cacheAndRetainChatAudioBlob(`retained-${index}`, {
        blobUrl: `blob:retained-${index}`,
        sizeBytes: 1,
      });
      expect(retained).not.toBeNull();
      if (!retained) {
        throw new Error("expected retained audio blob");
      }
      expect(retained.value.blobUrl).toBe(`blob:retained-${index}`);
      releases.push(retained.release);
    }
    expect(
      cacheAndRetainChatAudioBlob("retained-overflow", {
        blobUrl: "blob:retained-overflow",
        sizeBytes: 1,
      }),
    ).toBeNull();

    for (const release of releases) {
      release();
    }
  });

  it("caps retained audio bytes at 48 MiB", () => {
    const releases = Array.from({ length: 6 }, (_, index) =>
      cacheAndRetainChatAudioBlob(`large-${index}`, {
        blobUrl: `blob:large-${index}`,
        sizeBytes: CHAT_AUDIO_WAVEFORM_MAX_BYTES,
      }),
    );
    expect(releases.every((retained) => retained !== null)).toBe(true);
    expect(
      cacheAndRetainChatAudioBlob("large-overflow", {
        blobUrl: "blob:large-overflow",
        sizeBytes: CHAT_AUDIO_WAVEFORM_MAX_BYTES,
      }),
    ).toBeNull();
    for (const retained of releases) {
      retained?.release();
    }
  });
});
