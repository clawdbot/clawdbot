// Tests library entrypoint exports and package boundary behavior.
import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { loadSessionStore, saveSessionStore } from "./library.js";

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

  it("keeps the deprecated root session-store wrappers uncached", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-library-session-store-"));
    const storePath = path.join(dir, "sessions.json");
    try {
      await saveSessionStore(
        storePath,
        {
          "agent:main:main": { sessionId: "first", updatedAt: Date.now() },
        },
        { skipMaintenance: true },
      );
      expect(loadSessionStore(storePath)["agent:main:main"]?.sessionId).toBe("first");

      fs.writeFileSync(
        storePath,
        JSON.stringify({ "agent:main:main": { sessionId: "second", updatedAt: 2 } }),
      );
      expect(loadSessionStore(storePath)["agent:main:main"]?.sessionId).toBe("second");
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });
});
