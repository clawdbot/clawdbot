// Tests library entrypoint exports and package boundary behavior.
import { readFileSync } from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
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
    staticImports.add(expectDefined(match[1], "match[1] test invariant"));
  }
  for (const match of sourceText.matchAll(dynamicImportPattern)) {
    dynamicImports.add(expectDefined(match[1], "match[1] test invariant"));
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
