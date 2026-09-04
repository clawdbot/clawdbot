import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  listImportedBundledPluginFacadeIds,
  loadActivatedBundledPluginPublicSurfaceModule,
  resetFacadeRuntimeStateForTest,
} from "./facade-runtime.js";

it("awaits cold activation before loading a tiny allowed source facade", async () => {
  const bundledRoot = path.resolve("dist-runtime", "extensions");
  fs.mkdirSync(bundledRoot, { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(bundledRoot, ".async-activation-")));
  const pluginRoot = path.join(root, "fixture");
  fs.mkdirSync(pluginRoot);
  fs.writeFileSync(path.join(pluginRoot, "package.json"), '{"type":"module"}\n');
  fs.writeFileSync(
    path.join(pluginRoot, "openclaw.plugin.json"),
    '{"id":"async-cold-owner","enabledByDefault":true}\n',
  );
  fs.writeFileSync(path.join(pluginRoot, "api.ts"), 'export const marker: string = "cold";\n');
  resetFacadeRuntimeStateForTest();
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", root);
  try {
    const pending = loadActivatedBundledPluginPublicSurfaceModule({
      dirName: "fixture",
      artifactBasename: "api.js",
    });
    expect(listImportedBundledPluginFacadeIds()).toEqual([]);
    await expect(pending).resolves.toEqual({ marker: "cold" });
    expect(listImportedBundledPluginFacadeIds()).toEqual(["async-cold-owner"]);
  } finally {
    resetFacadeRuntimeStateForTest();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
