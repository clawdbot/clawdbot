import { describe, expect, it } from "vitest";
import { createPluginRecord } from "./loader-records.js";

describe("plugin loader records", () => {
  it("preserves manifest-declared channel ids before runtime registration", () => {
    const record = createPluginRecord({
      id: "kitchen-sink",
      name: "Kitchen Sink",
      source: "/tmp/kitchen-sink/index.js",
      origin: "global",
      enabled: true,
      channelIds: ["kitchen-sink-channel"],
      configSchema: false,
    });

    expect(record.channelIds).toEqual(["kitchen-sink-channel"]);
  });

  it("preserves manifest-declared provider ids before runtime registration", () => {
    const record = createPluginRecord({
      id: "kitchen-sink",
      name: "Kitchen Sink",
      source: "/tmp/kitchen-sink/index.js",
      origin: "global",
      enabled: true,
      providerIds: ["kitchen-sink-provider"],
      configSchema: false,
    });

    expect(record.providerIds).toEqual(["kitchen-sink-provider"]);
  });

  it("preserves manifest-declared capability provider ids before runtime registration", () => {
    const record = createPluginRecord({
      id: "kitchen-sink",
      name: "Kitchen Sink",
      source: "/tmp/kitchen-sink/index.js",
      origin: "global",
      enabled: true,
      contracts: {
        speechProviders: ["kitchen-sink-speech-provider"],
        realtimeTranscriptionProviders: ["kitchen-sink-transcription-provider"],
        realtimeVoiceProviders: ["kitchen-sink-voice-provider"],
        mediaUnderstandingProviders: ["kitchen-sink-media-provider"],
        imageGenerationProviders: ["kitchen-sink-image-provider"],
        videoGenerationProviders: ["kitchen-sink-video-provider"],
        musicGenerationProviders: ["kitchen-sink-music-provider"],
        webFetchProviders: ["kitchen-sink-web-fetch-provider"],
        webSearchProviders: ["kitchen-sink-web-search-provider"],
        migrationProviders: ["kitchen-sink-migration-provider"],
        memoryEmbeddingProviders: ["kitchen-sink-memory-provider"],
      },
      configSchema: false,
    });

    expect(record.speechProviderIds).toEqual(["kitchen-sink-speech-provider"]);
    expect(record.realtimeTranscriptionProviderIds).toEqual([
      "kitchen-sink-transcription-provider",
    ]);
    expect(record.realtimeVoiceProviderIds).toEqual(["kitchen-sink-voice-provider"]);
    expect(record.mediaUnderstandingProviderIds).toEqual(["kitchen-sink-media-provider"]);
    expect(record.imageGenerationProviderIds).toEqual(["kitchen-sink-image-provider"]);
    expect(record.videoGenerationProviderIds).toEqual(["kitchen-sink-video-provider"]);
    expect(record.musicGenerationProviderIds).toEqual(["kitchen-sink-music-provider"]);
    expect(record.webFetchProviderIds).toEqual(["kitchen-sink-web-fetch-provider"]);
    expect(record.webSearchProviderIds).toEqual(["kitchen-sink-web-search-provider"]);
    expect(record.migrationProviderIds).toEqual(["kitchen-sink-migration-provider"]);
    expect(record.memoryEmbeddingProviderIds).toEqual(["kitchen-sink-memory-provider"]);
  });
});
