import { runPluginUninstallCommand } from "../cli/plugins-uninstall-command.js";
import { normalizeClawHubSha256Integrity } from "../infra/clawhub.js";
import { resolveInstalledClawHubPlugin } from "../plugins/plugin-install-preflight.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import {
  applyClawHubSkillUninstall,
  planClawHubSkillUninstall,
  type ClawHubSkillUninstallPlan,
} from "../skills/lifecycle/clawhub-uninstall.js";
import {
  acquireClawPackageLifecycleLease,
  maintainClawPackageLifecycleLease,
  type MaintainedClawPackageLifecycleLease,
} from "../state/claw-package-lifecycle-lease.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  readClawPackageRefs,
  readClawInstallRecords,
  updateClawPackageRefStatus,
  type PersistedClawInstall,
  type PersistedClawPackageRef,
} from "./provenance.js";

type ClawReferencedCleanupMode = "retain" | "remove-if-unused" | "remove-selected";

export type ClawReferencedCleanup = {
  mode: ClawReferencedCleanupMode;
  selected?: readonly string[];
  allowConflicts?: boolean;
};

export type ClawPackageRemovalDecision = {
  packageRef: PersistedClawPackageRef;
  workspace: string;
  action: "uninstall" | "retain";
  blocked?: boolean;
  allowConflicts?: boolean;
  reason?: string;
  affectedClawAgentIds: string[];
  pluginId?: string;
  skillPlan?: ClawHubSkillUninstallPlan;
};

export type ClawPackageRemovalResult = {
  kind: PersistedClawPackageRef["kind"];
  ref: string;
  version: string;
  action: "uninstalled" | "retained" | "error";
  reason?: string;
};

export type PackageRemovalDeps = {
  readPackageRefs?: typeof readClawPackageRefs;
  readInstallRecords?: typeof readClawInstallRecords;
  claimPackageRef?: typeof updateClawPackageRefStatus;
  resolvePlugin?: typeof resolveInstalledClawHubPlugin;
  planSkill?: typeof planClawHubSkillUninstall;
  uninstallSkill?: typeof applyClawHubSkillUninstall;
  uninstallPlugin?: typeof runPluginUninstallCommand;
  acquirePackageLease?: typeof acquireClawPackageLifecycleLease;
};

type ClawPackageState = "present" | "missing" | "modified" | "ambiguous" | "incomplete";
export type ClawPackageInspection = PersistedClawPackageRef & {
  state: ClawPackageState;
  message?: string;
};

function sameArtifact(left: PersistedClawPackageRef, right: PersistedClawPackageRef): boolean {
  return left.kind === right.kind && left.source === right.source && left.ref === right.ref;
}

function sameVersionedArtifact(
  left: PersistedClawPackageRef,
  right: PersistedClawPackageRef,
): boolean {
  return sameArtifact(left, right) && left.version === right.version;
}

export function clawPackageRemovalSelector(packageRef: PersistedClawPackageRef): string {
  return `${packageRef.kind}:${packageRef.ref}@${packageRef.version}`;
}

function sameRecordedState(left: PersistedClawPackageRef, right: PersistedClawPackageRef): boolean {
  return (
    left.status === right.status &&
    left.relationship === right.relationship &&
    left.origin === right.origin &&
    (left.independentOwner === right.independentOwner ||
      (right.independentOwner && !left.independentOwner))
  );
}

function otherClawAgentIds(params: {
  packageRef: PersistedClawPackageRef;
  workspace: string;
  refs: PersistedClawPackageRef[];
  installs: PersistedClawInstall[];
  statuses?: ReadonlySet<PersistedClawPackageRef["status"]>;
}): string[] {
  return params.refs
    .filter((candidate) => {
      if (
        candidate.agentId === params.packageRef.agentId ||
        !sameArtifact(candidate, params.packageRef) ||
        (params.statuses && !params.statuses.has(candidate.status))
      ) {
        return false;
      }
      if (params.packageRef.kind === "plugin") {
        return true;
      }
      return params.installs.some(
        (install) =>
          install.agentId === candidate.agentId && install.workspace === params.workspace,
      );
    })
    .map((candidate) => candidate.agentId)
    .toSorted();
}

function hasAnotherClawOwner(params: {
  packageRef: PersistedClawPackageRef;
  workspace: string;
  refs: PersistedClawPackageRef[];
  installs: PersistedClawInstall[];
  statuses?: ReadonlySet<PersistedClawPackageRef["status"]>;
}): boolean {
  return otherClawAgentIds(params).length > 0;
}

function ownerInstallIsNewer(
  installedAt: string | number | undefined,
  packageRef: PersistedClawPackageRef,
): boolean {
  const timestamp = typeof installedAt === "number" ? installedAt : Date.parse(installedAt ?? "");
  return Number.isFinite(timestamp) && timestamp > packageRef.updatedAtMs;
}

function pluginIntegrityMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) {
    return false;
  }
  const normalizedActual = normalizeClawHubSha256Integrity(actual);
  const normalizedExpected = normalizeClawHubSha256Integrity(expected);
  return normalizedActual && normalizedExpected
    ? normalizedActual === normalizedExpected
    : actual === expected;
}

export async function inspectClawPackage(
  install: PersistedClawInstall,
  packageRef: PersistedClawPackageRef,
  deps: PackageRemovalDeps = {},
): Promise<ClawPackageInspection> {
  if (packageRef.status !== "complete") {
    return { ...packageRef, state: "incomplete", message: "Package installation is incomplete." };
  }
  if (packageRef.kind === "plugin") {
    const resolution = await (deps.resolvePlugin ?? resolveInstalledClawHubPlugin)({
      clawhubPackage: packageRef.ref,
    });
    if (resolution.status !== "found") {
      return {
        ...packageRef,
        state: resolution.status,
        message:
          resolution.status === "ambiguous"
            ? "Installed plugin identity is ambiguous."
            : "Installed plugin is missing.",
      };
    }
    if (
      resolution.installedVersion !== packageRef.version ||
      !pluginIntegrityMatches(resolution.record.integrity, packageRef.integrity)
    ) {
      return {
        ...packageRef,
        state: "modified",
        message: "Installed plugin version changed after the Claw was added.",
      };
    }
    return {
      ...packageRef,
      independentOwner:
        packageRef.independentOwner ||
        ownerInstallIsNewer(resolution.record.installedAt, packageRef),
      state: "present",
    };
  }
  if (!install.workspace) {
    return {
      ...packageRef,
      state: "ambiguous",
      message: "Skill workspace provenance is missing.",
    };
  }
  const skill = await (deps.planSkill ?? planClawHubSkillUninstall)({
    workspaceDir: install.workspace,
    slug: packageRef.ref,
    expectedVersion: packageRef.version,
  });
  return skill.ok
    ? {
        ...packageRef,
        independentOwner:
          packageRef.independentOwner || ownerInstallIsNewer(skill.plan.installedAt, packageRef),
        state: "present",
      }
    : { ...packageRef, state: skill.code, message: skill.error };
}

export async function planClawPackageRemovals(
  install: PersistedClawInstall,
  packages: PersistedClawPackageRef[],
  options: OpenClawStateDatabaseOptions & {
    deps?: PackageRemovalDeps;
    referencedCleanup?: ClawReferencedCleanup;
  } = {},
): Promise<ClawPackageRemovalDecision[]> {
  const deps = options.deps ?? {};
  const cleanup = options.referencedCleanup ?? { mode: "retain" };
  const selected = new Set(cleanup.selected ?? []);
  const allRefs = (deps.readPackageRefs ?? readClawPackageRefs)(options);
  let cachedInstalls: PersistedClawInstall[] | undefined;
  const allInstalls = (): PersistedClawInstall[] =>
    (cachedInstalls ??= (deps.readInstallRecords ?? readClawInstallRecords)(options));
  const decisions: ClawPackageRemovalDecision[] = [];
  for (const packageRef of packages) {
    const affectedClawAgentIds = otherClawAgentIds({
      packageRef,
      workspace: install.workspace,
      refs: allRefs,
      installs: packageRef.kind === "plugin" || !install.workspace ? [] : allInstalls(),
      statuses: new Set(["pending", "complete"]),
    });
    const retain = (reason: string): void => {
      decisions.push({
        packageRef,
        workspace: install.workspace,
        action: "retain",
        reason,
        affectedClawAgentIds,
      });
    };
    if (packageRef.status !== "complete") {
      retain("Package installation is incomplete.");
      continue;
    }
    const selector = clawPackageRemovalSelector(packageRef);
    const explicitlySelected = cleanup.mode === "remove-selected" && selected.has(selector);
    const managedCleanup = packageRef.relationship === "managed";
    if (explicitlySelected && managedCleanup) {
      decisions.push({
        packageRef,
        workspace: install.workspace,
        action: "retain",
        blocked: true,
        reason: "--remove-referenced only accepts resources with a referenced relationship.",
        affectedClawAgentIds,
      });
      continue;
    }
    if (!managedCleanup && !explicitlySelected && cleanup.mode !== "remove-if-unused") {
      retain("Referenced resources are retained unless a cleanup mode selects them.");
      continue;
    }
    if (!explicitlySelected && affectedClawAgentIds.length > 0) {
      retain("Another Claw still references this package.");
      continue;
    }
    if (
      !explicitlySelected &&
      (packageRef.independentOwner || packageRef.origin === "pre-existing")
    ) {
      retain("Package has a current non-Claw owner or pre-existing origin.");
      continue;
    }

    let pluginId: string | undefined;
    let ownerIsNewer: boolean;
    let skillPlan: ClawHubSkillUninstallPlan | undefined;
    if (packageRef.kind === "plugin") {
      const resolution = await (deps.resolvePlugin ?? resolveInstalledClawHubPlugin)({
        clawhubPackage: packageRef.ref,
      });
      if (resolution.status !== "found") {
        retain(
          resolution.status === "ambiguous"
            ? "Installed plugin identity is ambiguous."
            : "Installed plugin is missing.",
        );
        continue;
      }
      if (
        resolution.installedVersion !== packageRef.version ||
        !pluginIntegrityMatches(resolution.record.integrity, packageRef.integrity)
      ) {
        retain("Installed plugin changed after the Claw was added.");
        continue;
      }
      pluginId = resolution.pluginId;
      ownerIsNewer = ownerInstallIsNewer(resolution.record.installedAt, packageRef);
    } else {
      if (!install.workspace) {
        retain("Skill workspace provenance is missing.");
        continue;
      }
      const skill = await (deps.planSkill ?? planClawHubSkillUninstall)({
        workspaceDir: install.workspace,
        slug: packageRef.ref,
        expectedVersion: packageRef.version,
      });
      if (!skill.ok) {
        retain(skill.error);
        continue;
      }
      skillPlan = skill.plan;
      ownerIsNewer = ownerInstallIsNewer(skill.plan.installedAt, packageRef);
    }

    const independentlyOwned = packageRef.independentOwner || ownerIsNewer;
    const hasConflicts =
      affectedClawAgentIds.length > 0 || independentlyOwned || packageRef.origin === "pre-existing";
    if (!explicitlySelected && hasConflicts) {
      retain(
        affectedClawAgentIds.length > 0
          ? "Another Claw still references this package."
          : "Package has a current non-Claw owner or pre-existing origin.",
      );
      continue;
    }
    if (!explicitlySelected && packageRef.origin !== "claw-introduced") {
      retain("Only Claw-introduced referenced resources qualify for remove-if-unused.");
      continue;
    }
    if (explicitlySelected && hasConflicts && !cleanup.allowConflicts) {
      decisions.push({
        packageRef,
        workspace: install.workspace,
        action: "retain",
        blocked: true,
        reason:
          "Selected resource has other Claw dependents, a non-Claw owner, or pre-existing origin; explicit conflict override is required.",
        affectedClawAgentIds,
        ...(pluginId ? { pluginId } : {}),
        ...(skillPlan ? { skillPlan } : {}),
      });
      continue;
    }
    decisions.push({
      packageRef,
      workspace: install.workspace,
      action: "uninstall",
      ...(explicitlySelected && cleanup.allowConflicts ? { allowConflicts: true } : {}),
      affectedClawAgentIds,
      ...(pluginId ? { pluginId } : {}),
      ...(skillPlan ? { skillPlan } : {}),
    });
  }
  return decisions;
}

type ApplyClawPackageRemovalOptions = OpenClawStateDatabaseOptions & {
  deps?: PackageRemovalDeps;
};

export async function applyClawPackageRemovals(
  decisions: ClawPackageRemovalDecision[],
  options: ApplyClawPackageRemovalOptions = {},
): Promise<ClawPackageRemovalResult[]> {
  if (!decisions.some((decision) => decision.packageRef.kind === "plugin")) {
    return await applyClawPackageRemovalsUnlocked(decisions, options);
  }
  return await withPluginLifecycleLease(
    {
      ...(options.env ? { env: options.env } : {}),
      ...(options.path ? { path: options.path } : {}),
      ...(options.database ? { database: options.database } : {}),
    },
    async () => await applyClawPackageRemovalsUnlocked(decisions, options),
  );
}

async function applyClawPackageRemovalsUnlocked(
  decisions: ClawPackageRemovalDecision[],
  options: ApplyClawPackageRemovalOptions,
): Promise<ClawPackageRemovalResult[]> {
  const deps = options.deps ?? {};
  const results: ClawPackageRemovalResult[] = [];
  for (const decision of decisions) {
    const base = {
      kind: decision.packageRef.kind,
      ref: decision.packageRef.ref,
      version: decision.packageRef.version,
    };
    let packageLease: MaintainedClawPackageLifecycleLease | null = null;
    let claimed = false;
    let externalMutationStarted = false;
    try {
      const leaseArtifact =
        decision.packageRef.kind === "skill"
          ? {
              kind: decision.packageRef.kind,
              source: decision.packageRef.source,
              ref: decision.packageRef.ref,
              workspace: decision.workspace,
            }
          : {
              kind: decision.packageRef.kind,
              source: decision.packageRef.source,
              ref: decision.packageRef.ref,
            };
      const acquiredLease = (deps.acquirePackageLease ?? acquireClawPackageLifecycleLease)(
        leaseArtifact,
        { env: options.env, path: options.path, required: true },
      );
      if (!acquiredLease) {
        throw new Error(
          `Could not acquire package lifecycle lease for ${decision.packageRef.ref}.`,
        );
      }
      packageLease = maintainClawPackageLifecycleLease(acquiredLease);
      const currentRefs = (deps.readPackageRefs ?? readClawPackageRefs)(options);
      const currentInstalls =
        decision.packageRef.kind === "plugin"
          ? []
          : (deps.readInstallRecords ?? readClawInstallRecords)(options);
      const currentRef = currentRefs.find(
        (candidate) =>
          candidate.agentId === decision.packageRef.agentId &&
          sameVersionedArtifact(candidate, decision.packageRef),
      );
      if (decision.blocked) {
        throw new Error(decision.reason ?? "Package cleanup is blocked.");
      }
      if (decision.action === "retain") {
        if (!currentRef || !sameRecordedState(currentRef, decision.packageRef)) {
          throw new Error(
            `Package ${decision.packageRef.ref}@${decision.packageRef.version} ownership changed after removal planning.`,
          );
        }
        if (currentRef.status === "complete") {
          (deps.claimPackageRef ?? updateClawPackageRefStatus)(currentRef, "pending", options);
          claimed = true;
        }
        if (decision.reason === "Another Claw still references this package.") {
          const postClaimRefs = (deps.readPackageRefs ?? readClawPackageRefs)(options);
          const postClaimInstalls =
            decision.packageRef.kind === "plugin"
              ? []
              : (deps.readInstallRecords ?? readClawInstallRecords)(options);
          if (
            !hasAnotherClawOwner({
              packageRef: decision.packageRef,
              workspace: decision.workspace,
              refs: postClaimRefs,
              installs: postClaimInstalls,
              statuses: new Set(["complete"]),
            })
          ) {
            throw new Error(
              `Package ${decision.packageRef.ref}@${decision.packageRef.version} no longer has another surviving Claw owner.`,
            );
          }
        }
        results.push({ ...base, action: "retained", reason: decision.reason });
        continue;
      }
      const sharedPackage = hasAnotherClawOwner({
        packageRef: decision.packageRef,
        workspace: decision.workspace,
        refs: currentRefs,
        installs: currentInstalls,
        statuses: new Set(["complete"]),
      });
      if (
        !currentRef ||
        currentRef.status !== "complete" ||
        !sameRecordedState(currentRef, decision.packageRef) ||
        (sharedPackage && !decision.allowConflicts)
      ) {
        throw new Error(
          `Package ${decision.packageRef.ref}@${decision.packageRef.version} ownership changed after removal planning.`,
        );
      }
      (deps.claimPackageRef ?? updateClawPackageRefStatus)(currentRef, "pending", options);
      claimed = true;
      const postClaimRefs = (deps.readPackageRefs ?? readClawPackageRefs)(options);
      const postClaimInstalls =
        decision.packageRef.kind === "plugin"
          ? []
          : (deps.readInstallRecords ?? readClawInstallRecords)(options);
      const postClaimRef = postClaimRefs.find(
        (candidate) =>
          candidate.agentId === decision.packageRef.agentId &&
          sameVersionedArtifact(candidate, decision.packageRef),
      );
      const postClaimShared = hasAnotherClawOwner({
        packageRef: decision.packageRef,
        workspace: decision.workspace,
        refs: postClaimRefs,
        installs: postClaimInstalls,
        statuses: new Set(["complete"]),
      });
      if (
        !postClaimRef ||
        postClaimRef.status !== "pending" ||
        postClaimRef.relationship !== decision.packageRef.relationship ||
        postClaimRef.origin !== decision.packageRef.origin ||
        (postClaimRef.independentOwner !== decision.packageRef.independentOwner &&
          !decision.packageRef.independentOwner) ||
        (postClaimShared && !decision.allowConflicts)
      ) {
        throw new Error(
          `Package ${decision.packageRef.ref}@${decision.packageRef.version} ownership changed while claiming removal.`,
        );
      }
      if (decision.packageRef.kind === "plugin") {
        if (!decision.pluginId) {
          throw new Error("Plugin removal plan is missing canonical install identity.");
        }
        const resolution = await (deps.resolvePlugin ?? resolveInstalledClawHubPlugin)({
          clawhubPackage: decision.packageRef.ref,
        });
        if (
          resolution.status !== "found" ||
          resolution.pluginId !== decision.pluginId ||
          resolution.installedVersion !== decision.packageRef.version ||
          !pluginIntegrityMatches(resolution.record.integrity, decision.packageRef.integrity) ||
          ownerInstallIsNewer(resolution.record.installedAt, decision.packageRef)
        ) {
          throw new Error(
            `Plugin ${decision.packageRef.ref}@${decision.packageRef.version} changed after removal planning.`,
          );
        }
        externalMutationStarted = true;
        await (deps.uninstallPlugin ?? runPluginUninstallCommand)(decision.pluginId, {
          force: true,
          invalidateRuntimeCache: false,
          clawManaged: true,
        });
      } else {
        if (!decision.skillPlan) {
          throw new Error("Skill removal plan is missing canonical uninstall state.");
        }
        externalMutationStarted = true;
        const removed = await (deps.uninstallSkill ?? applyClawHubSkillUninstall)(
          decision.skillPlan,
        );
        if (!removed.ok) {
          throw new Error(removed.error);
        }
      }
      packageLease.assertCurrent();
      (deps.claimPackageRef ?? updateClawPackageRefStatus)(
        decision.packageRef,
        "complete",
        options,
      );
      results.push({ ...base, action: "uninstalled" });
    } catch (error) {
      if (claimed) {
        try {
          (deps.claimPackageRef ?? updateClawPackageRefStatus)(
            decision.packageRef,
            externalMutationStarted ? "failed" : "complete",
            options,
          );
        } catch {
          // Preserve the original cleanup failure as the actionable result.
        }
      }
      results.push({
        ...base,
        action: "error",
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      try {
        packageLease?.release();
      } catch {
        // Lease expiry recovers cleanup when the shared state database is unavailable.
      }
    }
  }
  return results;
}
