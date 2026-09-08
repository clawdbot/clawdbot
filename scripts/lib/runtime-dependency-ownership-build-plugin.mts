import { builtinModules } from "node:module";
import path from "node:path";
import type { TsdownPlugin } from "tsdown";
import { packageNameFromSpecifier } from "./plugin-package-dependencies.mts";
import {
  RUNTIME_DEPENDENCY_OWNERSHIP_ASSET_NAME,
  RUNTIME_DEPENDENCY_OWNERSHIP_FORMAT_VERSION,
  type RuntimeDependencyOwnership,
} from "./runtime-dependency-ownership-contract.mts";

type RuntimeOwner = "root" | `extension:${string}`;

const NODE_BUILTIN_MODULES = new Set(builtinModules.map((name) => name.replace(/^node:/u, "")));

type BuildModuleInfo = {
  dynamicallyImportedIds: readonly string[];
  id: string;
  importedIds: readonly string[];
  isEntry: boolean;
};

function runtimeOwnerForEntry(rootDir: string, moduleId: string): RuntimeOwner {
  const sourcePath = moduleId.split("?", 1)[0] ?? moduleId;
  const relativePath = path.relative(rootDir, sourcePath);
  const segments = relativePath.split(path.sep);
  return !relativePath.startsWith("..") && segments[0] === "extensions" && segments[1]
    ? `extension:${segments[1]}`
    : "root";
}

export function collectRuntimeDependencyOwnership(params: {
  getModuleInfo: (id: string) => BuildModuleInfo | null;
  includedModuleIds: ReadonlySet<string>;
  rootDir: string;
}): RuntimeDependencyOwnership {
  const ownersByDependency = new Map<string, Set<RuntimeOwner>>();
  const entries = [...params.includedModuleIds]
    .map((id) => params.getModuleInfo(id))
    .filter((info): info is BuildModuleInfo => info?.isEntry === true);

  for (const entry of entries) {
    const owner = runtimeOwnerForEntry(params.rootDir, entry.id);
    const visited = new Set<string>();
    const pending = [entry.id];
    while (pending.length > 0) {
      const moduleId = pending.pop()!;
      if (visited.has(moduleId)) {
        continue;
      }
      visited.add(moduleId);
      const info = params.getModuleInfo(moduleId);
      if (!info) {
        continue;
      }
      for (const importedId of [...info.importedIds, ...info.dynamicallyImportedIds]) {
        if (!params.includedModuleIds.has(importedId)) {
          const dependencyName = packageNameFromSpecifier(importedId);
          if (dependencyName && !NODE_BUILTIN_MODULES.has(dependencyName)) {
            const owners = ownersByDependency.get(dependencyName) ?? new Set<RuntimeOwner>();
            owners.add(owner);
            ownersByDependency.set(dependencyName, owners);
          }
        } else {
          pending.push(importedId);
        }
      }
    }
  }

  return {
    formatVersion: RUNTIME_DEPENDENCY_OWNERSHIP_FORMAT_VERSION,
    dependencies: Object.fromEntries(
      [...ownersByDependency.entries()]
        // The verifier needs positive authorization only for dependencies that
        // are unreachable from every root entry. Omitting root-reachable names
        // is conservative: an undeclared root import still fails closed.
        .filter(([, owners]) => !owners.has("root"))
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([dependencyName, owners]) => [
          dependencyName,
          {
            root: false,
            extensions: [...owners]
              .filter((owner): owner is `extension:${string}` => owner.startsWith("extension:"))
              .map((owner) => owner.slice("extension:".length))
              .toSorted((left, right) => left.localeCompare(right)),
          },
        ]),
    ),
  };
}

export function createRuntimeDependencyOwnershipBuildPlugin(rootDir = process.cwd()): TsdownPlugin {
  return {
    name: "openclaw:runtime-dependency-ownership",
    generateBundle(_options, bundle) {
      const includedModuleIds = new Set(
        Object.values(bundle).flatMap((output) =>
          output.type === "chunk" ? Object.keys(output.modules) : [],
        ),
      );
      const ownership = collectRuntimeDependencyOwnership({
        rootDir,
        includedModuleIds,
        getModuleInfo: (id) => {
          const info = this.getModuleInfo(id);
          return info
            ? {
                id: info.id,
                isEntry: info.isEntry,
                importedIds: info.importedIds,
                dynamicallyImportedIds: info.dynamicallyImportedIds,
              }
            : null;
        },
      });
      this.emitFile({
        type: "asset",
        fileName: RUNTIME_DEPENDENCY_OWNERSHIP_ASSET_NAME,
        source: `${JSON.stringify(ownership, null, 2)}\n`,
      });
    },
  };
}
