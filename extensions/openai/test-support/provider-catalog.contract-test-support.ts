import { beforeEach, describe, it, vi } from "vitest";
import {
  expectAugmentedCodexCatalog,
  expectedAugmentedOpenaiCodexCatalogEntriesWithGpt55,
  expectCodexBuiltInSuppression,
  expectCodexMissingAuthHint,
  importProviderRuntimeCatalogModule,
  loadBundledPluginPublicSurface,
} from "../../../test/helpers/plugins/provider-catalog.js";
import type { ProviderPlugin } from "../../../test/helpers/plugins/provider-catalog.js";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "../../../test/helpers/plugins/provider-registration.js";

const PROVIDER_CATALOG_CONTRACT_TIMEOUT_MS = 300_000;

type ResolvePluginProviders = (params?: { onlyPluginIds?: string[] }) => ProviderPlugin[];
type ResolveOwningPluginIdsForProvider = (params: { provider: string }) => string[] | undefined;
type ResolveCatalogHookProviderPluginIds = (params: unknown) => string[];

const resolvePluginProvidersMock = vi.hoisted(() => vi.fn<ResolvePluginProviders>(() => []));
const resolveOwningPluginIdsForProviderMock = vi.hoisted(() =>
  vi.fn<ResolveOwningPluginIdsForProvider>(() => undefined),
);
const resolveCatalogHookProviderPluginIdsMock = vi.hoisted(() =>
  vi.fn<ResolveCatalogHookProviderPluginIds>((_) => [] as string[]),
);

vi.mock("../../../src/plugins/providers.js", () => ({
  resolveOwningPluginIdsForProvider: (params: unknown) =>
    resolveOwningPluginIdsForProviderMock(params as never),
  resolveCatalogHookProviderPluginIds: (params: unknown) =>
    resolveCatalogHookProviderPluginIdsMock(params as never),
}));

vi.mock("../../../src/plugins/providers.runtime.js", () => ({
  isPluginProvidersLoadInFlight: () => false,
  resolvePluginProviders: (params: unknown) => resolvePluginProvidersMock(params as never),
}));

export function describeOpenAIProviderCatalogContract() {
  const contractDepsPromise = (async () => {
    vi.resetModules();
    const openaiPlugin = await loadBundledPluginPublicSurface<{
      default: Parameters<typeof registerProviderPlugin>[0]["plugin"];
    }>({
      pluginId: "openai",
      artifactBasename: "index.js",
    });
    const openaiProviders = (
      await registerProviderPlugin({
        plugin: openaiPlugin.default,
        id: "openai",
        name: "OpenAI",
      })
    ).providers;
    const openaiProvider = requireRegisteredProvider(openaiProviders, "openai", "provider");
    const {
      augmentModelCatalogWithProviderPlugins,
      resetProviderRuntimeHookCacheForTest,
      resolveProviderBuiltInModelSuppression,
    } = await importProviderRuntimeCatalogModule();
    return {
      augmentModelCatalogWithProviderPlugins,
      resetProviderRuntimeHookCacheForTest,
      resolveProviderBuiltInModelSuppression,
      openaiProviders,
      openaiProvider,
    };
  })();

  describe(
    "openai provider catalog contract",
    { timeout: PROVIDER_CATALOG_CONTRACT_TIMEOUT_MS },
    () => {
      beforeEach(async () => {
        const { resetProviderRuntimeHookCacheForTest, openaiProviders } = await contractDepsPromise;
        resetProviderRuntimeHookCacheForTest();

        resolvePluginProvidersMock.mockReset();
        resolvePluginProvidersMock.mockImplementation((params?: { onlyPluginIds?: string[] }) => {
          const onlyPluginIds = params?.onlyPluginIds;
          if (!onlyPluginIds || onlyPluginIds.length === 0) {
            return openaiProviders;
          }
          return onlyPluginIds.includes("openai") ? openaiProviders : [];
        });

        resolveOwningPluginIdsForProviderMock.mockReset();
        resolveOwningPluginIdsForProviderMock.mockImplementation((params) => {
          switch (params.provider) {
            case "azure-openai-responses":
            case "openai":
            case "openai-codex":
              return ["openai"];
            default:
              return undefined;
          }
        });

        resolveCatalogHookProviderPluginIdsMock.mockReset();
        resolveCatalogHookProviderPluginIdsMock.mockReturnValue(["openai"]);
      });

      it("keeps codex-only missing-auth hints wired through the provider runtime", async () => {
        const { openaiProvider } = await contractDepsPromise;
        expectCodexMissingAuthHint(
          (params) => openaiProvider.buildMissingAuthMessage?.(params.context) ?? undefined,
          "openai-codex/gpt-5.5",
        );
      });

      it("keeps built-in model suppression wired through the provider runtime", async () => {
        const { resolveProviderBuiltInModelSuppression } = await contractDepsPromise;
        expectCodexBuiltInSuppression(resolveProviderBuiltInModelSuppression);
      });

      it("keeps bundled model augmentation wired through the provider runtime", async () => {
        const { augmentModelCatalogWithProviderPlugins } = await contractDepsPromise;
        await expectAugmentedCodexCatalog(
          augmentModelCatalogWithProviderPlugins,
          expectedAugmentedOpenaiCodexCatalogEntriesWithGpt55,
        );
      });
    },
  );
}
