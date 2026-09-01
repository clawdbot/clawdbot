// Covers fs-safe import boundary rules in source files.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expectNoReaddirSyncDuring } from "../test-utils/fs-scan-assertions.js";
import { listGitTrackedFiles, toRepoRelativePath } from "../test-utils/repo-files.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const SCAN_ROOTS = ["src", "packages", "extensions"] as const;

const ALLOWED_PREFIXES = ["src/infra/", "src/plugin-sdk/", "packages/memory-host-sdk/"] as const;

function isSourceFile(filePath: string): boolean {
  return filePath.endsWith(".ts") && !filePath.endsWith(".test.ts") && !filePath.endsWith(".d.ts");
}

function listSourceFiles(): string[] {
  const files = listGitTrackedFiles({ repoRoot: REPO_ROOT, pathspecs: SCAN_ROOTS });
  if (files) {
    const sourceFiles = files.filter(isSourceFile);
    return SCAN_ROOTS.flatMap((root) =>
      sourceFiles
        .filter((file) => file.startsWith(`${root}/`))
        .map((file) => path.join(REPO_ROOT, file))
        .toSorted(),
    );
  }
  return SCAN_ROOTS.flatMap((root) => {
    const dir = path.join(REPO_ROOT, root);
    return listFindSourceFiles(dir) ?? walkSourceFiles(dir);
  });
}

function listFindSourceFiles(dir: string): string[] | null {
  const result = spawnSync("find", [dir, "-type", "f", "-name", "*.ts"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 8,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter(isSourceFile)
    .toSorted();
}

function walkSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") {
        continue;
      }
      files.push(...walkSourceFiles(fullPath));
      continue;
    }
    if (entry.isFile() && isSourceFile(fullPath)) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("fs-safe import boundary", () => {
  it("lists source files without scanning boundary roots in-process", () => {
    expectNoReaddirSyncDuring(() => {
      const files = listSourceFiles();

      expect(files.length).toBeGreaterThan(0);
      expect(files.every(isSourceFile)).toBe(true);
    });
  });

  it("keeps direct fs-safe imports behind OpenClaw policy wrappers", () => {
    const violations = listSourceFiles()
      .map((filePath) => toRepoRelativePath(REPO_ROOT, filePath))
      .filter((filePath) => {
        if (ALLOWED_PREFIXES.some((prefix) => filePath.startsWith(prefix))) {
          return false;
        }
        const source = fs.readFileSync(path.join(REPO_ROOT, filePath), "utf8");
        return source.includes('"@openclaw/fs-safe') || source.includes("'@openclaw/fs-safe");
      });

    expect(violations).toStrictEqual([]);
  });
});
