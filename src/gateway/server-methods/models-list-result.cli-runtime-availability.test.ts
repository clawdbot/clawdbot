import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    preparedAuthModes:
      params.authenticated && !params.pluginDisabled ? { "claude-cli": "api_key" } : {},
    view: "configured",
  });
}

describe("models.list CLI runtime availability", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    { authenticated: true, pluginDisabled: false, available: true },
    { authenticated: false, pluginDisabled: false, available: false },
    { authenticated: true, pluginDisabled: true, available: false },
  ])(
    "reports native login=$authenticated and plugin disabled=$pluginDisabled",
    async (scenario) => {
      await expect(listClaudeCliModel(scenario)).resolves.toEqual({
        models: [expect.objectContaining({ id: "claude-opus-5", available: scenario.available })],
      });
    },
  );
  it("does not use synthetic auth when plugins are globally disabled", async () => {
    await expect(
      listClaudeCliModel({
        cfg: {
          ...config,
          plugins: { enabled: false },
        },
      }),
    ).resolves.toEqual({
      models: [expect.objectContaining({ id: "claude-opus-5", available: false })],
    });
  });
});
