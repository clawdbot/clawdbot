// Resolves plugin install paths for local and package sources.
import { createHash } from "node:crypto";
import path from "node:path";
import {
  resolveSafeInstallDir,
  safeDirName,
  safePathSegmentHashed,
  unscopedPackageName,
} from "../infra/install-safe-path.js";
import { resolveConfigDir, resolveUserPath } from "../utils.js";

/** Encodes arbitrary input as a safe plugin install filename. */
export function safePluginInstallFileName(input: string): string {
  return safeDirName(input);
}

/** Encodes a plugin id for use as an install directory name. */
export function encodePluginInstallDirName(pluginId: string): string {
  const trimmed = pluginId.trim();
  if (!trimmed.includes("/")) {
    return safeDirName(trimmed);
  }
  // Scoped plugin ids need a reserved on-disk namespace so they cannot collide
  // with valid unscoped ids that happen to match the hashed slug.
  return `@${safePathSegmentHashed(trimmed)}`;
}

/** Validates a plugin id for install path safety. */
export function validatePluginId(pluginId: string): string | null {
  const trimmed = pluginId.trim();
  if (!trimmed) {
    return "invalid plugin name: missing";
  }
  if (trimmed.includes("\\")) {
    return "invalid plugin name: path separators not allowed";
  }
  const segments = trimmed.split("/");
  if (segments.some((segment) => !segment)) {
    return "invalid plugin name: malformed scope";
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return "invalid plugin name: reserved path segment";
  }
  if (segments.length === 1) {
    if (trimmed.startsWith("@")) {
      return "invalid plugin name: scoped ids must use @scope/name format";
    }
    return null;
  }
  if (segments.length !== 2) {
    return "invalid plugin name: path separators not allowed";
  }
  if (!segments[0]?.startsWith("@") || segments[0].length < 2) {
    return "invalid plugin name: scoped ids must use @scope/name format";
  }
  return null;
}

/** Checks whether an installed plugin id matches the expected id, including old npm keying. */
export function matchesExpectedPluginId(params: {
  expectedPluginId?: string;
  pluginId: string;
  manifestPluginId?: string;
  npmPluginId: string;
}): boolean {
  if (!params.expectedPluginId) {
    return true;
  }
  if (params.expectedPluginId === params.pluginId) {
    return true;
  }
  // Backward compatibility: older install records keyed scoped npm packages by
  // their unscoped package name. Preserve update-in-place for those records
  // unless the package declares an explicit manifest id override.
  return (
    !params.manifestPluginId &&
    params.pluginId === params.npmPluginId &&
    params.expectedPluginId === unscopedPackageName(params.npmPluginId)
  );
}

/** Resolves the default directory for path-installed plugin extensions. */
export function resolveDefaultPluginExtensionsDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir?: () => string,
): string {
  return path.join(resolveConfigDir(env, homedir), "extensions");
}

/** Resolves the default directory for managed npm plugin installs. */
export function resolveDefaultPluginNpmDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir?: () => string,
): string {
  return path.join(resolveConfigDir(env, homedir), "npm");
}

/** Encodes an npm package name into a managed npm project directory name. */
function encodePluginNpmProjectDirName(packageName: string): string {
  const trimmed = packageName.trim();
  if (!trimmed) {
    throw new Error("invalid npm package name: missing");
  }
  return safePathSegmentHashed(trimmed);
}

/** Resolves the directory containing managed npm plugin projects. */
export function resolvePluginNpmProjectsDir(npmDir?: string): string {
  const npmBase = npmDir ? resolveUserPath(npmDir) : resolveDefaultPluginNpmDir();
  return path.join(npmBase, "projects");
}

/** Resolves the managed npm project directory for a package name. */
export function resolvePluginNpmProjectDir(params: {
  packageName: string;
  npmDir?: string;
}): string {
  return path.join(
    resolvePluginNpmProjectsDir(params.npmDir),
    encodePluginNpmProjectDirName(params.packageName),
  );
}

const PLUGIN_NPM_GENERATION_PROJECT_SEPARATOR = "__openclaw-generation__";
const PLUGIN_NPM_GENERATION_KEY_HASH_CHARS = 16;

/** Resolves the managed npm artifact-generation project directory prefix for a package. */
export function resolvePluginNpmGenerationProjectDirPrefix(packageName: string): string {
  return `${encodePluginNpmProjectDirName(packageName)}${PLUGIN_NPM_GENERATION_PROJECT_SEPARATOR}`;
}

/** Encodes a package generation fingerprint into a compact project directory suffix. */
function encodePluginNpmGenerationKeyDirName(generationKey: string): string {
  const digest = createHash("sha256").update(generationKey).digest("hex");
  return `g-${digest.slice(0, PLUGIN_NPM_GENERATION_KEY_HASH_CHARS)}`;
}

/** Resolves an artifact-generation-specific managed npm project directory. */
export function resolvePluginNpmGenerationProjectDir(params: {
  packageName: string;
  generationKey: string;
  npmDir?: string;
}): string {
  return path.join(
    resolvePluginNpmProjectsDir(params.npmDir),
    `${resolvePluginNpmGenerationProjectDirPrefix(params.packageName)}${encodePluginNpmGenerationKeyDirName(
      params.generationKey,
    )}`,
  );
}

/** Resolves the installed node_modules package directory for a managed npm plugin. */
export function resolvePluginNpmPackageDir(params: {
  packageName: string;
  npmDir?: string;
}): string {
  return path.join(
    resolvePluginNpmProjectDir(params),
    "node_modules",
    ...params.packageName.split("/"),
  );
}

/** Resolves the default directory for git-installed plugins. */
export function resolveDefaultPluginGitDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir?: () => string,
): string {
  return path.join(resolveConfigDir(env, homedir), "git");
}

/** Resolves the safe install directory for one plugin id. */
export function resolvePluginInstallDir(pluginId: string, extensionsDir?: string): string {
  const extensionsBase = extensionsDir
    ? resolveUserPath(extensionsDir)
    : resolveDefaultPluginExtensionsDir();
  const pluginIdError = validatePluginId(pluginId);
  if (pluginIdError) {
    throw new Error(pluginIdError);
  }
  const targetDirResult = resolveSafeInstallDir({
    baseDir: extensionsBase,
    id: pluginId,
    invalidNameMessage: "invalid plugin name: path traversal detected",
    nameEncoder: encodePluginInstallDirName,
  });
  if (!targetDirResult.ok) {
    throw new Error(targetDirResult.error);
  }
  return targetDirResult.path;
}
