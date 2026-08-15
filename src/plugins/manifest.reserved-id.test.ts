/** Guards core-owned synthetic plugin ids from real plugin manifests. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginManifest } from "./manifest.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("reserved plugin ids", () => {
  it("rejects the core-owned node-mcp id", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-node-mcp-manifest-"));
    tempDirs.push(rootDir);
    await fs.writeFile(
      path.join(rootDir, "openclaw.plugin.json"),
      JSON.stringify({ id: "node-mcp", configSchema: { type: "object" } }),
    );

    expect(loadPluginManifest(rootDir, false)).toMatchObject({
      ok: false,
      error: 'plugin manifest id "node-mcp" is reserved by OpenClaw core',
    });
  });
});
