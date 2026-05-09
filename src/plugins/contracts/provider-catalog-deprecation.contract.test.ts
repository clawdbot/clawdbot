import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const extensionsRoot = path.join(repoRoot, "extensions");

function walkProductionSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
      continue;
    }
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkProductionSourceFiles(entryPath));
      continue;
    }
    const normalized = entryPath.split(path.sep).join("/");
    if (!/\.(?:ts|tsx|js|mjs|cjs)$/.test(normalized)) {
      continue;
    }
    if (/(\.test\.|\.spec\.|\/__tests__\/|\/test-support\/)/.test(normalized)) {
      continue;
    }
    files.push(entryPath);
  }
  return files;
}

function readBalancedBlock(source: string, openIndex: number): string | undefined {
  let depth = 0;
  let quote: '"' | "'" | "`" | undefined;
  let escaped = false;
  const opener = source[openIndex];
  const closer = opener === "(" ? ")" : opener === "{" ? "}" : undefined;
  if (!closer) {
    return undefined;
  }

  for (let index = openIndex; index < source.length; index += 1) {
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
      if (depth === 0 && char === closer) {
        return source.slice(openIndex + 1, index);
      }
    }
  }
  return undefined;
}

function listRegisterProviderObjects(source: string): string[] {
  const calls: string[] = [];
  const pattern = /\bregisterProvider\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const openParenIndex = source.indexOf("(", match.index);
    const args = readBalancedBlock(source, openParenIndex);
    if (args !== undefined) {
      calls.push(args);
    }
  }
  return calls;
}

function listProviderPluginObjects(source: string): string[] {
  const objects: string[] = [];
  const pattern = /:\s*[A-Za-z0-9_]*ProviderPlugin\s*=\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const openBraceIndex = source.indexOf("{", match.index);
    const object = readBalancedBlock(source, openBraceIndex);
    if (object !== undefined) {
      objects.push(object);
    }
  }
  return objects;
}

function lineNumberFor(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

describe("bundled provider catalog deprecation guard", () => {
  it("keeps bundled provider plugins off the deprecated discovery hook", () => {
    const offenders: string[] = [];
    for (const filePath of walkProductionSourceFiles(extensionsRoot)) {
      const source = fs.readFileSync(filePath, "utf8");
      const candidates = [
        ...listRegisterProviderObjects(source),
        ...listProviderPluginObjects(source),
      ];
      for (const candidate of candidates) {
        const match = /\bdiscovery\s*:/.exec(candidate);
        if (!match) {
          continue;
        }
        const absoluteOffset = source.indexOf(candidate) + match.index;
        offenders.push(
          `${path.relative(repoRoot, filePath)}:${lineNumberFor(source, absoluteOffset)}`,
        );
      }
    }

    expect(offenders).toEqual([]);
  });
});
