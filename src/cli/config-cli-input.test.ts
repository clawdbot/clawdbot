import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { getOrCreatePluginMetadataOwner } from "../plugins/plugin-metadata-collection.js";
import { buildConfigSetOperations, readConfigPatchOperations } from "./config-cli-input.js";

async function withPatchFile<T>(
  contents: string,
  run: (patchPath: string) => Promise<T>,
): Promise<T> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-cli-input-"));
  const patchPath = path.join(tempDir, "patch.json5");
  fs.writeFileSync(patchPath, contents, "utf8");
  try {
    return await run(patchPath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

describe("readConfigPatchOperations", () => {
  it("rejects patch files containing non-finite numbers", async () => {
    await withPatchFile('{ "channels": { "custom": { "timeout": 1e999 } } }', async (patchPath) => {
      await expect(readConfigPatchOperations({ file: patchPath })).rejects.toThrow(
        "Value must be a finite number",
      );
    });
  });
});

describe("config assignment parsing", () => {
  it.each([
    {
      name: "plain value",
      input: { path: "agents.entries.main.name", value: "worker", opts: {} },
      path: ["agents", "entries", "main", "name"],
      value: "worker",
    },
    {
      name: "plugin SecretRef",
      input: {
        path: "plugins.entries.demo.config.apiKey",
        opts: { refProvider: "default", refSource: "env", refId: "DEMO_API_KEY" },
      },
      path: ["plugins", "entries", "demo", "config", "apiKey"],
      value: { provider: "default", source: "env", id: "DEMO_API_KEY" },
    },
  ])("parses $name before metadata preparation", ({ input, path: requestedPath, value }) => {
    withPluginCache(createPluginCache(), () => {
      const owner = getOrCreatePluginMetadataOwner();
      try {
        expect(buildConfigSetOperations(input)).toMatchObject([{ requestedPath, value }]);
      } finally {
        owner.dispose();
      }
    });
  });
});
