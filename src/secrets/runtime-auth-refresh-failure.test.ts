/** Tests secrets runtime refresh handling for auth-profile stores. */
import fs from "node:fs/promises";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome } from "../config/home-env.test-harness.js";
import { resolveAuthProfileSecretOwnerId } from "./runtime-auth-profile-owner.js";
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
import { listActiveDegradedSecretOwners } from "./runtime-degraded-state.js";
import {
  activateSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
  refreshActiveProviderAuthRuntimeSnapshot,
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

  it("classifies a changed auth-profile ref as stale after a successful refresh", async () => {
    if (os.platform() === "win32") {
      return;
    }
    await withTempHome("openclaw-secrets-runtime-refresh-owner-", async (home) => {
      const { secretFile, agentDir } = await createOpenAIFileRuntimeFixture(home);
      const firstRef = { source: "file" as const, provider: "default", id: "/accounts/first" };
      const secondRef = { source: "file" as const, provider: "default", id: "/accounts/second" };
      let activeRef = firstRef;
      const loadAuthStore = () =>
        loadAuthStoreWithProfiles({
          "openai:default": {
            type: "api_key",
            provider: "openai",
            keyRef: activeRef,
          },
        });
      const writeSecrets = async (includeSecond: boolean) => {
        await fs.writeFile(
          secretFile,
          `${JSON.stringify({
            providers: { openai: { apiKey: "test-api-key" } },
            accounts: {
              first: "first-fixture",
              ...(includeSecond ? { second: "second-fixture" } : {}),
            },
          })}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
      };

      await writeSecrets(true);
      const prepared = await prepareSecretsRuntimeSnapshot({
        config: createOpenAIFileRuntimeConfig(secretFile),
        agentDirs: [agentDir],
        loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
        loadAuthStore,
      });
      const pluginOwners = [
        {
          ownerKind: "plugin-route" as const,
          ownerId: "audit.auth-profiles.route:routes.main.token",
          path: "plugins.entries.audit.auth-profiles.route.config.routes.main.token",
        },
        {
          ownerKind: "plugin-capability" as const,
          ownerId: "audit:auth-profiles.capability",
          path: "plugins.entries.audit.config.auth-profiles.capability.token",
        },
        {
          ownerKind: "plugin-provider" as const,
          ownerId: "audit.auth-profiles.provider:provider",
          path: 'plugins.entries.audit.auth-profiles.provider.config.headers["X.Trace"]',
        },
      ];
      const pluginWarnings = pluginOwners.map(({ ownerKind, path }) => ({
        code: "SECRETS_OWNER_UNAVAILABLE" as const,
        path,
        message: `${ownerKind} remains unavailable.`,
      }));
      prepared.secretOwners = [
        ...(prepared.secretOwners ?? []),
        {
          ownerKind: "account",
          ownerId: "discord:ops",
          refKeys: ["env:default:DISCORD_BOT_TOKEN"],
        },
        ...pluginOwners.map(({ ownerKind, ownerId }) => ({
          ownerKind,
          ownerId,
          refKeys: [`env:default:${ownerId}`],
        })),
      ];
      prepared.degradedOwners = [
        {
          ownerKind: "account",
          ownerId: "discord:ops",
          state: "unavailable",
          degradationState: "cold",
          paths: ["channels.discord.accounts.ops.token"],
          refKeys: ["env:default:DISCORD_BOT_TOKEN"],
          reason: "secret reference could not be resolved",
        },
        ...pluginOwners.map(({ ownerKind, ownerId, path }) => ({
          ownerKind,
          ownerId,
          state: "unavailable" as const,
          degradationState: "cold" as const,
          paths: [path],
          refKeys: [`env:default:${ownerId}`],
          reason: "secret reference could not be resolved",
        })),
      ];
      prepared.warnings = [
        {
          code: "SECRETS_OWNER_UNAVAILABLE",
          path: "channels.discord.accounts.ops.token",
          message: "Discord account ops remains unavailable.",
        },
        ...pluginWarnings,
        {
          code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
          path: "models.providers.openai.apiKey",
          message: "Old provider warning must be replaced.",
        },
        {
          code: "SECRETS_REF_OVERRIDES_PLAINTEXT",
          path: `${agentDir}.auth-profiles.openai:default.key`,
          message: "Old auth profile warning must be replaced.",
        },
      ];
      activateSecretsRuntimeSnapshot(prepared);

      activeRef = secondRef;
      await expect(refreshActiveProviderAuthRuntimeSnapshot()).resolves.toBe(true);
      expect(expectActiveSecretsRuntimeSnapshot().secretOwners).toContainEqual({
        ownerKind: "account",
        ownerId: "discord:ops",
        refKeys: ["env:default:DISCORD_BOT_TOKEN"],
      });
      expect(
        expectActiveSecretsRuntimeSnapshot().degradedOwners?.filter(
          (owner) => owner.ownerId === "discord:ops",
        ),
      ).toHaveLength(1);
      for (const { ownerKind, ownerId } of pluginOwners) {
        expect(expectActiveSecretsRuntimeSnapshot().secretOwners).toContainEqual(
          expect.objectContaining({ ownerKind, ownerId }),
        );
        expect(listActiveDegradedSecretOwners()).toContainEqual(
          expect.objectContaining({ ownerKind, ownerId }),
        );
      }
      expect(expectActiveSecretsRuntimeSnapshot().warnings).toEqual(
        expect.arrayContaining(pluginWarnings),
      );
      expect(expectActiveSecretsRuntimeSnapshot().warnings).not.toContainEqual(
        expect.objectContaining({ message: "Old provider warning must be replaced." }),
      );
      expect(expectActiveSecretsRuntimeSnapshot().warnings).not.toContainEqual(
        expect.objectContaining({ message: "Old auth profile warning must be replaced." }),
      );
      await writeSecrets(false);

      await expect(refreshActiveProviderAuthRuntimeSnapshot()).resolves.toBe(true);
      expect(listActiveDegradedSecretOwners()).toContainEqual(
        expect.objectContaining({
          ownerKind: "account",
          ownerId: resolveAuthProfileSecretOwnerId({ agentDir, profileId: "openai:default" }),
          degradationState: "stale",
        }),
      );
      expect(
        listActiveDegradedSecretOwners().filter((owner) => owner.ownerId === "discord:ops"),
      ).toHaveLength(1);
      expect(expectActiveSecretsRuntimeSnapshot().warnings).toContainEqual({
        code: "SECRETS_OWNER_UNAVAILABLE",
        path: "channels.discord.accounts.ops.token",
        message: "Discord account ops remains unavailable.",
      });
      expect(expectActiveSecretsRuntimeSnapshot().warnings).toEqual(
        expect.arrayContaining([
          ...pluginWarnings,
          expect.objectContaining({
            code: "SECRETS_OWNER_UNAVAILABLE",
            path: `${agentDir}.auth-profiles.openai:default.key`,
          }),
        ]),
      );
      for (const { ownerKind, ownerId } of pluginOwners) {
        expect(listActiveDegradedSecretOwners()).toContainEqual(
          expect.objectContaining({ ownerKind, ownerId }),
        );
      }
      const profile = expectActiveSecretsRuntimeSnapshot().authStores.find(
        (entry) => entry.agentDir === agentDir,
      )?.store.profiles["openai:default"];
      expect(profile).toMatchObject({ type: "api_key", key: "second-fixture" });
    });
  });

  it("makes an auth-profile credential cold when its provider endpoint changes", async () => {
    if (os.platform() === "win32") {
      return;
    }
    await withTempHome("openclaw-secrets-runtime-auth-route-", async (home) => {
      const { secretFile, agentDir } = await createOpenAIFileRuntimeFixture(home);
      const profileId = "openai:default";
      const loadAuthStore = () =>
        loadAuthStoreWithProfiles({
          [profileId]: {
            type: "api_key",
            provider: "openai",
            keyRef: OPENAI_FILE_KEY_REF,
          },
        });
      const config = (baseUrl: string) => {
        const candidate = createOpenAIFileRuntimeConfig(secretFile);
        const openai = candidate.models?.providers?.openai;
        if (openai) {
          openai.baseUrl = baseUrl;
        }
        return candidate;
      };
      const active = await prepareSecretsRuntimeSnapshot({
        config: config("https://old.example.invalid/v1"),
        agentDirs: [agentDir],
        loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
        loadAuthStore,
      });
      activateSecretsRuntimeSnapshot(active);
      await fs.unlink(secretFile);

      const candidate = await prepareSecretsRuntimeSnapshot({
        config: config("https://new.example.invalid/v1"),
        agentDirs: [agentDir],
        allowUnavailableSecretOwners: true,
        loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
        loadAuthStore,
      });

      expect(candidate.degradedOwners).toContainEqual(
        expect.objectContaining({
          ownerKind: "account",
          ownerId: resolveAuthProfileSecretOwnerId({ agentDir, profileId }),
          degradationState: "cold",
        }),
      );
      expect(candidate.authStores[0]?.store.profiles[profileId]).toMatchObject({
        type: "api_key",
        keyRef: OPENAI_FILE_KEY_REF,
        key: undefined,
      });
    });
  });
});
