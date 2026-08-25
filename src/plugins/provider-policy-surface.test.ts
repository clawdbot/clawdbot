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

  it.each([
    { owner: "bundled", initial: "surface" },
    { owner: "bundled", initial: "missing" },
    { owner: "external", initial: "surface" },
    { owner: "external", initial: "missing" },
  ] as const)(
    "drops cached $owner provider policy $initial entries when plugin metadata changes",
    async ({ owner, initial }) => {
      const retiredHook = vi.fn();
      const replacementHook = vi.fn();
      const loadArtifact = vi
        .fn()
        .mockReturnValueOnce(initial === "surface" ? { resolveModelRoutes: retiredHook } : {})
        .mockReturnValueOnce({ resolveModelRoutes: replacementHook });

      vi.doMock("./bundled-dir.js", () => ({
        resolveBundledPluginsDir: () => "/tmp/bundled-plugins",
      }));
      vi.doMock("./public-surface-loader.js", () => ({
        loadBundledPluginPublicArtifactModuleSync: loadArtifact,
        loadPluginPublicArtifactModuleSync: loadArtifact,
      }));

      const policySurface = await importFreshModule<typeof import("./provider-policy-surface.js")>(
        import.meta.url,
        `./provider-policy-surface.js?scope=lifecycle-${owner}-${initial}`,
      );
      const { clearPluginMetadataLifecycleCaches } = await import("./plugin-metadata-lifecycle.js");
      const resolveSurface = () =>
        owner === "bundled"
          ? policySurface.resolveDirectBundledProviderPolicySurface("demo")
          : policySurface.resolveTrustedExternalProviderPolicySurface({
              pluginId: "demo",
              pluginRoot: "/tmp/demo",
              trustedOfficialInstall: true,
            });

      const expectedInitial = initial === "surface" ? retiredHook : undefined;
      expect(resolveSurface()?.resolveModelRoutes).toBe(expectedInitial);
      expect(resolveSurface()?.resolveModelRoutes).toBe(expectedInitial);
      expect(loadArtifact).toHaveBeenCalledOnce();

      clearPluginMetadataLifecycleCaches();

      expect(resolveSurface()?.resolveModelRoutes).toBe(replacementHook);
      expect(loadArtifact).toHaveBeenCalledTimes(2);
    },
  );
});
