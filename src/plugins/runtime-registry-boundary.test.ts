import { spawnSync } from "node:child_process";
import fs, { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { expectNoFsSyncDuring } from "../test-utils/fs-scan-assertions.js";
import { listGitTrackedFiles, toRepoRelativePath } from "../test-utils/repo-files.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const allowedRuntimeResolverRefs = new Set([
  "src/commands/doctor.e2e-harness.ts",
  "src/infra/outbound/channel-bootstrap.runtime.ts",
  "src/plugins/capability-provider-runtime.ts",
  "src/plugins/loader.ts",
]);

function listSourceFiles(dir: string): string[] {
  const externalFiles = listExternalSourceFiles(dir);
  if (externalFiles) {
    return externalFiles;
  }
  return listSourceFilesByDirectory(dir);
}

function listExternalSourceFiles(dir: string): string[] | null {
  return listGitSourceFiles(dir) ?? listFindSourceFiles(dir);
}

function listGitSourceFiles(dir: string): string[] | null {
  const relativeRoot = toRepoRelativePath(repoRoot, dir) || ".";
  const files = listGitTrackedFiles({ repoRoot, pathspecs: relativeRoot });
  if (!files) {
    return null;
  }
  return files
    .map((file) => resolve(repoRoot, file))
    .filter((filePath) => fs.existsSync(filePath))
    .filter(isProductionTypeScriptFile)
    .toSorted();
}

function listFindSourceFiles(dir: string): string[] | null {
  const result = spawnSync("find", [dir, "-type", "f", "-name", "*.ts"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 4,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((file) => resolve(repoRoot, file))
    .filter(isProductionTypeScriptFile)
    .toSorted();
}

function listSourceFilesByDirectory(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") {
      continue;
    }
    const path = resolve(dir, entry);
    const stat = fs.statSync(path);
    if (stat.isDirectory()) {
      files.push(...listSourceFilesByDirectory(path));
      continue;
    }
    if (!isProductionTypeScriptFile(path)) {
      continue;
    }
    files.push(path);
  }
  return files;
}

function isProductionTypeScriptFile(path: string): boolean {
  return path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.endsWith(".test.tsx");
}

describe("runtime plugin registry boundary", () => {
  it("lists source files without scanning src in-process", () => {
    expectNoFsSyncDuring(() => {
      const files = listSourceFiles(resolve(repoRoot, "src"));

      expect(files.length).toBeGreaterThan(0);
      expect(files.every(isProductionTypeScriptFile)).toBe(true);
    }, ["readdirSync", "statSync"]);
  });

  it("keeps runtime registry resolution behind the loader boundary", () => {
    const offenders = listSourceFiles(resolve(repoRoot, "src"))
      .map((path) => ({
        path,
        relativePath: relative(repoRoot, path),
        source: readFileSync(path, "utf8"),
      }))
      .filter(
        (file) =>
          !allowedRuntimeResolverRefs.has(file.relativePath) &&
          file.source.includes("resolveRuntimePluginRegistry"),
      )
      .map((file) => file.relativePath);

    expect(offenders).toStrictEqual([]);
  });
});
