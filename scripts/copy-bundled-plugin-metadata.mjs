import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import JSON5 from "json5";
import { NON_PACKAGED_BUNDLED_PLUGIN_DIRS } from "./lib/bundled-plugin-build-entries.mjs";
import { shouldBuildBundledCluster } from "./lib/optional-bundled-clusters.mjs";
import {
  removeFileIfExists,
  removePathIfExists,
  writeTextFileIfChanged,
} from "./runtime-postbuild-shared.mjs";

const GENERATED_BUNDLED_SKILLS_DIR = "bundled-skills";
const GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA_PATH =
  "src/config/bundled-channel-config-metadata.generated.ts";
const TRANSIENT_COPY_ERROR_CODES = new Set(["EEXIST", "ENOENT", "ENOTEMPTY", "EBUSY"]);
const COPY_RETRY_DELAYS_MS = [10, 25, 50];

function shouldCopyBundledPluginMetadata(id, env) {
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

function readGeneratedBundledChannelConfigs(repoRoot) {
  const metadataPath = path.join(repoRoot, GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA_PATH);
  if (!fs.existsSync(metadataPath)) {
    return new Map();
  }
  const source = fs.readFileSync(metadataPath, "utf8");
  const match = source.match(
    /export const GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA = ([\s\S]*?) as const;/u,
  );
  if (!match?.[1]) {
    return new Map();
  }
  let entries;
  try {
    entries = JSON5.parse(match[1]);
  } catch {
    return new Map();
  }
  if (!Array.isArray(entries)) {
    return new Map();
  }
  const byPlugin = new Map();
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.pluginId !== "string" ||
      typeof entry.channelId !== "string" ||
      !entry.schema ||
      typeof entry.schema !== "object"
    ) {
      continue;
    }
    const pluginConfigs = byPlugin.get(entry.pluginId) ?? {};
    pluginConfigs[entry.channelId] = {
      schema: entry.schema,
      ...(typeof entry.label === "string" && entry.label ? { label: entry.label } : {}),
      ...(typeof entry.description === "string" && entry.description
        ? { description: entry.description }
        : {}),
      ...(entry.uiHints && typeof entry.uiHints === "object" ? { uiHints: entry.uiHints } : {}),
    };
    byPlugin.set(entry.pluginId, pluginConfigs);
  }
  return byPlugin;
}

function mergeGeneratedChannelConfigs(manifest, generatedChannelConfigs) {
  if (!generatedChannelConfigs || Object.keys(generatedChannelConfigs).length === 0) {
    return manifest;
  }
  const existingChannelConfigs =
    manifest.channelConfigs && typeof manifest.channelConfigs === "object"
      ? manifest.channelConfigs
      : {};
  const channelConfigs = { ...existingChannelConfigs };
  for (const [channelId, generated] of Object.entries(generatedChannelConfigs)) {
    const existing =
      existingChannelConfigs[channelId] && typeof existingChannelConfigs[channelId] === "object"
        ? existingChannelConfigs[channelId]
        : {};
    channelConfigs[channelId] = {
      ...generated,
      ...existing,
      schema: generated.schema,
      ...(generated.uiHints || existing.uiHints
        ? { uiHints: { ...generated.uiHints, ...existing.uiHints } }
        : {}),
      ...(existing.label || generated.label ? { label: existing.label ?? generated.label } : {}),
      ...(existing.description || generated.description
        ? { description: existing.description ?? generated.description }
        : {}),
    };
  }
  return {
    ...manifest,
    channelConfigs,
  };
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
    if (!shouldCopyBundledPluginMetadata(dirent.name, env)) {
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
      // Generated skill assets live under a dedicated dist-owned directory. Runtime
      // dependency staging owns dist plugin node_modules; do not remove it here.
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
