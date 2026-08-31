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
  it("reports exact lines across tracked text files and unusual paths", () => {
    const conflict = "before\n<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> branch\nafter\n";
    const rootDir = createRepository({
      "src/conflict.ts": conflict,
      "CHANGELOG.md": "<<<<<<< HEAD\nconflict\n>>>>>>> main\n",
      "scripts/bundled-plugin-metadata-runtime.mjs":
        "<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> branch\n",
      "docs/new\nline.md": conflict,
      "docs/weird name (v2).md": conflict,
    });

    expect(findConflictMarkersInTrackedFiles(rootDir)).toEqual([
      { filePath: "CHANGELOG.md", lines: [1, 3] },
      { filePath: "docs/new\nline.md", lines: [2, 4, 6] },
      { filePath: "docs/weird name (v2).md", lines: [2, 4, 6] },
      { filePath: "scripts/bundled-plugin-metadata-runtime.mjs", lines: [1, 3, 5] },
      { filePath: "src/conflict.ts", lines: [2, 4, 6] },
    ]);
  });

  it("ignores clean text, inline or indented markers, and binary marker bytes", () => {
    const rootDir = createRepository({
      "src/clean.ts": "const x = 1;\n",
      "docs/examples.md": [
        "Example:",
        "  <<<<<<< HEAD",
        "const text = '======= not a conflict';",
        "========",
      ].join("\n"),
      // An actual marker prefix followed by NUL must still be excluded by git grep -I.
      "assets/image.png": Buffer.from("<<<<<<< HEAD\n\0"),
    });

    expect(findConflictMarkersInTrackedFiles(rootDir)).toEqual([]);
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
