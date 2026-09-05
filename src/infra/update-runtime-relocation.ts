import fs from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "./path-guards.js";

export type RuntimeRelocation = {
  sourceRoot: string;
  destinationRoot: string;
  sourceAliases?: string[];
};

export function relocateRuntimePath(value: string, relocation: RuntimeRelocation): string {
  const root = [relocation.sourceRoot, ...(relocation.sourceAliases ?? [])].find((candidate) =>
    isPathInside(candidate, value),
  );
  return root ? path.join(relocation.destinationRoot, path.relative(root, value)) : value;
}

export async function relocateRuntimeSymlink(
  file: string,
  sourceFile: string,
  destinationFile: string,
  relocation: RuntimeRelocation,
): Promise<void> {
  const link = await fs.readlink(file);
  const target = relocateRuntimePath(path.resolve(path.dirname(sourceFile), link), relocation);
  const replacement = path.isAbsolute(link)
    ? target
    : path.relative(path.dirname(destinationFile), target);
  if (replacement === link) {
    return;
  }
  // Copied relative links still describe their original location. Inspect that
  // source before rebinding; Windows junctions require the final absolute target.
  const type =
    process.platform === "win32" && (await fs.stat(sourceFile)).isDirectory() ? "junction" : "file";
  await fs.unlink(file);
  await fs.symlink(type === "junction" ? target : replacement, file, type);
}
