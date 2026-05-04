import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { validateExternalCodePluginPackageJson } from "../../packages/plugin-package-contract/src/index.ts";
import {
  collectExtensionPackageJsonCandidates,
  collectChangedPathsFromGitRange,
  collectChangedExtensionIdsFromPaths,
  collectPublishablePluginPackageErrors,
  parsePluginReleaseArgs,
  resolvePublishablePluginVersion,
  resolveGitCommitSha,
  resolveChangedPublishablePluginPackages,
  resolveSelectedPublishablePluginPackages,
  type GitRangeSelection,
  type PluginReleaseSelectionMode,
} from "./plugin-npm-release.ts";

export { parsePluginReleaseArgs };

type PluginPackageJson = {
  name?: string;
  version?: string;
  private?: boolean;
  openclaw?: {
    extensions?: string[];
    install?: {
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
      publishToClawHub?: boolean;
      publishToNpm?: boolean;
    };
  };
};

export type PublishablePluginPackage = {
  extensionId: string;
  packageDir: string;
  packageName: string;
  version: string;
  channel: "stable" | "alpha" | "beta";
  publishTag: "latest" | "alpha" | "beta";
};

type PluginReleasePlanItem = PublishablePluginPackage & {
  alreadyPublished: boolean;
};

type PluginReleasePlan = {
  all: PluginReleasePlanItem[];
  candidates: PluginReleasePlanItem[];
  skippedPublished: PluginReleasePlanItem[];
};

type ClawHubPackageOwnerDetail = {
  owner?: {
    handle?: unknown;
  } | null;
};

type ClawHubPublishablePluginPackageFilters = {
  extensionIds?: readonly string[];
  packageNames?: readonly string[];
};

const CLAWHUB_DEFAULT_REGISTRY = "https://clawhub.ai";
const SAFE_EXTENSION_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const CLAWHUB_SHARED_RELEASE_INPUT_PATHS = [
  ".github/workflows/plugin-clawhub-release.yml",
  ".github/actions/setup-node-env",
  "package.json",
  "pnpm-lock.yaml",
  "packages/plugin-package-contract/src/index.ts",
  "scripts/lib/npm-publish-plan.mjs",
  "scripts/lib/plugin-npm-release.ts",
  "scripts/lib/plugin-clawhub-release.ts",
  "scripts/plugin-clawhub-owner-preflight.ts",
  "scripts/openclaw-npm-release-check.ts",
  "scripts/plugin-clawhub-publish.sh",
  "scripts/plugin-clawhub-release-check.ts",
  "scripts/plugin-clawhub-release-plan.ts",
] as const;

function getRegistryBaseUrl(explicit?: string) {
  return (
    explicit?.trim() ||
    process.env.CLAWHUB_REGISTRY?.trim() ||
    process.env.CLAWHUB_SITE?.trim() ||
    CLAWHUB_DEFAULT_REGISTRY
  );
}

export function collectClawHubPublishablePluginPackages(
  rootDir = resolve("."),
  filters: ClawHubPublishablePluginPackageFilters = {},
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
    if (packageJson.openclaw?.release?.publishToClawHub !== true) {
      continue;
    }
    if (!SAFE_EXTENSION_ID_RE.test(extensionId)) {
      validationErrors.push(
        `${extensionId}: extension directory name must match ^[a-z0-9][a-z0-9._-]*$ for ClawHub publish.`,
      );
      continue;
    }

    const errors = collectPublishablePluginPackageErrors({
      extensionId,
      packageDir,
      packageJson,
    });
    if (errors.length > 0) {
      validationErrors.push(...errors.map((error) => `${extensionId}: ${error}`));
      continue;
    }
    const contractValidation = validateExternalCodePluginPackageJson(packageJson);
    if (contractValidation.issues.length > 0) {
      validationErrors.push(
        ...contractValidation.issues.map((issue) => `${extensionId}: ${issue.message}`),
      );
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
      packageName,
      version,
      channel: parsedVersion.channel,
      publishTag:
        parsedVersion.channel === "alpha"
          ? "alpha"
          : parsedVersion.channel === "beta"
            ? "beta"
            : "latest",
    });
  }

  if (validationErrors.length > 0) {
    throw new Error(
      `Publishable ClawHub plugin metadata validation failed:\n${validationErrors.map((error) => `- ${error}`).join("\n")}`,
    );
  }

  return publishable.toSorted((left, right) => left.packageName.localeCompare(right.packageName));
}

export function collectPluginClawHubReleasePathsFromGitRange(params: {
  rootDir?: string;
  gitRange: GitRangeSelection;
}): string[] {
  return collectPluginClawHubReleasePathsFromGitRangeForPathspecs(params, ["extensions"]);
}

function collectPluginClawHubRelevantPathsFromGitRange(params: {
  rootDir?: string;
  gitRange: GitRangeSelection;
}): string[] {
  return collectPluginClawHubReleasePathsFromGitRangeForPathspecs(params, [
    "extensions",
    ...CLAWHUB_SHARED_RELEASE_INPUT_PATHS,
  ]);
}

function collectPluginClawHubReleasePathsFromGitRangeForPathspecs(
  params: {
    rootDir?: string;
    gitRange: GitRangeSelection;
  },
  pathspecs: readonly string[],
): string[] {
  return collectChangedPathsFromGitRange({
    rootDir: params.rootDir,
    gitRange: params.gitRange,
    pathspecs,
  });
}

function hasSharedClawHubReleaseInputChanges(changedPaths: readonly string[]) {
  return changedPaths.some((path) =>
    CLAWHUB_SHARED_RELEASE_INPUT_PATHS.some(
      (sharedPath) => path === sharedPath || path.startsWith(`${sharedPath}/`),
    ),
  );
}

export function resolveChangedClawHubPublishablePluginPackages(params: {
  plugins: PublishablePluginPackage[];
  changedPaths: readonly string[];
}): PublishablePluginPackage[] {
  return resolveChangedPublishablePluginPackages({
    plugins: params.plugins,
    changedExtensionIds: collectChangedExtensionIdsFromPaths(params.changedPaths),
  });
}

export function resolveSelectedClawHubPublishablePluginPackages(params: {
  plugins: PublishablePluginPackage[];
  selection?: string[];
  selectionMode?: PluginReleaseSelectionMode;
  gitRange?: GitRangeSelection;
  rootDir?: string;
}): PublishablePluginPackage[] {
  if (params.selectionMode === "all-publishable") {
    return params.plugins;
  }
  if (params.selection && params.selection.length > 0) {
    return resolveSelectedPublishablePluginPackages({
      plugins: params.plugins,
      selection: params.selection,
    });
  }
  if (params.gitRange) {
    const changedPaths = collectPluginClawHubRelevantPathsFromGitRange({
      rootDir: params.rootDir,
      gitRange: params.gitRange,
    });
    if (hasSharedClawHubReleaseInputChanges(changedPaths)) {
      return params.plugins;
    }
    return resolveChangedClawHubPublishablePluginPackages({
      plugins: params.plugins,
      changedPaths,
    });
  }
  return params.plugins;
}

function readPackageManifestAtGitRef(params: {
  rootDir?: string;
  ref: string;
  packageDir: string;
}): PluginPackageJson | null {
  const rootDir = params.rootDir ?? resolve(".");
  const commitSha = resolveGitCommitSha(rootDir, params.ref, "ref");
  try {
    const raw = execFileSync("git", ["show", `${commitSha}:${params.packageDir}/package.json`], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(raw) as PluginPackageJson;
  } catch {
    return null;
  }
}

export function collectClawHubVersionGateErrors(params: {
  plugins: PublishablePluginPackage[];
  gitRange: GitRangeSelection;
  rootDir?: string;
}): string[] {
  const changedPaths = collectPluginClawHubReleasePathsFromGitRange({
    rootDir: params.rootDir,
    gitRange: params.gitRange,
  });
  const changedPlugins = resolveChangedClawHubPublishablePluginPackages({
    plugins: params.plugins,
    changedPaths,
  });

  const errors: string[] = [];
  for (const plugin of changedPlugins) {
    const baseManifest = readPackageManifestAtGitRef({
      rootDir: params.rootDir,
      ref: params.gitRange.baseRef,
      packageDir: plugin.packageDir,
    });
    if (baseManifest?.openclaw?.release?.publishToClawHub !== true) {
      continue;
    }
    const baseVersion =
      typeof baseManifest.version === "string" && baseManifest.version.trim()
        ? baseManifest.version.trim()
        : null;
    if (baseVersion === null || baseVersion !== plugin.version) {
      continue;
    }
    errors.push(
      `${plugin.packageName}@${plugin.version}: changed publishable plugin still has the same version in package.json.`,
    );
  }

  return errors;
}

async function isPluginVersionPublishedOnClawHub(
  packageName: string,
  version: string,
  options: {
    fetchImpl?: typeof fetch;
    registryBaseUrl?: string;
  } = {},
): Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL(
    `/api/v1/packages/${encodeURIComponent(packageName)}/versions/${encodeURIComponent(version)}`,
    getRegistryBaseUrl(options.registryBaseUrl),
  );
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });

  if (response.status === 404) {
    return false;
  }
  if (response.ok) {
    return true;
  }

  throw new Error(
    `Failed to query ClawHub for ${packageName}@${version}: ${response.status} ${response.statusText}`,
  );
}

export async function collectClawHubOpenClawOwnerErrors(params: {
  plugins: readonly Pick<PublishablePluginPackage, "packageName">[];
  requiredOwnerHandle?: string;
  registryBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<string[]> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const requiredOwnerHandle = params.requiredOwnerHandle ?? "openclaw";
  const errors: string[] = [];

  await Promise.all(
    params.plugins.map(async (plugin) => {
      if (!plugin.packageName.startsWith("@openclaw/")) {
        return;
      }

      const url = new URL(
        `/api/v1/packages/${encodeURIComponent(plugin.packageName)}`,
        getRegistryBaseUrl(params.registryBaseUrl),
      );
      const response = await fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      });

      if (response.status === 404) {
        errors.push(
          `${plugin.packageName}: ClawHub package row must already exist under @${requiredOwnerHandle} before OpenClaw release publish.`,
        );
        return;
      }
      if (!response.ok) {
        errors.push(
          `${plugin.packageName}: failed to query ClawHub owner: ${response.status} ${response.statusText}`,
        );
        return;
      }

      const detail = (await response.json()) as ClawHubPackageOwnerDetail;
      const ownerHandle = typeof detail.owner?.handle === "string" ? detail.owner.handle : null;
      if (ownerHandle !== requiredOwnerHandle) {
        errors.push(
          `${plugin.packageName}: ClawHub package owner must be @${requiredOwnerHandle}; got ${ownerHandle ? `@${ownerHandle}` : "<missing>"}.`,
        );
      }
    }),
  );

  return errors.toSorted();
}

export async function collectPluginClawHubReleasePlan(params?: {
  rootDir?: string;
  selection?: string[];
  selectionMode?: PluginReleaseSelectionMode;
  gitRange?: GitRangeSelection;
  registryBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<PluginReleasePlan> {
  const rootDir = params?.rootDir;
  const selection = params?.selection ?? [];
  const changedPaths = params?.gitRange
    ? collectPluginClawHubRelevantPathsFromGitRange({
        rootDir,
        gitRange: params.gitRange,
      })
    : [];
  const sharedInputChanged = hasSharedClawHubReleaseInputChanges(changedPaths);
  const extensionIds =
    params?.selectionMode === "all-publishable" || !params?.gitRange || sharedInputChanged
      ? undefined
      : collectChangedExtensionIdsFromPaths(changedPaths);
  const allPublishable = collectClawHubPublishablePluginPackages(rootDir, {
    extensionIds,
    packageNames: selection.length > 0 ? selection : undefined,
  });
  const selectedPublishable = resolveSelectedClawHubPublishablePluginPackages({
    plugins: allPublishable,
    selection,
    selectionMode: params?.selectionMode,
    gitRange: params?.gitRange,
    rootDir,
  });

  const all = await Promise.all(
    selectedPublishable.map(async (plugin) =>
      Object.assign({}, plugin, {
        alreadyPublished: await isPluginVersionPublishedOnClawHub(
          plugin.packageName,
          plugin.version,
          { registryBaseUrl: params?.registryBaseUrl, fetchImpl: params?.fetchImpl },
        ),
      }),
    ),
  );

  return {
    all,
    candidates: all.filter((plugin) => !plugin.alreadyPublished),
    skippedPublished: all.filter((plugin) => plugin.alreadyPublished),
  };
}
