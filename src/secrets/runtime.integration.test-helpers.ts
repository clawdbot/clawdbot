import { vi } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { clearPluginDiscoveryCache } from "../plugins/discovery.js";
import { clearPluginLoaderCache } from "../plugins/loader.js";
import { clearPluginManifestRegistryCache } from "../plugins/manifest-registry.js";
import { __testing as webFetchProvidersTesting } from "../plugins/web-fetch-providers.runtime.js";
import { __testing as webSearchProvidersTesting } from "../plugins/web-search-providers.runtime.js";
import { captureEnv } from "../test-utils/env.js";
import type { SecretsRuntimeEnvSnapshot } from "./runtime-openai-file-fixture.test-helper.js";
export {
  asConfig,
  createOpenAIFileRuntimeConfig,
  createOpenAIFileRuntimeFixture,
  EMPTY_LOADABLE_PLUGIN_ORIGINS,
  expectResolvedOpenAIRuntime,
  loadAuthStoreWithProfiles,
  OPENAI_ENV_KEY_REF,
  OPENAI_FILE_KEY_REF,
} from "./runtime-openai-file-fixture.test-helper.js";
export type { SecretsRuntimeEnvSnapshot } from "./runtime-openai-file-fixture.test-helper.js";
import { clearSecretsRuntimeSnapshot } from "./runtime.js";

export const SECRETS_RUNTIME_INTEGRATION_TIMEOUT_MS = 300_000;

export function beginSecretsRuntimeIsolationForTest(): SecretsRuntimeEnvSnapshot {
  const envSnapshot = captureEnv([
    "OPENCLAW_BUNDLED_PLUGINS_DIR",
    "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
    "OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE",
    "OPENCLAW_VERSION",
  ]);
  delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  process.env.OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE = "1";
  delete process.env.OPENCLAW_VERSION;
  return envSnapshot;
}

export function endSecretsRuntimeIsolationForTest(envSnapshot: SecretsRuntimeEnvSnapshot) {
  vi.restoreAllMocks();
  envSnapshot.restore();
  clearSecretsRuntimeSnapshot();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  clearPluginLoaderCache();
  clearPluginDiscoveryCache();
  clearPluginManifestRegistryCache();
  webSearchProvidersTesting.resetWebSearchProviderSnapshotCacheForTests();
  webFetchProvidersTesting.resetWebFetchProviderSnapshotCacheForTests();
}
