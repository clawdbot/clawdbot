import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findConflictMarkersInTrackedFiles } from "../../scripts/check-no-conflict-markers.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createRepository(files: Record<string, string | Buffer>): string {
  const rootDir = createTempDir("openclaw-conflict-markers-");
  git(rootDir, "init", "-q");
  for (const [file, content] of Object.entries(files)) {
    const filePath = path.join(rootDir, file);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  // The scanner reads indexed worktree files, so no commit or author setup is needed.
  git(rootDir, "add", "--", ...Object.keys(files));
  return rootDir;
}

describe("check-no-conflict-markers", () => {
  it("finds git conflict markers at the start of lines", () => {
    const rootDir = createRepository({
      "src/conflict.ts": [
        "const ok = true;",
        "<<<<<<< HEAD",
        "value = left;",
        "=======",
        "value = right;",
        ">>>>>>> main",
      ].join("\n"),
    });

    expect(findConflictMarkersInTrackedFiles(rootDir)).toEqual([
      { filePath: "src/conflict.ts", lines: [2, 4, 6] },
    ]);
  });

  it("ignores marker-like text when it is indented or inline", () => {
    const rootDir = createRepository({
      "src/clean.ts": [
        "Example:",
        "  <<<<<<< HEAD",
        "const text = '======= not a conflict';",
        "========",
      ].join("\n"),
    });

    expect(findConflictMarkersInTrackedFiles(rootDir)).toStrictEqual([]);
  });

  it("scans text files and skips binary files", () => {
    const rootDir = createRepository({
      "CHANGELOG.md": "<<<<<<< HEAD\nconflict\n>>>>>>> main\n",
      "image.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]),
    });

    expect(findConflictMarkersInTrackedFiles(rootDir)).toEqual([
      { filePath: "CHANGELOG.md", lines: [1, 3] },
    ]);
  });

  it("finds conflict markers in tracked files using git grep", () => {
    const scriptFile = "scripts/bundled-plugin-metadata-runtime.mjs";
    const rootDir = createRepository({
      [scriptFile]: [
        "<<<<<<< HEAD",
        'const left = "left";',
        "=======",
        'const right = "right";',
        ">>>>>>> branch",
      ].join("\n"),
    });

    expect(findConflictMarkersInTrackedFiles(rootDir)).toEqual([
      { filePath: scriptFile, lines: [1, 3, 5] },
    ]);
  });

  it("disables configured git grep colors before parsing records", () => {
    const conflictFile = "src/conflict.ts";
    const rootDir = createRepository({
      [conflictFile]: "<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> branch\n",
    });
    git(rootDir, "config", "color.grep", "always");
    git(rootDir, "config", "color.grep.lineNumber", "red");

    expect(findConflictMarkersInTrackedFiles(rootDir)).toEqual([
      { filePath: conflictFile, lines: [1, 3, 5] },
    ]);
  });

  it("returns no violations when tracked files have no conflict markers", () => {
    const rootDir = createRepository({ "src/clean.ts": "const x = 1;\n" });

    expect(findConflictMarkersInTrackedFiles(rootDir)).toEqual([]);
  });

  it("skips binary tracked files via git grep binary exclusion", () => {
    // Marker-like bytes inside a binary file must still be excluded by git grep -I.
    const rootDir = createRepository({
      "assets/image.png": Buffer.from([0x3c, 0x3c, 0x3c, 0x3c, 0x3c, 0x3c, 0x3c, 0x20, 0x00]),
    });

    expect(findConflictMarkersInTrackedFiles(rootDir)).toEqual([]);
  });

  it.each([
    [
      "handles tracked files with spaces and unusual characters in paths",
      "docs/weird name (v2).md",
    ],
    [
      "reports tracked filenames containing newlines without mangling the path",
      "docs/weird\nname.md",
    ],
  ])("%s", (_name, file) => {
    // NUL framing must preserve the complete path, including embedded newlines.
    const rootDir = createRepository({
      [file]: "before\n<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> branch\nafter\n",
    });

    expect(findConflictMarkersInTrackedFiles(rootDir)).toEqual([
      { filePath: file, lines: [2, 4, 6] },
    ]);
  });

  it("detects markers in a file larger than the previous scan byte limit without reading it whole", () => {
    const largeFile = "generated/large.txt";
    // 10 MiB of filler keeps the marker beyond the old buffered scan limit.
    const filler = ("a".repeat(10240) + "\n").repeat(1024);
    const rootDir = createRepository({
      [largeFile]: filler + "<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> branch\n",
    });

    expect(findConflictMarkersInTrackedFiles(rootDir)).toEqual([
      { filePath: largeFile, lines: [1025, 1027, 1029] },
    ]);
  });

  it("main reports tracked violations with paths relative to cwd", () => {
    const conflictFile = "src/conflict.ts";
    const rootDir = createRepository({
      [conflictFile]: [
        "<<<<<<< HEAD",
        'const value = "left";',
        "=======",
        'const value = "right";',
        ">>>>>>> branch",
      ].join("\n"),
    });

    const scriptPath = path.resolve(__dirname, "../../scripts/check-no-conflict-markers.mjs");
    let error: Error | undefined;
    try {
      execFileSync(process.execPath, [scriptPath], {
        cwd: rootDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (caught) {
      error = caught as Error;
    }

    expect(error).toBeDefined();
    const stderr = (error as { stderr?: string }).stderr ?? "";
    expect(stderr).toContain("Found unresolved merge conflict markers:");
    expect(stderr).toContain(`- ${conflictFile}:1,3,5`);
  });
});
