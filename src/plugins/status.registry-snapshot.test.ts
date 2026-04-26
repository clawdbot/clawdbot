import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearPluginDiscoveryCache } from "./discovery.js";
import { clearPluginManifestRegistryCache } from "./manifest-registry.js";
import { buildPluginRegistrySnapshotReport } from "./status.js";

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-status-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  clearPluginDiscoveryCache();
  clearPluginManifestRegistryCache();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("buildPluginRegistrySnapshotReport", () => {
  it("reconstructs list metadata from indexed manifests without importing plugin runtime", () => {
    const pluginDir = makeTempDir();
    const runtimeMarker = path.join(pluginDir, "runtime-loaded.txt");
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@example/openclaw-indexed-demo",
        version: "9.8.7",
        openclaw: { extensions: ["./index.cjs"] },
      }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "indexed-demo",
        name: "Indexed Demo",
        description: "Manifest-backed list metadata",
        version: "1.2.3",
        providers: ["indexed-provider"],
        commandAliases: [{ name: "indexed-demo" }],
        configSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "index.cjs"),
      `require("node:fs").writeFileSync(${JSON.stringify(runtimeMarker)}, "loaded", "utf-8");\nmodule.exports = { id: "indexed-demo", register() {} };\n`,
      "utf-8",
    );

    const report = buildPluginRegistrySnapshotReport({
      config: {
        plugins: {
          load: { paths: [pluginDir] },
        },
      },
    });

    const plugin = report.plugins.find((entry) => entry.id === "indexed-demo");
    expect(plugin).toMatchObject({
      id: "indexed-demo",
      name: "Indexed Demo",
      description: "Manifest-backed list metadata",
      version: "9.8.7",
      format: "openclaw",
      providerIds: ["indexed-provider"],
      commands: ["indexed-demo"],
      source: fs.realpathSync(path.join(pluginDir, "index.cjs")),
      status: "loaded",
    });
    expect(fs.existsSync(runtimeMarker)).toBe(false);
  });
});
