// Check File Utils tests cover check file utils script behavior.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectFilesSync,
  isCodeFile,
  relativeToCwd,
  toPosixPath,
} from "../../scripts/check-file-utils.js";
import { createScriptTestHarness } from "./test-helpers.js";

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
