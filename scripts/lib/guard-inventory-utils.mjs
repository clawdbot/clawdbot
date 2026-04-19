import { promises as fs } from "node:fs";
import path from "node:path";

const parsedTypeScriptSourceCache = new Map();

export function normalizeRepoPath(repoRoot, filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

export function resolveRepoSpecifier(repoRoot, specifier, importerFile) {
  if (specifier.startsWith(".")) {
    return normalizeRepoPath(repoRoot, path.resolve(path.dirname(importerFile), specifier));
  }
  if (specifier.startsWith("/")) {
    return normalizeRepoPath(repoRoot, specifier);
  }
  return null;
}

export function visitModuleSpecifiers(ts, sourceFile, visit) {
  function walk(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      visit({
        kind: "import",
        node,
        specifier: node.moduleSpecifier.text,
        specifierNode: node.moduleSpecifier,
      });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      visit({
        kind: "export",
        node,
        specifier: node.moduleSpecifier.text,
        specifierNode: node.moduleSpecifier,
      });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      visit({
        kind: "dynamic-import",
        node,
        specifier: node.arguments[0].text,
        specifierNode: node.arguments[0],
      });
    }

    ts.forEachChild(node, walk);
  }

  walk(sourceFile);
}

export function diffInventoryEntries(expected, actual, compareEntries) {
  const expectedKeys = new Set(expected.map((entry) => JSON.stringify(entry)));
  const actualKeys = new Set(actual.map((entry) => JSON.stringify(entry)));
  return {
    missing: expected
      .filter((entry) => !actualKeys.has(JSON.stringify(entry)))
      .toSorted(compareEntries),
    unexpected: actual
      .filter((entry) => !expectedKeys.has(JSON.stringify(entry)))
      .toSorted(compareEntries),
  };
}

export function writeLine(stream, text) {
  stream.write(`${text}\n`);
}

export function createCachedAsync(factory) {
  let cachedPromise = null;
  return async function getCachedValue() {
    if (cachedPromise) {
      return cachedPromise;
    }

    cachedPromise = factory();
    try {
      return await cachedPromise;
    } catch (error) {
      cachedPromise = null;
      throw error;
    }
  };
}

export function formatGroupedInventoryHuman(params, inventory) {
  if (inventory.length === 0) {
    return `${params.rule}\n${params.cleanMessage}`;
  }

  const lines = [params.rule, params.inventoryTitle];
  let activeFile = "";
  for (const entry of inventory) {
    if (entry.file !== activeFile) {
      activeFile = entry.file;
      lines.push(activeFile);
    }
    lines.push(`  - line ${entry.line} [${entry.kind}] ${entry.reason}`);
    lines.push(`    specifier: ${entry.specifier}`);
    lines.push(`    resolved: ${entry.resolvedPath}`);
  }
  return lines.join("\n");
}

export async function collectTypeScriptInventory(params) {
  const inventory = [];
  const scriptKind = params.scriptKind ?? params.ts.ScriptKind.TS;

  for (const filePath of params.files) {
    const cacheKey = `${scriptKind}:${filePath}`;
    let sourceFile = parsedTypeScriptSourceCache.get(cacheKey);
    if (!sourceFile) {
      const source = await fs.readFile(filePath, "utf8");
      if (params.shouldParseSource && !params.shouldParseSource(source, filePath)) {
        continue;
      }
      sourceFile = params.ts.createSourceFile(
        filePath,
        source,
        params.ts.ScriptTarget.Latest,
        true,
        scriptKind,
      );
      parsedTypeScriptSourceCache.set(cacheKey, sourceFile);
    }
    inventory.push(...params.collectEntries(sourceFile, filePath));
  }

  return inventory.toSorted(params.compareEntries);
}

export async function runBaselineInventoryCheck(params) {
  const streams = params.io ?? { stdout: process.stdout, stderr: process.stderr };
  const json = params.argv.includes("--json");
  const actual = await params.collectActual();
  const expected = await params.readExpected();
  const { missing, unexpected } = params.diffInventory(expected, actual);
  const matchesBaseline = missing.length === 0 && unexpected.length === 0;

  if (json) {
    writeLine(streams.stdout, JSON.stringify(actual, null, 2));
  } else {
    writeLine(streams.stdout, params.formatInventoryHuman(actual));
    writeLine(
      streams.stdout,
      matchesBaseline
        ? `Baseline matches (${actual.length} entries).`
        : `Baseline mismatch (${unexpected.length} unexpected, ${missing.length} missing).`,
    );
    if (!matchesBaseline) {
      if (unexpected.length > 0) {
        writeLine(streams.stderr, "Unexpected entries:");
        for (const entry of unexpected) {
          writeLine(streams.stderr, `- ${params.formatEntry(entry)}`);
        }
      }
      if (missing.length > 0) {
        writeLine(streams.stderr, "Missing baseline entries:");
        for (const entry of missing) {
          writeLine(streams.stderr, `- ${params.formatEntry(entry)}`);
        }
      }
    }
  }

  return matchesBaseline ? 0 : 1;
}
