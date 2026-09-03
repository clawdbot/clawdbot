import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  canLoadActivatedBundledPluginPublicSurface,
  listImportedBundledPluginFacadeIds,
  loadActivatedBundledPluginPublicSurfaceModuleSync,
  loadBundledPluginPublicSurfaceModuleSync,
  resetFacadeRuntimeStateForTest,
} from "./facade-runtime.js";

describe("cold facade runtime", () => {
  it("loads and tracks a light source facade without prewarming workspace dependencies", () => {
    const bundledRoot = path.resolve("dist-runtime", "extensions");
    fs.mkdirSync(bundledRoot, { recursive: true });
    const fixtureRoot = fs.mkdtempSync(path.join(bundledRoot, ".cold-facade-"));
    const pluginRoot = path.join(fixtureRoot, "fixture");
    fs.mkdirSync(pluginRoot);
    fs.writeFileSync(path.join(pluginRoot, "package.json"), '{"type":"module"}\n');
    fs.writeFileSync(path.join(pluginRoot, "openclaw.plugin.json"), '{"id":"cold-facade-owner"}\n');
    fs.writeFileSync(path.join(pluginRoot, "api.ts"), 'export const marker: string = "cold";\n');

    resetFacadeRuntimeStateForTest();
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", fixtureRoot);
    try {
      const params = { dirName: "fixture", artifactBasename: "api.js" };
      const loaded = loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>(params);
      expect(loaded).toEqual({ marker: "cold" });
      expect(loadBundledPluginPublicSurfaceModuleSync(params)).toBe(loaded);
      expect(listImportedBundledPluginFacadeIds()).toEqual(["cold-facade-owner"]);
      expect(canLoadActivatedBundledPluginPublicSurface(params)).toBe(false);
      expect(() => loadActivatedBundledPluginPublicSurfaceModuleSync(params)).toThrow(
        'Bundled plugin public surface access blocked for "cold-facade-owner"',
      );
    } finally {
      resetFacadeRuntimeStateForTest();
      vi.unstubAllEnvs();
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
