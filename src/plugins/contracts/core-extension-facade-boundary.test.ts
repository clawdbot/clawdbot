import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

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
  const relativeDir = path.relative(repoRoot, dir).split(path.sep).join("/");
  if (!relativeDir || relativeDir.startsWith("..")) {
    return null;
  }
  const result = spawnSync("git", ["ls-files", "--", relativeDir], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim().replaceAll("\\", "/"))
    .filter((line) => line.length > 0 && line.endsWith(".ts") && !line.includes("/plugin-sdk/"))
    .map((line) => path.join(repoRoot, ...line.split("/")))
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
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

describe("core extension facade boundary", () => {
  it("lists core facade boundary sources from git without walking src", () => {
    const readDir = vi.spyOn(fs, "readdirSync");
    try {
      const files = collectSourceFiles(srcRoot);

      expect(files.length).toBeGreaterThan(0);
      expect(files.some((file) => file.includes("/plugin-sdk/"))).toBe(false);
      expect(readDir).not.toHaveBeenCalled();
    } finally {
      readDir.mockRestore();
    }
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
