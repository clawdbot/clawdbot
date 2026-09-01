import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
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
});
