// Verifies plugin manifest metadata scanning stays runtime-lazy.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writePersistedInstalledPluginIndexSync } from "./installed-plugin-index-store.js";
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
    writePersistedInstalledPluginIndexSync(
      {
        version: 1,
        hostContractVersion: "test",
        compatRegistryVersion: "test",
        migrationVersion: 1,
        policyHash: "test",
        generatedAtMs: 1,
        installRecords: {},
        plugins: [
          {
            pluginId: "openai",
            manifestPath: path.join(staleBundledRoot, "openai", "openclaw.plugin.json"),
            manifestHash: "stale-openai",
            rootDir: path.join(staleBundledRoot, "openai"),
            origin: "bundled",
            enabled: true,
            startup: {
              sidecar: false,
              memory: false,
              deferConfiguredChannelFullLoadUntilAfterListen: false,
              agentHarnesses: [],
            },
            compat: [],
          },
        ],
        diagnostics: [],
      },
      { stateDir: path.join(home, ".openclaw") },
    );

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

  it("keeps source manifest metadata when the active bundled tree is partial", () => {
    const root = createTempRoot();
    const home = path.join(root, "home");
    const partialBundledRoot = path.join(root, "dist", "extensions");

    writeJson(path.join(partialBundledRoot, "qa-lab", "openclaw.plugin.json"), {
      id: "qa-lab",
      providers: ["qa-lab"],
    });

    const records = listOpenClawPluginManifestMetadata({
      OPENCLAW_HOME: home,
      OPENCLAW_BUNDLED_PLUGINS_DIR: partialBundledRoot,
    });

    const openai = records.find((record) => record.manifest.id === "openai");
    expect(openai?.origin).toBe("source");
    expect(openai?.pluginDir).toBe(path.join(process.cwd(), "extensions", "openai"));
    expect(openai?.manifest.providerEndpoints).toContainEqual({
      endpointClass: "openai-public",
      hosts: ["api.openai.com"],
      hostSuffixes: [".api.openai.com"],
    });
  });

  it("falls through a blank OpenClaw home when scanning global manifests", () => {
    const root = createTempRoot();
    const home = path.join(root, "home");
    const pluginDir = path.join(home, ".openclaw", "extensions", "example");
    writeJson(path.join(pluginDir, "openclaw.plugin.json"), { id: "example" });

    const records = listOpenClawPluginManifestMetadata({
      OPENCLAW_HOME: "   ",
      HOME: home,
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "bundled"),
    });

    expect(records).toContainEqual({
      pluginDir,
      manifest: { id: "example" },
      origin: "global",
    });
  });
});
