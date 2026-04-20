import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = resolve(SRC_ROOT, "..");
const sourceCache = new Map<string, string>();
const tsFilesCache = new Map<string, string[]>();

type FileFilter = {
  excludeTests?: boolean;
  testOnly?: boolean;
};

function listTsFiles(rootRelativePath: string, filter: FileFilter = {}): string[] {
  const cacheKey = `${rootRelativePath}:${filter.excludeTests ? "exclude-tests" : ""}:${filter.testOnly ? "test-only" : ""}`;
  const cached = tsFilesCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const root = resolve(REPO_ROOT, rootRelativePath);
  const files: string[] = [];

  function walk(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts")) {
        continue;
      }
      const repoRelativePath = relative(REPO_ROOT, fullPath).split(sep).join("/");
      if (filter.excludeTests && repoRelativePath.endsWith(".test.ts")) {
        continue;
      }
      if (filter.testOnly && !repoRelativePath.endsWith(".test.ts")) {
        continue;
      }
      files.push(repoRelativePath);
    }
  }

  walk(root);
  const sorted = files.toSorted();
  tsFilesCache.set(cacheKey, sorted);
  return sorted;
}

function readRepoSource(file: string): string {
  const cached = sourceCache.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const source = readFileSync(resolve(REPO_ROOT, file), "utf8");
  sourceCache.set(file, source);
  return source;
}

describe("plugin contract boundary invariants", () => {
  it("keeps bundled-capability-metadata confined to contract/test inventory", () => {
    const files = listTsFiles("src");
    const offenders = files.filter((file) => {
      if (
        file === "src/plugins/contracts/boundary-invariants.test.ts" ||
        file.endsWith(".contract.test.ts") ||
        file.endsWith("-capability-metadata.test.ts")
      ) {
        return false;
      }
      return readRepoSource(file).includes("contracts/inventory/bundled-capability-metadata");
    });
    expect(offenders).toEqual([]);
  });

  it("keeps the bundled contract inventory out of non-test runtime code", () => {
    const files = listTsFiles("src", { excludeTests: true });
    const offenders = files.filter((file) => {
      return readRepoSource(file).includes("contracts/inventory/bundled-capability-metadata");
    });
    expect(offenders).toEqual([]);
  });

  it("keeps core tests off bundled extension deep imports", () => {
    const files = listTsFiles("src", { testOnly: true });
    const offenders = files.filter((file) => {
      const source = readRepoSource(file);
      return (
        /from\s+["'][^"']*extensions\/.+(?:api|runtime-api|test-api)\.js["']/u.test(source) ||
        /vi\.(?:mock|doMock)\(\s*["'][^"']*extensions\/.+["']/u.test(source) ||
        /importActual<[^>]*>\(\s*["'][^"']*extensions\/.+["']/u.test(source)
      );
    });
    expect(offenders).toEqual([]);
  });

  it("keeps plugin contract tests off bundled path helpers unless the test is explicitly about paths", () => {
    const files = listTsFiles("src/plugins/contracts", { testOnly: true });
    const offenders = files.filter((file) => {
      if (file === "src/plugins/contracts/boundary-invariants.test.ts") {
        return false;
      }
      return readRepoSource(file).includes("test/helpers/bundled-plugin-paths");
    });
    expect(offenders).toEqual([]);
  });

  it("keeps channel production code off bundled-plugin-metadata helpers", () => {
    const files = listTsFiles("src/channels", { excludeTests: true });
    const offenders = files.filter((file) => {
      return readRepoSource(file).includes("plugins/bundled-plugin-metadata");
    });
    expect(offenders).toEqual([]);
  });

  it("keeps contract loaders off hand-built bundled extension paths", () => {
    const files = [
      ...listTsFiles("src/plugins", { excludeTests: true }),
      ...listTsFiles("src/channels", { excludeTests: true }),
    ].toSorted();
    const offenders = files.filter((file) => {
      const source = readRepoSource(file);
      return /extensions\/\$\{|\.\.\/\.\.\/\.\.\/\.\.\/extensions\//u.test(source);
    });
    expect(offenders).toEqual([]);
  });
});
