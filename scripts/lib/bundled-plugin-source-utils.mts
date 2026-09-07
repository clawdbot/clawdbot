// Discovers bundled plugin source directories and reads optional metadata files.
import { spawnSync } from "node:child_process";
import fs, { type PathOrFileDescriptor } from "node:fs";
import path from "node:path";

/** Read a UTF-8 file when it exists, returning null on missing/unreadable paths. */
export function readIfExists(filePath: PathOrFileDescriptor): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

type BundledPluginSourceCandidate = {
  dirName: string;
  manifestPath: string | null;
  packageJsonPath: string | null;
  pluginDir: string;
};

function readJsonFile(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function collectTrackedBundledPluginSourceCandidates(repoRoot: string) {
  const pathspecs = [
    ":(glob)extensions/*/openclaw.plugin.json",
    ":(glob)extensions/*/package.json",
  ];
  const runGitLsFiles = (args: string[]) =>
    spawnSync("git", ["ls-files", ...args, "--", ...pathspecs], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  const result = runGitLsFiles([]);
  const deletedResult = runGitLsFiles(["--deleted"]);
  if (result.status !== 0 || deletedResult.status !== 0) {
    return null;
  }
  const deletedPaths = new Set(
    deletedResult.stdout
      .split("\n")
      .map((line) => line.trim().replaceAll("\\", "/"))
      .filter(Boolean),
  );

  const candidatesByDir = new Map<string, BundledPluginSourceCandidate>();
  for (const rawLine of result.stdout.split("\n")) {
    const line = rawLine.trim().replaceAll("\\", "/");
    if (deletedPaths.has(line)) {
      continue;
    }
    const match = /^extensions\/([^/]+)\/(openclaw\.plugin\.json|package\.json)$/u.exec(line);
    if (!match?.[1] || !match[2]) {
      continue;
    }
    const current = candidatesByDir.get(match[1]) ?? {
      dirName: match[1],
      manifestPath: null,
      packageJsonPath: null,
      pluginDir: path.join(repoRoot, "extensions", match[1]),
    };
    if (match[2] === "openclaw.plugin.json") {
      current.manifestPath = path.join(repoRoot, line);
    } else {
      current.packageJsonPath = path.join(repoRoot, line);
    }
    candidatesByDir.set(match[1], current);
  }

  return [...candidatesByDir.values()].toSorted((left, right) =>
    left.dirName.localeCompare(right.dirName),
  );
}

function collectBundledPluginSourceCandidatesFromDirectory(repoRoot: string) {
  const extensionsRoot = path.join(repoRoot, "extensions");
  if (!fs.existsSync(extensionsRoot)) {
    return [];
  }

  return fs
    .readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => {
      const pluginDir = path.join(extensionsRoot, dirent.name);
      const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
      const packageJsonPath = path.join(pluginDir, "package.json");
      return {
        dirName: dirent.name,
        manifestPath: fs.existsSync(manifestPath) ? manifestPath : null,
        packageJsonPath: fs.existsSync(packageJsonPath) ? packageJsonPath : null,
        pluginDir,
      };
    })
    .toSorted((left, right) => left.dirName.localeCompare(right.dirName));
}

/** Collect bundled plugin manifests and package metadata from git or the extensions directory. */
export function collectBundledPluginSources(
  params: { repoRoot?: string; requirePackageJson?: boolean } = {},
) {
  const repoRoot = path.resolve(params.repoRoot ?? process.cwd());
  const requirePackageJson = params.requirePackageJson === true;
  const candidates =
    collectTrackedBundledPluginSourceCandidates(repoRoot) ??
    collectBundledPluginSourceCandidatesFromDirectory(repoRoot);
  return candidates
    .flatMap(({ dirName, manifestPath, packageJsonPath, pluginDir }) => {
      if (!manifestPath || (requirePackageJson && !packageJsonPath)) {
        return [];
      }
      return [
        {
          dirName,
          pluginDir,
          manifestPath,
          manifest: readJsonFile(manifestPath),
          ...(packageJsonPath
            ? {
                packageJsonPath,
                packageJson: readJsonFile(packageJsonPath),
              }
            : {}),
        },
      ];
    })
    .toSorted((left, right) => left.dirName.localeCompare(right.dirName));
}
