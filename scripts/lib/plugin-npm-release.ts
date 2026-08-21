// Plugin Npm Release script supports OpenClaw repository automation.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectDefined } from "../../packages/normalization-core/src/expect.js";
import { collectExtensionPackageJsonCandidates } from "./plugin-publication-candidates.ts";
import {
  collectPublishablePluginPackagesFromCandidates,
  type PluginPackageJson,
  type PublishablePluginPackage,
  type PublishablePluginPackageFilters,
} from "./plugin-publication-collector.ts";
import { collectReleaseVersionFloorErrors } from "./release-version.mjs";

export {
  collectPublishablePluginPackageErrors,
  collectRequiredLatestDependencies,
  isPluginExternalPublicationDeferred,
  OPENCLAW_PLUGIN_NPM_REPOSITORY_URL,
  resolvePublishablePluginVersion,
} from "./plugin-publication-collector.ts";
export { collectExtensionPackageJsonCandidates } from "./plugin-publication-candidates.ts";
export type {
  PublishablePluginPackage,
  RequiredLatestDependency,
} from "./plugin-publication-collector.ts";

type PluginReleasePlanItem = PublishablePluginPackage & {
  alreadyPublished: boolean;
};

type PluginReleasePlan = {
  all: PluginReleasePlanItem[];
  candidates: PluginReleasePlanItem[];
  skippedPublished: PluginReleasePlanItem[];
};

export type PluginReleaseSelectionMode = "selected" | "all-publishable";

export type GitRangeSelection = {
  baseRef: string;
  headRef: string;
};

type ParsedPluginReleaseArgs = {
  selection: string[];
  selectionMode?: PluginReleaseSelectionMode;
  pluginsFlagProvided: boolean;
  baseRef?: string;
  headRef?: string;
};

type ParsedPluginNpmReleaseArgs = ParsedPluginReleaseArgs & {
  npmDistTag?: "extended-stable";
};

function parsePluginNpmDistTagOverride(value: string | undefined): "extended-stable" | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  if (value === "extended-stable") {
    return value;
  }
  throw new Error(`Unknown npm dist-tag override: ${value}. Expected "extended-stable".`);
}

const PLUGIN_NPM_VIEW_TIMEOUT_MS = 60_000;

function readPluginPackageJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function normalizeGitDiffPath(path: string): string {
  return path.trim().replaceAll("\\", "/");
}

export function parsePluginReleaseSelection(value: string | undefined): string[] {
  if (!value?.trim()) {
    return [];
  }

  return [
    ...new Set(
      value
        .split(/[,\s]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ].toSorted();
}

export function parsePluginReleaseSelectionMode(
  value: string | undefined,
): PluginReleaseSelectionMode {
  if (value === "selected" || value === "all-publishable") {
    return value;
  }

  throw new Error(
    `Unknown selection mode: ${value ?? "<missing>"}. Expected "selected" or "all-publishable".`,
  );
}

export function parsePluginReleaseArgs(argv: string[]): ParsedPluginReleaseArgs {
  let selection: string[] = [];
  let selectionMode: PluginReleaseSelectionMode | undefined;
  let pluginsFlagProvided = false;
  let baseRef: string | undefined;
  let headRef: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = expectDefined(argv[index], `plugin release argument at index ${index}`);
    if (arg === "--") {
      continue;
    }
    if (arg === "--plugins") {
      selection = parsePluginReleaseSelection(readRequiredArgValue(argv, index, arg, true));
      pluginsFlagProvided = true;
      index += 1;
      continue;
    }
    if (arg === "--selection-mode") {
      selectionMode = parsePluginReleaseSelectionMode(readRequiredArgValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--base-ref") {
      baseRef = readRequiredArgValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--head-ref") {
      headRef = readRequiredArgValue(argv, index, arg);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (pluginsFlagProvided && selection.length === 0) {
    throw new Error("`--plugins` must include at least one package name.");
  }
  if (selectionMode === "selected" && !pluginsFlagProvided) {
    throw new Error("`--selection-mode selected` requires `--plugins`.");
  }
  if (selectionMode === "all-publishable" && pluginsFlagProvided) {
    throw new Error("`--selection-mode all-publishable` must not be combined with `--plugins`.");
  }
  if (selection.length > 0 && (baseRef || headRef)) {
    throw new Error("Use either --plugins or --base-ref/--head-ref, not both.");
  }
  if (selectionMode && (baseRef || headRef)) {
    throw new Error("Use either --selection-mode or --base-ref/--head-ref, not both.");
  }
  if ((baseRef && !headRef) || (!baseRef && headRef)) {
    throw new Error("Both --base-ref and --head-ref are required together.");
  }
  return { selection, selectionMode, pluginsFlagProvided, baseRef, headRef };
}

export function parsePluginNpmReleaseArgs(argv: string[]): ParsedPluginNpmReleaseArgs {
  const baseArgs: string[] = [];
  let npmDistTag: "extended-stable" | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = expectDefined(argv[index], `plugin npm release argument at index ${index}`);
    if (arg !== "--npm-dist-tag") {
      baseArgs.push(arg);
      continue;
    }
    if (npmDistTag !== undefined) {
      throw new Error("--npm-dist-tag must not be provided more than once.");
    }
    npmDistTag = parsePluginNpmDistTagOverride(readRequiredArgValue(argv, index, arg));
    index += 1;
  }
  const parsed = parsePluginReleaseArgs(baseArgs);
  if (npmDistTag === "extended-stable" && parsed.selectionMode !== "all-publishable") {
    throw new Error(
      "extended-stable requires --selection-mode all-publishable without an explicit plugin list.",
    );
  }
  return { ...parsed, npmDistTag };
}

function readRequiredArgValue(
  argv: string[],
  index: number,
  flag: string,
  allowBlank = false,
): string {
  const value = argv[index + 1];
  const missingValue =
    value === undefined || value.startsWith("--") || (!allowBlank && value.trim() === "");
  if (missingValue) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

export function collectPublishablePluginPackages(
  rootDir = resolve("."),
  filters: PublishablePluginPackageFilters = {},
): PublishablePluginPackage[] {
  const rootVersion =
    filters.npmDistTag === "extended-stable"
      ? ((
          readPluginPackageJson(join(rootDir, "package.json")) as PluginPackageJson
        ).version?.trim() ?? "")
      : undefined;
  return collectPublishablePluginPackagesFromCandidates(
    collectExtensionPackageJsonCandidates(rootDir),
    "npm",
    { ...filters, rootVersion },
  );
}

export function resolveSelectedPublishablePluginPackages(params: {
  plugins: PublishablePluginPackage[];
  selection: string[];
}): PublishablePluginPackage[] {
  if (params.selection.length === 0) {
    return params.plugins;
  }

  const byName = new Map(params.plugins.map((plugin) => [plugin.packageName, plugin]));
  const selected: PublishablePluginPackage[] = [];
  const missing: string[] = [];

  for (const packageName of params.selection) {
    const plugin = byName.get(packageName);
    if (!plugin) {
      missing.push(packageName);
      continue;
    }
    selected.push(plugin);
  }

  if (missing.length > 0) {
    throw new Error(`Unknown or non-publishable plugin package selection: ${missing.join(", ")}.`);
  }

  return selected;
}

export function collectChangedExtensionIdsFromPaths(paths: readonly string[]): string[] {
  const extensionIds = new Set<string>();

  for (const path of paths) {
    const normalized = path.trim().replaceAll("\\", "/");
    const match = /^extensions\/([^/]+)\//.exec(normalized);
    if (match?.[1]) {
      extensionIds.add(match[1]);
    }
  }

  return [...extensionIds].toSorted();
}

function isNullGitRef(ref: string | undefined): boolean {
  return !ref || /^0+$/.test(ref);
}

function assertSafeGitRef(ref: string, label: string): string {
  const trimmed = ref.trim();
  if (!trimmed || isNullGitRef(trimmed)) {
    throw new Error(`${label} is required.`);
  }
  if (
    trimmed.startsWith("-") ||
    trimmed.includes("\u0000") ||
    trimmed.includes("\r") ||
    trimmed.includes("\n")
  ) {
    throw new Error(`${label} must be a normal git ref or commit SHA.`);
  }
  return trimmed;
}

export function resolveGitCommitSha(rootDir: string, ref: string, label: string): string {
  const safeRef = assertSafeGitRef(ref, label);
  try {
    return execFileSync("git", ["rev-parse", "--verify", "--quiet", `${safeRef}^{commit}`], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error(`${label} is not a valid git commit ref: ${safeRef}`);
  }
}

export function collectChangedPathsFromGitRange(params: {
  rootDir?: string;
  gitRange: GitRangeSelection;
  pathspecs: readonly string[];
}): string[] {
  const rootDir = params.rootDir ?? resolve(".");
  const { baseRef, headRef } = params.gitRange;

  if (isNullGitRef(baseRef) || isNullGitRef(headRef)) {
    return [];
  }

  const baseSha = resolveGitCommitSha(rootDir, baseRef, "baseRef");
  const headSha = resolveGitCommitSha(rootDir, headRef, "headRef");

  return execFileSync(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMR", baseSha, headSha, "--", ...params.pathspecs],
    {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((path) => normalizeGitDiffPath(path));
}

export function collectChangedExtensionIdsFromGitRange(params: {
  rootDir?: string;
  gitRange: GitRangeSelection;
}): string[] {
  return collectChangedExtensionIdsFromPaths(
    collectChangedPathsFromGitRange({
      rootDir: params.rootDir,
      gitRange: params.gitRange,
      pathspecs: ["extensions"],
    }),
  );
}

export function resolveChangedPublishablePluginPackages(params: {
  plugins: PublishablePluginPackage[];
  changedExtensionIds: readonly string[];
}): PublishablePluginPackage[] {
  if (params.changedExtensionIds.length === 0) {
    return [];
  }

  const changed = new Set(params.changedExtensionIds);
  return params.plugins.filter((plugin) => changed.has(plugin.extensionId));
}

export function collectPluginReleaseVersionFloorErrors(
  plugins: readonly Pick<PublishablePluginPackage, "packageName" | "version">[],
): string[] {
  return plugins.flatMap((plugin) =>
    collectReleaseVersionFloorErrors(plugin.version).map(
      (error) => `${plugin.packageName}@${plugin.version}: ${error}`,
    ),
  );
}

export function assertPluginReleaseVersionFloors(
  plugins: readonly Pick<PublishablePluginPackage, "packageName" | "version">[],
  label: string,
): void {
  const errors = collectPluginReleaseVersionFloorErrors(plugins);
  if (errors.length === 0) {
    return;
  }
  throw new Error(
    `${label} rejected plugin versions below the release floor:\n${errors
      .map((error) => `- ${error}`)
      .join("\n")}`,
  );
}

export type NpmLatestVersionResolver = (packageName: string) => string;

function isNpmViewTimeoutError(error: unknown): error is Error & { code: "ETIMEDOUT" } {
  return error instanceof Error && "code" in error && error.code === "ETIMEDOUT";
}

function runNpmView(args: string[]): string {
  const tempDir = mkdtempSync(join(tmpdir(), "openclaw-plugin-npm-view-"));
  const userconfigPath = join(tempDir, "npmrc");
  writeFileSync(userconfigPath, "");

  try {
    try {
      return execFileSync("npm", ["view", ...args, "--userconfig", userconfigPath], {
        encoding: "utf8",
        killSignal: "SIGKILL",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: PLUGIN_NPM_VIEW_TIMEOUT_MS,
      }).trim();
    } catch (error) {
      if (isNpmViewTimeoutError(error)) {
        throw Object.assign(
          new Error(`npm view timed out after ${PLUGIN_NPM_VIEW_TIMEOUT_MS}ms.`, {
            cause: error,
          }),
          { code: "ETIMEDOUT" as const },
        );
      }
      throw error;
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function resolveNpmLatestVersion(packageName: string): string {
  const raw = runNpmView([packageName, "dist-tags.latest", "--json"]);
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "string" || !parsed.trim()) {
    throw new Error(`npm returned an invalid latest dist-tag for ${packageName}.`);
  }
  return parsed.trim();
}

export function collectPluginReleaseDependencyFreshnessErrors(
  plugins: readonly PublishablePluginPackage[],
  resolveLatestVersion: NpmLatestVersionResolver = resolveNpmLatestVersion,
): string[] {
  // Only plugin-owned opt-ins use this strict gate. It prevents release branches
  // from silently carrying old executable pins while leaving normal dependencies alone.
  const latestVersions = new Map<string, string>();
  const errors: string[] = [];

  for (const plugin of plugins) {
    for (const dependency of plugin.requiredLatestDependencies ?? []) {
      let latestVersion = latestVersions.get(dependency.packageName);
      if (!latestVersion) {
        try {
          latestVersion = resolveLatestVersion(dependency.packageName);
          latestVersions.set(dependency.packageName, latestVersion);
        } catch (error) {
          errors.push(
            `${plugin.packageName}@${plugin.version}: could not resolve npm latest for ${dependency.packageName}: ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }
      }
      if (dependency.version !== latestVersion) {
        errors.push(
          `${plugin.packageName}@${plugin.version}: ${dependency.packageName} must match npm latest for release; found "${dependency.version}", latest is "${latestVersion}".`,
        );
      }
    }
  }

  return errors;
}

export function assertPluginReleaseDependencyFreshness(
  plugins: readonly PublishablePluginPackage[],
  label: string,
  resolveLatestVersion: NpmLatestVersionResolver = resolveNpmLatestVersion,
): void {
  const errors = collectPluginReleaseDependencyFreshnessErrors(plugins, resolveLatestVersion);
  if (errors.length === 0) {
    return;
  }
  throw new Error(
    `${label} rejected stale required release dependencies:\n${errors
      .map((error) => `- ${error}`)
      .join("\n")}`,
  );
}

function isPluginVersionPublished(packageName: string, version: string): boolean {
  try {
    runNpmView([`${packageName}@${version}`, "version"]);
    return true;
  } catch (error) {
    if (isNpmViewTimeoutError(error)) {
      throw error;
    }
    return false;
  }
}

export function collectPluginReleasePlan(params?: {
  rootDir?: string;
  selection?: string[];
  selectionMode?: PluginReleaseSelectionMode;
  gitRange?: GitRangeSelection;
  npmDistTag?: "extended-stable";
}): PluginReleasePlan {
  const changedExtensionIds = params?.gitRange
    ? collectChangedExtensionIdsFromGitRange({
        rootDir: params.rootDir,
        gitRange: params.gitRange,
      })
    : [];
  const allPublishable = collectPublishablePluginPackages(params?.rootDir, {
    extensionIds:
      params?.selectionMode === "all-publishable" || !params?.gitRange
        ? undefined
        : changedExtensionIds,
    packageNames: params?.selection && params.selection.length > 0 ? params.selection : undefined,
    npmDistTag: params?.npmDistTag,
  });
  const selectedPublishable =
    params?.selectionMode === "all-publishable"
      ? allPublishable
      : params?.selection && params.selection.length > 0
        ? resolveSelectedPublishablePluginPackages({
            plugins: allPublishable,
            selection: params.selection,
          })
        : params?.gitRange
          ? resolveChangedPublishablePluginPackages({
              plugins: allPublishable,
              changedExtensionIds,
            })
          : allPublishable;

  const explicitPublishSelection =
    params?.selectionMode !== undefined || (params?.selection?.length ?? 0) > 0;
  if (explicitPublishSelection) {
    assertPluginReleaseVersionFloors(selectedPublishable, "Plugin NPM release plan");
  }
  assertPluginReleaseDependencyFreshness(selectedPublishable, "Plugin NPM release plan");

  const all = selectedPublishable.map((plugin) =>
    Object.assign({}, plugin, {
      alreadyPublished: isPluginVersionPublished(plugin.packageName, plugin.version),
    }),
  );

  return {
    all,
    candidates: all.filter((plugin) => !plugin.alreadyPublished),
    skippedPublished: all.filter((plugin) => plugin.alreadyPublished),
  };
}
