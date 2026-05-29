import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { resolvePluginNpmProjectsDir } from "./install-paths.js";

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function sortPaths(paths: string[]): string[] {
  return paths.toSorted((left, right) => left.localeCompare(right));
}

export function listManagedPluginNpmProjectRootsSync(npmRoot: string): string[] {
  const projectsDir = resolvePluginNpmProjectsDir(npmRoot);
  try {
    return sortPaths(
      fs
        .readdirSync(projectsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(projectsDir, entry.name)),
    );
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }
}

export async function listManagedPluginNpmProjectRoots(npmRoot: string): Promise<string[]> {
  const projectsDir = resolvePluginNpmProjectsDir(npmRoot);
  try {
    return sortPaths(
      (await fsp.readdir(projectsDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(projectsDir, entry.name)),
    );
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }
}

export function listManagedPluginNpmRootsSync(npmRoot: string): string[] {
  return [npmRoot, ...listManagedPluginNpmProjectRootsSync(npmRoot)];
}

export async function listManagedPluginNpmRoots(npmRoot: string): Promise<string[]> {
  return [npmRoot, ...(await listManagedPluginNpmProjectRoots(npmRoot))];
}
