import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";
import { validateExternalCodePluginPackageJson } from "../../packages/plugin-package-contract/src/index.ts";
import { resolveNpmPublishPlan } from "./npm-publish-plan.mjs";
import { parseReleaseVersion } from "./release-version.mjs";

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
      bundledDist?: boolean;
      openclawVersion?: string;
      pluginSdkVersion?: string;
    };
    release?: {
      publishToClawHub?: boolean;
      publishToNpm?: boolean;
      requireLatestDependencies?: unknown;
    };
  };
};

export type PublishablePluginPackageCandidate<
  TPackageJson extends PluginPackageJson = PluginPackageJson,
> = {
  extensionId: string;
  packageDir: string;
  packageJson: TPackageJson;
  readmeText?: string;
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

export type PublishablePluginPackageFilters = {
  extensionIds?: readonly string[];
  packageNames?: readonly string[];
  npmDistTag?: "extended-stable";
  rootVersion?: string;
};

export type PublishablePluginPackageSource = Pick<
  PublishablePluginPackage,
  "extensionId" | "packageDir" | "packageName"
>;

export const OPENCLAW_PLUGIN_NPM_REPOSITORY_URL = "https://github.com/openclaw/openclaw";
const SAFE_CLAWHUB_EXTENSION_ID = /^[a-z0-9][a-z0-9._-]*$/;

/** Explicit core ownership defers staged external publication until the plugin is externalized. */
export function isPluginExternalPublicationDeferred(packageJson: {
  openclaw?: { build?: { bundledDist?: unknown } };
}): boolean {
  return packageJson.openclaw?.build?.bundledDist === true;
}

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

export function collectConflictingPluginPackageSourceErrors(
  sources: readonly PublishablePluginPackageSource[],
): string[] {
  const sourcesByPackageName = new Map<string, Map<string, PublishablePluginPackageSource>>();
  for (const source of sources) {
    const packageName = source.packageName.trim();
    if (!packageName) {
      continue;
    }
    const packageSources = sourcesByPackageName.get(packageName) ?? new Map();
    packageSources.set(`${source.extensionId}\0${source.packageDir}`, source);
    sourcesByPackageName.set(packageName, packageSources);
  }

  return [...sourcesByPackageName.entries()]
    .flatMap(([packageName, packageSources]) => {
      if (packageSources.size < 2) {
        return [];
      }
      const descriptions = [...packageSources.values()]
        .map((source) => `${source.extensionId} (${source.packageDir})`)
        .toSorted();
      return [
        `package ${packageName} is declared by multiple plugin sources: ${descriptions.join(", ")}.`,
      ];
    })
    .toSorted();
}

export function assertUniquePublishablePluginPackageSources(
  sources: readonly PublishablePluginPackageSource[],
  label: string,
): void {
  const errors = collectConflictingPluginPackageSourceErrors(sources);
  if (errors.length === 0) {
    return;
  }
  throw new Error(`${label} has conflicting plugin package provenance:\n${errors.join("\n")}`);
}

export function collectPublishablePluginPackagesFromCandidates(
  candidates: readonly PublishablePluginPackageCandidate[],
  target: "npm" | "clawhub",
  filters: PublishablePluginPackageFilters = {},
): PublishablePluginPackage[] {
  const publishable: PublishablePluginPackage[] = [];
  const validationErrors: string[] = [];
  const selectedExtensionIds = new Set(filters.extensionIds ?? []);
  const selectedPackageNames = new Set(filters.packageNames ?? []);
  const hasSelectedExtensionIds = Array.isArray(filters.extensionIds);
  const hasSelectedPackageNames = Array.isArray(filters.packageNames);

  validationErrors.push(
    ...collectConflictingPluginPackageSourceErrors(
      candidates
        .filter(
          (candidate) =>
            !isPluginExternalPublicationDeferred(candidate.packageJson) &&
            (candidate.packageJson.openclaw?.release?.publishToNpm === true ||
              candidate.packageJson.openclaw?.release?.publishToClawHub === true),
        )
        .map((candidate) => ({
          extensionId: candidate.extensionId,
          packageDir: candidate.packageDir,
          packageName: candidate.packageJson.name?.trim() ?? "",
        })),
    ),
  );

  for (const candidate of candidates) {
    const { extensionId, packageDir, packageJson } = candidate;
    if (hasSelectedExtensionIds && !selectedExtensionIds.has(extensionId)) {
      continue;
    }
    const packageName = packageJson.name?.trim() ?? "";
    if (hasSelectedPackageNames && !selectedPackageNames.has(packageName)) {
      continue;
    }
    if (isPluginExternalPublicationDeferred(packageJson)) {
      continue;
    }
    const enabled =
      target === "npm"
        ? packageJson.openclaw?.release?.publishToNpm === true
        : packageJson.openclaw?.release?.publishToClawHub === true;
    if (!enabled) {
      continue;
    }
    if (target === "clawhub" && !SAFE_CLAWHUB_EXTENSION_ID.test(extensionId)) {
      validationErrors.push(
        `${extensionId}: extension directory name must match ^[a-z0-9][a-z0-9._-]*$ for ClawHub publish.`,
      );
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
    const publishTag =
      target === "npm"
        ? resolveNpmPublishPlan(version, undefined, filters.npmDistTag).publishTag
        : parsedVersion.channel === "alpha"
          ? "alpha"
          : parsedVersion.channel === "beta"
            ? "beta"
            : "latest";

    publishable.push({
      extensionId,
      packageDir,
      packageName,
      version,
      channel: parsedVersion.channel,
      publishTag,
      ...(target === "npm"
        ? { installNpmSpec: normalizeOptionalString(packageJson.openclaw?.install?.npmSpec) }
        : {}),
      ...(requiredLatestDependencies.length > 0 ? { requiredLatestDependencies } : {}),
    });
  }

  if (target === "npm" && filters.npmDistTag === "extended-stable") {
    const rootVersion = filters.rootVersion?.trim() ?? "";
    for (const plugin of publishable) {
      if (plugin.version !== rootVersion) {
        validationErrors.push(
          `${plugin.extensionId}: package version ${plugin.version} must match root package version ${rootVersion || "<missing>"} for extended-stable publication.`,
        );
      }
    }
  }

  if (validationErrors.length > 0) {
    const label =
      target === "clawhub"
        ? "Publishable ClawHub plugin metadata validation failed"
        : "Publishable plugin metadata validation failed";
    throw new Error(`${label}:\n${validationErrors.map((error) => `- ${error}`).join("\n")}`);
  }

  return publishable.toSorted((left, right) => left.packageName.localeCompare(right.packageName));
}
