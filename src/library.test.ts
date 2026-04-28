import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const libraryPath = new URL("./library.ts", import.meta.url);
const lazyRuntimeSpecifiers = [
  "./auto-reply/reply.runtime.js",
  "./cli/prompt.js",
  "./infra/binaries.js",
  "./process/exec.js",
  "./plugins/runtime/runtime-web-channel-plugin.js",
] as const;

function readLibraryModuleImports() {
  const sourceText = readFileSync(libraryPath, "utf8");
  const staticImports = new Set<string>();
  const dynamicImports = new Set<string>();
  const staticImportPattern = /(?:^|\n)\s*import\s+(?!type\b)[\s\S]*?\s+from\s+["']([^"']+)["']/g;
  const dynamicImportPattern = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

  for (const match of sourceText.matchAll(staticImportPattern)) {
    staticImports.add(match[1]);
  }
  for (const match of sourceText.matchAll(dynamicImportPattern)) {
    dynamicImports.add(match[1]);
  }
  return { dynamicImports, staticImports };
}

describe("library module imports", () => {
  it("keeps lazy runtime boundaries on dynamic imports", () => {
    const { dynamicImports, staticImports } = readLibraryModuleImports();

    for (const specifier of lazyRuntimeSpecifiers) {
      expect(staticImports.has(specifier), `${specifier} should stay lazy`).toBe(false);
      expect(dynamicImports.has(specifier), `${specifier} should remain dynamically imported`).toBe(
        true,
      );
    }
  });
});
