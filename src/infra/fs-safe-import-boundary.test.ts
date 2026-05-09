import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const SCAN_ROOTS = ["src", "packages", "extensions"] as const;

const ALLOWED_PREFIXES = ["src/infra/", "src/plugin-sdk/", "packages/memory-host-sdk/"] as const;

function isSourceFile(filePath: string): boolean {
  return filePath.endsWith(".ts") && !filePath.endsWith(".test.ts") && !filePath.endsWith(".d.ts");
}

function walk(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") {
        continue;
      }
      files.push(...walk(fullPath));
      continue;
    }
    if (entry.isFile() && isSourceFile(fullPath)) {
      files.push(fullPath);
    }
  }
  return files;
}

function toRepoPath(filePath: string): string {
  return path.relative(REPO_ROOT, filePath).replaceAll(path.sep, "/");
}

describe("fs-safe import boundary", () => {
  it("keeps direct fs-safe imports behind OpenClaw policy wrappers", () => {
    const violations = SCAN_ROOTS.flatMap((root) => walk(path.join(REPO_ROOT, root)))
      .map(toRepoPath)
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
