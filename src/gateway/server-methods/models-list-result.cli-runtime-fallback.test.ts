// Regression coverage for issue #112848: a provider bound to a CLI runtime
// (e.g. anthropic -> claude-cli) must report available in models.list when the
// persisted OAuth snapshot is expired but refreshable, because the owning CLI
// refreshes it. This exercises the CLI-runtime provider discovery wired into the
// models.list auth resolver plus the external-CLI refreshable generalization.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { buildModelsListResult } from "./models-list-result.js";
import type { GatewayRequestContext } from "./types.js";

const WITHOUT_ANTHROPIC_ENV_AUTH = {
  ANTHROPIC_API_KEY: undefined,
  ANTHROPIC_AUTH_TOKEN: undefined,
  CLAUDE_API_KEY: undefined,
  CLAUDE_CODE_OAUTH_TOKEN: undefined,
} as const;

const anthropicEntry: ModelCatalogEntry = {
  id: "claude-opus-4-7",
  name: "Claude Opus 4.7",
  provider: "anthropic",
  api: "anthropic-messages",
};

async function listModels(cfg: OpenClawConfig) {
  const context = {
    getRuntimeConfig: () => cfg,
    loadGatewayModelCatalogSnapshot: vi.fn(() =>
      Promise.resolve({ entries: [anthropicEntry], routeVariants: [anthropicEntry] }),
    ),
    logGateway: { debug: vi.fn() },
  } as unknown as GatewayRequestContext;
  return await buildModelsListResult({ context, params: { view: "all" } });
}

describe("models.list CLI-runtime OAuth fallback", () => {
  beforeEach(() => {
    // The claude-cli runtime backend is plugin-provided at runtime; inject it so
    // the resolver can map anthropic execution onto claude-cli, as in production.
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupRegistry: () => ({
        providers: [],
        cliBackends: [],
        configMigrations: [],
        autoEnableProbes: [],
        diagnostics: [],
      }),
      resolveRuntimeCliBackends: () => [
        {
          id: "claude-cli",
          modelProvider: "anthropic",
          pluginId: "anthropic",
          config: { command: "claude" },
        },
      ],
    });
  });

  afterEach(() => {
    cliBackendsTesting.resetDepsForTest();
  });

  it("keeps an anthropic model available via an expired-but-refreshable claude-cli snapshot", async () => {
    await withEnvAsync(WITHOUT_ANTHROPIC_ENV_AUTH, async () => {
      await withOpenClawTestState(
        {
          layout: "home",
          prefix: "openclaw-models-list-claude-cli-oauth-",
          agentEnv: "main",
        },
        async (state) => {
          // Persisted snapshot is expired but carries refresh material; the live
          // keychain read is isolated to the empty temp HOME, so availability
          // depends entirely on the refreshable-snapshot fallback under test.
          await state.writeAuthProfiles({
            version: 1,
            profiles: {
              "anthropic:claude-cli": {
                type: "oauth",
                provider: "claude-cli",
                access: "",
                refresh: "stored-refresh",
                expires: Date.now() - 60_000,
              },
            },
          });
          const cfg = {
            models: {
              providers: {
                anthropic: {
                  agentRuntime: { id: "claude-cli" },
                  models: [{ id: anthropicEntry.id, name: anthropicEntry.name }],
                },
              },
            },
          } as unknown as OpenClawConfig;

          const result = await listModels(cfg);
          expect(result.models).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                id: anthropicEntry.id,
                provider: "anthropic",
                available: true,
              }),
            ]),
          );
        },
      );
    });
  });
});
