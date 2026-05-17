import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { expectNoReaddirSyncDuring } from "../../test-utils/fs-scan-assertions.js";
import { listGitTrackedFiles, toRepoRelativePath } from "../../test-utils/repo-files.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const srcRoot = path.join(repoRoot, "src");
const forbiddenOllamaFacadeFiles = [
  "src/plugin-sdk/ollama.ts",
  "src/plugin-sdk/ollama-runtime.ts",
] as const;
const genericCoreFixtureFiles = [
  "src/commands/auth-choice.apply.plugin-provider.test.ts",
  "src/plugins/contracts/memory-embedding-provider.contract.test.ts",
  "src/plugins/discovery.test.ts",
  "src/plugins/contracts/tts-contract-suites.ts",
] as const;
const forbiddenGenericFixtureTerms = [
  /\bOllama\b|\bollama\b/u,
  /\bMoonshot\b|\bmoonshot\b/u,
  /\bxAI\b|\bxai\b|\bx-ai\b/u,
] as const;
const importSpecifierPattern =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function listTrackedSourceFiles(dir: string): string[] | null {
  const relativeDir = toRepoRelativePath(repoRoot, dir);
  if (!relativeDir || relativeDir.startsWith("..")) {
    return null;
  }
  const files = listGitTrackedFiles({ repoRoot, pathspecs: relativeDir });
  if (!files) {
    return null;
  }
  return files
    .filter((line) => line.length > 0 && line.endsWith(".ts") && !line.includes("/plugin-sdk/"))
    .map((line) => path.join(repoRoot, ...line.split("/")))
    .filter((filePath) => fs.existsSync(filePath))
    .toSorted();
}

function collectSourceFiles(dir: string, files: string[] = []): string[] {
  const trackedFiles = listTrackedSourceFiles(dir);
  if (trackedFiles) {
    files.push(...trackedFiles);
    return files;
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "plugin-sdk") {
      continue;
    }
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(entryPath, files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(entryPath);
    }
  }
  return files;
}

function toRepoRelative(filePath: string): string {
  return toRepoRelativePath(repoRoot, filePath);
}

describe("core extension facade boundary", () => {
  it("lists core facade boundary sources from git without walking src", () => {
    expectNoReaddirSyncDuring(() => {
      const files = collectSourceFiles(srcRoot);

      expect(files.length).toBeGreaterThan(0);
      expect(files.some((file) => file.includes("/plugin-sdk/"))).toBe(false);
    });
  });

  it("does not expose Ollama plugin facades from core plugin-sdk", () => {
    expect(
      forbiddenOllamaFacadeFiles.filter((file) => fs.existsSync(path.join(repoRoot, file))),
    ).toStrictEqual([]);
  });

  it("does not import Ollama plugin facades from core code", () => {
    const violations: string[] = [];
    for (const filePath of collectSourceFiles(srcRoot)) {
      const source = fs.readFileSync(filePath, "utf8");
      for (const match of source.matchAll(importSpecifierPattern)) {
        const specifier = match[1] ?? match[2];
        if (specifier?.includes("plugin-sdk/ollama")) {
          violations.push(`${toRepoRelative(filePath)} -> ${specifier}`);
        }
      }
    }

    expect(violations).toStrictEqual([]);
  });

  it("keeps generic core fixtures free of bundled provider names", () => {
    const violations: string[] = [];
    for (const file of genericCoreFixtureFiles) {
      const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
      for (const pattern of forbiddenGenericFixtureTerms) {
        if (pattern.test(source)) {
          violations.push(`${file} matches ${String(pattern)}`);
        }
      }
    }

    expect(violations).toStrictEqual([]);
  });
});
