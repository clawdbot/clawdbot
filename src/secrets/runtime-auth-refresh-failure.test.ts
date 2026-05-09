import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome } from "../config/home-env.test-harness.js";
import {
  beginSecretsRuntimeIsolationForTest,
  createOpenAIFileRuntimeConfig,
  createOpenAIFileRuntimeFixture,
  EMPTY_LOADABLE_PLUGIN_ORIGINS,
  endSecretsRuntimeIsolationForTest,
  expectResolvedOpenAIRuntime,
  loadAuthStoreWithProfiles,
  OPENAI_FILE_KEY_REF,
  type SecretsRuntimeEnvSnapshot,
} from "./runtime-auth.integration.test-helpers.js";
import {
  activateSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "./runtime.js";

vi.unmock("../version.js");

function expectActiveSecretsRuntimeSnapshot(): NonNullable<
  ReturnType<typeof getActiveSecretsRuntimeSnapshot>
> {
  const snapshot = getActiveSecretsRuntimeSnapshot();
  if (snapshot === null) {
    throw new Error("Expected active secrets runtime snapshot");
  }
  return snapshot;
}

describe("secrets runtime snapshot auth refresh failure", () => {
  let envSnapshot: SecretsRuntimeEnvSnapshot;

  beforeEach(() => {
    envSnapshot = beginSecretsRuntimeIsolationForTest();
  });

  afterEach(() => {
    endSecretsRuntimeIsolationForTest(envSnapshot);
  });

  it("keeps last-known-good runtime snapshot active when refresh preparation fails", async () => {
    if (os.platform() === "win32") {
      return;
    }
    await withTempHome("openclaw-secrets-runtime-refresh-fail-", async (home) => {
      const { secretFile, agentDir } = await createOpenAIFileRuntimeFixture(home);

      let loadAuthStoreCalls = 0;
      const loadAuthStore = () => {
        loadAuthStoreCalls += 1;
        if (loadAuthStoreCalls > 1) {
          throw new Error("simulated secrets runtime refresh failure");
        }
        return loadAuthStoreWithProfiles({
          "openai:default": {
            type: "api_key",
            provider: "openai",
            keyRef: OPENAI_FILE_KEY_REF,
          },
        });
      };

      const prepared = await prepareSecretsRuntimeSnapshot({
        config: createOpenAIFileRuntimeConfig(secretFile),
        agentDirs: [agentDir],
        loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
        loadAuthStore,
      });

      activateSecretsRuntimeSnapshot(prepared);
      expectResolvedOpenAIRuntime(agentDir);

      await expect(
        prepareSecretsRuntimeSnapshot({
          config: {
            ...createOpenAIFileRuntimeConfig(secretFile),
            gateway: { auth: { mode: "token" } },
          },
          agentDirs: [agentDir],
          loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
          loadAuthStore,
        }),
      ).rejects.toThrow(/simulated secrets runtime refresh failure/i);

      const activeAfterFailure = expectActiveSecretsRuntimeSnapshot();
      expectResolvedOpenAIRuntime(agentDir);
      expect(activeAfterFailure.sourceConfig.models?.providers?.openai?.apiKey).toEqual(
        OPENAI_FILE_KEY_REF,
      );
    });
  });
});
