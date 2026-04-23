import { readdirSync, statSync } from "node:fs";
import path from "node:path";

type SourceFileCollectionOptions = {
  repoRoot: string;
  sourceExtensions: readonly string[];
  shouldSkipRepoPath?: (repoPath: string) => boolean;
};

export function normalizeRepoPath(filePath: string, repoRoot: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

export function cycleSignature(files: readonly string[]): string {
  return files.toSorted((left, right) => left.localeCompare(right)).join("\n");
}

export function collectSourceFiles(root: string, options: SourceFileCollectionOptions): string[] {
  const repoPath = normalizeRepoPath(root, options.repoRoot);
  if (options.shouldSkipRepoPath?.(repoPath)) {
    return [];
  }
  const stats = statSync(root);
  if (stats.isFile()) {
    return options.sourceExtensions.some((extension) => repoPath.endsWith(extension))
      ? [repoPath]
      : [];
  }
  if (!stats.isDirectory()) {
    return [];
  }
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => collectSourceFiles(path.join(root, entry.name), options))
    .toSorted((left, right) => left.localeCompare(right));
}

export function collectStronglyConnectedComponents(
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

export function findCycleWitness(
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
  return visit(start) ?? [...component];
}

export function formatCycle(
  component: readonly string[],
  graph: ReadonlyMap<string, readonly string[]>,
): string {
  const witness = findCycleWitness(component, graph);
  return witness.map((file, index) => `${index === 0 ? "  " : "  -> "}${file}`).join("\n");
}
