import type { NpmSpecResolution } from "../infra/install-source-utils.js";
import type { ManagedNpmRootInstalledDependency } from "../infra/npm-managed-root.js";

type InstalledNpmResolutionVerification =
  | { kind: "ok" }
  | { kind: "incomplete"; error: string }
  | { kind: "conflict"; error: string };

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
