import fs from "node:fs";
import path from "node:path";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("direct provider policy surface", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("./bundled-dir.js");
    vi.doUnmock("./manifest-registry.js");
    vi.doUnmock("./public-surface-loader.js");
    vi.resetModules();
  });

  it.each(["bundled", "external"] as const)(
    "retains %s policy misses per generation and propagates artifact failures",
    async (origin) => {
      const bundledRoot = fs.realpathSync(tempDirs.make("openclaw-policy-lifecycle-"));
      vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledRoot);
      vi.stubEnv("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");
      const {
        resolveDirectBundledProviderPolicySurface,
        resolveTrustedExternalProviderPolicySurface,
      } = await importFreshModule<typeof import("./provider-policy-surface.js")>(
        import.meta.url,
        `./provider-policy-surface.js?scope=policy-lifecycle-${origin}`,
      );
      const owner = createPluginCache();
      const pluginRoot = path.join(bundledRoot, "fixture");
      const resolve = () =>
        origin === "bundled"
          ? resolveDirectBundledProviderPolicySurface("fixture")
          : resolveTrustedExternalProviderPolicySurface({
              pluginId: "fixture",
              pluginRoot,
              trustedOfficialInstall: true,
            });
      expect(withPluginCache(owner, resolve)).toBeNull();

      fs.mkdirSync(pluginRoot);
      fs.writeFileSync(path.join(pluginRoot, "package.json"), '{"type":"commonjs"}\n');
      const failure = `Unable to resolve ${origin === "bundled" ? "bundled " : ""}plugin public surface fixture dependency`;
      fs.writeFileSync(
        path.join(pluginRoot, "provider-policy-api.js"),
        `throw new Error(${JSON.stringify(failure)});\n`,
      );

      expect(withPluginCache(owner, resolve)).toBeNull();
      expect(() => withPluginCache(createPluginCache(), resolve)).toThrow(failure);
    },
  );

  it("loads the provider-id artifact without evaluating the manifest registry", async () => {
    const manifestRegistryModuleFactory = vi.fn(() => {
      throw new Error("unexpected manifest registry import");
    });
    const resolveModelRoutes = vi.fn();
    const isResponseModelEquivalent = vi.fn();
    const loadPolicyArtifact = vi.fn(() => ({
      deprecatedProfileIds: ["demo:legacy"],
      resolveModelRoutes,
      isResponseModelEquivalent,
    }));

    vi.doMock("./bundled-dir.js", () => ({
      resolveBundledPluginsDir: () => "/tmp/bundled-plugins",
    }));
    vi.doMock("./manifest-registry.js", manifestRegistryModuleFactory);
    vi.doMock("./public-surface-loader.js", () => ({
      loadBundledPluginPublicArtifactModuleFromCandidatesSync: loadPolicyArtifact,
    }));

    const { resolveDirectBundledProviderPolicySurface } = await importFreshModule<
      typeof import("./provider-policy-surface.js")
    >(import.meta.url, "./provider-policy-surface.js?scope=direct-provider-policy");

    const surface = resolveDirectBundledProviderPolicySurface("openai");

    expect(surface?.resolveModelRoutes).toBe(resolveModelRoutes);
    expect(surface?.isResponseModelEquivalent).toBe(isResponseModelEquivalent);
    expect(surface?.deprecatedProfileIds).toEqual(["demo:legacy"]);
    expect(loadPolicyArtifact).toHaveBeenCalledWith({
      dirName: "openai",
      artifactCandidates: ["provider-policy-api.js"],
    });
    expect(manifestRegistryModuleFactory).not.toHaveBeenCalled();
  });
});
