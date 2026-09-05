// Tests get-reply import boundaries for lazy runtime and side-effect control.
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const getReplyPath = resolve(dirname(fileURLToPath(import.meta.url)), "get-reply.ts");
const lazyRuntimeSpecifiers = [
  "./session-reset-model.runtime.js",
  "./stage-sandbox-media.runtime.js",
] as const;

function readModuleImports(filePath: string) {
  const sourceText = readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const staticImports = new Set<string>();
  const dynamicImports = new Set<string>();

  function visit(node: ts.Node) {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !node.importClause?.isTypeOnly &&
      (!node.importClause?.namedBindings ||
        node.importClause.name ||
        ts.isNamespaceImport(node.importClause.namedBindings) ||
        node.importClause.namedBindings.elements.some((element) => !element.isTypeOnly))
    ) {
      staticImports.add(node.moduleSpecifier.text);
    }

    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !node.isTypeOnly &&
      (!node.exportClause ||
        ts.isNamespaceExport(node.exportClause) ||
        node.exportClause.elements.some((element) => !element.isTypeOnly))
    ) {
      staticImports.add(node.moduleSpecifier.text);
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1
    ) {
      const importArgument = expectDefined(node.arguments[0], "dynamic import argument");
      if (ts.isStringLiteral(importArgument)) {
        dynamicImports.add(importArgument.text);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { dynamicImports, staticImports };
}

function collectStaticImportPaths(entryPath: string): Set<string> {
  const paths = new Set([entryPath]);
  for (const filePath of paths) {
    for (const specifier of readModuleImports(filePath).staticImports) {
      if (!specifier.startsWith(".")) {
        continue;
      }
      const resolved = expectDefined(
        ts.resolveModuleName(specifier, filePath, {}, ts.sys).resolvedModule,
        `${filePath} -> ${specifier}`,
      );
      if (!resolved.resolvedFileName.endsWith(".d.ts")) {
        paths.add(resolved.resolvedFileName);
      }
    }
  }
  return paths;
}

describe("get-reply module imports", () => {
  it("keeps heavy runtime boundaries on dynamic imports", () => {
    const { dynamicImports, staticImports } = readModuleImports(getReplyPath);

    for (const specifier of lazyRuntimeSpecifiers) {
      expect(staticImports.has(specifier), `${specifier} should stay lazy`).toBe(false);
      expect(dynamicImports.has(specifier), `${specifier} should remain dynamically imported`).toBe(
        true,
      );
    }
  });

  it("keeps skill discovery and dispatch out of the inline-actions static import closure", () => {
    const skillsRoot = resolve(dirname(getReplyPath), "../../skills");
    const paths = collectStaticImportPaths(
      resolve(dirname(getReplyPath), "get-reply-inline-actions.ts"),
    );
    const eagerSkillRuntime = [...paths]
      .map((filePath) => relative(skillsRoot, filePath).replaceAll("\\", "/"))
      .filter((filePath) =>
        /^(?:loading\/|library\/|runtime\/|discovery\/(?:chat-commands|command-specs)(?:\.|\/))/.test(
          filePath,
        ),
      );

    expect(eagerSkillRuntime).toEqual([]);
  });
});
