import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function collectTrackedBundledPluginSourceCandidates(repoRoot) {
  const result = spawnSync(
    "git",
    [
      "ls-files",
      "--",
      ":(glob)extensions/*/openclaw.plugin.json",
      ":(glob)extensions/*/package.json",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.status !== 0) {
    return null;
  }

  const candidatesByDir = new Map();
  for (const rawLine of result.stdout.split("\n")) {
    const line = rawLine.trim().replaceAll("\\", "/");
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

function collectBundledPluginSourceCandidatesFromDirectory(repoRoot) {
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

export function collectBundledPluginSources(params = {}) {
  const repoRoot = path.resolve(params.repoRoot ?? process.cwd());
  const requirePackageJson = params.requirePackageJson === true;
  const entries = [];
  const candidates =
    collectTrackedBundledPluginSourceCandidates(repoRoot) ??
    collectBundledPluginSourceCandidatesFromDirectory(repoRoot);
  for (const { dirName, manifestPath, packageJsonPath, pluginDir } of candidates) {
    if (!manifestPath) {
      continue;
    }
    if (requirePackageJson && !packageJsonPath) {
      continue;
    }

    entries.push({
      dirName,
      pluginDir,
      manifestPath,
      manifest: JSON.parse(fs.readFileSync(manifestPath, "utf8")),
      ...(packageJsonPath
        ? {
            packageJsonPath,
            packageJson: JSON.parse(fs.readFileSync(packageJsonPath, "utf8")),
          }
        : {}),
    });
  }

  return entries.toSorted((left, right) => left.dirName.localeCompare(right.dirName));
}
