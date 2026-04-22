#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scanRoots = ["src", "extensions", "ui"] as const;
const sourceExtensions = [".ts"] as const;
const ignoredPathPartPattern =
  /(^|\/)(node_modules|dist|build|coverage|\.artifacts|\.git|assets)(\/|$)/;

function normalizeRepoPath(filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function cycleSignature(files: readonly string[]): string {
  return files.toSorted((left, right) => left.localeCompare(right)).join("\n");
}

function shouldSkipRepoPath(repoPath: string): boolean {
  return ignoredPathPartPattern.test(repoPath);
}

function collectSourceFiles(root: string): string[] {
  const repoPath = normalizeRepoPath(root);
  if (shouldSkipRepoPath(repoPath)) {
    return [];
  }
  const stats = statSync(root);
  if (stats.isFile()) {
    return sourceExtensions.some((extension) => repoPath.endsWith(extension)) ? [repoPath] : [];
  }
  if (!stats.isDirectory()) {
    return [];
  }
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => collectSourceFiles(path.join(root, entry.name)))
    .toSorted((left, right) => left.localeCompare(right));
}

function loadCompilerOptions(): ts.CompilerOptions {
  const configPath = path.join(repoRoot, "tsconfig.json");
  const config = ts.readConfigFile(configPath, (filePath) => ts.sys.readFile(filePath));
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  }
  return ts.parseJsonConfigFileContent(config.config, ts.sys, repoRoot).options;
}

function collectStaticModuleSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function createImportGraph(files: readonly string[]): Map<string, string[]> {
  const compilerOptions = loadCompilerOptions();
  const compilerHost = ts.createCompilerHost(compilerOptions, false);
  const resolutionCache = ts.createModuleResolutionCache(
    repoRoot,
    (value) => value,
    compilerOptions,
  );
  const absoluteToRepoPath = new Map(
    files.map((file): [string, string] => [path.resolve(repoRoot, file), file]),
  );
  const graph = new Map<string, string[]>();

  for (const file of files) {
    const absoluteFile = path.join(repoRoot, file);
    const sourceFile = ts.createSourceFile(
      file,
      readFileSync(absoluteFile, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const imports = collectStaticModuleSpecifiers(sourceFile).flatMap((specifier) => {
      const resolved = ts.resolveModuleName(
        specifier,
        absoluteFile,
        compilerOptions,
        compilerHost,
        resolutionCache,
      ).resolvedModule?.resolvedFileName;
      if (!resolved) {
        return [];
      }
      const repoPath = absoluteToRepoPath.get(path.resolve(resolved));
      return repoPath ? [repoPath] : [];
    });
    graph.set(
      file,
      imports.toSorted((left, right) => left.localeCompare(right)),
    );
  }

  return graph;
}

function collectStronglyConnectedComponents(
  graph: ReadonlyMap<string, readonly string[]>,
): string[][] {
  let nextIndex = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indexByNode = new Map<string, number>();
  const lowLinkByNode = new Map<string, number>();
  const components: string[][] = [];

  const visit = (node: string) => {
    indexByNode.set(node, nextIndex);
    lowLinkByNode.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const next of graph.get(node) ?? []) {
      if (!indexByNode.has(next)) {
        visit(next);
        lowLinkByNode.set(node, Math.min(lowLinkByNode.get(node)!, lowLinkByNode.get(next)!));
      } else if (onStack.has(next)) {
        lowLinkByNode.set(node, Math.min(lowLinkByNode.get(node)!, indexByNode.get(next)!));
      }
    }

    if (lowLinkByNode.get(node) !== indexByNode.get(node)) {
      return;
    }
    const component: string[] = [];
    let current: string | undefined;
    do {
      current = stack.pop();
      if (!current) {
        throw new Error("Import cycle stack underflow");
      }
      onStack.delete(current);
      component.push(current);
    } while (current !== node);
    if (component.length > 1 || (graph.get(node) ?? []).includes(node)) {
      components.push(component.toSorted((left, right) => left.localeCompare(right)));
    }
  };

  for (const node of graph.keys()) {
    if (!indexByNode.has(node)) {
      visit(node);
    }
  }

  return components.toSorted(
    (left, right) =>
      right.length - left.length || cycleSignature(left).localeCompare(cycleSignature(right)),
  );
}

function main(): number {
  const files = scanRoots.flatMap((root) => collectSourceFiles(path.join(repoRoot, root)));
  const graph = createImportGraph(files);
  const cycles = collectStronglyConnectedComponents(graph);

  console.log(`Madge import cycle check: ${cycles.length} cycle(s).`);
  if (cycles.length === 0) {
    return 0;
  }

  console.error("\nMadge circular dependencies:");
  for (const [index, cycle] of cycles.entries()) {
    console.error(`\n# cycle ${index + 1}`);
    console.error(`  ${cycle.join("\n  -> ")}`);
  }
  console.error(
    "\nBreak the cycle or extract a leaf contract instead of routing through a barrel.",
  );
  return 1;
}

process.exitCode = main();
