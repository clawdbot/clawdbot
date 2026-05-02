import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const toolsDir = new URL("./", import.meta.url);
const moduleReferencePattern =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/gu;

function collectStaticModuleReferences(
  source: string,
): readonly { line: number; specifier: string }[] {
  const references: { line: number; specifier: string }[] = [];
  const lines = source.split("\n");
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//")) {
      continue;
    }
    for (const match of line.matchAll(moduleReferencePattern)) {
      const specifier = match[1];
      if (specifier) {
        references.push({ line: index + 1, specifier });
      }
    }
  }
  return references;
}

describe("tool system boundary", () => {
  it("keeps production tool modules independent from OpenClaw subsystems", () => {
    const violations = readdirSync(toolsDir, { withFileTypes: true }).flatMap((entry) => {
      if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
        return [];
      }
      const source = readFileSync(new URL(entry.name, toolsDir), "utf8");
      return collectStaticModuleReferences(source)
        .filter(
          (reference) =>
            !reference.specifier.startsWith("./") && !reference.specifier.startsWith("node:"),
        )
        .map((reference) => `${entry.name}:${reference.line} ${reference.specifier}`);
    });

    expect(violations).toEqual([]);
  });
});
