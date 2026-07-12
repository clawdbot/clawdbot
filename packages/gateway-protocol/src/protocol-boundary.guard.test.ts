import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const protocolSourceRoot = path.join(process.cwd(), "packages/gateway-protocol/src");
const rootRuntimeSourceRoot = path.join(process.cwd(), "src");
const importSpecifierPattern =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

async function collectProductionSources(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const sources: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      sources.push(...(await collectProductionSources(fullPath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      sources.push(fullPath);
    }
  }

  return sources;
}

describe("gateway protocol package boundary", () => {
  it("keeps production sources independent from root runtime src imports", async () => {
    const sources = await collectProductionSources(protocolSourceRoot);
    const violations: string[] = [];

    for (const source of sources) {
      const content = await fs.readFile(source, "utf8");
      for (const match of content.matchAll(importSpecifierPattern)) {
        const specifier = match[1] ?? match[2];
        if (!specifier) {
          continue;
        }
        if (!specifier.startsWith(".")) {
          continue;
        }

        const resolved = path.resolve(path.dirname(source), specifier);
        const importsRootRuntime =
          resolved === rootRuntimeSourceRoot ||
          resolved.startsWith(`${rootRuntimeSourceRoot}${path.sep}`);
        if (importsRootRuntime) {
          violations.push(`${path.relative(process.cwd(), source)} -> ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
