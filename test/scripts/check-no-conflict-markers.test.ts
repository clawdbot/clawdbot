// Check No Conflict Markers tests cover check no conflict markers script behavior.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  findConflictMarkerLines,
  findConflictMarkersInFiles,
  findConflictMarkersInTrackedFiles,
} from "../../scripts/check-no-conflict-markers.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
  }).trim();
}

describe("check-no-conflict-markers", () => {
  it("finds git conflict markers at the start of lines", () => {
    expect(
      findConflictMarkerLines(
        [
          "const ok = true;",
          "<<<<<<< HEAD",
          "value = left;",
          "=======",
          "value = right;",
          ">>>>>>> main",
        ].join("\n"),
      ),
    ).toEqual([2, 4, 6]);
  });

  it("ignores marker-like text when it is indented or inline", () => {
    expect(
      findConflictMarkerLines(
        ["Example:", "  <<<<<<< HEAD", "const text = '======= not a conflict';", "========"].join(
          "\n",
        ),
      ),
    ).toStrictEqual([]);
  });

  it("scans text files and skips binary files", () => {
    const rootDir = createTempDir("openclaw-conflict-markers-");
    const textFile = path.join(rootDir, "CHANGELOG.md");
    const binaryFile = path.join(rootDir, "image.png");
    fs.writeFileSync(textFile, "<<<<<<< HEAD\nconflict\n>>>>>>> main\n");
    fs.writeFileSync(binaryFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));

    const violations = findConflictMarkersInFiles([textFile, binaryFile]);

    expect(violations).toEqual([
      {
        filePath: textFile,
        lines: [1, 3],
      },
    ]);
  });

  it("finds conflict markers in tracked files using git grep", () => {
    const rootDir = createTempDir("openclaw-conflict-markers-");
    git(rootDir, "init", "-q");
    git(rootDir, "config", "user.email", "test@example.com");
    git(rootDir, "config", "user.name", "Test User");

    const scriptFile = "scripts/bundled-plugin-metadata-runtime.mjs";
    const scriptPath = path.join(rootDir, scriptFile);
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(
      scriptPath,
      [
        "<<<<<<< HEAD",
        'const left = "left";',
        "=======",
        'const right = "right";',
        ">>>>>>> branch",
      ].join("\n"),
    );
    git(rootDir, "add", scriptFile);

    const violations = findConflictMarkersInTrackedFiles(rootDir);

    expect(violations).toEqual([
      {
        filePath: scriptFile,
        lines: [1, 3, 5],
      },
    ]);
  });

  it("disables configured git grep colors before parsing records", () => {
    const rootDir = createTempDir("openclaw-conflict-markers-");
    git(rootDir, "init", "-q");
    git(rootDir, "config", "user.email", "test@example.com");
    git(rootDir, "config", "user.name", "Test User");
    git(rootDir, "config", "color.grep", "always");
    git(rootDir, "config", "color.grep.lineNumber", "red");

    const conflictFile = "src/conflict.ts";
    const conflictPath = path.join(rootDir, conflictFile);
    fs.mkdirSync(path.dirname(conflictPath), { recursive: true });
    fs.writeFileSync(conflictPath, "<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> branch\n");
    git(rootDir, "add", conflictFile);

    expect(findConflictMarkersInTrackedFiles(rootDir)).toEqual([
      {
        filePath: conflictFile,
        lines: [1, 3, 5],
      },
    ]);
  });

  it("returns no violations when tracked files have no conflict markers", () => {
    const rootDir = createTempDir("openclaw-conflict-markers-");
    git(rootDir, "init", "-q");
    git(rootDir, "config", "user.email", "test@example.com");
    git(rootDir, "config", "user.name", "Test User");

    const cleanFile = "src/clean.ts";
    const cleanPath = path.join(rootDir, cleanFile);
    fs.mkdirSync(path.dirname(cleanPath), { recursive: true });
    fs.writeFileSync(cleanPath, "const x = 1;\n");
    git(rootDir, "add", cleanFile);

    expect(findConflictMarkersInTrackedFiles(rootDir)).toEqual([]);
  });

  it("skips binary tracked files via git grep binary exclusion", () => {
    const rootDir = createTempDir("openclaw-conflict-markers-");
    git(rootDir, "init", "-q");
    git(rootDir, "config", "user.email", "test@example.com");
    git(rootDir, "config", "user.name", "Test User");

    const binaryFile = "assets/image.png";
    const binaryPath = path.join(rootDir, binaryFile);
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    // Marker-like bytes inside a binary file should not be reported because
    // git grep -I skips binary files.
    fs.writeFileSync(
      binaryPath,
      Buffer.from([0x3c, 0x3c, 0x3c, 0x3c, 0x3c, 0x3c, 0x3c, 0x20, 0x00]),
    );
    git(rootDir, "add", binaryFile);

    expect(findConflictMarkersInTrackedFiles(rootDir)).toEqual([]);
  });

  it("handles tracked files with spaces and unusual characters in paths", () => {
    const rootDir = createTempDir("openclaw-conflict-markers-");
    git(rootDir, "init", "-q");
    git(rootDir, "config", "user.email", "test@example.com");
    git(rootDir, "config", "user.name", "Test User");

    const weirdFile = "docs/weird name (v2).md";
    const weirdPath = path.join(rootDir, weirdFile);
    fs.mkdirSync(path.dirname(weirdPath), { recursive: true });
    fs.writeFileSync(
      weirdPath,
      "before\n<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> branch\nafter\n",
    );
    git(rootDir, "add", weirdFile);

    const violations = findConflictMarkersInTrackedFiles(rootDir);

    expect(violations).toEqual([
      {
        filePath: weirdFile,
        lines: [2, 4, 6],
      },
    ]);
  });

  it("reports tracked filenames containing newlines without mangling the path", () => {
    const rootDir = createTempDir("openclaw-conflict-markers-");
    git(rootDir, "init", "-q");
    git(rootDir, "config", "user.email", "test@example.com");
    git(rootDir, "config", "user.name", "Test User");

    // git allows newlines in tracked filenames and git grep -z prints the
    // path verbatim; the parser must read the NUL-delimited path before any
    // newline-based record splitting or the path is silently truncated.
    const newlineFile = "docs/weird\nname.md";
    const newlinePath = path.join(rootDir, newlineFile);
    fs.mkdirSync(path.dirname(newlinePath), { recursive: true });
    fs.writeFileSync(
      newlinePath,
      "before\n<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> branch\nafter\n",
    );
    git(rootDir, "add", newlineFile);

    const violations = findConflictMarkersInTrackedFiles(rootDir);

    expect(violations).toEqual([
      {
        filePath: newlineFile,
        lines: [2, 4, 6],
      },
    ]);
  });

  it("detects markers in a file larger than the previous scan byte limit without reading it whole", () => {
    const rootDir = createTempDir("openclaw-conflict-markers-");
    git(rootDir, "init", "-q");
    git(rootDir, "config", "user.email", "test@example.com");
    git(rootDir, "config", "user.name", "Test User");

    const largeFile = "generated/large.txt";
    const largePath = path.join(rootDir, largeFile);
    fs.mkdirSync(path.dirname(largePath), { recursive: true });
    // 10 MiB of filler with a marker near the end; git grep reports the line
    // number without us buffering the entire file.
    const filler = ("a".repeat(10240) + "\n").repeat(1024);
    fs.writeFileSync(largePath, filler + "<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> branch\n");
    git(rootDir, "add", largeFile);

    const violations = findConflictMarkersInTrackedFiles(rootDir);

    expect(violations).toEqual([
      {
        filePath: largeFile,
        lines: [1025, 1027, 1029],
      },
    ]);
  });

  it("main reports tracked violations with paths relative to cwd", () => {
    const rootDir = createTempDir("openclaw-conflict-markers-main-");
    git(rootDir, "init", "-q");
    git(rootDir, "config", "user.email", "test@example.com");
    git(rootDir, "config", "user.name", "Test User");

    const conflictFile = "src/conflict.ts";
    const conflictPath = path.join(rootDir, conflictFile);
    fs.mkdirSync(path.dirname(conflictPath), { recursive: true });
    fs.writeFileSync(
      conflictPath,
      [
        "<<<<<<< HEAD",
        'const value = "left";',
        "=======",
        'const value = "right";',
        ">>>>>>> branch",
      ].join("\n"),
    );
    git(rootDir, "add", conflictFile);

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
