import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");

async function listProductionSources(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const sources: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      sources.push(...(await listProductionSources(entryPath)));
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.includes(".test.") &&
      !entry.name.includes(".test-")
    ) {
      sources.push(entryPath);
    }
  }
  return sources;
}

async function productionImportsPackage(packageName: string): Promise<boolean> {
  const sources = await listProductionSources(path.join(PACKAGE_ROOT, "src"));
  for (const sourcePath of sources) {
    const source = await fs.readFile(sourcePath, "utf8");
    const sourceFile = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
    for (const statement of sourceFile.statements) {
      if (
        (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        (statement.moduleSpecifier.text === packageName ||
          statement.moduleSpecifier.text.startsWith(`${packageName}/`))
      ) {
        return true;
      }
    }
  }
  return false;
}

describe("@openclaw/ai source dependency contract", () => {
  it("declares bundled normalization-core imports as a workspace dev dependency", async () => {
    const manifest = JSON.parse(
      await fs.readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(await productionImportsPackage("@openclaw/normalization-core")).toBe(true);
    expect(manifest.dependencies?.["@openclaw/normalization-core"]).toBeUndefined();
    expect(manifest.devDependencies?.["@openclaw/normalization-core"]).toBe("workspace:*");
  });
});
