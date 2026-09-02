// Shared parsing, diffing, and reporting helpers for inventory guard scripts.
import { createRequire } from "node:module";
import path from "node:path";

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

/** Write one line to a stream without each caller repeating newline handling. */
export function writeLine(stream, text) {
  stream.write(`${text}\n`);
}

function hasSupplementalModuleReference(ts, source, acceptSpecifier) {
  const checkUrl = source.includes("new") && source.includes("import") && source.includes("meta");
  const interpolationStart = source.indexOf("${");
  const checkRequire =
    interpolationStart >= 0 &&
    (source.includes("require") || source.indexOf("\\u", interpolationStart + 2) >= 0);
  const interpolatedSlash =
    interpolationStart < 0 ? -1 : source.indexOf("/", interpolationStart + 2);
  const checkTemplateImport =
    interpolatedSlash >= 0 && source.indexOf("import", interpolatedSlash + 1) >= 0;
  const checkNamespaceExport =
    source.includes("export") && source.includes("*") && source.includes("as");
  if (!checkUrl && !checkRequire && !checkTemplateImport && !checkNamespaceExport) {
    return false;
  }

  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    source,
  );
  const kinds = ts.SyntaxKind;
  const templateBraceDepths = [];
  const scanAcceptedSpecifier = () => {
    const token = scanner.scan();
    return (
      (token === kinds.StringLiteral || token === kinds.NoSubstitutionTemplateLiteral) &&
      acceptSpecifier(scanner.getTokenValue())
    );
  };

  for (let token = scanner.scan(); token !== kinds.EndOfFileToken; token = scanner.scan()) {
    if (
      checkUrl &&
      token === kinds.NewKeyword &&
      scanner.lookAhead(
        () =>
          scanner.scan() === kinds.Identifier &&
          scanner.getTokenValue() === "URL" &&
          scanner.scan() === kinds.OpenParenToken &&
          scanAcceptedSpecifier(),
      )
    ) {
      return true;
    }
    if (
      checkRequire &&
      (token === kinds.RequireKeyword ||
        (token === kinds.Identifier && scanner.getTokenValue() === "require")) &&
      scanner.lookAhead(() => scanner.scan() === kinds.OpenParenToken && scanAcceptedSpecifier())
    ) {
      return true;
    }
    if (
      checkNamespaceExport &&
      token === kinds.ExportKeyword &&
      scanner.lookAhead(() => {
        let next = scanner.scan();
        if (next === kinds.TypeKeyword) {
          next = scanner.scan();
        }
        return next === kinds.AsteriskToken && scanner.scan() === kinds.AsKeyword;
      })
    ) {
      return true;
    }

    // A context-free slash may start a regexp whose `}` would corrupt interpolation tracking.
    if (
      templateBraceDepths.length > 0 &&
      (token === kinds.SlashToken || token === kinds.SlashEqualsToken)
    ) {
      return true;
    }

    // Resume after each nested interpolation; otherwise template tails swallow later imports.
    if (token === kinds.TemplateHead) {
      templateBraceDepths.push(0);
    } else if (token === kinds.OpenBraceToken && templateBraceDepths.length > 0) {
      templateBraceDepths[templateBraceDepths.length - 1] += 1;
    } else if (token === kinds.CloseBraceToken && templateBraceDepths.length > 0) {
      const index = templateBraceDepths.length - 1;
      if (templateBraceDepths[index] > 0) {
        templateBraceDepths[index] -= 1;
      } else if (scanner.reScanTemplateToken(false) === kinds.TemplateTail) {
        templateBraceDepths.pop();
      }
    }
  }

  return false;
}

/**
 * Lexically reject clean files before parsing candidate module-boundary violations.
 *
 * @param {string} source
 * @param {{
 *   acceptSpecifier?: (specifier: string) => boolean;
 *   fileName?: string;
 *   ts?: typeof import("typescript");
 * }} [options]
 * @returns {Array<{ kind: string; line: number; specifier: string }>}
 */
export function collectModuleReferencesFromSource(source, options = {}) {
  const ts = options.ts ?? (cachedTypeScript ??= require("typescript"));
  const acceptSpecifier = options.acceptSpecifier ?? (() => true);
  const candidates = ts.preProcessFile(source, true, true).importedFiles;
  if (
    !candidates.some(({ fileName }) => acceptSpecifier(fileName)) &&
    !hasSupplementalModuleReference(ts, source, acceptSpecifier)
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
