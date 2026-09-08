import fs from "node:fs";
import { join } from "node:path";
import { isRecord } from "./record-shared.mjs";

export const RUNTIME_DEPENDENCY_OWNERSHIP_RELATIVE_PATH = "dist/runtime-dependency-ownership.json";
export const RUNTIME_DEPENDENCY_OWNERSHIP_ASSET_NAME = "runtime-dependency-ownership.json";

export type RuntimeDependencyOwnership = {
  chunks: Record<string, { sha256: string; extensions: string[] }>;
};

function parseRuntimeDependencyOwnership(value: unknown): RuntimeDependencyOwnership | null {
  if (!isRecord(value) || !isRecord(value.chunks)) {
    return null;
  }
  for (const chunk of Object.values(value.chunks)) {
    if (
      !isRecord(chunk) ||
      typeof chunk.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(chunk.sha256) ||
      !Array.isArray(chunk.extensions) ||
      chunk.extensions.length === 0 ||
      !chunk.extensions.every((id) => typeof id === "string" && /^[a-z0-9][a-z0-9-]*$/u.test(id)) ||
      new Set(chunk.extensions).size !== chunk.extensions.length
    ) {
      return null;
    }
  }
  return value as RuntimeDependencyOwnership;
}

export function readRuntimeDependencyOwnership(
  packageRoot: string,
  fsImpl: typeof fs = fs,
): RuntimeDependencyOwnership | null {
  const file = join(packageRoot, RUNTIME_DEPENDENCY_OWNERSHIP_RELATIVE_PATH);
  if (!fsImpl.existsSync(file)) {
    return null;
  }
  const stat = fsImpl.lstatSync(file);
  if (!stat.isFile() || stat.size > 1024 * 1024) {
    throw new Error("ownership artifact must be a regular file no larger than 1048576 bytes");
  }
  const ownership = parseRuntimeDependencyOwnership(JSON.parse(fsImpl.readFileSync(file, "utf8")));
  if (!ownership) {
    throw new Error("ownership artifact does not match the supported schema");
  }
  return ownership;
}
