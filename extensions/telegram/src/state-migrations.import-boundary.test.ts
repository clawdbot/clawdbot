import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Doctor enumeration cold-loads this closure for every operator running `openclaw
// doctor` or a startup migration scan, so it must reach only leaf modules. Each
// runtime store below owns the same rows but also value-loads the plugin runtime
// slot, the logger graph, or the ACP/session-binding graphs; the row shapes and
// sidecar readers live in the matching `*.legacy-state.ts` leaf instead.
const RUNTIME_STORE_MODULES = new Set([
  "message-cache.ts",
  "sent-message-cache.ts",
  "sticker-cache-store.ts",
  "thread-bindings.ts",
]);
const SOURCE_DIR = path.dirname(new URL(import.meta.url).pathname);

function listStaticRelativeImports(filePath: string): string[] {
  const source = fs.readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  for (const statement of sourceFile.statements) {
    const isTypeOnly =
      (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly === true) ||
      (ts.isExportDeclaration(statement) && statement.isTypeOnly);
    const moduleSpecifier =
      ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
        ? statement.moduleSpecifier
        : undefined;
    if (!isTypeOnly && moduleSpecifier && ts.isStringLiteralLike(moduleSpecifier)) {
      specifiers.push(moduleSpecifier.text);
    }
  }
  return specifiers.filter((specifier) => specifier.startsWith("."));
}

function collectPluginLocalClosure(entryFile: string): string[] {
  const visited = new Set<string>();
  const pending = [entryFile];
  while (pending.length > 0) {
    const fileName = pending.pop();
    if (!fileName || visited.has(fileName)) {
      continue;
    }
    visited.add(fileName);
    for (const specifier of listStaticRelativeImports(path.join(SOURCE_DIR, fileName))) {
      const resolved = `${specifier.replace(/^\.\//, "").replace(/\.js$/, "")}.ts`;
      if (fs.existsSync(path.join(SOURCE_DIR, resolved))) {
        pending.push(resolved);
      }
    }
  }
  return [...visited].toSorted();
}

describe("telegram state migration import boundary", () => {
  it("keeps runtime stores off the doctor discovery closure", () => {
    const closure = collectPluginLocalClosure("state-migrations.ts");

    expect(closure.filter((module) => RUNTIME_STORE_MODULES.has(module))).toStrictEqual([]);
    // The leaves are the intended replacements; an empty closure would pass vacuously.
    expect(closure).toEqual(
      expect.arrayContaining([
        "message-cache-persistence.ts",
        "sent-message-cache.legacy-state.ts",
        "sticker-cache-store.legacy-state.ts",
        "thread-bindings-store.ts",
      ]),
    );
  });
});
