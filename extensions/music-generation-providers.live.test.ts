import {
  resolveApiKeyForProvider,
  resolveDefaultAgentDir,
} from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  DEFAULT_LIVE_MUSIC_MODELS,
  collectProviderApiKeys,
  encodePngRgba,
  fillPixel,
  getShellEnvAppliedKeys,
  isAuthErrorMessage,
  isBillingErrorMessage,
  isLiveProfileKeyModeEnabled,
  isLiveTestEnabled,
  isModelNotFoundErrorMessage,
  isOverloadedErrorMessage,
  isServerErrorMessage,
  isTimeoutErrorMessage,
  isTruthyEnvValue,
  parseCsvFilter,
  parseProviderModelMap,
  redactLiveApiKey,
  resolveConfiguredLiveMusicModels,
  resolveLiveMusicAuthStore,
} from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import googlePlugin from "./google/index.js";
import minimaxPlugin from "./minimax/index.js";
import { maybeLoadShellEnvForGenerationProviders } from "./test-support/generation-live-test-helpers.js";

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
  maybeLoadShellEnvForGenerationProviders(providerIds);
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

function resolveLiveMusicSkipReason(providerId: string, error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  if (
    providerId === "google" &&
    message.toLowerCase().includes("music generation response missing audio data")
  ) {
    return "transient no-audio response";
  }
  if (isAuthErrorMessage(message)) {
    return "auth drift";
  }
  if (isModelNotFoundErrorMessage(message)) {
    return "model drift";
  }
  if (isBillingErrorMessage(message)) {
    return "billing drift";
  }
  if (isTimeoutErrorMessage(message) || /operation was aborted/i.test(message)) {
    return "provider timeout";
  }
  if (isOverloadedErrorMessage(message) || isServerErrorMessage(message)) {
    return "provider outage";
  }
  return null;
}

describeLive("music generation provider live", () => {
  it(
    "covers generate plus declared edit paths with shell/profile auth",
    async () => {
      const cfg = withPluginsEnabled(getRuntimeConfig());
      const configuredModels = resolveConfiguredLiveMusicModels(cfg);
      const agentDir = resolveDefaultAgentDir(cfg as never);
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
          const skipReason = resolveLiveMusicSkipReason(testCase.providerId, error);
          if (skipReason) {
            skipped.push(`${testCase.providerId}:generate ${skipReason}`);
            continue;
          }
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
          const skipReason = resolveLiveMusicSkipReason(testCase.providerId, error);
          if (skipReason) {
            skipped.push(`${testCase.providerId}:edit ${skipReason}`);
            continue;
          }
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
        expect(failures).toStrictEqual([]);
        console.warn("[live:music-generation] no provider had usable auth; skipping assertions");
        return;
      }
      expect(failures).toStrictEqual([]);
    },
    10 * 60_000,
  );
});
