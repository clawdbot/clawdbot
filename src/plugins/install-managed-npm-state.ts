import { randomUUID } from "node:crypto";
import path from "node:path";
import { parseRegistryNpmSpec, validateRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import {
  resolvePluginNpmGenerationProjectDir,
  isPluginNpmProjectDir,
  resolvePluginNpmProjectDir,
} from "./install-paths.js";
import { loadPluginInstallRuntime } from "./install-shared.js";
import {
  hasRetainedManagedNpmInstallMarker,
  retainedManagedNpmInstallPreservesFiles,
} from "./managed-npm-retention.js";
import type { OpenClawPackageManifest } from "./manifest.js";
import { listManagedPluginNpmRoots } from "./npm-project-roots.js";

export function isNpmAliasOverrideCompatibilityError(result: {
  stdout: string;
  stderr: string;
}): boolean {
  return `${result.stderr}\n${result.stdout}`.includes("Invalid comparator: npm:");
}

type ManagedNpmRootPrepareDependencyResult =
  | { ok: true; dependencySpec: string }
  | {
      ok: false;
      error: string;
    };

export type ManagedNpmRootDependencySpecPreparation = (params: {
  npmRoot: string;
}) => Promise<ManagedNpmRootPrepareDependencyResult>;

export async function resolveManagedNpmRootDependencySpecForInstall(params: {
  npmRoot: string;
  packageName: string;
  dependencySpec?: string;
  prepareDependencySpec?: ManagedNpmRootDependencySpecPreparation;
}): Promise<ManagedNpmRootPrepareDependencyResult> {
  if (params.prepareDependencySpec) {
    try {
      return await params.prepareDependencySpec({ npmRoot: params.npmRoot });
    } catch (error) {
      return {
        ok: false,
        error: `Failed to prepare managed npm dependency for ${params.packageName}: ${String(error)}`,
      };
    }
  }
  if (params.dependencySpec === undefined) {
    return {
      ok: false,
      error: `missing managed npm dependency spec for ${params.packageName}`,
    };
  }
  return { ok: true, dependencySpec: params.dependencySpec };
}

export function isManagedNpmProjectCorruptionInstallFailure(result: {
  stdout: string;
  stderr: string;
}): boolean {
  const output = `${result.stderr}\n${result.stdout}`;
  return (
    output.includes("ERR_INVALID_ARG_TYPE") &&
    output.includes('"from" argument') &&
    output.includes("Received undefined")
  );
}

export function resolveManagedNpmRootPackageDir(npmRoot: string, packageName: string): string {
  return path.join(npmRoot, "node_modules", ...packageName.split("/"));
}

export async function resolveManagedNpmInstallTarget(params: {
  runtime: Awaited<ReturnType<typeof loadPluginInstallRuntime>>;
  npmBaseDir: string;
  packageName: string;
  requestedMode: "install" | "update";
}): Promise<{
  npmRoot: string;
  installRoot: string;
  mode: "install" | "update";
  currentArtifactDir?: string;
}> {
  let npmRoot = resolvePluginNpmProjectDir({
    npmDir: params.npmBaseDir,
    packageName: params.packageName,
  });
  // --keep-files preserves its exact path. Ordinary updates replace the canonical
  // project atomically; active plugin graphs already own their captured artifact.
  if (
    retainedManagedNpmInstallPreservesFiles(
      resolveManagedNpmRootPackageDir(npmRoot, params.packageName),
    )
  ) {
    npmRoot = resolvePluginNpmGenerationProjectDir({
      npmDir: params.npmBaseDir,
      packageName: params.packageName,
      generationKey: `keep-files\n${randomUUID()}`,
    });
  }
  let currentArtifactDir: string | undefined;
  if (params.requestedMode === "update") {
    const roots = new Set([npmRoot, ...(await listManagedPluginNpmRoots(params.npmBaseDir))]);
    for (const root of roots) {
      const packageDir = resolveManagedNpmRootPackageDir(root, params.packageName);
      if (
        (root === params.npmBaseDir ||
          isPluginNpmProjectDir({
            npmDir: params.npmBaseDir,
            packageName: params.packageName,
            projectDir: root,
          })) &&
        !hasRetainedManagedNpmInstallMarker(packageDir) &&
        (await params.runtime.fileExists(packageDir))
      ) {
        currentArtifactDir = packageDir;
        break;
      }
    }
  }
  return {
    npmRoot,
    installRoot: resolveManagedNpmRootPackageDir(npmRoot, params.packageName),
    mode: currentArtifactDir ? "update" : "install",
    currentArtifactDir,
  };
}

export function resolveRequiredPlatformPackageNames(
  packageMetadata?: OpenClawPackageManifest,
): { ok: true; packageNames: string[] } | { ok: false; error: string } {
  const raw = packageMetadata?.install?.requiredPlatformPackages as unknown;
  if (raw === undefined) {
    return { ok: true, packageNames: [] };
  }
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error: "package.json openclaw.install.requiredPlatformPackages must be an array",
    };
  }
  const packageNames = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "string") {
      return {
        ok: false,
        error:
          "package.json openclaw.install.requiredPlatformPackages must contain only npm package names",
      };
    }
    const specError = validateRegistryNpmSpec(value);
    const parsed = parseRegistryNpmSpec(value);
    if (specError || !parsed || parsed.selectorKind !== "none") {
      return {
        ok: false,
        error: `package.json openclaw.install.requiredPlatformPackages contains invalid package name: ${value}`,
      };
    }
    packageNames.add(parsed.name);
  }
  return { ok: true, packageNames: [...packageNames] };
}
