// Verifies models.json planning reuses prepared plugin metadata for provider aliases.
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";

const manifestRegistry = {
  diagnostics: [],
  plugins: [
    {
      id: "xai",
      channels: [],
      cliBackends: [],
      hooks: [],
      origin: "bundled",
      manifestPath: "/tmp/xai/openclaw.plugin.json",
      providers: ["xai"],
      providerAuthAliases: { "x-ai": "xai" },
      rootDir: "/tmp/xai",
      skills: [],
      source: "/tmp/xai/index.js",
    },
  ],
};

vi.mock("./model-auth-env-vars.js", () => ({
  listKnownProviderEnvApiKeyNames: () => ["OPENAI_API_KEY"],
  resolveProviderEnvAuthLookupMaps: () => ({
    aliasMap: {},
    envCandidateMap: {},
    authEvidenceMap: {},
  }),
}));

let planOpenClawModelsJsonWithDeps: typeof import("./models-config.plan.test-support.js").planOpenClawModelsJsonWithDeps;
let loadPluginManifestRegistrySpy: MockInstance | undefined;
let loadBundledPluginPublicArtifactModuleSyncSpy: MockInstance | undefined;
let bundledPluginsDir: string;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const originalTrustBundledPluginsDir = process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;

beforeAll(async () => {
  bundledPluginsDir = tempDirs.make("openclaw-provider-policy-registry-");
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;
  process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";

  const manifestRegistryModule = await import("../plugins/manifest-registry.js");
  loadPluginManifestRegistrySpy = vi
    .spyOn(manifestRegistryModule, "loadPluginManifestRegistry")
    .mockReturnValue(manifestRegistry as never);
  const publicSurfaceLoader = await import("../plugins/public-surface-loader.js");
  loadBundledPluginPublicArtifactModuleSyncSpy = vi
    .spyOn(publicSurfaceLoader, "loadBundledPluginPublicArtifactModuleSync")
    .mockImplementation(({ dirName }: { dirName: string }) => {
      if (dirName !== "xai") {
        throw new Error(`Unable to resolve bundled plugin public surface ${dirName}`);
      }
      return {
        normalizeConfig: ({
          providerConfig,
        }: {
          providerConfig: ProviderConfig;
        }): ProviderConfig => ({
          ...providerConfig,
          baseUrl: "https://normalized.example/v1",
        }),
      };
    });
  ({ planOpenClawModelsJsonWithDeps } = await import("./models-config.plan.test-support.js"));
});

afterAll(() => {
  loadPluginManifestRegistrySpy?.mockRestore();
  loadBundledPluginPublicArtifactModuleSyncSpy?.mockRestore();
  if (originalBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledPluginsDir;
  }
  if (originalTrustBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = originalTrustBundledPluginsDir;
  }
});

describe("models-config provider policy registry", () => {
  it("does not reload manifests while resolving an alias-owned provider policy", async () => {
    loadPluginManifestRegistrySpy?.mockClear();
    loadBundledPluginPublicArtifactModuleSyncSpy?.mockClear();
    const pluginMetadataSnapshot = {
      index: { plugins: [] },
      manifestRegistry,
      owners: {
        providers: new Map(),
        modelCatalogProviders: new Map(),
        setupProviders: new Map(),
      },
    } as unknown as Pick<
      PluginMetadataSnapshot,
      "index" | "manifestRegistry" | "owners" | "pluginIds"
    >;

    const plan = await planOpenClawModelsJsonWithDeps(
      {
        cfg: { models: { providers: {} } },
        agentDir: "/tmp/openclaw-provider-policy-registry-test/agent",
        env: {},
        existingRaw: "",
        existingParsed: null,
        pluginMetadataSnapshot,
      },
      {
        resolveImplicitProviders: async () => ({
          "x-ai": {
            baseUrl: "https://mock.example/v1",
            api: "openai-responses",
            apiKey: "OPENAI_API_KEY",
            models: [],
          },
        }),
      },
    );

    expect(plan.action).toBe("write");
    expect(
      plan.action === "write" ? JSON.parse(plan.contents).providers["x-ai"].baseUrl : null,
    ).toBe("https://normalized.example/v1");
    expect(loadBundledPluginPublicArtifactModuleSyncSpy).toHaveBeenCalledWith({
      dirName: "xai",
      artifactBasename: "provider-policy-api.js",
    });
    expect(loadPluginManifestRegistrySpy).not.toHaveBeenCalled();
  });
});
