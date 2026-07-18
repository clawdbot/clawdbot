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

  it("skips oversized plugin manifests to prevent OOM during metadata scan", () => {
    const root = createTempRoot();
    const home = path.join(root, "home");
    const goodPluginDir = path.join(home, ".openclaw", "extensions", "good-plugin");
    writeJson(path.join(goodPluginDir, "openclaw.plugin.json"), { id: "good-plugin" });

    const oversizedDir = path.join(home, ".openclaw", "extensions", "big-plugin");
    const oversizedPath = path.join(oversizedDir, "openclaw.plugin.json");
    fs.mkdirSync(oversizedDir, { recursive: true });
    fs.writeFileSync(
      oversizedPath,
      JSON.stringify({ id: "big-plugin", pad: "x".repeat(256 * 1024) }),
      "utf8",
    );

    const records = listOpenClawPluginManifestMetadata({
      OPENCLAW_HOME: home,
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "empty-bundled"),
    });
    expect(records.find((record) => record.manifest.id === "good-plugin")).toBeTruthy();
    expect(records.find((record) => record.manifest.id === "big-plugin")).toBeUndefined();
  });

  it("accepts plugin manifests at the exact byte limit", () => {
    const root = createTempRoot();
    const home = path.join(root, "home");
    const exactDir = path.join(home, ".openclaw", "extensions", "exact-plugin");
    fs.mkdirSync(exactDir, { recursive: true });
    const exactPath = path.join(exactDir, "openclaw.plugin.json");
    const manifest = { id: "exact-plugin", pad: "" };
    const padding = 256 * 1024 - Buffer.byteLength(JSON.stringify(manifest), "utf8");
    manifest.pad = "x".repeat(padding);
    fs.writeFileSync(exactPath, JSON.stringify(manifest), "utf8");

    const records = listOpenClawPluginManifestMetadata({
      OPENCLAW_HOME: home,
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "empty-bundled"),
    });
    expect(records.find((record) => record.manifest.id === "exact-plugin")).toBeTruthy();
  });
});
