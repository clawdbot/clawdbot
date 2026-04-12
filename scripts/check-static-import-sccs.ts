#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scanRoots = ["src", "extensions", "ui"] as const;
const sourceExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"] as const;
const testSourcePattern = /(?:\.test|\.e2e\.test)\.[cm]?[tj]sx?$/;
const generatedSourcePattern = /\.(?:generated|bundle)\.[tj]s$/;
const declarationSourcePattern = /\.d\.[cm]?ts$/;
const ignoredPathPartPattern =
  /(^|\/)(node_modules|dist|build|coverage|\.artifacts|\.git|assets)(\/|$)/;

function normalizeRepoPath(filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function cycleSignature(files: readonly string[]): string {
  return files.toSorted((left, right) => left.localeCompare(right)).join("\n");
}

function shouldSkipRepoPath(repoPath: string): boolean {
  return (
    ignoredPathPartPattern.test(repoPath) ||
    testSourcePattern.test(repoPath) ||
    generatedSourcePattern.test(repoPath) ||
    declarationSourcePattern.test(repoPath)
  );
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

function collectStaticImports(
  file: string,
  resolveSource: ReturnType<typeof createSourceResolver>,
): string[] {
  const sourceFile = ts.createSourceFile(
    file,
    readFileSync(path.join(repoRoot, file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const imports = new Set<string>();
  const visit = (node: ts.Node) => {
    let specifier: string | undefined;
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifier = node.moduleSpecifier.text;
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifier = node.moduleSpecifier.text;
    }
    if (specifier) {
      const resolved = resolveSource(file, specifier);
      if (resolved) {
        imports.add(resolved);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...imports].toSorted((left, right) => left.localeCompare(right));
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

function findCycleWitness(
  component: readonly string[],
  graph: ReadonlyMap<string, readonly string[]>,
): string[] {
  const componentSet = new Set(component);
  const start = component[0];
  if (!start) {
    return [];
  }
  const activePath: string[] = [];
  const visited = new Set<string>();
  const visit = (node: string): string[] | null => {
    activePath.push(node);
    visited.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!componentSet.has(next)) {
        continue;
      }
      const existingIndex = activePath.indexOf(next);
      if (existingIndex >= 0) {
        return [...activePath.slice(existingIndex), next];
      }
      if (!visited.has(next)) {
        const result = visit(next);
        if (result) {
          return result;
        }
      }
    }
    activePath.pop();
    return null;
  };
  return visit(start) ?? component;
}

function formatCycle(
  component: readonly string[],
  graph: ReadonlyMap<string, readonly string[]>,
): string {
  const witness = findCycleWitness(component, graph);
  return witness.map((file, index) => `${index === 0 ? "  " : "  -> "}${file}`).join("\n");
}

function main(): number {
  const files = scanRoots.flatMap((root) => collectSourceFiles(path.join(repoRoot, root)));
  const resolveSource = createSourceResolver(files);
  const graph = new Map(
    files.map((file): [string, string[]] => [file, collectStaticImports(file, resolveSource)]),
  );
  const components = collectStronglyConnectedComponents(graph);

  console.log(`Static import SCC check: ${components.length} component(s).`);
  if (components.length === 0) {
    return 0;
  }

  console.error("\nStatic import SCCs:");
  for (const component of components) {
    console.error(`\n# component size ${component.length}`);
    console.error(formatCycle(component, graph));
  }
  console.error(
    "\nBreak the static cycle or extract a leaf contract instead of routing through a barrel.",
  );
  return 1;
}

process.exitCode = main();
