import path from "node:path";
import { clearCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { type PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { type PluginOrigin } from "../plugins/plugin-origin.types.js";
import { clearPluginSetupRegistryCache } from "../plugins/setup-registry.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "../plugins/test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

export function resetPluginAutoEnableTestState(): void {
  clearCurrentPluginMetadataSnapshot();
  clearPluginSetupRegistryCache();
  cleanupTrackedTempDirs(tempDirs);
}

export function makeTempDir(): string {
  return makeTrackedTempDir("openclaw-plugin-auto-enable", tempDirs);
}

export function makeIsolatedEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const rootDir = makeTempDir();
  return {
    OPENCLAW_STATE_DIR: path.join(rootDir, "state"),
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(process.cwd(), "extensions"),
    OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
    VITEST: "true",
    ...overrides,
  };
}

export function makeRegistry(
  plugins: Array<{
    id: string;
    channels: string[];
    activation?: { onAgentHarnesses?: string[] };
    autoEnableWhenConfiguredProviders?: string[];
    modelSupport?: { modelPrefixes?: string[]; modelPatterns?: string[] };
    contracts?: { webSearchProviders?: string[]; webFetchProviders?: string[]; tools?: string[] };
    providers?: string[];
    cliBackends?: string[];
    origin?: PluginOrigin;
    configSchema?: Record<string, unknown>;
    channelConfigs?: Record<
      string,
      { schema: Record<string, unknown>; label?: string; preferOver?: string[] }
    >;
  }>,
): PluginManifestRegistry {
  return {
    plugins: plugins.map((plugin) => ({
      id: plugin.id,
      channels: plugin.channels,
      activation: plugin.activation,
      autoEnableWhenConfiguredProviders: plugin.autoEnableWhenConfiguredProviders,
      modelSupport: plugin.modelSupport,
      contracts: plugin.contracts,
      configSchema: plugin.configSchema,
      channelConfigs: plugin.channelConfigs,
      providers: plugin.providers ?? [],
      cliBackends: plugin.cliBackends ?? [],
      skills: [],
      hooks: [],
      origin: plugin.origin ?? "config",
      rootDir: `/fake/${plugin.id}`,
      source: `/fake/${plugin.id}/index.js`,
      manifestPath: `/fake/${plugin.id}/openclaw.plugin.json`,
    })),
    diagnostics: [],
  };
}

export function makeApnChannelConfig() {
  return { channels: { apn: { someKey: "value" } } };
}
