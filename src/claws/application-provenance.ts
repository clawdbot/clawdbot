import { stableStringify } from "@openclaw/normalization-core";
import { clawProfileExtensionPackages } from "./application-plan.js";
import type { PersistedClawPackageRef } from "./provenance.js";
import type {
  ClawAddPlanAction,
  ClawDiagnostic,
  ClawManifest,
  ClawOpenClawProfile,
  ClawPackage,
  ClawPackagePreflight,
  ClawPackagePreflightResult,
} from "./types.js";

export function isApplicationUpdateBlocker(entry: ClawDiagnostic): boolean {
  return (
    entry.code !== "workspace_collision" &&
    entry.code !== "agent_id_collision" &&
    !entry.path.startsWith("$.packages")
  );
}

export function clawPackageKey(value: Pick<ClawPackage, "kind" | "ref">): string {
  return `${value.kind}:${value.ref}`;
}

export function recordingClawPackagePreflight(
  preflight: ClawPackagePreflight | undefined,
  workspace: string,
  results: Map<string, ClawPackagePreflightResult>,
): ClawPackagePreflight {
  return async (pkg) => {
    const result = preflight
      ? await preflight(pkg, workspace)
      : {
          ok: false as const,
          code: "package_install_unavailable",
          message: "Package preflight is unavailable.",
        };
    results.set(clawPackageKey(pkg), result);
    return result;
  };
}

export function clawTargetPackages(
  manifest: ClawManifest,
  profile: ClawOpenClawProfile | undefined,
) {
  return new Map(
    [...manifest.packages, ...clawProfileExtensionPackages(profile)].map(
      (pkg) => [clawPackageKey(pkg), pkg] as const,
    ),
  );
}

export function clawWorkspaceActionsById(actions: ClawAddPlanAction[]) {
  return new Map(
    actions
      .filter((action) => action.kind === "workspaceFile")
      .map((action) => [action.id, action] as const),
  );
}

export function clawPackageActionsById(actions: ClawAddPlanAction[]) {
  return new Map(
    actions
      .filter((action) => action.kind === "package")
      .map((action) => [action.id, action] as const),
  );
}

export function clawExtensionProvenanceChanged(
  current: PersistedClawPackageRef["extension"],
  target: ClawAddPlanAction | undefined,
): boolean {
  return stableStringify(current ?? null) !== stableStringify(target?.details?.extension ?? null);
}
