// Plugin Npm Release script supports OpenClaw repository automation.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";
import { validateExternalCodePluginPackageJson } from "../../packages/plugin-package-contract/src/index.ts";
import {
  collectReleaseVersionFloorErrors,
  parseReleaseVersion,
  resolveNpmPublishPlan,
} from "./npm-publish-plan.mjs";

export type PluginPackageJson = {
  name?: string;
  version?: string;
  type?: string;
  private?: boolean;
  dependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
  repository?:
    | string
    | {
        type?: string;
        url?: string;
      };
  openclaw?: {
    extensions?: string[];
    install?: {
      defaultChoice?: string;
      minHostVersion?: string;
      npmSpec?: string;
    };
    compat?: {
      pluginApi?: string;
      minGatewayVersion?: string;
    };
    build?: {
      openclawVersion?: string;
      pluginSdkVersion?: string;
    };
    release?: {
      publishToNpm?: boolean;
      requireLatestDependencies?: unknown;
    };
  };
};

export type RequiredLatestDependency = {
  packageName: string;
  version: string;
};

export type PublishablePluginPackage = {
  extensionId: string;
  packageDir: string;
  packageName: string;
  version: string;
  channel: "stable" | "alpha" | "beta";
  publishTag: "latest" | "alpha" | "beta" | "extended-stable";
  installNpmSpec?: string;
  requiredLatestDependencies?: RequiredLatestDependency[];
};

export type PluginReleasePlanItem = PublishablePluginPackage & {
  alreadyPublished: boolean;
};

export type PluginReleasePlan = {
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

type PublishablePluginPackageCandidate<TPackageJson extends PluginPackageJson = PluginPackageJson> =
  {
    extensionId: string;
    packageDir: string;
    packageJson: TPackageJson;
    readmeText?: string;
  };

export const OPENCLAW_PLUGIN_NPM_REPOSITORY_URL = "https://github.com/openclaw/openclaw";

export function collectRequiredLatestDependencies(packageJson: PluginPackageJson): {
  dependencies: RequiredLatestDependency[];
  errors: string[];
} {
  const configured = packageJson.openclaw?.release?.requireLatestDependencies;
  if (configured === undefined) {
    return { dependencies: [], errors: [] };
  }
  if (!Array.isArray(configured)) {
    return {
      dependencies: [],
      errors: ["openclaw.release.requireLatestDependencies must be an array of package names."],
    };
  }

  const runtimeDependencies = {
    ...packageJson.dependencies,
    ...packageJson.optionalDependencies,
  };
  const dependencies: RequiredLatestDependency[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const value of configured) {
    if (typeof value !== "string" || !value.trim()) {
      errors.push(
        "openclaw.release.requireLatestDependencies must contain only non-empty package names.",
      );
      continue;
    }
    const packageName = value.trim();
    if (seen.has(packageName)) {
      errors.push(
        `openclaw.release.requireLatestDependencies must not contain duplicate package names; found "${packageName}".`,
      );
      continue;
    }
    seen.add(packageName);

    const version = runtimeDependencies[packageName];
    if (typeof version !== "string" || !version.trim()) {
      errors.push(
        `openclaw.release.requireLatestDependencies must reference package.json dependencies or optionalDependencies; "${packageName}" is not a runtime dependency.`,
      );
      continue;
    }
    dependencies.push({ packageName, version: version.trim() });
  }

  return { dependencies, errors };
}

function readPluginPackageJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readOptionalTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export function collectExtensionPackageJsonCandidates<
  TPackageJson extends PluginPackageJson = PluginPackageJson,
>(rootDir = resolve(".")): PublishablePluginPackageCandidate<TPackageJson>[] {
  const extensionsDir = join(rootDir, "extensions");
  const dirs = readdirSync(extensionsDir, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory(),
  );

  const candidates: PublishablePluginPackageCandidate<TPackageJson>[] = [];
  for (const dir of dirs) {
    const packageDir = `extensions/${dir.name}`;
    const absolutePackageDir = join(extensionsDir, dir.name);
    const packageJsonPath = join(absolutePackageDir, "package.json");
    try {
      candidates.push({
        extensionId: dir.name,
        packageDir,
        packageJson: readPluginPackageJson(packageJsonPath) as TPackageJson,
        readmeText: readOptionalTextFile(join(absolutePackageDir, "README.md")),
      });
    } catch {
      continue;
    }
  }

  return candidates;
}

export function resolvePublishablePluginVersion(params: {
  extensionId: string;
  packageJson: Pick<PluginPackageJson, "version">;
  validationErrors: string[];
}): { version: string; parsedVersion: NonNullable<ReturnType<typeof parseReleaseVersion>> } | null {
  const version = params.packageJson.version?.trim() ?? "";
  const parsedVersion = parseReleaseVersion(version);
  if (parsedVersion === null) {
    params.validationErrors.push(
      `${params.extensionId}: package.json version must match YYYY.M.PATCH, YYYY.M.PATCH-N, YYYY.M.PATCH-alpha.N, or YYYY.M.PATCH-beta.N; found "${version}".`,
    );
    return null;
  }
  return { version, parsedVersion };
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
    const arg = argv[index];
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
    const arg = argv[index];
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

export function collectPublishablePluginPackageErrors(
  candidate: PublishablePluginPackageCandidate,
): string[] {
  const { packageJson } = candidate;
  const errors: string[] = [];
  const packageName = packageJson.name?.trim() ?? "";
  const packageVersion = packageJson.version?.trim() ?? "";
  const installNpmSpec = normalizeOptionalString(packageJson.openclaw?.install?.npmSpec);
  const repositoryUrl =
    typeof packageJson.repository === "string"
      ? packageJson.repository.trim()
      : (packageJson.repository?.url?.trim() ?? "");
  const extensions = packageJson.openclaw?.extensions ?? [];
  const requiredLatestDependencies = collectRequiredLatestDependencies(packageJson);

  if (!packageName.startsWith("@openclaw/")) {
    errors.push(
      `package name must start with "@openclaw/"; found "${packageName || "<missing>"}".`,
    );
  }
  if (packageJson.private === true) {
    errors.push("package.json private must not be true.");
  }
  if (packageJson.type !== "module") {
    errors.push('package.json type must be "module" so built .js runtime entries load as ESM.');
  }
  if (!candidate.readmeText?.trim()) {
    errors.push("README.md must exist and contain package documentation.");
  }
  if (repositoryUrl !== OPENCLAW_PLUGIN_NPM_REPOSITORY_URL) {
    errors.push(
      `package.json repository.url must be "${OPENCLAW_PLUGIN_NPM_REPOSITORY_URL}" so npm provenance can validate GitHub trusted publishing; found "${repositoryUrl || "<missing>"}".`,
    );
  }
  if (!packageVersion) {
    errors.push("package.json version must be non-empty.");
  } else if (parseReleaseVersion(packageVersion) === null) {
    errors.push(
      `package.json version must match YYYY.M.PATCH, YYYY.M.PATCH-N, YYYY.M.PATCH-alpha.N, or YYYY.M.PATCH-beta.N; found "${packageVersion}".`,
    );
  }
  if (!Array.isArray(extensions) || extensions.length === 0) {
    errors.push("openclaw.extensions must contain at least one entry.");
  }
  if (extensions.some((entry) => typeof entry !== "string" || !entry.trim())) {
    errors.push("openclaw.extensions must contain only non-empty strings.");
  }
  if (!installNpmSpec) {
    errors.push("openclaw.install.npmSpec must be a non-empty string for publishable plugins.");
  }
  errors.push(...requiredLatestDependencies.errors);
  errors.push(
    ...validateExternalCodePluginPackageJson(packageJson).issues.map((issue) => issue.message),
  );

  return errors;
}

type PublishablePluginPackageFilters = {
  extensionIds?: readonly string[];
  packageNames?: readonly string[];
  npmDistTag?: "extended-stable";
};

export function collectPublishablePluginPackages(
  rootDir = resolve("."),
  filters: PublishablePluginPackageFilters = {},
): PublishablePluginPackage[] {
  const publishable: PublishablePluginPackage[] = [];
  const validationErrors: string[] = [];
  const selectedExtensionIds = new Set(filters.extensionIds ?? []);
  const selectedPackageNames = new Set(filters.packageNames ?? []);
  const hasSelectedExtensionIds = Array.isArray(filters.extensionIds);
  const hasSelectedPackageNames = Array.isArray(filters.packageNames);

  for (const candidate of collectExtensionPackageJsonCandidates(rootDir)) {
    const { extensionId, packageDir, packageJson } = candidate;
    if (hasSelectedExtensionIds && !selectedExtensionIds.has(extensionId)) {
      continue;
    }
    const packageName = packageJson.name?.trim() ?? "";
    if (hasSelectedPackageNames && !selectedPackageNames.has(packageName)) {
      continue;
    }
    if (packageJson.openclaw?.release?.publishToNpm !== true) {
      continue;
    }

    const errors = collectPublishablePluginPackageErrors(candidate);
    if (errors.length > 0) {
      validationErrors.push(...errors.map((error) => `${extensionId}: ${error}`));
      continue;
    }

    const resolvedVersion = resolvePublishablePluginVersion({
      extensionId,
      packageJson,
      validationErrors,
    });
    if (!resolvedVersion) {
      continue;
    }
    const { version, parsedVersion } = resolvedVersion;
    const requiredLatestDependencies = collectRequiredLatestDependencies(packageJson).dependencies;

    publishable.push({
      extensionId,
      packageDir,
      packageName,
      version,
      channel: parsedVersion.channel,
      publishTag: resolveNpmPublishPlan(version, undefined, filters.npmDistTag).publishTag,
      installNpmSpec: normalizeOptionalString(packageJson.openclaw?.install?.npmSpec),
      ...(requiredLatestDependencies.length > 0 ? { requiredLatestDependencies } : {}),
    });
  }

  if (filters.npmDistTag === "extended-stable") {
    const rootPackage = readPluginPackageJson(join(rootDir, "package.json")) as PluginPackageJson;
    const rootVersion = rootPackage.version?.trim() ?? "";
    for (const plugin of publishable) {
      if (plugin.version !== rootVersion) {
        validationErrors.push(
          `${plugin.extensionId}: package version ${plugin.version} must match root package version ${rootVersion || "<missing>"} for extended-stable publication.`,
        );
      }
    }
  }

  if (validationErrors.length > 0) {
    throw new Error(
      `Publishable plugin metadata validation failed:\n${validationErrors.map((error) => `- ${error}`).join("\n")}`,
    );
  }

  return publishable.toSorted((left, right) => left.packageName.localeCompare(right.packageName));
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

function runNpmView(args: string[]): string {
  const tempDir = mkdtempSync(join(tmpdir(), "openclaw-plugin-npm-view-"));
  const userconfigPath = join(tempDir, "npmrc");
  writeFileSync(userconfigPath, "");

  try {
    return execFileSync("npm", ["view", ...args, "--userconfig", userconfigPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
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
  } catch {
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
