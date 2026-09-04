// Models auth provider-resolution tests cover provider auth status grouping and selection.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { clearAuthProfileMigrationDiagnostics } from "../agents/auth-profiles/legacy-source-diagnostic.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "../agents/auth-profiles/store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pluginLoaderCacheState } from "../plugins/registry-lifecycle.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { resolveRequestedLoginProviderOrThrow, runModelsAuthLoginFlowCore } from "./models/auth.js";

function makeProvider(params: { id: string; label?: string; aliases?: string[] }): ProviderPlugin {
  return {
    id: params.id,
    label: params.label ?? params.id,
    aliases: params.aliases,
    auth: [],
  };
}

describe("resolveRequestedLoginProviderOrThrow", () => {
  it("returns null and resolves provider by id/alias", () => {
    const providers = [
      makeProvider({ id: "google-gemini-cli", aliases: ["gemini-cli"] }),
      makeProvider({ id: "openai", aliases: ["openai"] }),
      makeProvider({ id: "minimax-portal" }),
    ];
    const scenarios = [
      { requested: undefined, expectedId: null },
      { requested: "google-gemini-cli", expectedId: "google-gemini-cli" },
      { requested: "gemini-cli", expectedId: "google-gemini-cli" },
      { requested: "openai", expectedId: "openai" },
    ] as const;

    for (const scenario of scenarios) {
      const result = resolveRequestedLoginProviderOrThrow(providers, scenario.requested);
      expect(result?.id ?? null).toBe(scenario.expectedId);
    }
  });

  it("throws when requested provider is not loaded", () => {
    const loadedProviders = [
      makeProvider({ id: "google-gemini-cli" }),
      makeProvider({ id: "minimax-portal" }),
    ];

    expect(() =>
      resolveRequestedLoginProviderOrThrow(loadedProviders, "google-antigravity"),
    ).toThrowError(
      'Unknown provider "google-antigravity". Loaded providers: google-gemini-cli, minimax-portal. Verify plugins via `openclaw plugins list --json`.',
    );
  });
});

describe("models auth login --force", () => {
  it("replaces expired shared and main-local profiles with the gateway stopped", async () => {
    const state = await createOpenClawTestState({
      label: "auth-force-login",
      env: {
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_OAUTH_DIR: undefined,
        OPENCLAW_GATEWAY_URL: undefined,
        OPENCLAW_GATEWAY_PORT: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
      },
    });
    try {
      pluginLoaderCacheState.clear();
      resetPluginRuntimeStateForTest();
      const provider = "authstore-proof";
      const freshId = `${provider}:fresh`;
      const fresh = { type: "token" as const, provider, token: "fixture-fresh-token" };
      const expired = { ...fresh, token: "fixture-expired-token", expires: 1 };
      const unrelated = { type: "token" as const, provider: "other-proof", token: "fixture-other" };
      const pluginDir = path.join(state.workspaceDir, ".openclaw", "extensions", provider);
      await fs.mkdir(pluginDir, { recursive: true, mode: 0o755 });
      await fs.writeFile(
        path.join(pluginDir, "openclaw.plugin.json"),
        JSON.stringify({
          id: provider,
          providers: [provider],
          configSchema: { type: "object", additionalProperties: false, properties: {} },
        }),
      );
      await fs.writeFile(
        path.join(pluginDir, "index.cjs"),
        `module.exports = {
          id: ${JSON.stringify(provider)},
          register(api) {
            api.registerProvider({
              id: ${JSON.stringify(provider)}, label: "Auth store proof",
              auth: [{ id: "token", label: "Fixture token", kind: "token",
                async run() {
                  return ${JSON.stringify({ profiles: [{ profileId: freshId, credential: fresh }] })};
                }
              }]
            });
          }
        };`,
      );
      const config: OpenClawConfig = {
        agents: { list: [{ id: "main", workspace: state.workspaceDir }] },
        plugins: { allow: [provider], entries: { [provider]: { enabled: true } } },
        gateway: {
          mode: "local",
          port: await getFreePort(),
          auth: { mode: "token", token: "fixture-gateway-token" },
        },
      };
      await state.writeConfig(config);
      saveAuthProfileStore(
        {
          version: 1,
          profiles: { [`${provider}:shared`]: expired, "other-proof:shared": unrelated },
        },
        undefined,
        { sharedStoreWrite: true, filterExternalAuthProfiles: false, syncExternalCli: false },
      );
      await state.writeAuthProfiles({
        version: 1,
        profiles: { [`${provider}:local`]: expired, "other-proof:local": unrelated },
        order: { [provider]: [`${provider}:local`] },
      });
      const unexpectedPrompt = async (): Promise<never> => {
        throw new Error("Unexpected interactive prompt in explicit fixture login");
      };
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      await runModelsAuthLoginFlowCore({
        provider,
        method: "token",
        agent: "main",
        force: true,
        config,
        runtime,
        prompter: createWizardPrompter({
          select: unexpectedPrompt,
          text: unexpectedPrompt,
          confirm: unexpectedPrompt,
        }),
      });

      expect(loadPersistedAuthProfileStore()?.profiles).toEqual({
        [freshId]: fresh,
        "other-proof:shared": unrelated,
      });
      const local = loadPersistedAuthProfileStore(state.agentDir());
      expect(local?.profiles).toEqual({ "other-proof:local": unrelated });
      expect(local?.order?.[provider]).toBeUndefined();
      expect(loadAuthProfileStoreWithoutExternalProfiles(state.agentDir()).profiles).toEqual({
        [freshId]: fresh,
        "other-proof:shared": unrelated,
        "other-proof:local": unrelated,
      });
      expect(runtime.log).toHaveBeenCalledWith(
        `Removed cached auth profiles for provider "${provider}" (--force). Running fresh auth flow.`,
      );
      expect(runtime.log).toHaveBeenCalledWith(`Auth profile: ${freshId} (${provider}/token)`);
    } finally {
      pluginLoaderCacheState.clear();
      resetPluginRuntimeStateForTest();
      clearRuntimeAuthProfileStoreSnapshots();
      clearAuthProfileMigrationDiagnostics();
      await state.cleanup();
    }
  });
});
