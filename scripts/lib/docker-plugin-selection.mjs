import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { collectRootPackageExcludedExtensionDirs } from "./root-package-bundled-plugin-excludes.mjs";

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]*$/u;

function readManifestId(pluginDir) {
  const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  return typeof manifest.id === "string" && manifest.id.length > 0 ? manifest.id : null;
}

function collectPluginIdentities(extensionsRoot) {
  return fs
    .readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const pluginDir = path.join(extensionsRoot, entry.name);
      const hasPackageJson = fs.existsSync(path.join(pluginDir, "package.json"));
      const manifestId = readManifestId(pluginDir);
      return {
        dirName: entry.name,
        manifestId,
        known: hasPackageJson || manifestId !== null,
      };
    })
    .filter((entry) => entry.known)
    .toSorted((left, right) => left.dirName.localeCompare(right.dirName));
}

/** Resolve public Docker selections to the source directories used by build and prune steps. */
function resolveDockerPluginSelection(params) {
  const selection = typeof params.selection === "string" ? params.selection : "";
  const selectedIds = new Set(
    selection
      .split(/[\s,]+/u)
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  const plugins = collectPluginIdentities(params.extensionsRoot);
  const resolvedDirs = new Set();

  for (const selectedId of selectedIds) {
    if (!PLUGIN_ID_RE.test(selectedId)) {
      throw new Error(`invalid OPENCLAW_EXTENSIONS plugin id: ${selectedId}`);
    }
    const matches = plugins.filter(
      (plugin) => plugin.dirName === selectedId || plugin.manifestId === selectedId,
    );
    if (matches.length === 0) {
      throw new Error(`unknown OPENCLAW_EXTENSIONS plugin id: ${selectedId}`);
    }
    if (matches.length > 1) {
      throw new Error(
        `ambiguous OPENCLAW_EXTENSIONS plugin id: ${selectedId} (${matches
          .map((plugin) => plugin.dirName)
          .join(", ")})`,
      );
    }
    resolvedDirs.add(matches[0].dirName);
  }

  return [...resolvedDirs].toSorted((left, right) => left.localeCompare(right));
}

function collectRequiredBundledPluginDirs(params) {
  const excluded = collectRootPackageExcludedExtensionDirs({
    cwd: path.dirname(params.rootPackagePath),
  });
  return collectPluginIdentities(params.extensionsRoot)
    .filter(({ dirName }) => {
      if (excluded.has(dirName)) {
        return false;
      }
      const packageJsonPath = path.join(params.extensionsRoot, dirName, "package.json");
      if (!fs.existsSync(packageJsonPath)) {
        return false;
      }
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      return Object.keys(packageJson.dependencies ?? {}).length > 0;
    })
    .map(({ dirName }) => dirName);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const params = {
      extensionsRoot: process.argv[2],
      selection: process.argv[3] ?? "",
    };
    let resolved = resolveDockerPluginSelection(params);
    if (process.argv[4] === "--required-bundled") {
      resolved = [
        ...new Set([
          ...resolved,
          ...collectRequiredBundledPluginDirs({ ...params, rootPackagePath: process.argv[5] }),
        ]),
      ].toSorted((left, right) => left.localeCompare(right));
    } else if (process.argv[4] === "--required-platform-packages") {
      resolved = [
        ...new Set(
          resolved.flatMap((dirName) => {
            const packageJsonPath = path.join(params.extensionsRoot, dirName, "package.json");
            if (!fs.existsSync(packageJsonPath)) {
              return [];
            }
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
            return packageJson.openclaw?.install?.requiredPlatformPackages ?? [];
          }),
        ),
      ].toSorted((left, right) => left.localeCompare(right));
    }
    if (resolved.length > 0) {
      process.stdout.write(`${resolved.join("\n")}\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ERROR: ${message}`);
    process.exitCode = 1;
  }
}
