import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOpenClawTools } from "../../../../src/agents/openclaw-tools.js";
import type { PreparedModelRuntimeSnapshot } from "../../../../src/agents/prepared-model-runtime.js";
import { createPluginMetadataSnapshot } from "../../../../src/config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import type {
  MusicGenerationProvider,
  MusicGenerationRequest,
} from "../../../../src/music-generation/types.js";
import { prepareMediaCapabilityProviders } from "../../../../src/plugins/capability-provider-runtime.js";
import { installTemporaryCurrentPluginMetadataSnapshot } from "../../../../src/plugins/current-plugin-metadata-snapshot.js";
import { resolvePluginRegistryLoadCacheKey } from "../../../../src/plugins/loader.js";
import type { PluginManifestRecord } from "../../../../src/plugins/manifest-registry.js";
import { createEmptyPluginRegistry } from "../../../../src/plugins/registry.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../../../src/plugins/runtime.js";
import { withEnvAsync } from "../../../../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

type ToolResult = {
  content?: Array<{ type: string; text?: string }>;
  details?: unknown;
};

type ProviderCall = {
  provider: string;
  request: MusicGenerationRequest;
};

const PLUGIN_ID = "qa-music-controls";

function detailsOf(result: ToolResult): Record<string, unknown> {
  if (!result.details || typeof result.details !== "object") {
    throw new Error("expected music_generate result details");
  }
  return result.details as Record<string, unknown>;
}

function textOf(result: ToolResult): string {
  return result.content?.find((entry) => entry.type === "text")?.text ?? "";
}

function createMusicFixture() {
  const calls: ProviderCall[] = [];
  const primary: MusicGenerationProvider = {
    id: "qa-primary",
    label: "QA primary music",
    defaultModel: "song-v1",
    models: ["song-v1"],
    capabilities: {
      generate: {
        maxDurationSeconds: 60,
        supportsLyrics: true,
        supportsInstrumental: true,
        supportsDuration: true,
        supportsFormat: true,
        supportedFormats: ["mp3", "wav"],
      },
    },
    isConfigured: () => true,
    generateMusic: async (request) => {
      calls.push({ provider: "qa-primary", request });
      throw new Error("intentional primary provider outage");
    },
  };
  const fallback: MusicGenerationProvider = {
    id: "qa-fallback",
    label: "QA fallback music",
    defaultModel: "beat-v2",
    models: ["beat-v2"],
    capabilities: {
      generate: {
        maxDurationSeconds: 30,
        supportsLyrics: false,
        supportsInstrumental: true,
        supportsDuration: true,
        supportsFormat: true,
        supportedFormats: ["mp3"],
      },
    },
    isConfigured: () => true,
    generateMusic: async (request) => {
      calls.push({ provider: "qa-fallback", request });
      const kind = request.instrumental ? "instrumental" : "vocal-fallback";
      return {
        tracks: [
          {
            buffer: Buffer.from(`ID3-qa-${kind}-audio`),
            mimeType: "audio/mpeg",
            fileName: `${kind}.mp3`,
          },
        ],
        model: request.model,
      };
    },
  };
  const config: OpenClawConfig = {
    plugins: {
      allow: [PLUGIN_ID],
      entries: { [PLUGIN_ID]: { enabled: true } },
      slots: { memory: "none" },
    },
    agents: {
      defaults: {
        mediaModels: {
          music: {
            primary: "qa-primary/song-v1",
            fallbacks: ["qa-fallback/beat-v2"],
          },
        },
      },
    },
  };
  const registry = createEmptyPluginRegistry();
  for (const provider of [primary, fallback]) {
    registry.musicGenerationProviders.push({
      pluginId: PLUGIN_ID,
      pluginName: "QA music controls",
      source: "test",
      provider,
    });
  }
  const manifest = {
    id: PLUGIN_ID,
    channels: [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    origin: "bundled",
    rootDir: `/fake/${PLUGIN_ID}`,
    source: `/fake/${PLUGIN_ID}/index.js`,
    manifestPath: `/fake/${PLUGIN_ID}/openclaw.plugin.json`,
    contracts: {
      musicGenerationProviders: [primary.id, fallback.id],
    },
  } satisfies PluginManifestRecord;
  const pluginMetadataSnapshot = createPluginMetadataSnapshot({
    config,
    manifestRegistry: {
      plugins: [manifest],
      diagnostics: [],
    },
  });
  const mediaCapabilityProviders = prepareMediaCapabilityProviders({
    cfg: config,
    pluginMetadataSnapshot,
    registry,
  });
  expect(mediaCapabilityProviders.musicGenerationProviders?.map((provider) => provider.id)).toEqual(
    ["qa-primary", "qa-fallback"],
  );

  const preparedModelRuntime = {
    metadataSnapshot: pluginMetadataSnapshot,
    mediaCapabilityProviders,
  } as unknown as PreparedModelRuntimeSnapshot;
  const musicTools = createOpenClawTools({
    config,
    preparedModelRuntime,
    disableMessageTool: true,
    disablePluginTools: true,
    wrapBeforeToolCallHook: false,
  }).filter((candidate) => candidate.name === "music_generate");
  expect(musicTools).toHaveLength(1);
  const [tool] = musicTools;
  if (!tool) {
    throw new Error(
      "expected production tool inventory to include music_generate for the prepared provider runtime",
    );
  }
  return { calls, config, fallback, pluginMetadataSnapshot, primary, registry, tool };
}

describe("music generation controls QA product proof", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("lists capabilities, falls back in config order, normalizes controls, and persists audio", async () => {
    const fixture = createMusicFixture();
    const activeRegistry = captureActivePluginRegistrySnapshot();
    const metadataLease = installTemporaryCurrentPluginMetadataSnapshot(
      fixture.pluginMetadataSnapshot,
      {
        config: fixture.config,
      },
    );
    try {
      const pluginIds = [PLUGIN_ID];
      const cacheKey = resolvePluginRegistryLoadCacheKey({
        config: fixture.config,
        onlyPluginIds: pluginIds,
        activate: false,
      });
      setActivePluginRegistry(fixture.registry, cacheKey);
      const listed = (await fixture.tool.execute("music-list", {
        action: "list",
      })) as ToolResult;
      const listedProviders = detailsOf(listed).providers as Array<Record<string, unknown>>;
      const primaryListing = listedProviders.find((entry) => entry.id === fixture.primary.id);
      const fallbackListing = listedProviders.find((entry) => entry.id === fixture.fallback.id);

      expect(primaryListing).toMatchObject({
        configured: true,
        defaultModel: "song-v1",
        models: ["song-v1"],
        modes: ["generate"],
      });
      expect(fallbackListing).toMatchObject({
        configured: true,
        defaultModel: "beat-v2",
        models: ["beat-v2"],
        modes: ["generate"],
      });
      expect(textOf(listed)).toContain(
        "capabilities: modes=generate, maxDurationSeconds=60, lyrics, instrumental, duration, format, supportedFormats=mp3/wav",
      );
    } finally {
      metadataLease.release();
      restoreActivePluginRegistrySnapshot(activeRegistry);
    }

    const stateDir = tempDirs.make("openclaw-qa-music-controls-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const vocalResult = (await fixture.tool.execute("music-vocal-fallback", {
        prompt: "bright QA chorus",
        lyrics: "OpenClaw keeps the signal clear",
        instrumental: false,
        durationSeconds: 45,
        format: "wav",
      })) as ToolResult;

      expect(fixture.calls.map((call) => `${call.provider}/${call.request.model}`)).toEqual([
        "qa-primary/song-v1",
        "qa-fallback/beat-v2",
      ]);
      expect(fixture.calls[0]?.request).toMatchObject({
        lyrics: "OpenClaw keeps the signal clear",
        instrumental: false,
        durationSeconds: 45,
        format: "wav",
      });
      expect(fixture.calls[1]?.request).toMatchObject({
        instrumental: false,
        durationSeconds: 30,
      });
      expect(fixture.calls[1]?.request.lyrics).toBeUndefined();
      expect(fixture.calls[1]?.request.format).toBeUndefined();

      const vocalDetails = detailsOf(vocalResult);
      expect(vocalDetails).toMatchObject({
        provider: "qa-fallback",
        model: "beat-v2",
        count: 1,
        instrumental: false,
        durationSeconds: 30,
        requestedDurationSeconds: 45,
        attempts: [
          {
            provider: "qa-primary",
            model: "song-v1",
            error: "intentional primary provider outage",
          },
        ],
        ignoredOverrides: [
          { key: "lyrics", value: "OpenClaw keeps the signal clear" },
          { key: "format", value: "wav" },
        ],
        normalization: {
          durationSeconds: {
            requested: 45,
            applied: 30,
          },
        },
      });
      expect(vocalDetails).not.toHaveProperty("requestedLyrics");
      expect(vocalDetails).not.toHaveProperty("format");
      expect(textOf(vocalResult)).toContain(
        "Warning: Ignored unsupported overrides for qa-fallback/beat-v2: lyrics=OpenClaw keeps the signal clear, format=wav.",
      );
      expect(textOf(vocalResult)).toContain("Duration normalized: requested 45s; used 30s.");

      const instrumentalResult = (await fixture.tool.execute("music-instrumental", {
        prompt: "tight QA percussion loop",
        model: "qa-fallback/beat-v2",
        instrumental: true,
        durationSeconds: 12,
        format: "mp3",
      })) as ToolResult;
      expect(fixture.calls.map((call) => `${call.provider}/${call.request.model}`)).toEqual([
        "qa-primary/song-v1",
        "qa-fallback/beat-v2",
        "qa-fallback/beat-v2",
      ]);
      expect(fixture.calls[2]?.request).toMatchObject({
        instrumental: true,
        durationSeconds: 12,
        format: "mp3",
      });
      expect(detailsOf(instrumentalResult)).toMatchObject({
        provider: "qa-fallback",
        model: "beat-v2",
        instrumental: true,
        durationSeconds: 12,
        format: "mp3",
        attempts: [],
      });

      const persisted = [
        ...(vocalDetails.paths as string[]),
        ...(detailsOf(instrumentalResult).paths as string[]),
      ];
      expect(persisted).toHaveLength(2);
      for (const filePath of persisted) {
        const canonicalPath = await fs.realpath(filePath);
        expect(
          canonicalPath.startsWith(path.join(stateDir, "media", "tool-music-generation")),
        ).toBe(true);
        expect((await fs.readFile(canonicalPath)).byteLength).toBeGreaterThan(0);
      }
    });
  });

  it("rejects invalid output formats before invoking a prepared provider", async () => {
    const fixture = createMusicFixture();

    await expect(
      fixture.tool.execute("music-invalid-format", {
        prompt: "QA invalid format proof",
        format: "flac",
      }),
    ).rejects.toThrow('format must be one of "mp3" or "wav"');
    expect(fixture.calls).toEqual([]);
  });
});
