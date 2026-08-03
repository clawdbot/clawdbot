// Check File Utils tests cover check file utils script behavior.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectFilesSync,
  isCodeFile,
  listRepoFilesSync,
  relativeToCwd,
  toPosixPath,
} from "../../scripts/check-file-utils.js";
import { createScriptTestHarness } from "./test-helpers.js";

const execFileSyncMock = vi.hoisted(() => vi.fn(() => ""));

vi.mock("node:child_process", async (importOriginal) => {
  const original = (await importOriginal()) as typeof import("node:child_process");
  return { ...original, execFileSync: execFileSyncMock };
});

const { createTempDir } = createScriptTestHarness();

describe("scripts/check-file-utils isCodeFile", () => {
  it("accepts source files and skips declarations", () => {
    expect(isCodeFile("example.ts")).toBe(true);
    expect(isCodeFile("example.mjs")).toBe(true);
    expect(isCodeFile("example.d.ts")).toBe(false);
  });
});

describe("scripts/check-file-utils collectFilesSync", () => {
  it("collects matching files while skipping common generated dirs", () => {
    const rootDir = createTempDir("openclaw-check-file-utils-");
    fs.mkdirSync(path.join(rootDir, "src", "nested"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "dist"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "docs", ".generated"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "src", "keep.ts"), "");
    fs.writeFileSync(path.join(rootDir, "src", "nested", "keep.test.ts"), "");
    fs.writeFileSync(path.join(rootDir, "dist", "skip.ts"), "");
    fs.writeFileSync(path.join(rootDir, "docs", ".generated", "skip.ts"), "");

    const files = collectFilesSync(rootDir, {
      includeFile: (filePath) => filePath.endsWith(".ts"),
    }).map((filePath) => toPosixPath(path.relative(rootDir, filePath)));

    expect(files.toSorted((left, right) => left.localeCompare(right))).toEqual([
      "src/keep.ts",
      "src/nested/keep.test.ts",
    ]);
  });

  it("supports custom skipped directories", () => {
    const rootDir = createTempDir("openclaw-check-file-utils-");
    fs.mkdirSync(path.join(rootDir, "fixtures"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "fixtures", "skip.ts"), "");
    fs.writeFileSync(path.join(rootDir, "src", "keep.ts"), "");

    const files = collectFilesSync(rootDir, {
      includeFile: (filePath) => filePath.endsWith(".ts"),
      skipDirNames: new Set(["fixtures"]),
    }).map((filePath) => toPosixPath(path.relative(rootDir, filePath)));

    expect(files).toEqual(["src/keep.ts"]);
  });
});

describe("scripts/check-file-utils relativeToCwd", () => {
  it("renders repo-relative paths when possible", () => {
    expect(relativeToCwd(path.join(process.cwd(), "scripts", "check-file-utils.ts"))).toBe(
      "scripts/check-file-utils.ts",
    );
  });
});

describe("scripts/check-file-utils listRepoFilesSync", () => {
  afterEach(() => {
    execFileSyncMock.mockReset();
  });

  it("bounds git ls-files with a timeout and kill signal", () => {
    execFileSyncMock.mockReturnValue("src/keep.ts\nsrc/skip.d.ts\n");

    expect(
      listRepoFilesSync("/fake/repo", {
        includeFile: (filePath) => isCodeFile(filePath),
      }),
    ).toEqual(["src/keep.ts"]);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["-C", "/fake/repo", "ls-files", "--"]),
      expect.objectContaining({
        timeout: 30_000,
        killSignal: "SIGKILL",
      }),
    );
  });

  it("falls back to filesystem traversal when git ls-files times out", () => {
    const error: NodeJS.ErrnoException & { signal?: string } = new Error("Command timed out");
    error.code = "ETIMEDOUT";
    error.signal = "SIGKILL";
    execFileSyncMock.mockImplementation(() => {
      throw error;
    });
    const rootDir = createTempDir("openclaw-check-file-utils-fallback-");
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "src", "keep.ts"), "");

    expect(
      listRepoFilesSync(rootDir, {
        includeFile: (filePath) => filePath.endsWith(".ts"),
      }),
    ).toEqual(["src/keep.ts"]);
  });
});
