#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  collectSourceFiles,
  collectStronglyConnectedComponents,
  formatCycle,
} from "./lib/import-cycle-graph.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scanRoots = ["src", "extensions", "scripts"] as const;
const sourceExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"] as const;
const testSourcePattern = /(?:\.test|\.e2e\.test)\.[cm]?[tj]sx?$/;
const generatedSourcePattern = /\.(?:generated|bundle)\.[tj]s$/;
const declarationSourcePattern = /\.d\.[cm]?ts$/;
const ignoredPathPartPattern =
  /(^|\/)(node_modules|dist|build|coverage|\.artifacts|\.git|assets)(\/|$)/;

function shouldSkipRepoPath(repoPath: string): boolean {
  return (
    ignoredPathPartPattern.test(repoPath) ||
    testSourcePattern.test(repoPath) ||
    generatedSourcePattern.test(repoPath) ||
    declarationSourcePattern.test(repoPath)
  );
}

function createSourceResolver(files: readonly string[]) {
  const fileSet = new Set(files);
  const pathMap = new Map<string, string>();
  for (const file of files) {
    const parsed = path.posix.parse(file);
    const extensionless = path.posix.join(parsed.dir, parsed.name);
    pathMap.set(extensionless, file);
    if (file.endsWith(".ts")) {
      pathMap.set(`${extensionless}.js`, file);
    } else if (file.endsWith(".tsx")) {
      pathMap.set(`${extensionless}.jsx`, file);
    } else if (file.endsWith(".mts")) {
      pathMap.set(`${extensionless}.mjs`, file);
    } else if (file.endsWith(".cts")) {
      pathMap.set(`${extensionless}.cjs`, file);
    }
  }
  return (importer: string, specifier: string): string | null => {
    if (!specifier.startsWith(".")) {
      return null;
    }
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
    const candidates = [
      base,
      ...sourceExtensions.map((extension) => `${base}${extension}`),
      `${base}/index.ts`,
      `${base}/index.tsx`,
      `${base}/index.js`,
      `${base}/index.mjs`,
    ];
    for (const candidate of candidates) {
      if (fileSet.has(candidate)) {
        return candidate;
      }
      const mapped = pathMap.get(candidate);
      if (mapped) {
        return mapped;
      }
    }
    return null;
  };
}

function importDeclarationHasRuntimeEdge(node: ts.ImportDeclaration): boolean {
  if (!node.importClause) {
    return true;
  }
  if (node.importClause.isTypeOnly) {
    return false;
  }
  const bindings = node.importClause.namedBindings;
  if (node.importClause.name || !bindings || ts.isNamespaceImport(bindings)) {
    return true;
  }
  return bindings.elements.some((element) => !element.isTypeOnly);
}

function exportDeclarationHasRuntimeEdge(node: ts.ExportDeclaration): boolean {
  if (!node.moduleSpecifier || node.isTypeOnly) {
    return false;
  }
  const clause = node.exportClause;
  if (!clause || ts.isNamespaceExport(clause)) {
    return true;
  }
  return clause.elements.some((element) => !element.isTypeOnly);
}

function collectRuntimeStaticImports(
  file: string,
  resolveSource: ReturnType<typeof createSourceResolver>,
) {
  const sourceFile = ts.createSourceFile(
    file,
    readFileSync(path.join(repoRoot, file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const imports: string[] = [];
  const visit = (node: ts.Node) => {
    let specifier: string | undefined;
    let include = false;
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifier = node.moduleSpecifier.text;
      include = importDeclarationHasRuntimeEdge(node);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifier = node.moduleSpecifier.text;
      include = exportDeclarationHasRuntimeEdge(node);
    }
    if (include && specifier) {
      const resolved = resolveSource(file, specifier);
      if (resolved) {
        imports.push(resolved);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return imports.toSorted((left, right) => left.localeCompare(right));
}

function main(): number {
  const files = scanRoots.flatMap((root) =>
    collectSourceFiles(path.join(repoRoot, root), {
      repoRoot,
      sourceExtensions,
      shouldSkipRepoPath,
    }),
  );
  const resolveSource = createSourceResolver(files);
  const graph = new Map(
    files.map((file): [string, string[]] => [
      file,
      collectRuntimeStaticImports(file, resolveSource),
    ]),
  );
  const components = collectStronglyConnectedComponents(graph);

  console.log(`Import cycle check: ${components.length} runtime value cycle(s).`);
  if (components.length === 0) {
    return 0;
  }

  console.error("\nRuntime value import cycles:");
  for (const component of components) {
    console.error(`\n# component size ${component.length}`);
    console.error(formatCycle(component, graph));
  }
  console.error("\nBreak the cycle or convert type-only edges to `import type`.");
  return 1;
}

process.exitCode = main();
