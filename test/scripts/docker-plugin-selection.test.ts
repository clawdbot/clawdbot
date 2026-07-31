import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const selectorScript = path.join(repoRoot, "scripts/lib/docker-plugin-selection.mjs");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function writePlugin(extensionsRoot: string, dirName: string, manifestId?: string) {
  const pluginDir = path.join(extensionsRoot, dirName);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "package.json"), `${JSON.stringify({ name: dirName })}\n`);
  if (manifestId) {
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      `${JSON.stringify({ id: manifestId })}\n`,
    );
  }
}

function runSelector(extensionsRoot: string, selection: string) {
  return spawnSync(process.execPath, [selectorScript, extensionsRoot, selection], {
    encoding: "utf8",
  });
}

describe("Docker plugin selection", () => {
  it("resolves manifest ids and source directory names deterministically", () => {
    const extensionsRoot = tempDirs.make("openclaw-docker-plugin-selection-");
    writePlugin(extensionsRoot, "source-only");
    writePlugin(extensionsRoot, "provider-source", "provider-id");

    const result = runSelector(
      extensionsRoot,
      "source-only,provider-id provider-source,provider-id",
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("provider-source\nsource-only\n");
  });

  it("fails closed for unknown, invalid, and ambiguous ids", () => {
    const extensionsRoot = tempDirs.make("openclaw-docker-plugin-selection-errors-");
    writePlugin(extensionsRoot, "shared");
    writePlugin(extensionsRoot, "other-source", "shared");

    for (const [selection, message] of [
      ["missing-plugin", "unknown OPENCLAW_EXTENSIONS plugin id: missing-plugin"],
      ["../invalid", "invalid OPENCLAW_EXTENSIONS plugin id: ../invalid"],
      ["shared", "ambiguous OPENCLAW_EXTENSIONS plugin id: shared"],
    ] as const) {
      const result = runSelector(extensionsRoot, selection);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(message);
    }
  });
});
