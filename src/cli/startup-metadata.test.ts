// Startup metadata tests cover CLI startup metadata collection and propagation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readCliStartupMetadata } from "./startup-metadata.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createModuleLayout(): { moduleDir: string; moduleUrl: string; parentDir: string } {
  const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-metadata-"));
  tempDirs.push(parentDir);
  const moduleDir = path.join(parentDir, "chunks");
  fs.mkdirSync(moduleDir);
  return {
    moduleDir,
    moduleUrl: pathToFileURL(path.join(moduleDir, "root-help-metadata-abc123.js")).href,
    parentDir,
  };
}

function writeMetadata(dir: string, marker: string): void {
  fs.writeFileSync(path.join(dir, "cli-startup-metadata.json"), JSON.stringify({ marker }));
}

describe("readCliStartupMetadata", () => {
  it("prefers metadata beside the bundled chunk", () => {
    const layout = createModuleLayout();
    writeMetadata(layout.parentDir, "parent");
    writeMetadata(layout.moduleDir, "direct");

    expect(readCliStartupMetadata(layout.moduleUrl)).toEqual({ marker: "direct" });
  });

  it("falls back to metadata beside the bundled chunks directory", () => {
    const layout = createModuleLayout();
    writeMetadata(layout.parentDir, "parent");

    expect(readCliStartupMetadata(layout.moduleUrl)).toEqual({ marker: "parent" });
  });
});
