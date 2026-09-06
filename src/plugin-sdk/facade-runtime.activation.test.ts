import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import * as activationRuntime from "./facade-activation-check.runtime.js";
import {
  listImportedBundledPluginFacadeIds,
  loadActivatedBundledPluginPublicSurfaceModule,
  loadActivatedBundledPluginPublicSurfaceModuleSync,
  resetFacadeRuntimeStateForTest,
  testing,
} from "./facade-runtime.js";

it.each([
  ["sync", loadActivatedBundledPluginPublicSurfaceModuleSync],
  ["async", loadActivatedBundledPluginPublicSurfaceModule],
] as const)(
  "%s activation preserves policy errors, cached exports, and artifact failures",
  async (_kind, load) => {
    const bundledRoot = path.resolve("dist-runtime", "extensions");
    fs.mkdirSync(bundledRoot, { recursive: true });
    const root = fs.realpathSync(fs.mkdtempSync(path.join(bundledRoot, ".activation-")));
    for (const id of ["fixture", "broken"]) {
      const pluginRoot = path.join(root, id);
      fs.mkdirSync(pluginRoot);
      fs.writeFileSync(path.join(pluginRoot, "package.json"), '{"type":"commonjs"}\n');
      fs.writeFileSync(
        path.join(pluginRoot, "openclaw.plugin.json"),
        JSON.stringify({ id, enabledByDefault: true }),
      );
      fs.writeFileSync(
        path.join(pluginRoot, "api.js"),
        id === "fixture"
          ? 'exports.marker = "activated";\n'
          : 'throw new Error("plugin load failure");\n',
      );
    }
    resetFacadeRuntimeStateForTest();
    testing.setFacadeActivationCheckRuntimeForTest(activationRuntime);
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", root);
    const params = { dirName: "fixture", artifactBasename: "api.js" };
    const invoke = (request = params) => Promise.resolve().then(() => load(request));
    try {
      setRuntimeConfigSnapshot({});
      await expect(
        invoke({ dirName: "missing-fixture", artifactBasename: "api.js" }),
      ).rejects.toEqual(
        new Error(
          'Bundled plugin public surface access blocked for "missing-fixture" via missing-fixture/api.js: no bundled plugin manifest found for missing-fixture',
        ),
      );
      await expect(invoke({ dirName: "broken", artifactBasename: "api.js" })).rejects.toThrow(
        "plugin load failure",
      );
      expect(listImportedBundledPluginFacadeIds()).toEqual([]);
      const loaded = await invoke();
      expect(loaded).toEqual({ marker: "activated" });
      expect(await invoke()).toBe(loaded);
      expect(listImportedBundledPluginFacadeIds()).toEqual(["fixture"]);

      setRuntimeConfigSnapshot({ plugins: { entries: { fixture: { enabled: false } } } });
      await expect(invoke()).rejects.toEqual(
        new Error(
          'Bundled plugin public surface access blocked for "fixture" via fixture/api.js: disabled in config',
        ),
      );
      setRuntimeConfigSnapshot({});
      expect(await invoke()).toBe(loaded);
    } finally {
      clearRuntimeConfigSnapshot();
      resetFacadeRuntimeStateForTest();
      vi.unstubAllEnvs();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
