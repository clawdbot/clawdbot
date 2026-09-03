/**
 * Removes undeclared bundler runtime helpers from emitted `.d.ts` export lists.
 *
 * Rolldown/tsdown can mirror JS helpers such as `__exportAll` into declaration
 * `export { ... }` clauses without emitting a matching type declaration. Strict
 * consumers then fail with TS2304 when they import public SDK entrypoints that
 * resolve through those chunks (for example `openclaw/plugin-sdk/tool-plugin`).
 */
import ts from "typescript";

/** Runtime helpers that must never appear as undeclared declaration exports. */
export const BUNDLER_RUNTIME_HELPER_EXPORT_NAMES = ["__exportAll"] as const;

export type BundlerRuntimeHelperExportName = (typeof BUNDLER_RUNTIME_HELPER_EXPORT_NAMES)[number];

const HELPER_NAME_SET = new Set<string>(BUNDLER_RUNTIME_HELPER_EXPORT_NAMES);

export type UndeclaredBundlerHelperDtsExport = {
  /** Helper local name as it appears in the export clause. */
  name: BundlerRuntimeHelperExportName;
  /** 1-based line of the export clause. */
  line: number;
};

function isBundlerHelperName(name: string | undefined): name is BundlerRuntimeHelperExportName {
  return Boolean(name && HELPER_NAME_SET.has(name));
}

function hasLocalHelperDeclaration(sourceFile: ts.SourceFile, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) {
      return;
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      found = true;
      return;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      found = true;
      return;
    }
    if (
      (ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isModuleDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

function exportElementLocalName(element: ts.ExportSpecifier): string | undefined {
  return element.propertyName?.text ?? element.name.text;
}

/**
 * Finds bundler helpers that are re-exported from a declaration file without a
 * local declaration the TypeScript checker can resolve.
 */
export function findUndeclaredBundlerHelperDtsExports(
  sourceText: string,
  fileName = "chunk.d.ts",
): UndeclaredBundlerHelperDtsExport[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    ts.ScriptKind.TS,
  );
  const findings: UndeclaredBundlerHelperDtsExport[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isExportDeclaration(node) &&
      !node.moduleSpecifier &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause)
    ) {
      for (const element of node.exportClause.elements) {
        const localName = exportElementLocalName(element);
        if (!isBundlerHelperName(localName)) {
          continue;
        }
        if (hasLocalHelperDeclaration(sourceFile, localName)) {
          continue;
        }
        const { line } = sourceFile.getLineAndCharacterOfPosition(element.getStart(sourceFile));
        findings.push({ name: localName, line: line + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return findings;
}

/**
 * Drops undeclared bundler helper export specifiers from declaration text.
 * Preserves surrounding formatting where practical.
 */
export function sanitizeBundlerHelperDtsExports(sourceText: string): {
  sourceText: string;
  removed: UndeclaredBundlerHelperDtsExport[];
} {
  const removed = findUndeclaredBundlerHelperDtsExports(sourceText);
  if (removed.length === 0) {
    return { sourceText, removed };
  }

  const sourceFile = ts.createSourceFile(
    "chunk.d.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    ts.ScriptKind.TS,
  );
  const edits: Array<{ start: number; end: number }> = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isExportDeclaration(node) &&
      !node.moduleSpecifier &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause)
    ) {
      for (const element of node.exportClause.elements) {
        const localName = exportElementLocalName(element);
        if (!isBundlerHelperName(localName)) {
          continue;
        }
        if (hasLocalHelperDeclaration(sourceFile, localName)) {
          continue;
        }
        const start = element.getFullStart();
        let end = element.getEnd();
        // Consume a following comma when present so we do not leave `a, , b`.
        const after = sourceText.slice(end).match(/^\s*,/u);
        if (after) {
          end += after[0].length;
        } else {
          // Or a preceding comma when this is the final specifier.
          const before = sourceText.slice(0, start).match(/,\s*$/u);
          if (before) {
            edits.push({ start: start - before[0].length, end });
            continue;
          }
        }
        edits.push({ start, end });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  let next = sourceText;
  for (const edit of edits.toSorted((left, right) => right.start - left.start)) {
    next = `${next.slice(0, edit.start)}${next.slice(edit.end)}`;
  }
  return { sourceText: next, removed };
}
