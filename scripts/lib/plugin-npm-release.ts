import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { normalizeOptionalString } from "../../src/shared/string-coerce.ts";
import { parseReleaseVersion } from "../openclaw-npm-release-check.ts";
import { resolveNpmPublishPlan } from "./npm-publish-plan.mjs";

export type PluginPackageJson = {
  name?: string;
  version?: string;
  private?: boolean;
  openclaw?: {
    extensions?: string[];
    install?: {
      npmSpec?: string;
    };
    release?: {
      publishToNpm?: boolean;
    };
  };
};

export type PublishablePluginPackage = {
  extensionId: string;
  packageDir: string;
  packageName: string;
  version: string;
  channel: "stable" | "beta";
  publishTag: "latest" | "beta";
  installNpmSpec?: string;
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

export type ParsedPluginReleaseArgs = {
  selection: string[];
  selectionMode?: PluginReleaseSelectionMode;
  pluginsFlagProvided: boolean;
  baseRef?: string;
  headRef?: string;
};

export type PublishablePluginPackageCandidate<
  TPackageJson extends PluginPackageJson = PluginPackageJson,
> = {
  extensionId: string;
  packageDir: string;
  packageJson: TPackageJson;
};

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Release helper preserves caller-specific package.json shape.
function readPluginPackageJson<TPackageJson extends PluginPackageJson = PluginPackageJson>(
  path: string,
): TPackageJson {
  return JSON.parse(readFileSync(path, "utf8")) as TPackageJson;
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
        packageJson: readPluginPackageJson<TPackageJson>(packageJsonPath),
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
      `${params.extensionId}: package.json version must match YYYY.M.D, YYYY.M.D-N, or YYYY.M.D-beta.N; found "${version}".`,
    );
    return null;
  }
  return { version, parsedVersion };
}

export function normalizeGitDiffPath(path: string): string {
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
      selection = parsePluginReleaseSelection(argv[index + 1]);
      pluginsFlagProvided = true;
      index += 1;
      continue;
    }
    if (arg === "--selection-mode") {
      selectionMode = parsePluginReleaseSelectionMode(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--base-ref") {
      baseRef = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--head-ref") {
      headRef = argv[index + 1];
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

export function collectPublishablePluginPackageErrors(
  candidate: PublishablePluginPackageCandidate,
): string[] {
  const { packageJson } = candidate;
  const errors: string[] = [];
  const packageName = packageJson.name?.trim() ?? "";
  const packageVersion = packageJson.version?.trim() ?? "";
  const extensions = packageJson.openclaw?.extensions ?? [];

  if (!packageName.startsWith("@openclaw/")) {
    errors.push(
      `package name must start with "@openclaw/"; found "${packageName || "<missing>"}".`,
    );
  }
  if (packageJson.private === true) {
    errors.push("package.json private must not be true.");
  }
  if (!packageVersion) {
    errors.push("package.json version must be non-empty.");
  } else if (parseReleaseVersion(packageVersion) === null) {
    errors.push(
      `package.json version must match YYYY.M.D, YYYY.M.D-N, or YYYY.M.D-beta.N; found "${packageVersion}".`,
    );
  }
  if (!Array.isArray(extensions) || extensions.length === 0) {
    errors.push("openclaw.extensions must contain at least one entry.");
  }
  if (extensions.some((entry) => typeof entry !== "string" || !entry.trim())) {
    errors.push("openclaw.extensions must contain only non-empty strings.");
  }

  return errors;
}

export function collectPublishablePluginPackages(
  rootDir = resolve("."),
): PublishablePluginPackage[] {
  const publishable: PublishablePluginPackage[] = [];
  const validationErrors: string[] = [];

  for (const candidate of collectExtensionPackageJsonCandidates(rootDir)) {
    const { extensionId, packageDir, packageJson } = candidate;
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

    publishable.push({
      extensionId,
      packageDir,
      packageName: packageJson.name!.trim(),
      version,
      channel: parsedVersion.channel,
      publishTag: resolveNpmPublishPlan(version).publishTag,
      installNpmSpec: normalizeOptionalString(packageJson.openclaw?.install?.npmSpec),
    });
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

export function isNullGitRef(ref: string | undefined): boolean {
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

export function isPluginVersionPublished(packageName: string, version: string): boolean {
  const tempDir = mkdtempSync(join(tmpdir(), "openclaw-plugin-npm-view-"));
  const userconfigPath = join(tempDir, "npmrc");
  writeFileSync(userconfigPath, "");

  try {
    execFileSync(
      "npm",
      ["view", `${packageName}@${version}`, "version", "--userconfig", userconfigPath],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return true;
  } catch {
    return false;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function collectPluginReleasePlan(params?: {
  rootDir?: string;
  selection?: string[];
  selectionMode?: PluginReleaseSelectionMode;
  gitRange?: GitRangeSelection;
}): PluginReleasePlan {
  const allPublishable = collectPublishablePluginPackages(params?.rootDir);
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
              changedExtensionIds: collectChangedExtensionIdsFromGitRange({
                rootDir: params.rootDir,
                gitRange: params.gitRange,
              }),
            })
          : allPublishable;

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
