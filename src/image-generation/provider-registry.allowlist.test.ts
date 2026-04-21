import { beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  getProviderRegistryAllowlistMocks,
  installProviderRegistryAllowlistMockDefaults,
  primeBundledProviderAllowlistFallback,
} from "../test-utils/provider-registry-allowlist.test-helpers.js";

let getImageGenerationProvider: typeof import("./provider-registry.js").getImageGenerationProvider;
let listImageGenerationProviders: typeof import("./provider-registry.js").listImageGenerationProviders;
const mocks = getProviderRegistryAllowlistMocks();
installProviderRegistryAllowlistMockDefaults();

describe("image-generation provider registry allowlist fallback", () => {
  beforeAll(async () => {
    ({ getImageGenerationProvider, listImageGenerationProviders } =
      await import("./provider-registry.js"));
  });

  it("adds bundled capability plugin ids to plugins.allow before fallback registry load", () => {
    const { cfg, compatConfig } = primeBundledProviderAllowlistFallback({
      contractKey: "imageGenerationProviders",
    });

    expect(listImageGenerationProviders(cfg as OpenClawConfig)).toEqual([]);
    expect(getImageGenerationProvider("openai", cfg as OpenClawConfig)).toBeUndefined();
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith({
      config: compatConfig,
    });
  });
});
