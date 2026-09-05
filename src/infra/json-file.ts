// Loads and saves JSON files with symlink backup handling.
import "./fs-safe-defaults.js";
import fs from "node:fs";
import path from "node:path";
import { tryReadJsonSync, writeJsonSync } from "@openclaw/fs-safe/json";

function resolveJsonSymlinkTarget(pathname: string): string | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(pathname);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (!stat.isSymbolicLink()) {
    return undefined;
  }

  return path.resolve(path.dirname(pathname), fs.readlinkSync(pathname));
}

export function resolveJsonSaveTarget(pathname: string): string {
  let currentPath = pathname;
  const visited = new Set<string>();
  while (fs.lstatSync(currentPath, { throwIfNoEntry: false })?.isSymbolicLink()) {
    const normalizedPath = path.resolve(currentPath);
    if (visited.has(normalizedPath)) {
      throw Object.assign(new Error(`Too many symlink levels while resolving ${pathname}`), {
        code: "ELOOP",
      });
    }
    visited.add(normalizedPath);
    currentPath = path.resolve(path.dirname(currentPath), fs.readlinkSync(currentPath));
  }
  if (visited.size > 0) {
    fs.statSync(path.dirname(currentPath));
  }
  return currentPath;
}

export function writeJsonTarget(pathname: string, data: unknown): void {
  writeJsonSync(resolveJsonSaveTarget(pathname), data);
}

// oxlint-disable-next-line typescript-eslint/no-unnecessary-type-parameters -- legacy typed JSON loader alias.
export function loadJsonFileThroughSymlink<T = unknown>(pathname: string): T | undefined {
  const direct = tryReadJsonSync<T>(pathname);
  if (direct !== null) {
    return direct;
  }
  const target = resolveJsonSymlinkTarget(pathname);
  return target ? (tryReadJsonSync<T>(target) ?? undefined) : undefined;
}
