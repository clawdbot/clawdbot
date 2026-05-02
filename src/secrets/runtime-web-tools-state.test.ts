import { beforeAll, describe, expect, it } from "vitest";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

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
      loadablePluginOrigins: new Map([["google", "bundled"]]),
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
