import { afterEach, describe, expect, it } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import {
  listModels,
  providerCatalogEntry,
} from "./models-list-result.openai-routes.test-support.js";

describe("models.list CLI runtime aliases", () => {
  afterEach(() => {
    cliBackendsTesting.resetDepsForTest();
  });

  it("hides setup-registered CLI alias providers from rows and route variants", async () => {
    const setupBackend = {
      id: "claude-cli",
      modelProvider: "anthropic",
      config: { command: "claude" },
      bundleMcp: false,
    } as never;
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [],
      resolvePluginSetupCliBackend: () => ({ pluginId: "anthropic", backend: setupBackend }),
      resolvePluginSetupRegistry: () => ({
        providers: [],
        cliBackends: [{ pluginId: "anthropic", backend: setupBackend }],
        configMigrations: [],
        autoEnableProbes: [],
        diagnostics: [],
      }),
    });

    const result = await listModels({
      catalog: [
        providerCatalogEntry("claude-cli", "claude-opus-5"),
        providerCatalogEntry("anthropic", "claude-opus-5"),
      ],
      cfg: {},
      catalogComplete: true,
      view: "all",
    });

    expect(result.models).toEqual([
      expect.objectContaining({ provider: "anthropic", id: "claude-opus-5" }),
    ]);
    expect(result.models).not.toContainEqual(expect.objectContaining({ provider: "claude-cli" }));
  });
});
