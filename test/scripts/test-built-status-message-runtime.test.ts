import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findBuiltStatusMessageRuntimePath } from "../../scripts/test-built-status-message-runtime.mjs";
import { expectNoReaddirSyncDuring } from "../../src/test-utils/fs-scan-assertions.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeDistDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-status-runtime-"));
  tempDirs.push(root);
  const distDir = path.join(root, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  return distDir;
}

describe("test-built-status-message-runtime", () => {
  it("finds the built status runtime without scanning dist in-process", () => {
    const distDir = makeDistDir();
    fs.writeFileSync(path.join(distDir, "status-message.runtime.js"), "export {}\n");
    fs.writeFileSync(path.join(distDir, "status-message.runtime-abc123.js"), "export {}\n");
    fs.writeFileSync(path.join(distDir, "other.js"), "export {}\n");

    expectNoReaddirSyncDuring(() => {
      expect(findBuiltStatusMessageRuntimePath(distDir)).toBe(
        path.join(distDir, "status-message.runtime-abc123.js"),
      );
    });
  });
});
