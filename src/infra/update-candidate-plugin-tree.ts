import fs from "node:fs/promises";
import path from "node:path";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { hasNodeErrorCode, isPathInside } from "./path-guards.js";
import {
  readRuntimeModulesManifest,
  relocateRuntimeTree,
  type RuntimeRelocation,
} from "./update-runtime-relocation.js";

const isHostEdge = (file: string) =>
  path.basename(file) === "openclaw" && path.basename(path.dirname(file)) === "node_modules";
const isHostLauncher = (file: string) =>
  path.basename(path.dirname(file)) === ".bin" &&
  ["openclaw", "openclaw.cmd", "openclaw.ps1"].includes(path.basename(file));

async function dependencyOwner(target: string): Promise<string> {
  // A pnpm package resolves dependencies beside its package directory. Preserve
  // that Node lookup ancestry, including scoped packages and nested installs.
  const parts = target.split(path.sep);
  const store = parts.indexOf(".pnpm");
  if (store >= 0) {
    return parts.slice(0, store + 1).join(path.sep);
  }
  const modules = parts.indexOf("node_modules");
  if (modules >= 0) {
    return parts.slice(0, modules + 1).join(path.sep);
  }
  let directory = (await fs.stat(target)).isDirectory() ? target : path.dirname(target);
  const fallback = target;
  for (;;) {
    if (
      await fs.stat(path.join(directory, "package.json")).then(
        () => true,
        (error: unknown) => {
          if (hasNodeErrorCode(error, "ENOENT")) {
            return false;
          }
          throw error;
        },
      )
    ) {
      return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return fallback;
    }
    directory = parent;
  }
}

/** Copy dependency owners intact, then rebind their complete private link graph. */
export async function copyUpdateCandidatePluginTrees(params: {
  roots: Map<string, string>;
  project: (source: string) => string;
  targetStateDir: string;
  candidateRoot: string;
}): Promise<{ copies: Array<[string, string]>; hostLinks: Set<string> }> {
  const roots = new Map(params.roots);
  const privateRoot = resolvePathViaExistingAncestorSync(path.resolve(params.targetStateDir));
  const candidateRoot = resolvePathViaExistingAncestorSync(path.resolve(params.candidateRoot));
  const scanned = new Set<string>();
  const edges = new Map<string, { target: string; real: string }>();
  const hosts = new Set<string>();
  const hostRoots = new Set<string>();
  const stores = new Set<string>();
  const covered = (file: string) => [...roots.keys()].some((root) => isPathInside(root, file));
  function addRoot(source: string) {
    if (!covered(source)) {
      roots.set(source, params.project(source));
    }
  }
  function assertSource(source: string) {
    if (isPathInside(source, privateRoot) || isPathInside(privateRoot, source)) {
      throw new Error("Plugin copy source overlaps candidate state");
    }
  }
  async function scan(directory: string): Promise<void> {
    assertSource(directory);
    if (scanned.has(directory)) {
      return;
    }
    scanned.add(directory);
    if (!(await fs.stat(directory)).isDirectory()) {
      return;
    }
    // Read before link discovery, so custom external stores retain their owner.
    const modules = await readRuntimeModulesManifest(path.join(directory, ".modules.yaml"));
    if (typeof modules?.manifest.virtualStoreDir === "string") {
      const store = await fs.realpath(path.resolve(directory, modules.manifest.virtualStoreDir));
      stores.add(store);
      addRoot(store);
    }
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (isHostEdge(file)) {
        hosts.add(file);
        const root = await fs.realpath(file).catch((error: unknown) => {
          if (hasNodeErrorCode(error, "ENOENT")) {
            return undefined;
          }
          throw error;
        });
        if (root) {
          hostRoots.add(root);
        }
      } else if (entry.isDirectory()) {
        await scan(file);
      } else if (entry.isSymbolicLink()) {
        const target = path.resolve(directory, await fs.readlink(file));
        const real = await fs.realpath(file).catch((error: unknown) => {
          if (hasNodeErrorCode(error, "ENOENT") || hasNodeErrorCode(error, "ELOOP")) {
            return target;
          }
          throw error;
        });
        edges.set(file, { target, real });
      }
    }
  }
  // A locator can itself name a package inside a pnpm store or hoisted tree.
  for (const source of params.roots.keys()) {
    if (source.split(path.sep).includes("node_modules")) {
      addRoot(await dependencyOwner(source));
    }
  }
  for (;;) {
    for (const root of roots.keys()) {
      await scan(root);
    }
    let added = false;
    for (const [file, { real }] of edges) {
      if (
        covered(real) ||
        (isHostLauncher(file) && [...hostRoots].some((root) => isPathInside(root, real)))
      ) {
        continue;
      }
      // Internal dangling links remain dangling. External missing targets cannot
      // be materialized without leaving an escape into the serving filesystem.
      const store = [...stores].find((root) => isPathInside(root, real));
      const owner =
        store ??
        (await dependencyOwner(real).catch((cause: unknown) => {
          throw new Error(`Cannot privately copy plugin dependency ${file} -> ${real}`, { cause });
        }));
      assertSource(owner);
      addRoot(owner);
      added = true;
    }
    if (!added) {
      break;
    }
  }
  const copies = [...roots].filter(
    ([source]) =>
      ![...roots.keys()].some((other) => other !== source && isPathInside(other, source)),
  );
  function projected(file: string): string {
    const copy = copies.find(([source]) => isPathInside(source, file));
    if (!copy) {
      throw new Error("Plugin dependency has no private copy owner");
    }
    return path.join(copy[1], path.relative(copy[0], file));
  }
  const relocations: RuntimeRelocation[] = copies.map(([sourceRoot, destinationRoot]) => ({
    sourceRoot,
    destinationRoot,
  }));
  for (const root of hostRoots) {
    relocations.push({ sourceRoot: root, destinationRoot: candidateRoot });
  }
  for (const host of hosts) {
    relocations.push({ sourceRoot: host, destinationRoot: candidateRoot });
  }
  for (const { target, real } of edges.values()) {
    const host = [...hostRoots].find((root) => isPathInside(root, real));
    relocations.push({
      sourceRoot: target,
      destinationRoot: host ? path.join(candidateRoot, path.relative(host, real)) : projected(real),
    });
  }
  relocations.sort((a, b) => b.sourceRoot.length - a.sourceRoot.length);
  const hostLinks = new Set([...hosts].map(projected));
  for (const [source, target] of copies) {
    const destination = resolvePathViaExistingAncestorSync(target);
    if (!isPathInside(privateRoot, destination)) {
      throw new Error("Plugin copy destination escapes candidate state");
    }
    for (const [other] of copies) {
      if (isPathInside(other, destination) || isPathInside(destination, other)) {
        throw new Error("Plugin copy source overlaps its destination");
      }
    }
    await fs.cp(source, target, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (file) => !isHostEdge(file),
    });
  }
  for (const [source, target] of copies) {
    if ((await fs.stat(target)).isDirectory()) {
      await relocateRuntimeTree(target, source, target, relocations);
    }
  }
  async function verify(directory: string): Promise<void> {
    if (!(await fs.stat(directory)).isDirectory()) {
      return;
    }
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await verify(file);
      } else if (entry.isSymbolicLink()) {
        const target = path.resolve(directory, await fs.readlink(file));
        if (
          !isPathInside(privateRoot, target) &&
          !(isHostLauncher(file) && isPathInside(candidateRoot, target))
        ) {
          throw new Error("Copied plugin symlink escapes candidate state");
        }
      }
    }
  }
  for (const [, target] of copies) {
    await verify(target);
  }
  return { copies, hostLinks };
}
