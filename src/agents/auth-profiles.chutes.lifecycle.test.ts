import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetFileLockStateForTest } from "../infra/file-lock.js";
import { isPluginRegistryLoadInFlight } from "../plugins/loader-cache.js";
import {
  cleanupPluginLoaderFixturesForTest,
  loadOpenClawPlugins,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { resolveProviderOAuthCredentialWithPlugin } from "../plugins/provider-runtime.runtime.js";
import { resolveProviderRefOwnership } from "../plugins/providers.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  resolveApiKeyForProfile,
  type AuthProfileStore,
} from "./auth-profiles.js";
import { loadPersistedAuthProfileStore } from "./auth-profiles/persisted.js";

const START_AUTH_CALLBACK = "__openclawChutesLifecycleStart";
const DISABLED_REGISTER_CALLBACK = "__openclawDisabledChutesRegister";

function writeChutesPlugin(params: { id: string; registerBody: string }) {
  useNoBundledPlugins();
  const plugin = writePlugin({
    id: params.id,
    body: `module.exports = {
      id: ${JSON.stringify(params.id)},
      register(api) {
        ${params.registerBody}
      },
    };`,
  });
  fs.writeFileSync(
    path.join(plugin.dir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: params.id,
        providers: ["chutes"],
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      },
      null,
      2,
    ),
    "utf8",
  );
  return plugin;
}

function createPluginConfig(params: { id: string; file: string; enabled: boolean }) {
  return {
    plugins: {
      allow: [params.id],
      load: { paths: [params.file] },
      entries: { [params.id]: { enabled: params.enabled } },
    },
  } satisfies OpenClawConfig;
}

beforeEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  resetFileLockStateForTest();
  resetPluginLoaderTestStateForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearRuntimeAuthProfileStoreSnapshots();
  resetFileLockStateForTest();
  resetPluginLoaderTestStateForTest();
});

afterAll(cleanupPluginLoaderFixturesForTest);

describe("Chutes auth-profile plugin lifecycle", () => {
  it("resumes an expired OAuth refresh after synchronous provider registration completes", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-chutes-lifecycle-", agentEnv: "main" },
      async (state) => {
        const expiredCredential = {
          type: "oauth" as const,
          provider: "chutes",
          access: "at_old",
          refresh: "rt_old",
          expires: 1,
          clientId: "cid_test",
        };
        const refreshedCredential = {
          ...expiredCredential,
          access: "at_new",
          refresh: "rt_new",
          expires: 4_102_444_800_000,
        };
        const initialStore: AuthProfileStore = {
          version: 1,
          profiles: { "chutes:default": expiredCredential },
        };
        await state.writeAuthProfiles(initialStore);
        const store = ensureAuthProfileStore();
        const plugin = writeChutesPlugin({
          id: "chutes-lifecycle",
          registerBody: `
            globalThis[${JSON.stringify(START_AUTH_CALLBACK)}]();
            api.registerProvider({
              id: "chutes",
              label: "Chutes",
              auth: [],
              async refreshOAuth(credential) {
                return {
                  ...credential,
                  access: "at_new",
                  refresh: "rt_new",
                  expires: 4102444800000,
                };
              },
            });
          `,
        });
        const config = createPluginConfig({ id: plugin.id, file: plugin.file, enabled: true });
        const loadOptions: NonNullable<Parameters<typeof loadOpenClawPlugins>[0]> = {
          cache: false,
          workspaceDir: plugin.dir,
          config,
          onlyPluginIds: [plugin.id],
        };
        let authResolution: ReturnType<typeof resolveApiKeyForProfile> | undefined;
        const startAuthDuringRegister = vi.fn(() => {
          if (authResolution) {
            throw new Error("Chutes lifecycle fixture registered more than once");
          }
          expect(isPluginRegistryLoadInFlight(loadOptions)).toBe(true);
          authResolution = resolveApiKeyForProfile({
            cfg: config,
            store,
            profileId: "chutes:default",
          });
        });
        vi.stubGlobal(START_AUTH_CALLBACK, startAuthDuringRegister);

        loadOpenClawPlugins(loadOptions);

        expect(isPluginRegistryLoadInFlight(loadOptions)).toBe(false);
        if (!authResolution) {
          throw new Error("Chutes lifecycle fixture did not start auth resolution");
        }
        await expect(authResolution).resolves.toMatchObject({ apiKey: "at_new" });
        expect(loadPersistedAuthProfileStore(state.agentDir())?.profiles["chutes:default"]).toEqual(
          refreshedCredential,
        );
        expect(startAuthDuringRegister).toHaveBeenCalledOnce();
      },
    );
  });

  it("distinguishes an explicitly disabled owner from an unowned provider", async () => {
    const disabledRegister = vi.fn();
    vi.stubGlobal(DISABLED_REGISTER_CALLBACK, disabledRegister);
    const plugin = writeChutesPlugin({
      id: "disabled-chutes",
      registerBody: `globalThis[${JSON.stringify(DISABLED_REGISTER_CALLBACK)}]();`,
    });
    const config = createPluginConfig({ id: plugin.id, file: plugin.file, enabled: false });
    const credential = {
      type: "oauth" as const,
      provider: "chutes",
      access: "at_old",
      refresh: "rt_old",
      expires: 1,
    };

    expect(
      resolveProviderRefOwnership({ provider: "chutes", config, workspaceDir: plugin.dir }),
    ).toEqual({ status: "owned", pluginIds: [plugin.id] });
    await expect(
      resolveProviderOAuthCredentialWithPlugin({
        provider: "chutes",
        config,
        workspaceDir: plugin.dir,
        credential,
        refresh: true,
      }),
    ).resolves.toEqual({ status: "configured-unavailable" });
    await expect(
      resolveProviderOAuthCredentialWithPlugin({
        provider: "not-owned",
        config,
        workspaceDir: plugin.dir,
        credential: { ...credential, provider: "not-owned" },
        refresh: true,
      }),
    ).resolves.toEqual({ status: "unowned" });
    expect(disabledRegister).not.toHaveBeenCalled();
  });
});
