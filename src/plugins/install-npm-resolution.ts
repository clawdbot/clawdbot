import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { NpmSpecResolution } from "../infra/install-source-utils.js";
import type { ManagedNpmRootInstalledDependency } from "../infra/npm-managed-root.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";

type InstalledNpmResolutionVerification =
  | { kind: "ok" }
  | { kind: "incomplete"; error: string }
  | { kind: "conflict"; error: string };

/** True when npm metadata and the staged manifest identify one exact requested package. */
export function npmPackageIdentityMatchesResolution(params: {
  expectedPackageName: string;
  resolution: NpmSpecResolution;
  manifest: { name?: unknown; version?: unknown } | undefined;
}): boolean {
  const expectedPackageName = normalizeOptionalString(params.expectedPackageName);
  const resolvedName = normalizeOptionalString(params.resolution.name);
  const resolvedVersion = normalizeOptionalString(params.resolution.version);
  const resolvedSpecValue = normalizeOptionalString(params.resolution.resolvedSpec);
  const resolvedSpec = resolvedSpecValue ? parseRegistryNpmSpec(resolvedSpecValue) : null;
  return Boolean(
    expectedPackageName &&
    resolvedName === expectedPackageName &&
    resolvedVersion &&
    resolvedSpec?.name === expectedPackageName &&
    resolvedSpec.selectorKind === "exact-version" &&
    resolvedSpec.selector === resolvedVersion &&
    normalizeOptionalString(params.manifest?.name) === expectedPackageName &&
    normalizeOptionalString(params.manifest?.version) === resolvedVersion,
  );
}

export function verifyInstalledNpmResolution(params: {
  packageName: string;
  expected: NpmSpecResolution;
  installed: ManagedNpmRootInstalledDependency | null;
}): InstalledNpmResolutionVerification {
  if (!params.installed) {
    return {
      kind: "incomplete",
      error: `npm install did not record package-lock metadata for ${params.packageName}`,
    };
  }
  if (params.expected.version && params.installed.version) {
    if (params.installed.version !== params.expected.version) {
      return {
        kind: "conflict",
        error: `npm install resolved ${params.packageName} to version ${params.installed.version}, expected ${params.expected.version}`,
      };
    }
  }
  if (params.expected.integrity && params.installed.integrity) {
    if (params.installed.integrity !== params.expected.integrity) {
      return {
        kind: "conflict",
        error: `npm install resolved ${params.packageName} with integrity ${params.installed.integrity}, expected ${params.expected.integrity}`,
      };
    }
  }
  if (
    (params.expected.version && !params.installed.version) ||
    (params.expected.integrity && !params.installed.integrity)
  ) {
    return {
      kind: "incomplete",
      error: `npm install recorded incomplete package-lock metadata for ${params.packageName}: ${params.expected.version && !params.installed.version ? "version" : "integrity"} missing`,
    };
  }
  return { kind: "ok" };
}
