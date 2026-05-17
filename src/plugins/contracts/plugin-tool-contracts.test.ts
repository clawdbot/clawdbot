import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expectNoReaddirSyncDuring } from "../../test-utils/fs-scan-assertions.js";
import {
  listGitTrackedFiles,
  toRepoPath,
  toRepoRelativePath,
} from "../../test-utils/repo-files.js";

type PluginManifestFile = {
  id?: unknown;
  contracts?: {
    tools?: unknown;
  };
};

function walkFiles(dir: string): string[] {
  const gitFiles = listGitFiles(dir);
  if (gitFiles) {
    return gitFiles;
  }

  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
      continue;
    }
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(entryPath));
      continue;
    }
    files.push(entryPath);
  }
  return files;
}

function repoRelativePath(filePath: string): string {
  return toRepoRelativePath(process.cwd(), filePath);
}

function isSkippedRepoPath(relativePath: string): boolean {
  return relativePath
    .split("/")
    .some((part) => part === "node_modules" || part === "dist" || part.startsWith("."));
}

function listGitFiles(dir: string): string[] | null {
  const relativeDir = repoRelativePath(dir);
  if (!relativeDir || relativeDir.startsWith("..") || path.isAbsolute(relativeDir)) {
    return null;
  }
  const files = listGitTrackedFiles({ pathspecs: relativeDir });
  if (!files) {
    return null;
  }
  return files
    .filter((line) => !isSkippedRepoPath(line))
    .map((line) => path.join(process.cwd(), ...line.split("/")))
    .filter((filePath) => fs.existsSync(filePath))
    .toSorted();
}

function listGitPluginManifestPaths(extensionsDir: string): string[] | null {
  const relativeDir = repoRelativePath(extensionsDir);
  if (!relativeDir || relativeDir.startsWith("..") || path.isAbsolute(relativeDir)) {
    return null;
  }
  const files = listGitTrackedFiles({ pathspecs: relativeDir });
  if (!files) {
    return null;
  }
  return files
    .filter((line) => /^extensions\/[^/]+\/openclaw\.plugin\.json$/u.test(line))
    .map((line) => path.join(process.cwd(), ...line.split("/")))
    .filter((filePath) => fs.existsSync(filePath))
    .toSorted();
}

function listPluginManifestPaths(extensionsDir: string): string[] {
  const gitPaths = listGitPluginManifestPaths(extensionsDir);
  if (gitPaths) {
    return gitPaths;
  }

  return fs
    .readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => path.join(extensionsDir, entry.name, "openclaw.plugin.json"))
    .filter((manifestPath) => fs.existsSync(manifestPath));
}

function isProductionSource(filePath: string): boolean {
  if (!/\.(?:cjs|mjs|js|ts|tsx)$/.test(filePath)) {
    return false;
  }
  const normalized = toRepoPath(filePath);
  return !/(\.test\.|\.spec\.|\/__tests__\/|\/test-support\/)/.test(normalized);
}

function readBalancedCallArguments(source: string, openParenIndex: number): string | undefined {
  let depth = 0;
  let quote: '"' | "'" | "`" | undefined;
  let escaped = false;
  for (let index = openParenIndex; index < source.length; index += 1) {
    const char = source[index];
    if (!char) {
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "{" || char === "[") {
      depth += 1;
      continue;
    }
    if (char === ")" || char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0 && char === ")") {
        return source.slice(openParenIndex + 1, index);
      }
    }
  }
  return undefined;
}

function listRegisterToolCalls(source: string): string[] {
  const calls: string[] = [];
  const pattern = /\bregisterTool\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const openParenIndex = source.indexOf("(", match.index);
    const args = readBalancedCallArguments(source, openParenIndex);
    if (args !== undefined) {
      calls.push(args);
    }
  }
  return calls;
}

function splitTopLevelArgs(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: '"' | "'" | "`" | undefined;
  let escaped = false;
  let start = 0;
  for (let index = 0; index < args.length; index += 1) {
    const char = args[index];
    if (!char) {
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "{" || char === "[") {
      depth += 1;
      continue;
    }
    if (char === ")" || char === "}" || char === "]") {
      depth -= 1;
      continue;
    }
    if (char === "," && depth === 0) {
      const part = args.slice(start, index).trim();
      if (part.length > 0) {
        parts.push(part);
      }
      start = index + 1;
    }
  }
  const part = args.slice(start).trim();
  if (part.length > 0) {
    parts.push(part);
  }
  return parts;
}

function extractStringLiterals(source: string): string[] {
  const names: string[] = [];
  const pattern = /["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    if (match[1]) {
      names.push(match[1]);
    }
  }
  return names;
}

function extractStaticRegisteredToolNamesFromObject(source: string): string[] {
  const names = new Set<string>();
  const namesPattern = /\bnames\s*:\s*\[([\s\S]*?)\]/g;
  let namesMatch: RegExpExecArray | null;
  while ((namesMatch = namesPattern.exec(source))) {
    for (const name of extractStringLiterals(namesMatch[1] ?? "")) {
      names.add(name);
    }
  }

  const namePattern = /\bname\s*:\s*["']([^"']+)["']/g;
  let nameMatch: RegExpExecArray | null;
  while ((nameMatch = namePattern.exec(source))) {
    if (nameMatch[1]) {
      names.add(nameMatch[1]);
    }
  }
  return [...names];
}

function extractStaticRegisteredToolNames(callArgs: string): string[] {
  const args = splitTopLevelArgs(callArgs);
  const names = new Set<string>();
  const firstArg = args[0]?.trim() ?? "";
  const optionsArg = args[1]?.trim() ?? "";
  if (firstArg.startsWith("{")) {
    for (const name of extractStaticRegisteredToolNamesFromObject(firstArg)) {
      names.add(name);
    }
  }
  if (optionsArg.startsWith("{")) {
    for (const name of extractStaticRegisteredToolNamesFromObject(optionsArg)) {
      names.add(name);
    }
  }
  return [...names];
}

function readManifest(manifestPath: string): PluginManifestFile {
  return JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as PluginManifestFile;
}

function normalizeManifestTools(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

describe("bundled plugin tool manifest contracts", () => {
  it("lists plugin tool contract inputs from git without walking extension roots", () => {
    const extensionsDir = path.join(process.cwd(), "extensions");
    expectNoReaddirSyncDuring(() => {
      const manifestPaths = listPluginManifestPaths(extensionsDir);
      const sourceFiles = manifestPaths.flatMap((manifestPath) =>
        walkFiles(path.dirname(manifestPath)).filter(isProductionSource),
      );

      expect(manifestPaths.length).toBeGreaterThan(0);
      expect(sourceFiles.length).toBeGreaterThan(0);
    });
  });

  it("declares every production registerTool owner in contracts.tools", () => {
    const extensionsDir = path.join(process.cwd(), "extensions");
    const failures: string[] = [];

    for (const manifestPath of listPluginManifestPaths(extensionsDir)) {
      const pluginDir = path.dirname(manifestPath);
      const manifest = readManifest(manifestPath);
      const pluginId = typeof manifest.id === "string" ? manifest.id : path.basename(pluginDir);
      const declaredTools = new Set(normalizeManifestTools(manifest.contracts?.tools));
      const registeredNames = new Set<string>();
      let registerCallCount = 0;

      for (const filePath of walkFiles(pluginDir).filter(isProductionSource)) {
        const source = fs.readFileSync(filePath, "utf-8");
        for (const call of listRegisterToolCalls(source)) {
          registerCallCount += 1;
          for (const name of extractStaticRegisteredToolNames(call)) {
            registeredNames.add(name);
          }
        }
      }

      if (registerCallCount === 0) {
        continue;
      }
      if (declaredTools.size === 0) {
        failures.push(`${pluginId}: registers agent tools but has no contracts.tools`);
        continue;
      }

      const missing = [...registeredNames].filter((name) => !declaredTools.has(name)).toSorted();
      if (missing.length > 0) {
        failures.push(`${pluginId}: missing contracts.tools for ${missing.join(", ")}`);
      }
    }

    expect(failures).toStrictEqual([]);
  });
});
