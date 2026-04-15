import { describe, expect, it } from "vitest";
import { resolveOpenClawAgentDir } from "../src/agents/agent-paths.js";
import { collectProviderApiKeys } from "../src/agents/live-auth-keys.js";
import { isLiveProfileKeyModeEnabled, isLiveTestEnabled } from "../src/agents/live-test-helpers.js";
import { resolveApiKeyForProvider } from "../src/agents/model-auth.js";
import { loadConfig, type OpenClawConfig } from "../src/config/config.js";
import { isTruthyEnvValue } from "../src/infra/env.js";
import { getShellEnvAppliedKeys, loadShellEnvFallback } from "../src/infra/shell-env.js";
import { encodePngRgba, fillPixel } from "../src/media/png-encode.js";
import {
  DEFAULT_LIVE_MUSIC_MODELS,
  parseCsvFilter,
  parseProviderModelMap,
  redactLiveApiKey,
  resolveConfiguredLiveMusicModels,
  resolveLiveMusicAuthStore,
} from "../src/music-generation/live-test-helpers.js";
import { getProviderEnvVars } from "../src/secrets/provider-env-vars.js";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "../test/helpers/plugins/provider-registration.js";
import googlePlugin from "./google/index.js";
import minimaxPlugin from "./minimax/index.js";

const LIVE = isLiveTestEnabled();
const REQUIRE_PROFILE_KEYS =
  isLiveProfileKeyModeEnabled() || isTruthyEnvValue(process.env.OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS);
const describeLive = LIVE ? describe : describe.skip;
const providerFilter = parseCsvFilter(process.env.OPENCLAW_LIVE_MUSIC_GENERATION_PROVIDERS);
const envModelMap = parseProviderModelMap(process.env.OPENCLAW_LIVE_MUSIC_GENERATION_MODELS);

type LiveProviderCase = {
  plugin: Parameters<typeof registerProviderPlugin>[0]["plugin"];
  pluginId: string;
  pluginName: string;
  providerId: string;
};

const CASES: LiveProviderCase[] = [
  {
    plugin: googlePlugin,
    pluginId: "google",
    pluginName: "Google Provider",
    providerId: "google",
  },
  {
    plugin: minimaxPlugin,
    pluginId: "minimax",
    pluginName: "MiniMax Provider",
    providerId: "minimax",
  },
]
  .filter((entry) => (providerFilter ? providerFilter.has(entry.providerId) : true))
  .toSorted((left, right) => left.providerId.localeCompare(right.providerId));

function withPluginsEnabled(cfg: OpenClawConfig): OpenClawConfig {
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      enabled: true,
    },
  };
}

function createEditReferencePng(): Buffer {
  const width = 192;
  const height = 192;
  const buf = Buffer.alloc(width * height * 4, 255);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      fillPixel(buf, x, y, width, 250, 246, 240, 255);
    }
  }

  for (let y = 24; y < 168; y += 1) {
    for (let x = 24; x < 168; x += 1) {
      fillPixel(buf, x, y, width, 255, 143, 77, 255);
    }
  }

  for (let y = 48; y < 144; y += 1) {
    for (let x = 48; x < 144; x += 1) {
      fillPixel(buf, x, y, width, 34, 40, 49, 255);
    }
  }

  return encodePngRgba(buf, width, height);
}

function resolveProviderModelForLiveTest(providerId: string, modelRef: string): string {
  const slash = modelRef.indexOf("/");
  if (slash <= 0 || slash === modelRef.length - 1) {
    return modelRef;
  }
  return modelRef.slice(0, slash) === providerId ? modelRef.slice(slash + 1) : modelRef;
}

function maybeLoadShellEnvForMusicProviders(providerIds: string[]): void {
  const expectedKeys = [
    ...new Set(providerIds.flatMap((providerId) => getProviderEnvVars(providerId))),
  ];
  if (expectedKeys.length === 0) {
    return;
  }
  loadShellEnvFallback({
    enabled: true,
    env: process.env,
    expectedKeys,
    logger: { warn: (message: string) => console.warn(message) },
  });
}

function resolveLiveLyrics(providerId: string): string | undefined {
  if (providerId !== "minimax") {
    return undefined;
  }
  return [
    "[Verse]",
    "Streetlights shimmer while we race the dawn",
    "Neon echoes carry us along",
    "[Chorus]",
    "Hold the night inside this song",
    "We run together bright and strong",
  ].join("\n");
}

describeLive("music generation provider live", () => {
  it(
    "covers generate plus declared edit paths with shell/profile auth",
    async () => {
      const cfg = withPluginsEnabled(loadConfig());
      const configuredModels = resolveConfiguredLiveMusicModels(cfg);
      const agentDir = resolveOpenClawAgentDir();
      const attempted: string[] = [];
      const skipped: string[] = [];
      const failures: string[] = [];

      maybeLoadShellEnvForMusicProviders(CASES.map((entry) => entry.providerId));

      for (const testCase of CASES) {
        const modelRef =
          envModelMap.get(testCase.providerId) ??
          configuredModels.get(testCase.providerId) ??
          DEFAULT_LIVE_MUSIC_MODELS[testCase.providerId];
        if (!modelRef) {
          skipped.push(`${testCase.providerId}: no model configured`);
          continue;
        }

        const hasLiveKeys = collectProviderApiKeys(testCase.providerId).length > 0;
        const authStore = resolveLiveMusicAuthStore({
          requireProfileKeys: REQUIRE_PROFILE_KEYS,
          hasLiveKeys,
        });
        let authLabel = "unresolved";
        try {
          const auth = await resolveApiKeyForProvider({
            provider: testCase.providerId,
            cfg,
            agentDir,
            store: authStore,
          });
          authLabel = `${auth.source} ${redactLiveApiKey(auth.apiKey)}`;
        } catch {
          skipped.push(`${testCase.providerId}: no usable auth`);
          continue;
        }

        const { musicProviders } = await registerProviderPlugin({
          plugin: testCase.plugin,
          id: testCase.pluginId,
          name: testCase.pluginName,
        });
        const provider = requireRegisteredProvider(
          musicProviders,
          testCase.providerId,
          "music provider",
        );
        const providerModel = resolveProviderModelForLiveTest(testCase.providerId, modelRef);
        const generateCaps = provider.capabilities.generate;
        const liveLyrics = resolveLiveLyrics(testCase.providerId);

        try {
          const result = await provider.generateMusic({
            provider: testCase.providerId,
            model: providerModel,
            prompt: "Upbeat instrumental synthwave with warm neon pads and a simple driving beat.",
            cfg,
            agentDir,
            authStore,
            ...(generateCaps?.supportsDuration ? { durationSeconds: 12 } : {}),
            ...(generateCaps?.supportsFormat ? { format: "mp3" as const } : {}),
            ...(liveLyrics ? { lyrics: liveLyrics } : {}),
            ...(generateCaps?.supportsInstrumental && !liveLyrics ? { instrumental: true } : {}),
          });

          expect(result.tracks.length).toBeGreaterThan(0);
          expect(result.tracks[0]?.mimeType.startsWith("audio/")).toBe(true);
          expect(result.tracks[0]?.buffer.byteLength).toBeGreaterThan(1024);
          attempted.push(`${testCase.providerId}:generate:${providerModel} (${authLabel})`);
        } catch (error) {
          failures.push(
            `${testCase.providerId}:generate (${authLabel}): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          continue;
        }

        if (!provider.capabilities.edit?.enabled) {
          continue;
        }

        try {
          const result = await provider.generateMusic({
            provider: testCase.providerId,
            model: providerModel,
            prompt: "Turn the reference cover art into a short dramatic trailer sting.",
            cfg,
            agentDir,
            authStore,
            inputImages: [
              {
                buffer: createEditReferencePng(),
                mimeType: "image/png",
                fileName: "reference.png",
              },
            ],
          });

          expect(result.tracks.length).toBeGreaterThan(0);
          expect(result.tracks[0]?.mimeType.startsWith("audio/")).toBe(true);
          expect(result.tracks[0]?.buffer.byteLength).toBeGreaterThan(1024);
          attempted.push(`${testCase.providerId}:edit:${providerModel} (${authLabel})`);
        } catch (error) {
          failures.push(
            `${testCase.providerId}:edit (${authLabel}): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      console.log(
        `[live:music-generation] attempted=${attempted.join(", ") || "none"} skipped=${skipped.join(", ") || "none"} failures=${failures.join(" | ") || "none"} shellEnv=${getShellEnvAppliedKeys().join(", ") || "none"}`,
      );

      if (attempted.length === 0) {
        expect(failures).toEqual([]);
        console.warn("[live:music-generation] no provider had usable auth; skipping assertions");
        return;
      }
      expect(failures).toEqual([]);
    },
    10 * 60_000,
  );
});
