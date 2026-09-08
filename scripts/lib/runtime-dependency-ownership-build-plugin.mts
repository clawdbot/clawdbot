import { createHash } from "node:crypto";
import path from "node:path";
import type { TsdownPlugin } from "tsdown";
import {
  RUNTIME_DEPENDENCY_OWNERSHIP_ASSET_NAME,
  type RuntimeDependencyOwnership,
} from "./runtime-dependency-ownership-contract.mts";

export function createRuntimeDependencyOwnershipBuildPlugin(rootDir = process.cwd()): TsdownPlugin {
  return {
    name: "openclaw:runtime-dependency-ownership",
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const chunks = Object.values(bundle).filter((output) => output.type === "chunk");
        const ownersByChunk = new Map<string, Set<string>>();
        for (const entry of chunks.filter((chunk) => chunk.isEntry)) {
          const source = entry.facadeModuleId?.split("?", 1)[0];
          const relative = source ? path.relative(rootDir, source).split(path.sep).join("/") : "";
          // An empty owner represents a root entry and prevents plugin authorization.
          const owner = /^extensions\/([a-z0-9][a-z0-9-]*)\//u.exec(relative)?.[1] ?? "";
          const pending = [entry.fileName];
          const visited = new Set<string>();
          while (pending.length > 0) {
            const fileName = pending.pop()!;
            if (visited.has(fileName)) {
              continue;
            }
            visited.add(fileName);
            const chunk = bundle[fileName];
            if (chunk?.type !== "chunk") {
              continue;
            }
            const owners = ownersByChunk.get(fileName) ?? new Set<string>();
            owners.add(owner);
            ownersByChunk.set(fileName, owners);
            pending.push(...chunk.imports, ...chunk.dynamicImports);
          }
        }
        const ownership: RuntimeDependencyOwnership = { chunks: {} };
        for (const chunk of chunks.toSorted((a, b) => a.fileName.localeCompare(b.fileName))) {
          const owners = ownersByChunk.get(chunk.fileName);
          if (!owners?.size || owners.has("") || chunk.fileName.startsWith("extensions/")) {
            continue;
          }
          ownership.chunks[chunk.fileName] = {
            sha256: createHash("sha256").update(chunk.code).digest("hex"),
            extensions: [...owners].toSorted(),
          };
        }
        this.emitFile({
          type: "asset",
          fileName: RUNTIME_DEPENDENCY_OWNERSHIP_ASSET_NAME,
          source: `${JSON.stringify(ownership)}\n`,
        });
      },
    },
  };
}
