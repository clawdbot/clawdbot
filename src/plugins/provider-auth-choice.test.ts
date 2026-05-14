import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createNonExitingRuntime } from "../runtime.js";
import type { ProviderPlugin } from "./types.js";

const ensureCodexRuntimePluginForModelSelection = vi.hoisted(() => vi.fn());
vi.mock("../commands/codex-runtime-plugin-install.js", () => ({
  CODEX_RUNTIME_PLUGIN_ID: "codex",
  ensureCodexRuntimePluginForModelSelection,
}));

const offerPostInstallMigrations = vi.hoisted(() => vi.fn());
vi.mock("../wizard/setup.post-install-migration.js", () => ({
  offerPostInstallMigrations,
}));

const { __testing, applyAuthChoicePluginProvider } = await import("./provider-auth-choice.js");

function buildProvider(): ProviderPlugin {
  return {
    id: "openai",
    label: "OpenAI",
    auth: [
      {
        id: "api-key",
        label: "API key",
        kind: "api_key",
        run: vi.fn(async () => ({
          profiles: [],
          notes: [],
          defaultModel: "gpt-5.5",
        })),
      },
    ],
  };
}

describe("applyAuthChoicePluginProvider", () => {
  beforeEach(() => {
    __testing.resetDepsForTest();
    ensureCodexRuntimePluginForModelSelection.mockReset();
    offerPostInstallMigrations.mockReset();
  });

  it("returns post-install Codex migration config when setting an OpenAI default model", async () => {
    const provider = buildProvider();
    const runProviderModelSelectedHook = vi.fn(async () => undefined);
    __testing.setDepsForTest({
      loadPluginProviderRuntime: async () =>
        ({
          resolvePluginProviders: () => [provider],
          runProviderModelSelectedHook,
        }) as never,
    });
    ensureCodexRuntimePluginForModelSelection.mockImplementation(
      async ({ cfg }: { cfg: OpenClawConfig }) => ({
        installed: true,
        cfg: {
          ...cfg,
          plugins: {
            ...cfg.plugins,
            entries: {
              ...cfg.plugins?.entries,
              codex: { enabled: true },
            },
          },
        },
      }),
    );
    offerPostInstallMigrations.mockImplementation(
      async ({ config }: { config: OpenClawConfig }) => ({
        config: {
          ...config,
          plugins: {
            ...config.plugins,
            entries: {
              ...config.plugins?.entries,
              codex: {
                enabled: true,
                config: {
                  codexPlugins: {
                    enabled: true,
                    allow_destructive_actions: true,
                    plugins: {
                      gmail: {
                        enabled: true,
                        marketplaceName: "openai-curated",
                        pluginName: "gmail",
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );

    const result = await applyAuthChoicePluginProvider(
      {
        authChoice: "openai-api-key",
        config: {},
        runtime: createNonExitingRuntime(),
        prompter: createWizardPrompter(),
        setDefaultModel: true,
      },
      {
        authChoice: "openai-api-key",
        pluginId: "openai",
        providerId: "openai",
        methodId: "api-key",
        label: "OpenAI",
      },
    );

    expect(runProviderModelSelectedHook).toHaveBeenCalledOnce();
    expect(offerPostInstallMigrations).toHaveBeenCalledWith(
      expect.objectContaining({
        installedPluginIds: ["codex"],
      }),
    );
    const resultConfig = result?.config;
    expect(resultConfig?.agents?.defaults?.model).toEqual({ primary: "gpt-5.5" });
    const codexConfig = resultConfig?.plugins?.entries?.codex?.config as
      | { codexPlugins?: { plugins?: unknown } }
      | undefined;
    expect(codexConfig?.codexPlugins?.plugins).toEqual({
      gmail: {
        enabled: true,
        marketplaceName: "openai-curated",
        pluginName: "gmail",
      },
    });
  });
});
