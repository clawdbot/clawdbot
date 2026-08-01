// Shared parsing, diffing, and reporting helpers for inventory guard scripts.
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const parsedTypeScriptSourceCache = new Map();
const sourceTextCache = new Map();
const require = createRequire(import.meta.url);
let cachedTypeScript;

/** Convert an absolute file path to a repo-relative POSIX path. */
export function normalizeRepoPath(repoRoot, filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

/** Resolve a relative or absolute module specifier to a repo-relative path. */
export function resolveRepoSpecifier(repoRoot, specifier, importerFile) {
  if (specifier.startsWith(".")) {
    return normalizeRepoPath(repoRoot, path.resolve(path.dirname(importerFile), specifier));
  }
  if (specifier.startsWith("/")) {
    return normalizeRepoPath(repoRoot, specifier);
  }
  return null;
}

/** Visit static and dynamic module specifiers in a parsed TypeScript source file. */
export function visitModuleSpecifiers(ts, sourceFile, visit, options = {}) {
  function walk(node) {
    let kind;
    let specifierNode;
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      kind = "import";
      specifierNode = node.moduleSpecifier;
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      kind = "export";
      specifierNode = node.moduleSpecifier;
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length >= 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      kind = "dynamic-import";
      specifierNode = node.arguments[0];
    } else if (
      options.includeImportTypes &&
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      kind = "dynamic-import";
      specifierNode = node.argument.literal;
    } else if (
      options.includeCommonJs &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length >= 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      kind = "commonjs-require";
      specifierNode = node.arguments[0];
    } else if (
      options.includeCommonJs &&
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      kind = "commonjs-require";
      specifierNode = node.moduleReference.expression;
    } else if (
      options.includeImportMetaUrl &&
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "URL" &&
      node.arguments?.length >= 2 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      ts.isPropertyAccessExpression(node.arguments[1]) &&
      node.arguments[1].name.text === "url" &&
      ts.isMetaProperty(node.arguments[1].expression) &&
      node.arguments[1].expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
      node.arguments[1].expression.name.text === "meta"
    ) {
      kind = "import-meta-url";
      specifierNode = node.arguments[0];
    }

    if (specifierNode) {
      visit({ kind, node, specifier: specifierNode.text, specifierNode });
    }
    ts.forEachChild(node, walk);
  }

  walk(sourceFile);
}

/** Diff expected and actual inventory entries using JSON identity. */
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

/** Write one line to a stream without each caller repeating newline handling. */
export function writeLine(stream, text) {
  stream.write(`${text}\n`);
}

/** Lexically reject clean files before parsing candidate module-boundary violations. */
export function collectModuleReferencesFromSource(source, options = {}) {
  const ts = options.ts ?? (cachedTypeScript ??= require("typescript"));
  const acceptSpecifier = options.acceptSpecifier ?? (() => true);
  const candidates = ts.preProcessFile(source, true, true).importedFiles;
  const mayContainImportMetaUrl =
    source.includes("new") &&
    source.includes("import") &&
    source.includes("meta") &&
    [
      ...source.matchAll(
        /\bnew(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)+[A-Za-z_$\\][\w$\\{}]*(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*\((?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*(["'\x60])((?:\\[\s\S]|(?!\1)[^\\])*)\1/gu,
      ),
    ].some((match) => match[2].includes("\\") || acceptSpecifier(match[2]));
  // The TypeScript preprocessor visits imports, but not require calls, in template expressions.
  const mayContainEmbeddedRequire =
    source.includes("$") &&
    source.includes("{") &&
    source.includes("require") &&
    [
      ...source.matchAll(
        /\brequire(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*\((?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*(["'\x60])((?:\\[\s\S]|(?!\1)[^\\])*)\1/gu,
      ),
    ].some((match) => match[2].includes("\\") || acceptSpecifier(match[2]));
  // TypeScript's lexical preprocessor omits namespace re-exports, so never drop that edge.
  const mayContainNamespaceExport =
    /\bexport(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*(?:type(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*)?\*(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*as\b/u.test(
      source,
    );
  if (
    !candidates.some(({ fileName }) => acceptSpecifier(fileName)) &&
    !mayContainImportMetaUrl &&
    !mayContainEmbeddedRequire &&
    !mayContainNamespaceExport
  ) {
    return [];
  }

  const sourceFile = ts.createSourceFile(
    options.fileName ?? "source.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const references = [];
  visitModuleSpecifiers(
    ts,
    sourceFile,
    ({ kind, specifier, specifierNode }) => {
      if (acceptSpecifier(specifier)) {
        references.push({
          kind,
          line:
            sourceFile.getLineAndCharacterOfPosition(specifierNode.getStart(sourceFile)).line + 1,
          specifier,
        });
      }
    },
    { includeCommonJs: true, includeImportMetaUrl: true, includeImportTypes: true },
  );

  return references.toSorted(
    (left, right) =>
      left.line - right.line ||
      left.kind.localeCompare(right.kind) ||
      left.specifier.localeCompare(right.specifier),
  );
}

/** Memoize an async factory while resetting the cache after failures. */
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

/** Format grouped inventory entries for human-readable guard output. */
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

/** Parse TypeScript files and collect sorted inventory entries from each source file. */
export async function collectTypeScriptInventory(params) {
  const inventory = [];

  for (const filePath of params.files) {
    const cacheKey = `${params.scriptKind ?? "auto"}:${filePath}`;
    let sourceFile = parsedTypeScriptSourceCache.get(cacheKey);
    if (!sourceFile) {
      let source = sourceTextCache.get(filePath);
      if (source === undefined) {
        source = await fs.readFile(filePath, "utf8");
        sourceTextCache.set(filePath, source);
      }
      if (params.shouldParseSource && !params.shouldParseSource(source, filePath)) {
        continue;
      }
      sourceFile = params.ts.createSourceFile(
        filePath,
        source,
        params.ts.ScriptTarget.Latest,
        true,
        params.scriptKind,
      );
      parsedTypeScriptSourceCache.set(cacheKey, sourceFile);
    }
    inventory.push(...params.collectEntries(sourceFile, filePath));
  }

  return inventory.toSorted(params.compareEntries);
}

/** Run a baseline inventory check and return the intended process exit code. */
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
