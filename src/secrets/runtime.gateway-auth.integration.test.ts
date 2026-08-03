/** Integration tests for Gateway auth secret surfaces in the secrets runtime. */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { getRuntimeConfig, writeConfigFile } from "../config/config.js";
import { withTempHome } from "../config/home-env.test-harness.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  asConfig,
  beginSecretsRuntimeIsolationForTest,
  EMPTY_LOADABLE_PLUGIN_ORIGINS,
  endSecretsRuntimeIsolationForTest,
  loadAuthStoreWithProfiles,
  SECRETS_RUNTIME_INTEGRATION_TIMEOUT_MS,
  type SecretsRuntimeEnvSnapshot,
} from "./runtime.integration.test-helpers.js";
import {
  activateSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "./runtime.js";

vi.unmock("../version.js");

describe("secrets runtime snapshot gateway-auth integration", () => {
  let envSnapshot: SecretsRuntimeEnvSnapshot;

  beforeEach(() => {
    envSnapshot = beginSecretsRuntimeIsolationForTest();
  });

  afterEach(() => {
    endSecretsRuntimeIsolationForTest(envSnapshot);
  });

  it("fails fast at startup when gateway auth SecretRef is active and unresolved", async () => {
    await withEnvAsync(
      {
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_VERSION: undefined,
      },
      async () => {
        await expect(
          prepareSecretsRuntimeSnapshot({
            config: asConfig({
              gateway: {
                auth: {
                  mode: "token",
                  token: {
                    source: "env",
                    provider: "default",
                    id: "MISSING_GATEWAY_AUTH_TOKEN",
                  },
                },
              },
            }),
            env: {},
            agentDirs: ["/tmp/openclaw-agent-main"],
            loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
            loadAuthStore: () => ({ version: 1, profiles: {} }),
          }),
        ).rejects.toThrow(/MISSING_GATEWAY_AUTH_TOKEN/i);
      },
    );
  });

  it(
    "rejects unresolved active gateway auth refs before persisting them",
    async () => {
      await withTempHome("openclaw-secrets-runtime-gateway-auth-reload-lkg-", async (home) => {
        const initialTokenRef = {
          source: "env",
          provider: "default",
          id: "GATEWAY_AUTH_TOKEN",
        } as const;
        const missingTokenRef = {
          source: "env",
          provider: "default",
          id: "MISSING_GATEWAY_AUTH_TOKEN",
        } as const;
        await fs.mkdir(path.join(home, ".openclaw"), { recursive: true });
        await fs.writeFile(
          path.join(home, ".openclaw", "openclaw.json"),
          `${JSON.stringify(
            {
              gateway: {
                auth: {
                  mode: "token",
                  token: initialTokenRef,
                },
              },
            },
            null,
            2,
          )}\n`,
          "utf8",
        );

        const prepared = await prepareSecretsRuntimeSnapshot({
          config: asConfig({
            gateway: {
              auth: {
                mode: "token",
                token: initialTokenRef,
              },
            },
          }),
          env: {
            GATEWAY_AUTH_TOKEN: "gateway-runtime-token",
          },
          agentDirs: ["/tmp/openclaw-agent-main"],
          loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
          loadAuthStore: () => loadAuthStoreWithProfiles({}),
        });

        activateSecretsRuntimeSnapshot(prepared);
        expect(getRuntimeConfig().gateway?.auth?.token).toBe("gateway-runtime-token");

        await expect(
          writeConfigFile({
            ...getRuntimeConfig(),
            gateway: {
              auth: {
                mode: "token",
                token: missingTokenRef,
              },
            },
          }),
        ).rejects.toThrow(/active SecretRef resolution failed: .*MISSING_GATEWAY_AUTH_TOKEN/i);

        const activeAfterFailure = getActiveSecretsRuntimeSnapshot();
        if (activeAfterFailure === null) {
          throw new Error("Expected active secrets runtime snapshot");
        }
        expect(getRuntimeConfig().gateway?.auth?.token).toBe("gateway-runtime-token");
        expect(activeAfterFailure.sourceConfig.gateway?.auth?.token).toEqual(initialTokenRef);

        const persistedConfig = JSON.parse(
          await fs.readFile(path.join(home, ".openclaw", "openclaw.json"), "utf8"),
        ) as OpenClawConfig;
        expect(persistedConfig.gateway?.auth?.token).toEqual(initialTokenRef);
      });
    },
    SECRETS_RUNTIME_INTEGRATION_TIMEOUT_MS,
  );
});
