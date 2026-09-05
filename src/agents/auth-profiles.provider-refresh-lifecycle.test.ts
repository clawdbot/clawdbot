import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetFileLockStateForTest } from "../infra/file-lock.js";
import { isPluginRegistryLoadInFlight } from "../plugins/loader-cache.js";
import {
  cleanupPluginLoaderFixturesForTest,
  EMPTY_PLUGIN_SCHEMA,
  loadOpenClawPlugins,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  oauthCred,
  readAuthProfileStoreForTest,
  storeWith,
} from "./auth-profiles/oauth-test-utils.js";
import { resolveApiKeyForProfile } from "./auth-profiles/oauth.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./auth-profiles/runtime-snapshots.js";

const startAuthChannel = channel("openclaw.test.providerRefreshLifecycleStart");
const PLUGIN_ID = "provider-refresh-lifecycle";
const PROVIDER_ID = "lifecycle-provider";
const PROFILE_ID = `${PROVIDER_ID}:default`;

function writeLifecycleProviderPlugin(registerBody: string) {
  useNoBundledPlugins();
  const plugin = writePlugin({
    id: PLUGIN_ID,
    body: `module.exports = {
      id: ${JSON.stringify(PLUGIN_ID)},
      register(api) {
        ${registerBody}
      },
    };`,
  });
  fs.writeFileSync(
    path.join(plugin.dir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: plugin.id,
        providers: [PROVIDER_ID],
        configSchema: EMPTY_PLUGIN_SCHEMA,
      },
      null,
      2,
    ),
    "utf8",
  );
  return plugin;
}

beforeEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  resetFileLockStateForTest();
  resetPluginLoaderTestStateForTest();
});

afterEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  resetFileLockStateForTest();
  resetPluginLoaderTestStateForTest();
});

afterAll(cleanupPluginLoaderFixturesForTest);

describe("provider OAuth refresh lifecycle", () => {
  it("resumes refresh after synchronous provider registration completes", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-provider-refresh-", agentEnv: "main" },
      async (state) => {
        const expiredCredential = oauthCred({
          provider: PROVIDER_ID,
          access: "access-old",
          refresh: "refresh-old",
          expires: 1,
        });
        const refreshedCredential = {
          ...expiredCredential,
          access: "access-new",
          refresh: "refresh-new",
          expires: 4_102_444_800_000,
        };
        const initialStore = storeWith(PROFILE_ID, expiredCredential);
        await state.writeAuthProfiles(initialStore);
        const plugin = writeLifecycleProviderPlugin(`
          require("node:diagnostics_channel").channel(${JSON.stringify(startAuthChannel.name)}).publish();
          api.registerProvider({
            id: ${JSON.stringify(PROVIDER_ID)},
            label: "Lifecycle Provider",
            auth: [],
            async refreshOAuth(credential) {
              return {
                ...credential,
                access: "access-new",
                refresh: "refresh-new",
                expires: 4102444800000,
              };
            },
          });
        `);
        const config = {
          plugins: {
            allow: [plugin.id],
            load: { paths: [plugin.file] },
            entries: { [plugin.id]: { enabled: true } },
          },
        } satisfies OpenClawConfig;
        const loadOptions: NonNullable<Parameters<typeof loadOpenClawPlugins>[0]> = {
          cache: false,
          workspaceDir: plugin.dir,
          config,
          onlyPluginIds: [plugin.id],
        };
        let authResolution: ReturnType<typeof resolveApiKeyForProfile> | undefined;
        let registrationStarted = false;
        const startAuthDuringRegister = vi.fn(() => {
          if (registrationStarted) {
            throw new Error("provider lifecycle fixture registered more than once");
          }
          registrationStarted = true;
          expect(isPluginRegistryLoadInFlight(loadOptions)).toBe(true);
          authResolution = resolveApiKeyForProfile({
            cfg: config,
            store: initialStore,
            profileId: PROFILE_ID,
          });
        });
        startAuthChannel.subscribe(startAuthDuringRegister);
        try {
          loadOpenClawPlugins(loadOptions);

          expect(isPluginRegistryLoadInFlight(loadOptions)).toBe(false);
          if (!authResolution) {
            throw new Error("provider lifecycle fixture did not start auth resolution");
          }
          await expect(authResolution).resolves.toMatchObject({ apiKey: "access-new" });
          expect(readAuthProfileStoreForTest(state.agentDir()).profiles[PROFILE_ID]).toEqual(
            refreshedCredential,
          );
          expect(startAuthDuringRegister).toHaveBeenCalledOnce();
        } finally {
          startAuthChannel.unsubscribe(startAuthDuringRegister);
        }
      },
    );
  });
});
