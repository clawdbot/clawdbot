// Covers the runtime chooser /models offers for providers served by an
// app-server agent harness rather than by a CLI backend.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  resetPluginRuntimeStateForTest,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { buildPreparedModelsProviderData } from "./commands-models.js";

const modelCatalogMocks = vi.hoisted(() => ({ loadModelCatalog: vi.fn() }));

vi.mock("../../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  loadPreparedModelCatalog: modelCatalogMocks.loadModelCatalog,
  loadPreparedModelCatalogSnapshot: async (...args: unknown[]) => {
    const entries = await modelCatalogMocks.loadModelCatalog(...args);
    return { entries, routeVariants: entries };
  },
}));

vi.mock("../../agents/model-provider-auth.js", () => ({
  createProviderAuthChecker: () =>
    Object.assign(
      vi.fn(() => true),
      {
        evaluateModelAuth: vi.fn(async () => ({ availability: true, routeResolution: null })),
      },
    ),
  hasAuthForModelProvider: () => true,
  getCurrentProviderAuthState: () => null,
  clearCurrentProviderAuthState: () => undefined,
}));

const CONFIG = {
  agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
} as OpenClawConfig;

let previousPluginRegistry: ReturnType<typeof captureActivePluginRegistrySnapshot>;

beforeEach(() => {
  previousPluginRegistry = captureActivePluginRegistrySnapshot();
  resetPluginRuntimeStateForTest();
  // No CLI backends registered anywhere, so every runtime choice observed here
  // comes from the app-server bindings rather than a CLI runtime binding.
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupRegistry: () => ({
      providers: [],
      cliBackends: [],
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [],
    }),
    resolveRuntimeCliBackends: () => [],
  });
  setActivePluginRegistry(createEmptyPluginRegistry());
  modelCatalogMocks.loadModelCatalog.mockReset();
  modelCatalogMocks.loadModelCatalog.mockResolvedValue([
    { provider: "openai", id: "gpt-5.5", name: "GPT-5.5" },
    { provider: "github-copilot", id: "claude-opus-4-6", name: "Claude Opus 4.6" },
    { provider: "unbound-provider", id: "unbound-model", name: "Unbound Model" },
  ]);
});

afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
  resetPluginRuntimeStateForTest();
  restoreActivePluginRegistrySnapshot(previousPluginRegistry);
});

describe("buildPreparedModelsProviderData app-server runtime choices", () => {
  it("offers the Copilot runtime for github-copilot models", async () => {
    const data = await buildPreparedModelsProviderData(CONFIG);

    expect(data.runtimeChoicesByProvider?.get("github-copilot")).toEqual([
      {
        id: "openclaw",
        label: "OpenClaw Default",
        description: "Use the built-in OpenClaw runtime.",
      },
      {
        id: "copilot",
        label: "GitHub Copilot",
        description: "Use the GitHub Copilot runtime selected by the effective harness policy.",
      },
    ]);
  });

  it("keeps offering the Codex runtime for openai models", async () => {
    const data = await buildPreparedModelsProviderData(CONFIG);

    expect(data.runtimeChoicesByProvider?.get("openai")?.map((choice) => choice.id)).toEqual([
      "codex",
      "openclaw",
    ]);
  });

  it("leaves providers with no app-server harness out of the chooser", async () => {
    const data = await buildPreparedModelsProviderData(CONFIG);

    expect(data.runtimeChoicesByProvider?.get("unbound-provider")).toBeUndefined();
  });
});
