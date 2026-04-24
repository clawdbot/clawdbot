import { describe, expect, it } from "vitest";
import { resolveOpenClawAgentDir } from "../src/agents/agent-paths.js";
import { collectProviderApiKeys } from "../src/agents/live-auth-keys.js";
import { isLiveProfileKeyModeEnabled, isLiveTestEnabled } from "../src/agents/live-test-helpers.js";
import { resolveApiKeyForProvider } from "../src/agents/model-auth.js";
import { loadConfig, type OpenClawConfig } from "../src/config/config.js";
import {
  DEFAULT_LIVE_IMAGE_MODELS,
  parseCaseFilter,
  parseCsvFilter,
  parseProviderModelMap,
  redactLiveApiKey,
  resolveConfiguredLiveImageModels,
  resolveLiveImageAuthStore,
} from "../src/image-generation/live-test-helpers.js";
import { isTruthyEnvValue } from "../src/infra/env.js";
import { getShellEnvAppliedKeys } from "../src/infra/shell-env.js";
import { encodePngRgba, fillPixel } from "../src/media/png-encode.js";
import { maybeLoadShellEnvForGenerationProviders } from "../src/test-utils/generation-live-test-helpers.js";
import { loadBundledProviderPlugin as loadBundledProviderPluginFromTestHelper } from "./helpers/media-generation/bundled-provider-builders.js";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "./helpers/plugins/provider-registration.js";

const LIVE = isLiveTestEnabled();
const REQUIRE_PROFILE_KEYS =
  isLiveProfileKeyModeEnabled() || isTruthyEnvValue(process.env.OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS);
const describeLive = LIVE ? describe : describe.skip;
const providerFilter = parseCsvFilter(process.env.OPENCLAW_LIVE_IMAGE_GENERATION_PROVIDERS);
const caseFilter = parseCaseFilter(process.env.OPENCLAW_LIVE_IMAGE_GENERATION_CASES);
const envModelMap = parseProviderModelMap(process.env.OPENCLAW_LIVE_IMAGE_GENERATION_MODELS);

type LiveProviderCase = {
  pluginId: string;
  pluginName: string;
  providerId: string;
};

type LiveImageCase = {
  id: string;
  providerId: string;
  modelRef: string;
  prompt: string;
  size?: string;
  resolution?: "1K" | "2K" | "4K";
  inputImages?: Array<{ buffer: Buffer; mimeType: string; fileName?: string }>;
};

function loadBundledProviderPlugin(
  pluginId: string,
): ReturnType<typeof loadBundledProviderPluginFromTestHelper> {
  return loadBundledProviderPluginFromTestHelper(pluginId);
}

const PROVIDER_CASES: LiveProviderCase[] = [
  {
    pluginId: "fal",
    pluginName: "fal Provider",
    providerId: "fal",
  },
  {
    pluginId: "google",
    pluginName: "Google Provider",
    providerId: "google",
  },
  {
    pluginId: "minimax",
    pluginName: "MiniMax Provider",
    providerId: "minimax",
  },
  {
    pluginId: "openai",
    pluginName: "OpenAI Provider",
    providerId: "openai",
  },
  {
    pluginId: "openrouter",
    pluginName: "OpenRouter Provider",
    providerId: "openrouter",
  },
  {
    pluginId: "vydra",
    pluginName: "Vydra Provider",
    providerId: "vydra",
  },
  {
    pluginId: "xai",
    pluginName: "xAI Provider",
    providerId: "xai",
  },
]
  .filter((entry) => (providerFilter ? providerFilter.has(entry.providerId) : true))
  .toSorted((left, right) => left.providerId.localeCompare(right.providerId));

function createEditReferencePng(): Buffer {
  const width = 192;
  const height = 192;
  const buf = Buffer.alloc(width * height * 4, 255);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      fillPixel(buf, x, y, width, 245, 248, 255, 255);
    }
  }

  for (let y = 24; y < 168; y += 1) {
    for (let x = 24; x < 168; x += 1) {
      fillPixel(buf, x, y, width, 255, 189, 89, 255);
    }
  }

  for (let y = 48; y < 144; y += 1) {
    for (let x = 48; x < 144; x += 1) {
      fillPixel(buf, x, y, width, 41, 47, 54, 255);
    }
  }

  return encodePngRgba(buf, width, height);
}

function withPluginsEnabled(cfg: OpenClawConfig): OpenClawConfig {
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      enabled: true,
    },
  };
}

function resolveProviderModelForLiveTest(providerId: string, modelRef: string): string {
  const slash = modelRef.indexOf("/");
  if (slash <= 0 || slash === modelRef.length - 1) {
    return modelRef;
  }
  return modelRef.slice(0, slash) === providerId ? modelRef.slice(slash + 1) : modelRef;
}

function buildLiveCases(params: {
  providerId: string;
  modelRef: string;
  editEnabled: boolean;
}): LiveImageCase[] {
  const generatePrompt =
    "Create a minimal flat illustration of an orange cat face sticker on a white background.";
  const editPrompt =
    "Change ONLY the background to a pale blue gradient. Keep the subject, framing, and style identical.";
  const cases: LiveImageCase[] = [
    {
      id: `${params.providerId}:generate`,
      providerId: params.providerId,
      modelRef: params.modelRef,
      prompt: generatePrompt,
      size: "1024x1024",
    },
  ];
  if (params.editEnabled) {
    cases.push({
      id: `${params.providerId}:edit`,
      providerId: params.providerId,
      modelRef: params.modelRef,
      prompt: editPrompt,
      resolution: "2K",
      inputImages: [
        {
          buffer: createEditReferencePng(),
          mimeType: "image/png",
          fileName: "reference.png",
        },
      ],
    });
  }
  return cases;
}

describeLive("image generation live (provider sweep)", () => {
  it(
    "generates images for every configured image-generation variant with available auth",
    async () => {
      const cfg = withPluginsEnabled(loadConfig());
      const configuredModels = resolveConfiguredLiveImageModels(cfg);
      const agentDir = resolveOpenClawAgentDir();
      const attempted: string[] = [];
      const skipped: string[] = [];
      const failures: string[] = [];

      maybeLoadShellEnvForGenerationProviders(PROVIDER_CASES.map((entry) => entry.providerId));

      for (const providerCase of PROVIDER_CASES) {
        const modelRef =
          envModelMap.get(providerCase.providerId) ??
          configuredModels.get(providerCase.providerId) ??
          DEFAULT_LIVE_IMAGE_MODELS[providerCase.providerId];
        if (!modelRef) {
          skipped.push(`${providerCase.providerId}: no model configured`);
          continue;
        }

        const hasLiveKeys = collectProviderApiKeys(providerCase.providerId).length > 0;
        const authStore = resolveLiveImageAuthStore({
          requireProfileKeys: REQUIRE_PROFILE_KEYS,
          hasLiveKeys,
        });
        let authLabel = "unresolved";
        try {
          const auth = await resolveApiKeyForProvider({
            provider: providerCase.providerId,
            cfg,
            agentDir,
            store: authStore,
          });
          authLabel = `${auth.source} ${redactLiveApiKey(auth.apiKey)}`;
        } catch {
          skipped.push(`${providerCase.providerId}: no usable auth`);
          continue;
        }

        const { imageProviders } = await registerProviderPlugin({
          plugin: loadBundledProviderPlugin(providerCase.pluginId),
          id: providerCase.pluginId,
          name: providerCase.pluginName,
        });
        const provider = requireRegisteredProvider(
          imageProviders,
          providerCase.providerId,
          "image provider",
        );
        const providerModel = resolveProviderModelForLiveTest(providerCase.providerId, modelRef);
        const liveCases = buildLiveCases({
          providerId: providerCase.providerId,
          modelRef,
          editEnabled: provider.capabilities.edit?.enabled ?? false,
        }).filter((entry) => (caseFilter ? caseFilter.has(entry.id.toLowerCase()) : true));

        for (const testCase of liveCases) {
          const startedAt = Date.now();
          console.error(
            `[live:image-generation] starting ${testCase.id} model=${providerModel} auth=${authLabel}`,
          );
          try {
            const result = await provider.generateImage({
              provider: providerCase.providerId,
              model: providerModel,
              prompt: testCase.prompt,
              cfg,
              agentDir,
              authStore,
              size: testCase.size,
              resolution: testCase.resolution,
              inputImages: testCase.inputImages,
              timeoutMs: 60_000,
            });

            expect(result.images.length).toBeGreaterThan(0);
            expect(result.images[0]?.mimeType.startsWith("image/")).toBe(true);
            expect(result.images[0]?.buffer.byteLength).toBeGreaterThan(512);
            attempted.push(`${testCase.id}:${result.model} (${authLabel})`);
            console.error(
              `[live:image-generation] done ${testCase.id} ms=${Date.now() - startedAt} images=${result.images.length}`,
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            failures.push(`${testCase.id} (${authLabel}): ${message}`);
            console.error(
              `[live:image-generation] failed ${testCase.id} ms=${Date.now() - startedAt} error=${message}`,
            );
          }
        }
      }

      console.log(
        `[live:image-generation] attempted=${attempted.join(", ") || "none"} skipped=${skipped.join(", ") || "none"} failures=${failures.join(" | ") || "none"} shellEnv=${getShellEnvAppliedKeys().join(", ") || "none"}`,
      );

      if (attempted.length === 0) {
        expect(failures).toEqual([]);
        console.warn("[live:image-generation] no provider had usable auth; skipping assertions");
        return;
      }
      expect(failures).toEqual([]);
    },
    10 * 60_000,
  );
});
