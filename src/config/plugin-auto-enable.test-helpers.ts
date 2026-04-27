import fs from "node:fs";
import path from "node:path";
import { clearPluginDiscoveryCache } from "../plugins/discovery.js";
import {
  clearPluginManifestRegistryCache,
  type PluginManifestRegistry,
} from "../plugins/manifest-registry.js";
import { clearPluginSetupRegistryCache } from "../plugins/setup-registry.js";
import {
  cleanupTrackedTempDirs,
  makeTrackedTempDir,
  mkdirSafeDir,
} from "../plugins/test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

export function resetPluginAutoEnableTestState(): void {
  clearPluginDiscoveryCache();
  clearPluginManifestRegistryCache();
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
    VITEST: "true",
    ...overrides,
  };
}

export function writePluginManifestFixture(params: {
  rootDir: string;
  id: string;
  channels: string[];
}): void {
  mkdirSafeDir(params.rootDir);
  fs.writeFileSync(
    path.join(params.rootDir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: params.id,
        channels: params.channels,
        configSchema: { type: "object" },
      },
      null,
      2,
    ),
    "utf-8",
  );
  fs.writeFileSync(path.join(params.rootDir, "index.ts"), "export default {}", "utf-8");
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
    configSchema?: Record<string, unknown>;
    channelConfigs?: Record<string, { schema: Record<string, unknown>; preferOver?: string[] }>;
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
      origin: "config" as const,
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

export function makeBluebubblesAndImessageChannels() {
  return {
    bluebubbles: { serverUrl: "http://localhost:1234", password: "x" },
    imessage: { cliPath: "/usr/local/bin/imsg" },
  };
}
