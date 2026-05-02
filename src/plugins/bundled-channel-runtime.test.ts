import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listBundledChannelPluginMetadata,
  resolveBundledChannelWorkspacePath,
} from "./bundled-channel-runtime.js";

const tempRoots: string[] = [];

function createTempRoot(): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-empty-bundled-root-"));
  tempRoots.push(tempRoot);
  return tempRoot;
}

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0)) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe("bundled channel runtime metadata", () => {
  it("preserves explicit empty bundled roots", () => {
    const tempRoot = createTempRoot();

    expect(listBundledChannelPluginMetadata({ rootDir: tempRoot })).toEqual([]);
    expect(resolveBundledChannelWorkspacePath({ rootDir: tempRoot, pluginId: "telegram" })).toBe(
      null,
    );
  });

  it("preserves explicit missing bundled scan roots", () => {
    const tempRoot = createTempRoot();
    const missingScanDir = path.join(tempRoot, "missing-extensions");

    expect(
      listBundledChannelPluginMetadata({ rootDir: tempRoot, scanDir: missingScanDir }),
    ).toEqual([]);
  });
});
