import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearPluginLoaderCache } from "../../plugins/loader.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";

const EMPTY_PLUGIN_SCHEMA = { type: "object", additionalProperties: false, properties: {} };

export function createTempPluginDir(tempDirs: string[], prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export function writeTempPlugin(params: {
  dir: string;
  id: string;
  body: string;
  manifest?: Record<string, unknown>;
  filename?: string;
}): string {
  const pluginDir = path.join(params.dir, params.id);
  fs.mkdirSync(pluginDir, { recursive: true });
  const file = path.join(pluginDir, params.filename ?? `${params.id}.mjs`);
  fs.writeFileSync(file, params.body, "utf-8");
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: params.id,
        ...params.manifest,
        configSchema: EMPTY_PLUGIN_SCHEMA,
      },
      null,
      2,
    ),
    "utf-8",
  );
  return file;
}

export function cleanupTempPluginTestEnvironment(
  tempDirs: string[],
  originalBundledPluginsDir: string | undefined,
) {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  clearPluginLoaderCache();
  setActivePluginRegistry(createEmptyPluginRegistry());
  if (originalBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledPluginsDir;
  }
}

export function resetActivePluginRegistryForTest() {
  setActivePluginRegistry(createEmptyPluginRegistry());
}
