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
const BUNDLER_RUNTIME_HELPER_EXPORT_NAMES = ["__exportAll"] as const;

type BundlerRuntimeHelperExportName = (typeof BUNDLER_RUNTIME_HELPER_EXPORT_NAMES)[number];

const HELPER_NAME_SET = new Set<string>(BUNDLER_RUNTIME_HELPER_EXPORT_NAMES);

export type UndeclaredBundlerHelperDtsExport = {
  /** Helper local name as it appears in the export clause. */
  name: BundlerRuntimeHelperExportName;
  /** 1-based line of the export clause. */
  line: number;
};

type DtsSanitization = {
  edits: Array<{ start: number; end: number }>;
  removed: UndeclaredBundlerHelperDtsExport[];
};

function isBundlerHelperName(name: string | undefined): name is BundlerRuntimeHelperExportName {
  return Boolean(name && HELPER_NAME_SET.has(name));
}

function hasLocalHelperBinding(sourceFile: ts.SourceFile, name: string): boolean {
  return sourceFile.statements.some((statement) => {
    if (ts.isImportDeclaration(statement) && statement.importClause) {
      const { importClause } = statement;
      if (importClause.name?.text === name) {
        return true;
      }
      const bindings = importClause.namedBindings;
      if (!bindings) {
        return false;
      }
      if (ts.isNamespaceImport(bindings)) {
        return bindings.name.text === name;
      }
      return bindings.elements.some(
        (specifier) =>
          ts.isImportSpecifier(specifier) &&
          specifier.name.text === name &&
          (specifier.propertyName?.text ?? name) === name,
      );
    }
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.some(
        (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name,
      );
    }
    if (
      ts.isClassDeclaration(statement) ||
      ts.isFunctionDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
    ) {
      return statement.name?.text === name;
    }
    return false;
  });
}

function exportElementLocalName(element: ts.ExportSpecifier): string | undefined {
  return element.propertyName?.text ?? element.name.text;
}

function removeListElement(
  sourceText: string,
  element: ts.Node,
  edits: Array<{ start: number; end: number }>,
) {
  const start = element.getFullStart();
  let end = element.getEnd();
  const after = sourceText.slice(end).match(/^\s*,/u);
  if (after) {
    end += after[0].length;
    edits.push({ start, end });
    return;
  }
  const before = sourceText.slice(0, start).match(/,\s*$/u);
  edits.push({ start: before ? start - before[0].length : start, end });
}

function scanDts(sourceText: string, fileName: string): DtsSanitization {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    ts.ScriptKind.TS,
  );
  const helperIsDeclared = hasLocalHelperBinding(sourceFile, "__exportAll");
  const removed: UndeclaredBundlerHelperDtsExport[] = [];
  const edits: Array<{ start: number; end: number }> = [];

  for (const statement of sourceFile.statements) {
    const importBindings = ts.isImportDeclaration(statement)
      ? statement.importClause?.namedBindings
      : undefined;
    if (importBindings && ts.isNamedImports(importBindings)) {
      const namedBindings = importBindings;
      const helpers = namedBindings.elements.filter(
        (specifier): specifier is ts.ImportSpecifier =>
          ts.isImportSpecifier(specifier) &&
          specifier.name.text === "__exportAll" &&
          specifier.propertyName !== undefined &&
          specifier.propertyName.text !== "__exportAll",
      );
      if (helpers.length > 0) {
        if (helpers.length === namedBindings.elements.length) {
          edits.push({ start: statement.getFullStart(), end: statement.getEnd() });
        } else {
          for (const helper of helpers) {
            removeListElement(sourceText, helper, edits);
          }
        }
      }
    }
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier) {
      continue;
    }
    const exportClause = statement.exportClause;
    if (!exportClause || !ts.isNamedExports(exportClause)) {
      continue;
    }
    for (const element of exportClause.elements) {
      const localName = exportElementLocalName(element);
      if (!isBundlerHelperName(localName) || helperIsDeclared) {
        continue;
      }
      const { line } = sourceFile.getLineAndCharacterOfPosition(element.getStart(sourceFile));
      removed.push({ name: localName, line: line + 1 });
      removeListElement(sourceText, element, edits);
    }
  }
  return { edits, removed };
}

/** Finds undeclared bundler helpers re-exported from a declaration file. */
export function findUndeclaredBundlerHelperDtsExports(
  sourceText: string,
  fileName = "chunk.d.ts",
): UndeclaredBundlerHelperDtsExport[] {
  return scanDts(sourceText, fileName).removed;
}

/** Drops undeclared bundler helper specifiers from declaration text. */
export function sanitizeBundlerHelperDtsExports(sourceText: string): {
  sourceText: string;
  removed: UndeclaredBundlerHelperDtsExport[];
} {
  const { edits, removed } = scanDts(sourceText, "chunk.d.ts");
  let next = sourceText;
  for (const edit of edits.toSorted((left, right) => right.start - left.start)) {
    next = `${next.slice(0, edit.start)}${next.slice(edit.end)}`;
  }
  return { sourceText: next, removed };
}
