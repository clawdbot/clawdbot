// Copies bundled plugin metadata into generated runtime locations.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { collectSourceCheckoutPluginBuildEntries } from "./lib/bundled-plugin-build-entries.mjs";
import { assertRealOutputRoot } from "./lib/output-root-guard.mjs";
import {
  mergeGeneratedChannelConfigs,
  readGeneratedBundledChannelConfigs,
} from "./lib/plugin-npm-package-manifest.mts";
import { isRecord } from "./lib/record-shared.mjs";
import {
  removeFileIfExists,
  removePathIfExists,
  writeTextFileIfChanged,
} from "./runtime-postbuild-shared.mjs";

const GENERATED_BUNDLED_SKILLS_DIR = "bundled-skills";
const TRANSIENT_COPY_ERROR_CODES = new Set(["EEXIST", "ENOENT", "ENOTEMPTY", "EBUSY"]);
const COPY_RETRY_DELAYS_MS = [10, 25, 50];

type CopyMetadataParams = { cwd?: string; repoRoot?: string; env?: NodeJS.ProcessEnv };
type SkillPathParams = {
  distPluginDir: string;
  manifest: Record<string, unknown>;
  pluginDir: string;
  repoRoot: string;
};

function rewritePackageExtensions(entries: unknown, extension: string): string[] | undefined {
  if (!Array.isArray(entries)) {
    return undefined;
  }

  return entries
    .filter((entry) => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => {
      const normalized = entry.replace(/^\.\//, "");
      const rewritten = normalized.replace(/\.[^.]+$/u, extension);
      return `./${rewritten}`;
    });
}

function rewritePackageEntry(entry: unknown, extension: string): string | undefined {
  if (typeof entry !== "string" || entry.trim().length === 0) {
    return undefined;
  }
  const normalized = entry.replace(/^\.\//, "");
  const rewritten = normalized.replace(/\.[^.]+$/u, extension);
  return `./${rewritten}`;
}

function ensurePathInsideRoot(rootDir: string, rawPath: string): string {
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

function normalizeManifestRelativePath(rawPath: string): string {
  return rawPath.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function resolveDeclaredSkillSourcePath(params: {
  pluginDir: string;
  rawPath: string;
  repoRoot: string;
}): string {
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

function resolveBundledSkillTarget(rawPath: string) {
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

function isTransientCopyError(error: unknown): boolean {
  return (
    isRecord(error) && typeof error.code === "string" && TRANSIENT_COPY_ERROR_CODES.has(error.code)
  );
}

function sleepSync(ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function copySkillPathWithRetry(params: {
  copyOptions: fs.CopySyncOptions;
  sourcePath: string;
  targetPath: string;
}): void {
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

function copyDeclaredPluginSkillPaths(params: SkillPathParams): string[] {
  const skills = Array.isArray(params.manifest.skills) ? params.manifest.skills : [];
  const pluginId =
    typeof params.manifest.id === "string" ? params.manifest.id : path.basename(params.pluginDir);
  const copiedSkills: string[] = [];
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
        `[bundled-plugin-metadata] skipping missing skill path ${sourcePath} (plugin ${pluginId})`,
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
        filter: (candidatePath: string) => {
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

function linkSourcePluginDependencies(pluginDir: string, distNodeModules: string) {
  const sourceModules = path.join(pluginDir, "node_modules");
  if (!fs.existsSync(sourceModules)) {
    return;
  }
  const packages = fs.readdirSync(sourceModules).flatMap((name) => {
    if (name.startsWith(".") && name !== ".bin") {
      return [];
    }
    return name.startsWith("@")
      ? fs.readdirSync(path.join(sourceModules, name)).map((child) => path.join(name, child))
      : [name];
  });
  // An outer node_modules junction misresolves pnpm's relative links on Windows.
  // Link canonical package roots individually; keep scopes real and payloads source-owned.
  // Preserve .bin for managed launchers that resolve the plugin's private CLI shim.
  for (const name of packages) {
    const target = path.join(distNodeModules, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const canonical = fs.realpathSync(path.join(sourceModules, name));
    // POSIX release checkouts relocate as a unit; Windows junctions require absolute targets.
    fs.symlinkSync(
      process.platform === "win32" ? canonical : path.relative(path.dirname(target), canonical),
      target,
      "junction",
    );
  }
}

/**
 * Copies bundled plugin metadata and package extension files.
 */
export function copyBundledPluginMetadata(params: CopyMetadataParams = {}): void {
  const repoRoot = params.cwd ?? params.repoRoot ?? process.cwd();
  const env = params.env ?? process.env;
  const extensionsRoot = path.join(repoRoot, "extensions");
  const distExtensionsRoot = path.join(repoRoot, "dist", "extensions");
  if (!fs.existsSync(extensionsRoot)) {
    return;
  }
  // Fail closed before any dist/extensions removal: a symlinked dist root
  // would redirect recursive deletes into the link target.
  assertRealOutputRoot(path.join(repoRoot, "dist"));

  const buildEntries = new Map(
    collectSourceCheckoutPluginBuildEntries({ cwd: repoRoot, env }).map((entry) => [
      entry.id,
      entry,
    ]),
  );
  const generatedChannelConfigsByPlugin = readGeneratedBundledChannelConfigs(repoRoot);
  const sourcePluginDirs = new Set<string>();
  for (const dirent of fs.readdirSync(extensionsRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }

    const pluginDir = path.join(extensionsRoot, dirent.name);
    const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
    const distPluginDir = path.join(distExtensionsRoot, dirent.name);
    const packageJsonPath = path.join(pluginDir, "package.json");
    const parsedPackageJson: unknown = fs.existsSync(packageJsonPath)
      ? JSON.parse(fs.readFileSync(packageJsonPath, "utf8"))
      : undefined;
    const packageJson = isRecord(parsedPackageJson) ? parsedPackageJson : undefined;
    const buildEntry = buildEntries.get(dirent.name);
    if (!buildEntry) {
      removePathIfExists(distPluginDir);
      continue;
    }
    const distNodeModules = path.join(distPluginDir, "node_modules");
    // Remove only dist-owned entries, including an old directory link itself,
    // before skill cleanup or an isolated/unified profile transition.
    fs.rmSync(distNodeModules, { recursive: true, force: true });

    sourcePluginDirs.add(dirent.name);

    const distManifestPath = path.join(distPluginDir, "openclaw.plugin.json");
    const distPackageJsonPath = path.join(distPluginDir, "package.json");

    if (fs.existsSync(manifestPath)) {
      const manifest: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (!isRecord(manifest)) {
        throw new Error(`invalid plugin manifest: ${manifestPath}`);
      }
      const pluginId = typeof manifest.id === "string" ? manifest.id : undefined;
      const mergedManifest = mergeGeneratedChannelConfigs(
        manifest,
        pluginId ? generatedChannelConfigsByPlugin.get(pluginId) : undefined,
      );
      // Generated skill assets live under a dedicated dist-owned directory.
      removePathIfExists(path.join(distPluginDir, GENERATED_BUNDLED_SKILLS_DIR));
      const copiedSkills = copyDeclaredPluginSkillPaths({
        manifest: mergedManifest,
        pluginDir,
        distPluginDir,
        repoRoot,
      });
      const bundledManifest = Array.isArray(mergedManifest.skills)
        ? { ...mergedManifest, skills: copiedSkills }
        : mergedManifest;
      writeTextFileIfChanged(distManifestPath, `${JSON.stringify(bundledManifest, null, 2)}\n`);
    } else {
      removeFileIfExists(distManifestPath);
    }

    if (!fs.existsSync(packageJsonPath)) {
      removeFileIfExists(distPackageJsonPath);
      continue;
    }
    if (packageJson && isRecord(packageJson.openclaw) && "extensions" in packageJson.openclaw) {
      const extension = buildEntry.runtimeExtension;
      packageJson.openclaw = {
        ...packageJson.openclaw,
        extensions: rewritePackageExtensions(packageJson.openclaw.extensions, extension),
        ...(typeof packageJson.openclaw.setupEntry === "string"
          ? { setupEntry: rewritePackageEntry(packageJson.openclaw.setupEntry, extension) }
          : {}),
      };
    }

    writeTextFileIfChanged(distPackageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
    if (buildEntry.isolated) {
      linkSourcePluginDependencies(pluginDir, distNodeModules);
    }
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
