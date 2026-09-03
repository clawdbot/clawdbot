import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  listModels,
  providerCatalogEntry,
} from "./models-list-result.openai-routes.test-support.js";

const resolveProviderSyntheticAuthWithPlugin = vi.hoisted(() => vi.fn());

vi.mock("../../plugins/provider-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/provider-runtime.js")>()),
  resolveProviderSyntheticAuthWithPlugin,
}));

const config = {
  agents: {
    defaults: { model: { primary: "anthropic/claude-opus-5" } },
    list: [{ id: "main", default: true }],
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
  const cfg =
    params.cfg ??
    (params.pluginDisabled
      ? { ...config, plugins: { entries: { anthropic: { enabled: false } } } }
      : config);
  const nativeLoginEnabled =
    params.authenticated &&
    !params.pluginDisabled &&
    cfg.plugins?.enabled !== false &&
    cfg.plugins?.entries?.anthropic?.enabled !== false;
  resolveProviderSyntheticAuthWithPlugin.mockReturnValue(
    nativeLoginEnabled
      ? { apiKey: "native-login", source: "native login", mode: "api-key" }
      : undefined,
  );
  return await listModels({
    catalog: [],
    staticEntries: [
      {
        ...providerCatalogEntry("anthropic", "claude-opus-5"),
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
      },
    ],
    cfg,
    preparedProviderAuth: nativeLoginEnabled
      ? { anthropic: { mode: "api_key", runtime: "claude-cli" } }
      : {},
    catalogComplete: true,
    view: "configured",
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
    resolveProviderSyntheticAuthWithPlugin.mockReset();
    vi.unstubAllEnvs();
  });

  it.each([
    {
      authenticated: true,
      providerApiKey: false,
      pluginDisabled: false,
      available: false,
      reason: "missing-auth",
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
      available: true,
      reason: undefined,
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
      expect(result.models).toEqual([
        expect.objectContaining({
          provider: "anthropic",
          id: "claude-opus-5",
          available: scenario.available,
          ...(scenario.authenticated && !scenario.pluginDisabled
            ? { agentRuntime: expect.objectContaining({ id: "claude-cli", source: "auth" }) }
            : {}),
        }),
      ]);
      expect(result.models).not.toContainEqual(expect.objectContaining({ provider: "claude-cli" }));
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

  it("shows OpenAI rows as available through a native Codex login", async () => {
    resolveProviderSyntheticAuthWithPlugin.mockReturnValue({
      apiKey: "codex-app-server",
      source: "Codex CLI native auth",
      mode: "oauth",
      runtime: "codex",
    });

    const result = await listModels({
      catalog: [
        {
          ...providerCatalogEntry("openai", "gpt-5.6-sol"),
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
        },
      ],
      cfg: {},
      preparedProviderAuth: { openai: { mode: "oauth", runtime: "codex" } },
      catalogComplete: true,
      view: "all",
    });

    expect(result.models).toContainEqual(
      expect.objectContaining({
        provider: "openai",
        id: "gpt-5.6-sol",
        available: true,
        agentRuntime: expect.objectContaining({ id: "codex", source: "auth" }),
      }),
    );
  });
});
