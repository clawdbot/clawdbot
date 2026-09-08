/** Verifies plugin loader records expose stable metadata for registered plugin surfaces. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginRecord, recordPluginError } from "./loader-records.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";

describe("plugin loader records", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps package attribution separate from the runtime version", () => {
    const record = createPluginRecord({
      id: "versioned",
      name: "Versioned",
      source: "test",
      origin: "workspace",
      enabled: true,
      configSchema: false,
      packageVersion: "1.2.3",
      version: "runtime-4",
    });

    expect(record).toMatchObject({
      packageVersion: "1.2.3",
      version: "runtime-4",
    });
  });

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
        embeddingProviders: ["kitchen-sink-embedding-provider"],
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
      },
      configSchema: false,
    });

    expect(record.embeddingProviderIds).toEqual(["kitchen-sink-embedding-provider"]);
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
  });

  it.each([
    { diagnostics: "", expected: "Error: boom" },
    { diagnostics: "1", expected: "Error: boom\n    at plugin-entry.ts:1:1" },
  ])("uses lifecycle tracing for loader error stacks", ({ diagnostics, expected }) => {
    vi.stubEnv("OPENCLAW_PLUGIN_LIFECYCLE_TRACE", diagnostics);
    const registry = createEmptyPluginRegistry();
    const record = createPluginRecord({
      id: "broken-plugin",
      source: "/tmp/broken-plugin/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });
    const error = new Error("boom");
    error.stack = "Error: boom\n    at plugin-entry.ts:1:1";

    recordPluginError({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      registry,
      record,
      seenIds: new Map(),
      phase: "load",
      error,
      logPrefix: "",
      diagnosticMessagePrefix: "",
    });

    expect(record.error).toBe(expected);
  });

  it.each([
    {
      name: "names the install path when a missing module sits on the error cause",
      error: new Error("import failed", {
        cause: Object.assign(new Error("Cannot find module 'discord-api-types/v10'"), {
          code: "MODULE_NOT_FOUND",
        }),
      }),
      expected: "install @openclaw/discord (Error: import failed)",
    },
    {
      name: "keeps unrelated failures verbatim",
      error: new Error("boom"),
      expected: "Error: boom",
    },
    {
      name: "survives a nested throwing code accessor without rethrowing",
      error: new Error("wrapped", {
        cause: Object.defineProperty(new Error("nested"), "code", {
          get(): never {
            throw new Error("code exploded");
          },
        }),
      }),
      expected: "Error: wrapped",
    },
    {
      name: "survives a throwing cause accessor without rethrowing",
      error: Object.defineProperty(new Error("hostile"), "cause", {
        get(): never {
          throw new Error("cause exploded");
        },
      }),
      expected: "Error: hostile",
    },
  ])("$name", ({ error, expected }) => {
    const registry = createEmptyPluginRegistry();
    const record = createPluginRecord({
      id: "discord",
      source: "/tmp/discord/index.js",
      origin: "bundled",
      enabled: true,
      configSchema: false,
    });

    recordPluginError({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      registry,
      record,
      seenIds: new Map(),
      phase: "load",
      error,
      logPrefix: "",
      diagnosticMessagePrefix: "",
      missingDependencyHint: "install @openclaw/discord",
    });

    expect(record.error).toBe(expected);
  });
});
