import { beforeAll, describe, expect, it, vi } from "vitest";
import type { PluginWebSearchProviderEntry } from "../plugins/types.js";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

const { resolvePluginWebSearchProvidersMock } = vi.hoisted(() => ({
  resolvePluginWebSearchProvidersMock: vi.fn<() => PluginWebSearchProviderEntry[]>(() => [
    {
      pluginId: "google",
      id: "gemini",
      label: "gemini",
      hint: "gemini test provider",
      envVars: ["GEMINI_API_KEY"],
      placeholder: "gemini-...",
      signupUrl: "https://example.com/gemini",
      autoDetectOrder: 20,
      credentialPath: "plugins.entries.google.config.webSearch.apiKey",
      inactiveSecretPaths: ["plugins.entries.google.config.webSearch.apiKey"],
      getCredentialValue: (searchConfig) => searchConfig?.apiKey,
      setCredentialValue: (searchConfigTarget, value) => {
        searchConfigTarget.apiKey = value;
      },
      getConfiguredCredentialValue: (config) =>
        (config?.plugins?.entries?.google?.config as { webSearch?: { apiKey?: unknown } })
          ?.webSearch?.apiKey,
      setConfiguredCredentialValue: (configTarget, value) => {
        const plugins = (configTarget.plugins ??= {}) as { entries?: Record<string, unknown> };
        const entries = (plugins.entries ??= {});
        const entry = (entries.google ??= {}) as { config?: Record<string, unknown> };
        const config = (entry.config ??= {});
        const webSearch = (config.webSearch ??= {}) as { apiKey?: unknown };
        webSearch.apiKey = value;
      },
      createTool: () => null,
    },
  ]),
}));

vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: resolvePluginWebSearchProvidersMock,
}));

let activateSecretsRuntimeSnapshot: typeof import("./runtime.js").activateSecretsRuntimeSnapshot;
let getActiveRuntimeWebToolsMetadata: typeof import("./runtime.js").getActiveRuntimeWebToolsMetadata;
const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

describe("runtime web tools state", () => {
  beforeAll(async () => {
    ({ activateSecretsRuntimeSnapshot, getActiveRuntimeWebToolsMetadata } =
      await import("./runtime.js"));
  });

  it("exposes active runtime web tool metadata as a defensive clone", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        tools: {
          web: {
            search: {
              provider: "gemini",
            },
          },
        },
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  apiKey: {
                    source: "env",
                    provider: "default",
                    id: "WEB_SEARCH_GEMINI_API_KEY",
                  },
                },
              },
            },
          },
        },
      }),
      env: {
        WEB_SEARCH_GEMINI_API_KEY: "web-search-gemini-ref",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    activateSecretsRuntimeSnapshot(snapshot);

    const first = getActiveRuntimeWebToolsMetadata();
    expect(first?.search.providerConfigured).toBe("gemini");
    expect(first?.search.selectedProvider).toBe("gemini");
    expect(first?.search.selectedProviderKeySource).toBe("secretRef");
    if (!first) {
      throw new Error("missing runtime web tools metadata");
    }
    first.search.providerConfigured = "brave";
    first.search.selectedProvider = "brave";

    const second = getActiveRuntimeWebToolsMetadata();
    expect(second?.search.providerConfigured).toBe("gemini");
    expect(second?.search.selectedProvider).toBe("gemini");
  });
});
