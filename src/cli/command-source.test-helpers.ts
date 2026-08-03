// Test helper for reading command source plus lazy runtime modules that carry secret resolution.
import fs from "node:fs/promises";
import path from "node:path";

function resolveImportedTypeScriptPath(importerPath: string, target: string): string {
  const resolvedTarget = path.join(path.dirname(importerPath), target);
  return resolvedTarget.replace(/\.js$/u, ".ts");
}

async function readModuleSource(modulePath: string, seen: Set<string>): Promise<string> {
  const resolvedPath = path.resolve(modulePath);
  if (seen.has(resolvedPath)) {
    return "";
  }
  seen.add(resolvedPath);

  const source = await fs.readFile(resolvedPath, "utf8");
  if (source.includes("resolveCommandSecretRefsViaGateway")) {
    return source;
  }
  const nestedTargets = new Set<string>();

  for (const match of source.matchAll(/^export \* from "(?<target>[^"]+)";$/gmu)) {
    const target = match.groups?.target;
    if (target) {
      nestedTargets.add(resolveImportedTypeScriptPath(resolvedPath, target));
    }
  }

  for (const match of source.matchAll(/import\("(?<target>\.[^"]+\.runtime\.js)"\)/gmu)) {
    const target = match.groups?.target;
    if (target) {
      nestedTargets.add(resolveImportedTypeScriptPath(resolvedPath, target));
    }
  }

  const nestedSources = (
    await Promise.all(
      [...nestedTargets].map(async (targetPath) => await readModuleSource(targetPath, seen)),
    )
  ).filter(Boolean);

  return nestedSources.length > 0 ? [source, ...nestedSources].join("\n") : source;
}

/** Read a command source file and selected nested runtime modules for source-policy tests. */
export async function readCommandSource(
  relativePath: string,
  cwd = process.cwd(),
): Promise<string> {
  return await readModuleSource(path.join(cwd, relativePath), new Set<string>());
}
