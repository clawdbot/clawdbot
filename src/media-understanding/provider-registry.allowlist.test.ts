import { beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import {
  createEmptyProviderRegistryAllowlistFallbackRegistry,
  getProviderRegistryAllowlistMocks,
  installProviderRegistryAllowlistMockDefaults,
} from "../test-utils/provider-registry-allowlist.test-helpers.js";

let buildMediaUnderstandingRegistry: typeof import("./provider-registry.js").buildMediaUnderstandingRegistry;
let getMediaUnderstandingProvider: typeof import("./provider-registry.js").getMediaUnderstandingProvider;
const mocks = getProviderRegistryAllowlistMocks();
installProviderRegistryAllowlistMockDefaults();

describe("media-understanding provider registry allowlist fallback", () => {
  beforeAll(async () => {
    ({ buildMediaUnderstandingRegistry, getMediaUnderstandingProvider } =
      await import("./provider-registry.js"));
  });

  it("adds bundled capability plugin ids to plugins.allow before fallback registry load", () => {
    const cfg = { plugins: { allow: ["custom-plugin"] } } as OpenClawConfig;
    const compatConfig = {
      plugins: {
        allow: ["custom-plugin", "openai"],
        entries: { openai: { enabled: true } },
      },
    };

    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "openai",
          origin: "bundled",
          contracts: { mediaUnderstandingProviders: ["openai"] },
        },
      ] as never,
      diagnostics: [],
    });
    mocks.withBundledPluginEnablementCompat.mockReturnValue(compatConfig);
    mocks.withBundledPluginVitestCompat.mockReturnValue(compatConfig);
    mocks.resolveRuntimePluginRegistry.mockImplementation(() =>
      createEmptyProviderRegistryAllowlistFallbackRegistry(),
    );

    const registry = buildMediaUnderstandingRegistry(undefined, cfg);

    expect(getMediaUnderstandingProvider("openai", registry)).toBeUndefined();
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith({
      config: compatConfig,
    });
  });
});
