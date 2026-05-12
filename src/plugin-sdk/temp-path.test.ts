import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { buildRandomTempFilePath, withTempDownloadPath } from "./temp-path.js";

function expectPathInsideTmpRoot(resultPath: string) {
  const tmpRoot = fsSync.realpathSync(resolvePreferredOpenClawTmpDir());
  let resolved = path.resolve(resultPath);
  try {
    resolved = path.join(fsSync.realpathSync(path.dirname(resultPath)), path.basename(resultPath));
  } catch {
    // The temp parent is intentionally gone after withTempDownloadPath cleanup.
  }
  const rel = path.relative(tmpRoot, resolved);
  expect(rel === ".." || rel.startsWith(`..${path.sep}`)).toBe(false);
  expect(resultPath).not.toContain("..");
}

describe("buildRandomTempFilePath", () => {
  it.each([
    {
      name: "builds deterministic paths when now/uuid are provided",
      input: {
        prefix: "line-media",
        extension: ".jpg",
        tmpDir: "/tmp",
        now: 123,
        uuid: "abc",
      },
      expectedPath: path.join("/tmp", "line-media-123-abc.jpg"),
      expectedBasename: "line-media-123-abc.jpg",
      verifyInsideTmpRoot: false,
    },
    {
      name: "sanitizes prefix and extension to avoid path traversal segments",
      input: {
        prefix: "../../channels/../media",
        extension: "/../.jpg",
        now: 123,
        uuid: "abc",
      },
      expectedBasename: "channels-media-123-abc.jpg",
      verifyInsideTmpRoot: true,
    },
  ])("$name", ({ input, expectedPath, expectedBasename, verifyInsideTmpRoot }) => {
    const result = buildRandomTempFilePath(input);
    if (expectedPath) {
      expect(result).toBe(expectedPath);
    }
    expect(path.basename(result)).toBe(expectedBasename);
    if (verifyInsideTmpRoot) {
      expectPathInsideTmpRoot(result);
    }
  });
});

describe("withTempDownloadPath", () => {
  it.each([
    {
      name: "creates a temp path under tmp dir and cleans up the temp directory",
      input: { prefix: "line-media" },
      expectCleanup: true,
      expectedBasename: undefined,
    },
    {
      name: "sanitizes prefix and fileName",
      input: { prefix: "../../channels/../media", fileName: "../../evil.bin" },
      expectCleanup: false,
      expectedBasename: "evil.bin",
    },
  ])("$name", async ({ input, expectCleanup, expectedBasename }) => {
    let capturedPath = "";
    await withTempDownloadPath(input, async (tmpPath) => {
      capturedPath = tmpPath;
      if (expectCleanup) {
        await fs.writeFile(tmpPath, "ok");
      }
    });

    expectPathInsideTmpRoot(capturedPath);
    if (expectedBasename) {
      expect(path.basename(capturedPath)).toBe(expectedBasename);
    } else {
      expect(capturedPath).toContain(path.join(resolvePreferredOpenClawTmpDir(), "line-media-"));
    }
    if (expectCleanup) {
      let statError: NodeJS.ErrnoException | undefined;
      try {
        await fs.stat(capturedPath);
      } catch (error) {
        statError = error as NodeJS.ErrnoException;
      }
      expect(statError?.code).toBe("ENOENT");
    }
  });
});
