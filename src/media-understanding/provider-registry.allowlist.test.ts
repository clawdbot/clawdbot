import { beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import {
  getProviderRegistryAllowlistMocks,
  installProviderRegistryAllowlistMockDefaults,
  primeBundledProviderAllowlistFallback,
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
    const { cfg, compatConfig } = primeBundledProviderAllowlistFallback({
      contractKey: "mediaUnderstandingProviders",
    });

    const registry = buildMediaUnderstandingRegistry(undefined, cfg as OpenClawConfig);

    expect(getMediaUnderstandingProvider("openai", registry)).toBeUndefined();
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith({
      config: compatConfig,
      activate: false,
    });
  });
});
