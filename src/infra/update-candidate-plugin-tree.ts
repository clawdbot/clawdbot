import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { tryReadJson } from "./json-files.js";
import { parseRegistryNpmSpec } from "./npm-registry-spec.js";
import { hasNodeErrorCode, isPathInside } from "./path-guards.js";
import {
  readRuntimeModulesManifest,
  relocateRuntimeTree,
  type RuntimeRelocation,
} from "./update-runtime-relocation.js";

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
}): Promise<Array<[string, string]>> {
  const roots = new Map(params.roots);
  const privateRoot = resolvePathViaExistingAncestorSync(path.resolve(params.targetStateDir));
  const candidateRoot = resolvePathViaExistingAncestorSync(path.resolve(params.candidateRoot));
  const scanned = new Set<string>();
  const edges = new Map<string, { target: string; real: string }>();
  const hosts = new Set<string>();
  const hostRoots = new Set<string>();
  const stores = new Set<string>();
  const moduleAliases = new Map<string, string>();
  const moduleOwners = new Set<string>();
  const isOwnedHostEdge = (file: string) =>
    path.basename(file) === "openclaw" && moduleOwners.has(path.dirname(file));
  const covered = (file: string) => [...roots.keys()].some((root) => isPathInside(root, file));
  const insideHost = (file: string) => [...hosts].some((root) => isPathInside(root, file));
  const excludesInferredRoot = (root: string) =>
    !params.roots.has(root) && (insideHost(root) || hostRoots.has(root));
  function addRoot(source: string) {
    if (!roots.has(source)) {
      roots.set(source, params.project(source));
    }
  }
  function assertSource(source: string) {
    if (isPathInside(source, privateRoot) || isPathInside(privateRoot, source)) {
      throw new Error("Plugin copy source overlaps candidate state");
    }
  }
  async function discoverHoistedDependencies(directory: string): Promise<void> {
    const manifest = await tryReadJson<unknown>(path.join(directory, "package.json"));
    if (!isRecord(manifest)) {
      return;
    }
    const names = new Set<string>();
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      const dependencies = manifest[field];
      if (isRecord(dependencies)) {
        for (const [name, spec] of Object.entries(dependencies)) {
          const parsed = parseRegistryNpmSpec(name);
          if (typeof spec === "string" && parsed?.name === name && parsed.selectorKind === "none") {
            names.add(name);
          }
        }
      }
    }
    for (const name of names) {
      for (let ancestor = directory; ; ancestor = path.dirname(ancestor)) {
        // Node skips a redundant node_modules/node_modules lookup.
        if (path.basename(ancestor) !== "node_modules") {
          const modulesDir = path.join(ancestor, "node_modules");
          const dependency = path.join(modulesDir, ...name.split("/"));
          const exists = await fs.stat(dependency).then(
            () => true,
            (error: unknown) => {
              if (hasNodeErrorCode(error, "ENOENT") || hasNodeErrorCode(error, "ENOTDIR")) {
                return false;
              }
              throw error;
            },
          );
          if (exists) {
            // Copy the reached module owner, not its repository. Its projected
            // ancestry preserves both nearest-package shadowing and sibling imports.
            const realModules = await fs.realpath(modulesDir);
            assertSource(modulesDir);
            assertSource(realModules);
            moduleOwners.add(realModules);
            addRoot(realModules);
            if (realModules !== modulesDir) {
              moduleAliases.set(modulesDir, realModules);
            }
            break;
          }
        }
        if (path.dirname(ancestor) === ancestor) {
          // Missing optional dependencies remain absent; validation owns required ones.
          break;
        }
      }
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
    if (path.basename(directory) === "node_modules") {
      moduleOwners.add(directory);
    }
    await discoverHoistedDependencies(directory);
    // Read before link discovery, so custom external stores retain their owner.
    const modules = await readRuntimeModulesManifest(path.join(directory, ".modules.yaml"));
    if (typeof modules?.manifest.virtualStoreDir === "string") {
      const store = await fs.realpath(path.resolve(directory, modules.manifest.virtualStoreDir));
      stores.add(store);
      addRoot(store);
    }
    const entries = await fs.readdir(directory, { withFileTypes: true });
    // Register identities before visiting siblings: a physical module directory
    // may sort before the node_modules alias that establishes its ownership.
    for (const entry of entries) {
      if (entry.name === "node_modules" && (entry.isDirectory() || entry.isSymbolicLink())) {
        const owner = await fs
          .realpath(path.join(directory, entry.name))
          .catch((error: unknown) => {
            if (hasNodeErrorCode(error, "ENOENT") || hasNodeErrorCode(error, "ELOOP")) {
              return undefined;
            }
            throw error;
          });
        if (owner) {
          const source = path.join(directory, entry.name);
          assertSource(owner);
          moduleOwners.add(owner);
          addRoot(owner);
          if (source !== owner) {
            moduleAliases.set(source, owner);
          }
        }
      }
    }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (isOwnedHostEdge(file)) {
        // The complete-wave owner pass records the authoritative host identity.
        continue;
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
  async function refreshHostEdges(): Promise<void> {
    const discovered: Array<{ source: string; real?: string }> = [];
    for (const owner of moduleOwners) {
      const source = path.join(owner, "openclaw");
      const exists = await fs.lstat(source).then(
        () => true,
        (error: unknown) => {
          if (hasNodeErrorCode(error, "ENOENT") || hasNodeErrorCode(error, "ENOTDIR")) {
            return false;
          }
          throw error;
        },
      );
      if (!exists) {
        continue;
      }
      const real = await fs.realpath(source).catch((error: unknown) => {
        if (hasNodeErrorCode(error, "ENOENT")) {
          return undefined;
        }
        throw error;
      });
      discovered.push({ source, real });
    }
    hosts.clear();
    hostRoots.clear();
    for (const host of discovered) {
      if (
        discovered.some(
          (other) => other.source !== host.source && isPathInside(other.source, host.source),
        )
      ) {
        continue;
      }
      hosts.add(host.source);
      if (host.real) {
        hostRoots.add(host.real);
      }
    }
    // A later module alias can identify a host subtree that an earlier root
    // already scanned. Its discoveries must not become private dependency copies
    // or nested aliases beneath the immutable staged host edge.
    for (const root of roots.keys()) {
      if (excludesInferredRoot(root)) {
        roots.delete(root);
      }
    }
    for (const file of edges.keys()) {
      if (insideHost(file)) {
        edges.delete(file);
      }
    }
    for (const source of moduleAliases.keys()) {
      if (insideHost(source)) {
        moduleAliases.delete(source);
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
    // Module ownership is a complete-wave fact, independent of root order.
    await refreshHostEdges();
    let added = false;
    for (const [file, { real }] of edges) {
      if (
        covered(real) ||
        hostRoots.has(real) ||
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
      if (excludesInferredRoot(owner)) {
        throw new Error(
          `Cannot privately copy host-owned plugin link ${file} -> ${real}; use the openclaw package/SDK import or a separately owned plugin dependency.`,
        );
      }
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
  for (const [sourceRoot, real] of moduleAliases) {
    relocations.push({ sourceRoot, destinationRoot: projected(real) });
  }
  for (const root of hostRoots) {
    relocations.push({ sourceRoot: root, destinationRoot: candidateRoot });
  }
  for (const host of hosts) {
    relocations.push({ sourceRoot: host, destinationRoot: candidateRoot });
  }
  for (const [file, { target, real }] of edges) {
    const host = [...hostRoots].find(
      (root) => real === root || (isHostLauncher(file) && isPathInside(root, real)),
    );
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
      filter: (file) => !hosts.has(file),
    });
  }
  for (const [source, target] of copies) {
    if ((await fs.stat(target)).isDirectory()) {
      await relocateRuntimeTree(target, source, target, relocations);
    }
  }
  // Projection owns these private links. Installer peer-link policy expects a
  // literal node_modules directory and cannot bind a relocated module owner.
  for (const link of hostLinks) {
    if (!isPathInside(privateRoot, resolvePathViaExistingAncestorSync(path.dirname(link)))) {
      throw new Error("Plugin host link escapes candidate state");
    }
    await fs.mkdir(path.dirname(link), { recursive: true });
    const existing = await fs.lstat(link).catch((error: unknown) => {
      if (hasNodeErrorCode(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    });
    if (existing) {
      if (
        !existing.isSymbolicLink() ||
        path.resolve(path.dirname(link), await fs.readlink(link)) !== candidateRoot
      ) {
        throw new Error("Plugin host link conflicts with its candidate owner");
      }
    } else {
      await fs.symlink(candidateRoot, link, process.platform === "win32" ? "junction" : "dir");
    }
  }
  const privateAliases: string[] = [];
  for (const [source, real] of moduleAliases) {
    const owner = copies.find(([root]) => isPathInside(root, source));
    const alias = owner
      ? path.join(owner[1], path.relative(owner[0], source))
      : params.project(source);
    const target = projected(real);
    if (!isPathInside(privateRoot, resolvePathViaExistingAncestorSync(path.dirname(alias)))) {
      throw new Error("Plugin module alias escapes candidate state");
    }
    const existing = await fs.lstat(alias).catch((error: unknown) => {
      if (hasNodeErrorCode(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    });
    if (existing) {
      if ((await fs.realpath(alias)) !== (await fs.realpath(target))) {
        throw new Error("Plugin module alias conflicts with its private owner");
      }
    } else {
      await fs.mkdir(path.dirname(alias), { recursive: true });
      await fs.symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
    }
    privateAliases.push(alias);
  }
  async function verify(file: string): Promise<void> {
    const stat = await fs.lstat(file);
    if (hostLinks.has(file)) {
      if (
        !stat.isSymbolicLink() ||
        path.resolve(path.dirname(file), await fs.readlink(file)) !== candidateRoot
      ) {
        throw new Error("Copied plugin host link does not target the candidate");
      }
      return;
    }
    // Inspect the entry before traversal, including standalone module aliases;
    // following a copied root link can otherwise accept an entirely live tree.
    if (stat.isSymbolicLink()) {
      const target = path.resolve(path.dirname(file), await fs.readlink(file));
      if (
        !isPathInside(privateRoot, target) &&
        !(isHostLauncher(file) && isPathInside(candidateRoot, target))
      ) {
        throw new Error("Copied plugin symlink escapes candidate state");
      }
      return;
    }
    if (stat.isDirectory()) {
      for (const entry of await fs.readdir(file)) {
        await verify(path.join(file, entry));
      }
    }
  }
  for (const alias of privateAliases) {
    await verify(alias);
  }
  for (const [, target] of copies) {
    await verify(target);
  }
  return copies;
}
