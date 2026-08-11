/** Shared isolation helpers for auth-profile backed secrets runtime integration tests. */
import { vi } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { captureEnv } from "../test-utils/env.js";
import type { SecretsRuntimeEnvSnapshot } from "./runtime-openai-file-fixture.test-helper.js";

/** Shared integration helpers for auth-profile backed secrets runtime tests. */
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

const secretsRuntimePluginMocks = vi.hoisted(() => ({
  resolveExternalAuthProfilesWithPluginsMock: vi.fn(() => []),
  resolvePluginWebSearchProvidersMock: vi.fn(() => []),
}));

// Mock plugin-provided auth/web surfaces so auth integration tests only cover
// the configured stores and fixtures they explicitly install.
vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: secretsRuntimePluginMocks.resolvePluginWebSearchProvidersMock,
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveExternalAuthProfilesWithPlugins:
    secretsRuntimePluginMocks.resolveExternalAuthProfilesWithPluginsMock,
}));

/** Start an isolated secrets runtime test with plugin auth/web discovery disabled. */
export function beginSecretsRuntimeIsolationForTest(): SecretsRuntimeEnvSnapshot {
  secretsRuntimePluginMocks.resolveExternalAuthProfilesWithPluginsMock.mockReset();
  secretsRuntimePluginMocks.resolveExternalAuthProfilesWithPluginsMock.mockReturnValue([]);
  secretsRuntimePluginMocks.resolvePluginWebSearchProvidersMock.mockReset();
  secretsRuntimePluginMocks.resolvePluginWebSearchProvidersMock.mockReturnValue([]);
  const envSnapshot = captureEnv([
    "OPENCLAW_BUNDLED_PLUGINS_DIR",
    "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
    "OPENCLAW_VERSION",
  ]);
  delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  delete process.env.OPENCLAW_VERSION;
  return envSnapshot;
}

/** Restore env, mocks, config caches, and secrets runtime snapshot state. */
export function endSecretsRuntimeIsolationForTest(envSnapshot: SecretsRuntimeEnvSnapshot) {
  vi.restoreAllMocks();
  envSnapshot.restore();
  clearSecretsRuntimeSnapshot();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
}
