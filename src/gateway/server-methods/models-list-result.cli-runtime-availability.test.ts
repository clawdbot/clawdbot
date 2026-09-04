import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  clearUserProfileAuthLink,
  connectUserModelAccount,
} from "../../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { loadDeferredCatalog } from "../server-model-catalog-auth.js";
import {
  buildModelsListResult,
  createGatewayAgentModelCatalogProjector,
} from "./models-list-result.js";
import {
  createModelsListTestContext,
  listModels,
  providerCatalogEntry,
} from "./models-list-result.openai-routes.test-support.js";

const config = {
  agents: {
    defaults: { model: { primary: "anthropic/claude-opus-5" } },
    list: [
      {
        id: "main",
        default: true,
        models: {
          "anthropic/claude-opus-5": { agentRuntime: { id: "claude-cli" } },
        },
      },
    ],
  },
} satisfies OpenClawConfig;

async function listClaudeCliModel(
  params: {
    authenticated?: boolean;
    providerApiKey?: boolean;
    pluginDisabled?: boolean;
    cfg?: OpenClawConfig;
  } = {},
) {
  return await listModels({
    catalog: [],
    staticEntries: [providerCatalogEntry("anthropic", "claude-opus-5")],
    cfg:
      params.cfg ??
      (params.pluginDisabled
        ? { ...config, plugins: { entries: { anthropic: { enabled: false } } } }
        : config),
    preparedAuthModes: params.authenticated ? { "claude-cli": "api_key" } : {},
    catalogComplete: true,
    view: "configured",
  });
}

async function listDirectClaudeCliModel(params: {
  authenticated: boolean;
  pluginDisabled?: boolean;
}) {
  const cfg = params.pluginDisabled
    ? { ...config, plugins: { entries: { anthropic: { enabled: false } } } }
    : config;
  return await listModels({
    catalog: [providerCatalogEntry("claude-cli", "claude-opus-5")],
    cfg,
    preparedAuthModes:
      params.authenticated && !params.pluginDisabled ? { "claude-cli": "oauth" } : {},
    catalogComplete: true,
    view: "all",
  });
}

describe("models.list CLI runtime availability", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    // Prepared runtime metadata must not cold-load the plugin's executable setup entry.
    cliBackendsTesting.setDepsForTest({
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
    vi.unstubAllEnvs();
  });

  it.each([
    { authenticated: true, available: true, reason: undefined },
    { authenticated: false, available: false, reason: "missing-auth" },
    {
      authenticated: true,
      pluginDisabled: true,
      available: false,
      reason: "missing-auth",
    },
  ])(
    "reports direct Claude CLI auth=$authenticated and plugin disabled=$pluginDisabled",
    async (scenario) => {
      const result = await listDirectClaudeCliModel(scenario);

      expect(result.models).toEqual([
        expect.objectContaining({
          provider: "claude-cli",
          id: "claude-opus-5",
          available: scenario.available,
          ...(scenario.reason ? { unavailableReason: scenario.reason } : {}),
        }),
      ]);
    },
  );

  it.each([
    {
      authenticated: true,
      providerApiKey: false,
      pluginDisabled: false,
      available: true,
      reason: undefined,
    },
    {
      authenticated: false,
      providerApiKey: false,
      pluginDisabled: false,
      available: false,
      reason: "missing-auth",
    },
    {
      authenticated: false,
      providerApiKey: true,
      pluginDisabled: false,
      available: false,
      reason: "missing-auth",
    },
    {
      authenticated: true,
      providerApiKey: false,
      pluginDisabled: true,
      available: false,
      reason: "missing-auth",
    },
  ])(
    "reports native login=$authenticated, provider key=$providerApiKey, and plugin disabled=$pluginDisabled",
    async (scenario) => {
      vi.stubEnv("ANTHROPIC_API_KEY", scenario.providerApiKey ? "test-key" : "");
      const result = await listClaudeCliModel(scenario);
      expect(result).toEqual({
        models: [expect.objectContaining({ id: "claude-opus-5", available: scenario.available })],
      });
      expect(result.models[0]?.unavailableReason).toBe(scenario.reason);
      expect(result.models[0]?.unavailableUntil).toBeUndefined();
    },
  );
  it("does not use synthetic auth when plugins are globally disabled", async () => {
    await expect(
      listClaudeCliModel({
        authenticated: true,
        cfg: {
          ...config,
          plugins: { enabled: false },
        },
      }),
    ).resolves.toEqual({
      models: [expect.objectContaining({ id: "claude-opus-5", available: false })],
    });
  });

  it("does not use provider auth when the native runtime plugin is disabled", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");

    const result = await listClaudeCliModel({ authenticated: true, pluginDisabled: true });

    expect(result.models[0]).toMatchObject({ available: false, unavailableReason: "missing-auth" });
  });

  it.each([
    { selection: "draft", expired: false },
    { selection: "default", expired: false },
    { selection: "draft", expired: true },
    { selection: "default", expired: true },
  ])(
    "uses personal $selection auth instead of native login (expired=$expired)",
    async ({ selection, expired }) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "personal-cli-model-catalog-" },
        async (state) => {
          const owner = ensureProfileForEmail("alice@example.test");
          const { authProfileId } = connectUserModelAccount({
            ownerProfileId: owner.id,
            credential: {
              type: "token",
              provider: "anthropic",
              token: "synthetic-personal-token",
              expires: Date.now() + (expired ? -60_000 : 600_000),
            },
            assertCurrent() {},
          });
          if (selection === "draft") {
            clearUserProfileAuthLink({ profileId: owner.id, provider: "anthropic" });
          }
          const context = createModelsListTestContext({
            cfg: config,
            agentDir: state.agentDir(),
            workspaceDir: state.workspaceDir,
            catalog: [providerCatalogEntry("anthropic", "claude-opus-5")],
            catalogComplete: true,
            preparedAuthModes: expired ? { "claude-cli": "oauth" } : {},
          });
          const snapshot = await loadDeferredCatalog(context, "main", { readOnly: true });
          const result = await buildModelsListResult({
            context,
            agentId: "main",
            requesterProfileId: owner.id,
            params: { view: "configured", preparedOnly: true },
            preloadedCatalog: { agentId: "main", config, snapshot },
            preloadedOnly: true,
            catalogProjector: createGatewayAgentModelCatalogProjector({
              cfg: config,
              agentId: "main",
              agentDir: state.agentDir(),
              workspaceDir: state.workspaceDir,
              snapshot,
              metadataSnapshot: snapshot.metadataSnapshot,
              preparedAuthStore: snapshot.authStore,
              preparedRuntimeAuthModes: snapshot.authModes,
              preparedSyntheticAuthComplete: snapshot.catalogComplete,
              requesterProfileId: owner.id,
              ...(selection === "draft"
                ? { preferredProfileId: authProfileId, lockedProfileId: authProfileId }
                : {}),
            }),
          });

          const model = result.models.find(
            (entry) => entry.provider === "anthropic" && entry.id === "claude-opus-5",
          );
          expect(model).toMatchObject({
            agentRuntime: expect.objectContaining({ id: "claude-cli" }),
            available: !expired,
          });
          expect(model?.unavailableReason).toBe(expired ? "auth-failed" : undefined);
        },
      );
    },
  );
});
