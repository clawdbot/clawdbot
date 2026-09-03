import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("direct provider policy surface", () => {
  afterEach(() => {
    vi.doUnmock("./bundled-dir.js");
    vi.doUnmock("./manifest-registry.js");
    vi.doUnmock("./public-surface-loader.js");
    vi.resetModules();
  });

  it("loads the provider-id artifact without evaluating the manifest registry", async () => {
    const manifestRegistryModuleFactory = vi.fn(() => {
      throw new Error("unexpected manifest registry import");
    });
    const resolveModelRoutes = vi.fn();
    const isResponseModelEquivalent = vi.fn();
    const loadBundledPluginPublicArtifactModuleSync = vi.fn(() => ({
      deprecatedProfileIds: ["demo:legacy"],
      resolveModelRoutes,
      isResponseModelEquivalent,
    }));

    vi.doMock("./bundled-dir.js", () => ({
      resolveBundledPluginsDir: () => "/tmp/bundled-plugins",
    }));
    vi.doMock("./manifest-registry.js", manifestRegistryModuleFactory);
    vi.doMock("./public-surface-loader.js", () => ({
      loadBundledPluginPublicArtifactModuleSync,
    }));

    const { resolveDirectBundledProviderPolicySurface } = await importFreshModule<
      typeof import("./provider-policy-surface.js")
    >(import.meta.url, "./provider-policy-surface.js?scope=direct-provider-policy");

    const surface = resolveDirectBundledProviderPolicySurface("openai");

    expect(surface?.resolveModelRoutes).toBe(resolveModelRoutes);
    expect(surface?.isResponseModelEquivalent).toBe(isResponseModelEquivalent);
    expect(surface?.deprecatedProfileIds).toEqual(["demo:legacy"]);
    expect(loadBundledPluginPublicArtifactModuleSync).toHaveBeenCalledWith({
      dirName: "openai",
      artifactBasename: "provider-policy-api.js",
    });
    expect(manifestRegistryModuleFactory).not.toHaveBeenCalled();
  });
});
