import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginManifest } from "./manifest.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

function makePluginDir() {
  return makeTrackedTempDir("openclaw-manifest-model-catalog", tempDirs);
}

function writeManifest(dir: string, manifest: Record<string, unknown>) {
  fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), JSON.stringify(manifest), "utf8");
}

describe("plugin manifest model catalog", () => {
  afterEach(() => {
    cleanupTrackedTempDirs(tempDirs);
  });

  it("allows cli backends to own manifest model catalog rows", () => {
    const dir = makePluginDir();
    writeManifest(dir, {
      id: "anthropic",
      providers: ["anthropic"],
      cliBackends: ["claude-cli"],
      modelCatalog: {
        providers: {
          "claude-cli": {
            models: [{ id: "claude-sonnet-4-6" }],
          },
        },
        discovery: {
          "claude-cli": "static",
        },
      },
      configSchema: { type: "object" },
    });

    const result = loadPluginManifest(dir);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.manifest.modelCatalog).toEqual({
      providers: {
        "claude-cli": {
          models: [{ id: "claude-sonnet-4-6" }],
        },
      },
      discovery: {
        "claude-cli": "static",
      },
    });
  });
});
