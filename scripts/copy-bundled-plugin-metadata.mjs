import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  collectBundledPluginBuildEntries,
  NON_PACKAGED_BUNDLED_PLUGIN_DIRS,
} from "./lib/bundled-plugin-build-entries.mjs";
import { shouldBuildBundledCluster } from "./lib/optional-bundled-clusters.mjs";
import {
  mergeGeneratedChannelConfigs,
  readGeneratedBundledChannelConfigs,
} from "./lib/plugin-npm-package-manifest.mjs";
import {
  removeFileIfExists,
  removePathIfExists,
  writeTextFileIfChanged,
} from "./runtime-postbuild-shared.mjs";

const GENERATED_BUNDLED_SKILLS_DIR = "bundled-skills";
const TRANSIENT_COPY_ERROR_CODES = new Set(["EEXIST", "ENOENT", "ENOTEMPTY", "EBUSY"]);
const COPY_RETRY_DELAYS_MS = [10, 25, 50];

function shouldCopyBundledPluginMetadata(id, env, buildablePluginDirs) {
  if (!buildablePluginDirs.has(id)) {
    return false;
  }
  if (!NON_PACKAGED_BUNDLED_PLUGIN_DIRS.has(id)) {
    return true;
  }
  return env.OPENCLAW_BUILD_PRIVATE_QA === "1";
}

export function rewritePackageExtensions(entries) {
  if (!Array.isArray(entries)) {
    return undefined;
  }

  return entries
    .filter((entry) => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => {
      const normalized = entry.replace(/^\.\//, "");
      const rewritten = normalized.replace(/\.[^.]+$/u, ".js");
      return `./${rewritten}`;
    });
}

function collectTopLevelPublicSurfaceEntries(pluginDir) {
  if (!fs.existsSync(pluginDir)) {
    return [];
  }

  return fs
    .readdirSync(pluginDir, { withFileTypes: true })
    .flatMap((dirent) => {
      if (!dirent.isFile()) {
        return [];
      }

      if (!/\.(?:[cm]?[jt]s)$/u.test(dirent.name) || dirent.name.endsWith(".d.ts")) {
        return [];
      }

      const normalizedName = dirent.name.toLowerCase();
      if (
        /^config-api\.(?:[cm]?[jt]s)$/u.test(normalizedName) ||
        normalizedName.includes(".test.") ||
        normalizedName.includes(".spec.") ||
        normalizedName.includes(".fixture.") ||
        normalizedName.includes(".snap")
      ) {
        return [];
      }

      return [dirent.name];
    })
    .toSorted((left, right) => left.localeCompare(right));
}

function isManifestlessBundledRuntimeSupportPackage(params) {
  const packageName = typeof params.packageJson?.name === "string" ? params.packageJson.name : "";
  if (packageName !== `@openclaw/${params.dirName}`) {
    return false;
  }
  return params.topLevelPublicSurfaceEntries.length > 0;
}

function rewritePackageEntry(entry) {
  if (typeof entry !== "string" || entry.trim().length === 0) {
    return undefined;
  }
  const normalized = entry.replace(/^\.\//, "");
  const rewritten = normalized.replace(/\.[^.]+$/u, ".js");
  return `./${rewritten}`;
}

function ensurePathInsideRoot(rootDir, rawPath) {
  const resolved = path.resolve(rootDir, rawPath);
  const relative = path.relative(rootDir, resolved);
  if (
    relative === "" ||
    relative === "." ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  ) {
    return resolved;
  }
  throw new Error(`path escapes plugin root: ${rawPath}`);
}

function normalizeManifestRelativePath(rawPath) {
  return rawPath.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function resolveDeclaredSkillSourcePath(params) {
  const normalized = normalizeManifestRelativePath(params.rawPath);
  const pluginLocalPath = ensurePathInsideRoot(params.pluginDir, normalized);
  if (fs.existsSync(pluginLocalPath)) {
    return pluginLocalPath;
  }
  if (!/^node_modules(?:\/|$)/u.test(normalized)) {
    return pluginLocalPath;
  }
  return ensurePathInsideRoot(params.repoRoot, normalized);
}

function resolveBundledSkillTarget(rawPath) {
  const normalized = normalizeManifestRelativePath(rawPath);
  if (/^node_modules(?:\/|$)/u.test(normalized)) {
    // Bundled dist/plugin roots must not publish nested node_modules trees. Relocate
    // dependency-backed skill assets into a dist-owned directory and rewrite the manifest.
    const trimmed = normalized.replace(/^node_modules\/?/u, "");
    if (!trimmed) {
      throw new Error(`node_modules skill path must point to a package: ${rawPath}`);
    }
    const bundledRelativePath = `${GENERATED_BUNDLED_SKILLS_DIR}/${trimmed}`;
    return {
      manifestPath: `./${bundledRelativePath}`,
      outputPath: bundledRelativePath,
    };
  }
  return {
    manifestPath: rawPath,
    outputPath: normalized,
  };
}

function isTransientCopyError(error) {
  return (
    !!error &&
    typeof error === "object" &&
    typeof error.code === "string" &&
    TRANSIENT_COPY_ERROR_CODES.has(error.code)
  );
}

function sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function copySkillPathWithRetry(params) {
  const maxAttempts = COPY_RETRY_DELAYS_MS.length + 1;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      removePathIfExists(params.targetPath);
      fs.mkdirSync(path.dirname(params.targetPath), { recursive: true });
      fs.cpSync(params.sourcePath, params.targetPath, params.copyOptions);
      return;
    } catch (error) {
      if (!isTransientCopyError(error) || attempt === maxAttempts - 1) {
        throw error;
      }
      sleepSync(COPY_RETRY_DELAYS_MS[attempt] ?? 0);
    }
  }
}

function copyDeclaredPluginSkillPaths(params) {
  const skills = Array.isArray(params.manifest.skills) ? params.manifest.skills : [];
  const copiedSkills = [];
  for (const raw of skills) {
    if (typeof raw !== "string" || raw.trim().length === 0) {
      continue;
    }
    const sourcePath = resolveDeclaredSkillSourcePath({
      rawPath: raw,
      pluginDir: params.pluginDir,
      repoRoot: params.repoRoot,
    });
    const target = resolveBundledSkillTarget(raw);
    if (!fs.existsSync(sourcePath)) {
      // Some Docker/lightweight builds intentionally omit optional plugin-local
      // dependencies. Only advertise skill paths that were actually bundled.
      console.warn(
        `[bundled-plugin-metadata] skipping missing skill path ${sourcePath} (plugin ${params.manifest.id ?? path.basename(params.pluginDir)})`,
      );
      continue;
    }
    const targetPath = ensurePathInsideRoot(params.distPluginDir, target.outputPath);
    const shouldExcludeNestedNodeModules = /^node_modules(?:\/|$)/u.test(
      normalizeManifestRelativePath(raw),
    );
    if (shouldExcludeNestedNodeModules) {
      removePathIfExists(
        ensurePathInsideRoot(params.distPluginDir, normalizeManifestRelativePath(raw)),
      );
    }
    copySkillPathWithRetry({
      sourcePath,
      targetPath,
      copyOptions: {
        dereference: true,
        force: true,
        recursive: true,
        filter: (candidatePath) => {
          if (!shouldExcludeNestedNodeModules || candidatePath === sourcePath) {
            return true;
          }
          const relativeCandidate = path.relative(sourcePath, candidatePath).replaceAll("\\", "/");
          return !relativeCandidate.split("/").includes("node_modules");
        },
      },
    });
    copiedSkills.push(target.manifestPath);
  }
  return copiedSkills;
}

/**
 * @param {{
 *   cwd?: string;
 *   repoRoot?: string;
 *   env?: NodeJS.ProcessEnv;
 * }} [params]
 */
export function copyBundledPluginMetadata(params = {}) {
  const repoRoot = params.cwd ?? params.repoRoot ?? process.cwd();
  const env = params.env ?? process.env;
  const extensionsRoot = path.join(repoRoot, "extensions");
  const distExtensionsRoot = path.join(repoRoot, "dist", "extensions");
  if (!fs.existsSync(extensionsRoot)) {
    return;
  }

  const buildablePluginDirs = new Set(
    collectBundledPluginBuildEntries({ cwd: repoRoot, env }).map((entry) => entry.id),
  );
  const generatedChannelConfigsByPlugin = readGeneratedBundledChannelConfigs(repoRoot);
  const sourcePluginDirs = new Set();
  for (const dirent of fs.readdirSync(extensionsRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }

    const pluginDir = path.join(extensionsRoot, dirent.name);
    const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
    const distPluginDir = path.join(distExtensionsRoot, dirent.name);
    const packageJsonPath = path.join(pluginDir, "package.json");
    const packageJson = fs.existsSync(packageJsonPath)
      ? JSON.parse(fs.readFileSync(packageJsonPath, "utf8"))
      : undefined;
    const topLevelPublicSurfaceEntries = collectTopLevelPublicSurfaceEntries(pluginDir);
    if (!shouldCopyBundledPluginMetadata(dirent.name, env, buildablePluginDirs)) {
      removePathIfExists(distPluginDir);
      continue;
    }
    if (!shouldBuildBundledCluster(dirent.name, env, { packageJson })) {
      removePathIfExists(distPluginDir);
      continue;
    }

    const isManifestlessSupportPackage =
      !fs.existsSync(manifestPath) &&
      isManifestlessBundledRuntimeSupportPackage({
        dirName: dirent.name,
        packageJson,
        topLevelPublicSurfaceEntries,
      });

    sourcePluginDirs.add(dirent.name);

    const distManifestPath = path.join(distPluginDir, "openclaw.plugin.json");
    const distPackageJsonPath = path.join(distPluginDir, "package.json");
    if (!fs.existsSync(manifestPath) && !isManifestlessSupportPackage) {
      removePathIfExists(distPluginDir);
      continue;
    }

    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const manifestWithGeneratedChannelConfigs = mergeGeneratedChannelConfigs(
        manifest,
        generatedChannelConfigsByPlugin.get(manifest.id),
      );
      // Generated skill assets live under a dedicated dist-owned directory.
      removePathIfExists(path.join(distPluginDir, GENERATED_BUNDLED_SKILLS_DIR));
      const copiedSkills = copyDeclaredPluginSkillPaths({
        manifest: manifestWithGeneratedChannelConfigs,
        pluginDir,
        distPluginDir,
        repoRoot,
      });
      const bundledManifest = Array.isArray(manifestWithGeneratedChannelConfigs.skills)
        ? { ...manifestWithGeneratedChannelConfigs, skills: copiedSkills }
        : manifestWithGeneratedChannelConfigs;
      writeTextFileIfChanged(distManifestPath, `${JSON.stringify(bundledManifest, null, 2)}\n`);
    } else {
      removeFileIfExists(distManifestPath);
    }

    if (!fs.existsSync(packageJsonPath)) {
      removeFileIfExists(distPackageJsonPath);
      continue;
    }
    if (packageJson.openclaw && "extensions" in packageJson.openclaw) {
      packageJson.openclaw = {
        ...packageJson.openclaw,
        extensions: rewritePackageExtensions(packageJson.openclaw.extensions),
        ...(typeof packageJson.openclaw.setupEntry === "string"
          ? { setupEntry: rewritePackageEntry(packageJson.openclaw.setupEntry) }
          : {}),
      };
    }

    writeTextFileIfChanged(distPackageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
  }

  if (!fs.existsSync(distExtensionsRoot)) {
    return;
  }

  for (const dirent of fs.readdirSync(distExtensionsRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory() || sourcePluginDirs.has(dirent.name)) {
      continue;
    }
    const distPluginDir = path.join(distExtensionsRoot, dirent.name);
    removePathIfExists(distPluginDir);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  copyBundledPluginMetadata();
}
