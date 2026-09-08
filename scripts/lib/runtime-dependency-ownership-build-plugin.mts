import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import type { TsdownPlugin } from "tsdown";
import ts from "typescript";
import { packageNameFromSpecifier } from "./plugin-package-dependencies.mts";
import {
  RUNTIME_DEPENDENCY_OWNERSHIP_ASSET_NAME,
  RUNTIME_DEPENDENCY_OWNERSHIP_FORMAT_VERSION,
  type RuntimeDependencyOwnership,
} from "./runtime-dependency-ownership-contract.mts";

type RuntimeOwner = "root" | `extension:${string}`;
const NODE_BUILTIN_MODULES = new Set(builtinModules.map((name) => name.replace(/^node:/u, "")));

function moduleOwner(rootDir: string, moduleId: string): RuntimeOwner | null {
  const sourcePath = moduleId.split("?", 1)[0] ?? moduleId;
  const relativePath = path.relative(rootDir, sourcePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return null;
  const segments = relativePath.split(path.sep);
  if (segments[0] === "node_modules") return null;
  return segments[0] === "extensions" && segments[1] ? `extension:${segments[1]}` : "root";
}

export function collectRuntimeDependencyOwnership(params: {
  moduleIds: readonly string[];
  readSource?: (moduleId: string) => string;
  rootDir: string;
}): RuntimeDependencyOwnership {
  const ownersByDependency = new Map<string, Set<RuntimeOwner>>();
  const readSource = params.readSource ?? ((moduleId: string) => readFileSync(moduleId, "utf8"));
  for (const moduleId of [...new Set(params.moduleIds)].toSorted()) {
    const sourcePath = moduleId.split("?", 1)[0] ?? moduleId;
    const owner = moduleOwner(params.rootDir, sourcePath);
    if (!owner) continue;
    let source: string;
    try {
      source = readSource(sourcePath);
    } catch {
      continue;
    }
    for (const importedFile of ts.preProcessFile(source, true, true).importedFiles) {
      const dependencyName = packageNameFromSpecifier(importedFile.fileName);
      if (!dependencyName || NODE_BUILTIN_MODULES.has(dependencyName)) continue;
      const owners = ownersByDependency.get(dependencyName) ?? new Set<RuntimeOwner>();
      owners.add(owner);
      ownersByDependency.set(dependencyName, owners);
    }
  }
  return {
    formatVersion: RUNTIME_DEPENDENCY_OWNERSHIP_FORMAT_VERSION,
    dependencies: Object.fromEntries(
      [...ownersByDependency.entries()]
        .filter(([, owners]) => !owners.has("root"))
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([dependencyName, owners]) => [
          dependencyName,
          {
            root: false,
            extensions: [...owners]
              .filter((owner): owner is `extension:${string}` => owner.startsWith("extension:"))
              .map((owner) => owner.slice("extension:".length))
              .toSorted(),
          },
        ]),
    ),
  };
}

export function createRuntimeDependencyOwnershipBuildPlugin(rootDir = process.cwd()): TsdownPlugin {
  const sources = new Map<string, string>();
  return {
    name: "openclaw:runtime-dependency-ownership",
    buildStart() {
      sources.clear();
    },
    transform(code, id) {
      const sourcePath = id.split("?", 1)[0] ?? id;
      if (moduleOwner(rootDir, sourcePath)) sources.set(sourcePath, code);
      return null;
    },
    generateBundle() {
      const ownership = collectRuntimeDependencyOwnership({
        rootDir,
        moduleIds: [...sources.keys()],
        readSource: (moduleId) => sources.get(moduleId) ?? "",
      });
      this.emitFile({
        type: "asset",
        fileName: RUNTIME_DEPENDENCY_OWNERSHIP_ASSET_NAME,
        source: `${JSON.stringify(ownership, null, 2)}\n`,
      });
    },
  };
}
