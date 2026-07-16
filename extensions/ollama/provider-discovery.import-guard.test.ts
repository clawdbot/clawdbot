import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");

function readPluginSource(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("ollama provider discovery import surface", () => {
  it("stays off the full provider runtime graph", () => {
    const source = readPluginSource("extensions/ollama/provider-discovery.ts");

    for (const forbidden of [
      "./index",
      "./api",
      "./runtime-api",
      "./src/setup",
      "./src/stream",
      "./src/embedding-provider",
      "./src/memory-embedding-adapter",
      "./src/web-search-provider",
      "openclaw/plugin-sdk/text-runtime",
      "openclaw/plugin-sdk/plugin-entry",
    ]) {
      expect(source, `provider discovery must not import ${forbidden}`).not.toContain(forbidden);
    }
  });
});
