import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { createNonExitingRuntime } from "../runtime.js";
import { runSearchSetupFlow } from "./search-setup.js";

const mockGrokProvider = vi.hoisted(() => ({
  id: "grok",
  pluginId: "xai",
  label: "Grok",
  hint: "Search with xAI",
  docsUrl: "https://docs.openclaw.ai/tools/web",
  requiresCredential: true,
  credentialLabel: "xAI API key",
  placeholder: "xai-...",
  signupUrl: "https://x.ai/api",
  envVars: ["XAI_API_KEY"],
  onboardingScopes: ["text-inference"],
  credentialPath: "plugins.entries.xai.config.webSearch.apiKey",
  credentialNote: "Configure Grok web search prerequisites before entering the credential.",
  getCredentialValue: (search?: Record<string, unknown>) => search?.apiKey,
  setCredentialValue: (searchConfigTarget: Record<string, unknown>, value: unknown) => {
    searchConfigTarget.apiKey = value;
  },
  getConfiguredCredentialValue: (config?: Record<string, unknown>) =>
    (
      config?.plugins as
        | {
            entries?: Record<
              string,
              {
                config?: {
                  webSearch?: { apiKey?: unknown };
                };
              }
            >;
          }
        | undefined
    )?.entries?.xai?.config?.webSearch?.apiKey,
  setConfiguredCredentialValue: (configTarget: Record<string, unknown>, value: unknown) => {
    const plugins = (configTarget.plugins ??= {}) as Record<string, unknown>;
    const entries = (plugins.entries ??= {}) as Record<string, unknown>;
    const xaiEntry = (entries.xai ??= {}) as Record<string, unknown>;
    const xaiConfig = (xaiEntry.config ??= {}) as Record<string, unknown>;
    const webSearch = (xaiConfig.webSearch ??= {}) as Record<string, unknown>;
    webSearch.apiKey = value;
  },
  runSetup: async ({
    config,
    prompter,
  }: {
    config: Record<string, unknown>;
    prompter: { select: (params: Record<string, unknown>) => Promise<string> };
  }) => {
    const enableXSearch = await prompter.select({
      message: "Enable x_search",
      options: [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
      ],
    });
    if (enableXSearch !== "yes") {
      return config;
    }
    const model = await prompter.select({
      message: "Grok model",
      options: [{ value: "grok-4-1-fast", label: "grok-4-1-fast" }],
    });
    const pluginEntries = (config.plugins as { entries?: Record<string, unknown> } | undefined)
      ?.entries;
    const existingXaiEntry = pluginEntries?.xai as Record<string, unknown> | undefined;
    const existingXaiConfig = (
      pluginEntries?.xai as { config?: Record<string, unknown> } | undefined
    )?.config;
    return {
      ...config,
      plugins: {
        ...(config.plugins as Record<string, unknown> | undefined),
        entries: {
          ...pluginEntries,
          xai: {
            ...existingXaiEntry,
            config: {
              ...existingXaiConfig,
              xSearch: {
                enabled: true,
                model,
              },
            },
          },
        },
      },
    };
  },
}));

vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: () => [mockGrokProvider],
}));

describe("runSearchSetupFlow", () => {
  it("runs provider-owned setup after selecting Grok web search", async () => {
    const select = vi
      .fn()
      .mockResolvedValueOnce("grok")
      .mockResolvedValueOnce("yes")
      .mockResolvedValueOnce("grok-4-1-fast");
    const text = vi.fn().mockResolvedValue("xai-test-key");
    const prompter = createWizardPrompter({
      select: select as never,
      text: text as never,
    });

    const next = await runSearchSetupFlow(
      { plugins: { allow: ["xai"] } },
      createNonExitingRuntime(),
      prompter,
    );

    expect(next.plugins?.entries?.xai?.config?.webSearch).toMatchObject({
      apiKey: "xai-test-key",
    });
    expect(next.tools?.web?.search).toMatchObject({
      provider: "grok",
      enabled: true,
    });
    expect(next.plugins?.entries?.xai?.config?.xSearch).toMatchObject({
      enabled: true,
      model: "grok-4-1-fast",
    });
  });

  it("shows provider credential notes before plaintext credential prompts", async () => {
    const select = vi.fn().mockResolvedValueOnce("grok").mockResolvedValueOnce("no");
    const text = vi.fn().mockResolvedValue("xai-test-key");
    const note = vi.fn(async () => {});
    const prompter = createWizardPrompter({
      note: note as never,
      select: select as never,
      text: text as never,
    });

    await runSearchSetupFlow({ plugins: { allow: ["xai"] } }, createNonExitingRuntime(), prompter);

    expect(note).toHaveBeenCalledWith(mockGrokProvider.credentialNote, mockGrokProvider.label);
    expect(text).toHaveBeenCalledTimes(1);
    expect(note.mock.invocationCallOrder[1]).toBeLessThan(text.mock.invocationCallOrder[0]);
  });

  it("shows provider credential notes before SecretRef setup notes", async () => {
    const select = vi.fn().mockResolvedValueOnce("grok").mockResolvedValueOnce("no");
    const note = vi.fn(async () => {});
    const prompter = createWizardPrompter({
      note: note as never,
      select: select as never,
    });

    await runSearchSetupFlow({ plugins: { allow: ["xai"] } }, createNonExitingRuntime(), prompter, {
      secretInputMode: "ref",
    });

    expect(note).toHaveBeenNthCalledWith(
      2,
      mockGrokProvider.credentialNote,
      mockGrokProvider.label,
    );
    expect(note).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("Secret references enabled"),
      "Web search",
    );
  });

  it("skips provider credential notes in quickstart fast path", async () => {
    const select = vi.fn().mockResolvedValueOnce("grok").mockResolvedValueOnce("no");
    const note = vi.fn(async () => {});
    const prompter = createWizardPrompter({
      note: note as never,
      select: select as never,
    });

    await runSearchSetupFlow(
      {
        plugins: {
          allow: ["xai"],
          entries: {
            xai: {
              enabled: true,
              config: {
                webSearch: {
                  apiKey: "xai-test-key",
                },
              },
            },
          },
        },
      },
      createNonExitingRuntime(),
      prompter,
      { quickstartDefaults: true },
    );

    expect(note).not.toHaveBeenCalledWith(mockGrokProvider.credentialNote, mockGrokProvider.label);
  });

  it("preserves disabled web_search state while still allowing provider-owned x_search setup", async () => {
    const select = vi
      .fn()
      .mockResolvedValueOnce("grok")
      .mockResolvedValueOnce("yes")
      .mockResolvedValueOnce("grok-4-1-fast");
    const prompter = createWizardPrompter({
      select: select as never,
    });

    const next = await runSearchSetupFlow(
      {
        plugins: {
          allow: ["xai"],
          entries: {
            xai: {
              enabled: true,
              config: {
                webSearch: {
                  apiKey: "xai-test-key",
                },
              },
            },
          },
        },
        tools: {
          web: {
            search: {
              provider: "grok",
              enabled: false,
            },
          },
        },
      },
      createNonExitingRuntime(),
      prompter,
    );

    expect(next.tools?.web?.search).toMatchObject({
      provider: "grok",
      enabled: false,
    });
    expect(next.plugins?.entries?.xai?.config?.xSearch).toMatchObject({
      enabled: true,
      model: "grok-4-1-fast",
    });
  });
});
