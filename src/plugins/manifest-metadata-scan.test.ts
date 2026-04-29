import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listOpenClawPluginManifestMetadata } from "./manifest-metadata-scan.js";

const tempRoots: string[] = [];

function createTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-manifest-metadata-"));
  tempRoots.push(root);
  return root;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

describe("listOpenClawPluginManifestMetadata", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefers the active bundled manifest over stale persisted bundled installs", () => {
    const root = createTempRoot();
    const home = path.join(root, "home");
    const bundledRoot = path.join(root, "extensions");
    const staleBundledRoot = path.join(root, "stale", "extensions");

    writeJson(path.join(bundledRoot, "openai", "openclaw.plugin.json"), {
      id: "openai",
      providerEndpoints: [{ endpointClass: "openai-public", hosts: ["api.openai.com"] }],
    });
    writeJson(path.join(staleBundledRoot, "openai", "openclaw.plugin.json"), {
      id: "openai",
      providers: ["openai"],
    });
    writeJson(path.join(home, ".openclaw", "plugins", "installs.json"), {
      plugins: [{ rootDir: path.join(staleBundledRoot, "openai"), origin: "bundled" }],
    });

    const records = listOpenClawPluginManifestMetadata({
      OPENCLAW_HOME: home,
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
    });

    const openai = records.find((record) => record.manifest.id === "openai");
    expect(openai?.pluginDir).toBe(path.join(bundledRoot, "openai"));
    expect(openai?.manifest.providerEndpoints).toEqual([
      { endpointClass: "openai-public", hosts: ["api.openai.com"] },
    ]);
  });
});
