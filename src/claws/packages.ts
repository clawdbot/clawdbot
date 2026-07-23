import { runPluginInstallCommand } from "../cli/plugins-install-command.js";
import { runPluginUninstallCommand } from "../cli/plugins-uninstall-command.js";
import { normalizeClawHubSha256Integrity } from "../infra/clawhub.js";
import { installPluginFromClawHub } from "../plugins/clawhub.js";
import {
  preflightPluginInstall,
  resolveInstalledClawHubPlugin,
} from "../plugins/plugin-install-preflight.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { installSkillFromClawHub, preflightSkillFromClawHub } from "../skills/lifecycle/clawhub.js";
import {
  acquireClawPackageLifecycleLease,
  maintainClawPackageLifecycleLease,
  type MaintainedClawPackageLifecycleLease,
} from "../state/claw-package-lifecycle-lease.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  persistClawPackageRef,
  readClawPackageRefs,
  updateClawPackageRefStatus,
  type PersistedClawPackageRef,
} from "./provenance.js";
import type { ClawAddPlan, ClawAddPlanAction, ClawPackage, ResolvedClawPackage } from "./types.js";

export class ClawPackageInstallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly installedPackages: PersistedClawPackageRef[],
  ) {
    super(message);
    this.name = "ClawPackageInstallError";
  }
}

type PackageInstallerDeps = {
  installPlugin?: typeof runPluginInstallCommand;
  uninstallPlugin?: typeof runPluginUninstallCommand;
  probePlugin?: typeof installPluginFromClawHub;
  installSkill?: typeof installSkillFromClawHub;
  preflightPlugin?: typeof preflightPluginInstall;
  preflightSkill?: typeof preflightSkillFromClawHub;
  persistPackageRef?: typeof persistClawPackageRef;
  completePackageRef?: typeof updateClawPackageRefStatus;
  readPackageRefs?: typeof readClawPackageRefs;
  acquirePackageLease?: typeof acquireClawPackageLifecycleLease;
  resolvePlugin?: typeof resolveInstalledClawHubPlugin;
};

type PlannedClawPackage = ResolvedClawPackage & {
  ownerAction: "install" | "reuse";
  installId?: string;
  riskWarning?: string;
};
function packageFromAction(action: ClawAddPlanAction): PlannedClawPackage {
  const details = action.details as
    | (Partial<ResolvedClawPackage> & {
        ownerAction?: "install" | "reuse";
        installId?: string;
        riskWarning?: string;
      })
    | undefined;
  if (details?.kind !== "skill" && details?.kind !== "plugin") {
    throw new Error(`Package action ${JSON.stringify(action.id)} has no valid package kind.`);
  }
  if (
    details.source !== "clawhub" ||
    !details.ref ||
    !details.version ||
    !details.integrity ||
    !normalizeClawHubSha256Integrity(details.integrity)
  ) {
    throw new Error(
      `Package action ${JSON.stringify(action.id)} is not a pinned ClawHub package with integrity.`,
    );
  }
  if (details.ownerAction !== "install" && details.ownerAction !== "reuse") {
    throw new Error(`Package action ${JSON.stringify(action.id)} has no planned owner state.`);
  }
  if (details.kind === "plugin" && !details.installId) {
    throw new Error(`Package action ${JSON.stringify(action.id)} has no resolved plugin id.`);
  }
  return {
    kind: details.kind,
    source: details.source,
    ref: details.ref,
    version: details.version,
    integrity: details.integrity,
    ownerAction: details.ownerAction,
    ...(details.installId ? { installId: details.installId } : {}),
    ...(details.riskWarning ? { riskWarning: details.riskWarning } : {}),
  };
}

function installerRuntime(runtime: RuntimeEnv): RuntimeEnv {
  return {
    log: (value) => runtime.log(value),
    error: (value) => runtime.error(value),
    exit: (code) => {
      throw new Error(`Plugin installer exited with code ${code}.`);
    },
  };
}

function ownerInstallIsNewerThanRefs(
  installedAt: string | undefined,
  refs: PersistedClawPackageRef[],
): boolean {
  const timestamp = Date.parse(installedAt ?? "");
  return (
    Number.isFinite(timestamp) &&
    refs.length > 0 &&
    refs.every((candidate) => timestamp > candidate.updatedAtMs)
  );
}

type ClawPackagePreflightResult =
  | {
      ok: true;
      action: "install" | "reuse";
      integrity: string;
      installId?: string;
      warning?: string;
    }
  | {
      ok: false;
      code: string;
      message: string;
      installedVersion?: string;
      integrity?: string;
      installId?: string;
      warning?: string;
    };

export async function preflightClawPackage(
  pkg: ClawPackage,
  workspaceDir: string,
): Promise<ClawPackagePreflightResult> {
  if (pkg.kind === "skill") {
    const result = await preflightSkillFromClawHub({
      workspaceDir,
      slug: pkg.ref,
      version: pkg.version,
      acknowledgeClawHubRisk: true,
    });
    return result.ok ? result : { ok: false, code: result.code, message: result.error };
  }
  const result = await preflightPluginInstall({
    clawhubPackage: pkg.ref,
    rawSpec: `clawhub:${pkg.ref}@${pkg.version}`,
    expectedVersion: pkg.version,
  });
  if (!result.ok && result.code !== "plugin_version_conflict") {
    return {
      ok: false,
      code: result.code,
      message: result.error,
    };
  }
  const probe = await installPluginFromClawHub({
    spec: `clawhub:${pkg.ref}@${pkg.version}`,
    dryRun: true,
    acknowledgeClawHubRisk: true,
  });
  if (!probe.ok) {
    return { ok: false, code: probe.code ?? "plugin_preflight_failed", message: probe.error };
  }
  const integrity = probe.clawhub.integrity
    ? normalizeClawHubSha256Integrity(probe.clawhub.integrity)
    : null;
  if (!integrity) {
    return {
      ok: false,
      code: "plugin_integrity_unavailable",
      message: `Plugin ${pkg.ref}@${pkg.version} did not resolve an artifact integrity.`,
    };
  }
  if (!result.ok) {
    return {
      ok: false,
      code: result.code,
      installedVersion: result.installedVersion,
      integrity,
      installId: probe.pluginId,
      ...(probe.warning ? { warning: probe.warning } : {}),
      message: `Plugin ${pkg.ref}@${pkg.version} conflicts with installed version ${result.installedVersion}.`,
    };
  }
  if (
    result.action === "reuse" &&
    (result.installedId !== probe.pluginId ||
      !result.installedIntegrity ||
      normalizeClawHubSha256Integrity(result.installedIntegrity) !== integrity)
  ) {
    return {
      ok: false,
      code: "plugin_integrity_conflict",
      message: `Plugin ${pkg.ref}@${pkg.version} is installed as ${result.installedId} with integrity ${result.installedIntegrity ?? "unknown"}, expected ${probe.pluginId} with ${integrity}.`,
    };
  }
  return {
    ok: true,
    action: result.action,
    integrity,
    installId: probe.pluginId,
    ...(probe.warning ? { warning: probe.warning } : {}),
  };
}

export async function installClawPackages(
  plan: ClawAddPlan,
  options: OpenClawStateDatabaseOptions & {
    deps?: PackageInstallerDeps;
    runtime?: RuntimeEnv;
    nowMs?: number;
    onExternalMutation?: (pkg: ClawPackage) => void;
  } = {},
): Promise<PersistedClawPackageRef[]> {
  const deps = options.deps ?? {};
  const installPlugin = deps.installPlugin ?? runPluginInstallCommand;
  const uninstallPlugin = deps.uninstallPlugin ?? runPluginUninstallCommand;
  const probePlugin = deps.probePlugin ?? installPluginFromClawHub;
  const installSkill = deps.installSkill ?? installSkillFromClawHub;
  const preflightPlugin = deps.preflightPlugin ?? preflightPluginInstall;
  const preflightSkill = deps.preflightSkill ?? preflightSkillFromClawHub;
  const persistPackageRef = deps.persistPackageRef ?? persistClawPackageRef;
  const completePackageRef = deps.completePackageRef ?? updateClawPackageRefStatus;
  const readPackageRefs = deps.readPackageRefs ?? readClawPackageRefs;
  const acquirePackageLease = deps.acquirePackageLease ?? acquireClawPackageLifecycleLease;
  const resolvePlugin = deps.resolvePlugin ?? resolveInstalledClawHubPlugin;
  const runtime = options.runtime ?? defaultRuntime;
  const installedPackages: PersistedClawPackageRef[] = [];
  const installedPlugins: Array<{ installId: string; packageIndex: number }> = [];

  for (const action of plan.actions.filter((candidate) => candidate.kind === "package")) {
    let packageLease: MaintainedClawPackageLifecycleLease | null = null;
    try {
      const pkg = packageFromAction(action);
      const leaseArtifact =
        pkg.kind === "skill"
          ? {
              kind: pkg.kind,
              source: pkg.source,
              ref: pkg.ref,
              workspace: plan.agent.workspace,
            }
          : { kind: pkg.kind, source: pkg.source, ref: pkg.ref };
      const acquiredLease = acquirePackageLease(leaseArtifact, {
        env: options.env,
        path: options.path,
        required: true,
      });
      if (!acquiredLease) {
        throw new Error(`Could not acquire package lifecycle lease for ${pkg.ref}.`);
      }
      packageLease = maintainClawPackageLifecycleLease(acquiredLease);
      if (pkg.kind === "skill") {
        const preflight = await preflightSkill({
          workspaceDir: plan.agent.workspace,
          slug: pkg.ref,
          version: pkg.version,
          expectedIntegrity: pkg.integrity,
          acknowledgeClawHubRisk: true,
        });
        packageLease.assertCurrent();
        if (!preflight.ok) {
          throw new Error(preflight.error);
        }
        if (
          preflight.action !== pkg.ownerAction ||
          preflight.warning !== pkg.riskWarning ||
          normalizeClawHubSha256Integrity(preflight.integrity) !==
            normalizeClawHubSha256Integrity(pkg.integrity)
        ) {
          throw new ClawPackageInstallError(
            "package_owner_state_changed",
            `Skill ${pkg.ref}@${pkg.version} changed after planning; run add --dry-run again.`,
            installedPackages,
          );
        }
        if (preflight.action === "reuse") {
          installedPackages.push(
            persistPackageRef(plan, pkg, {
              ...options,
              status: "complete",
              relationship: "managed",
              origin: "pre-existing",
              independentOwner: true,
            }),
          );
          continue;
        }
        let packageRef = persistPackageRef(plan, pkg, {
          ...options,
          status: "pending",
          relationship: "managed",
          origin: "claw-introduced",
          independentOwner: false,
        });
        installedPackages.push(packageRef);
        // The installer has no mutation receipt. Mark the boundary before calling it so a throw
        // after an on-disk change is treated as uncertain instead of falsely reported as rolled back.
        options.onExternalMutation?.(pkg);
        const installed = await installSkill({
          workspaceDir: plan.agent.workspace,
          slug: pkg.ref,
          version: pkg.version,
          expectedIntegrity: pkg.integrity,
          acknowledgeClawHubRisk: true,
          clawManaged: true,
        });
        packageLease.assertCurrent();
        if (!installed.ok) {
          throw new Error(installed.error);
        }
        packageRef = completePackageRef(packageRef, "complete", options);
        installedPackages[installedPackages.length - 1] = packageRef;
        continue;
      }

      const probe = await probePlugin({
        spec: `clawhub:${pkg.ref}@${pkg.version}`,
        dryRun: true,
        acknowledgeClawHubRisk: true,
      });
      if (!probe.ok) {
        throw new Error(probe.error);
      }
      const probeIntegrity = probe.clawhub.integrity
        ? normalizeClawHubSha256Integrity(probe.clawhub.integrity)
        : null;
      if (
        probe.pluginId !== pkg.installId ||
        probeIntegrity !== normalizeClawHubSha256Integrity(pkg.integrity) ||
        probe.warning !== pkg.riskWarning
      ) {
        throw new ClawPackageInstallError(
          "package_owner_state_changed",
          `Plugin ${pkg.ref}@${pkg.version} identity or trust state changed after planning; run add --dry-run again.`,
          installedPackages,
        );
      }
      const preflight = await preflightPlugin({
        clawhubPackage: pkg.ref,
        rawSpec: `clawhub:${pkg.ref}@${pkg.version}`,
        expectedVersion: pkg.version,
      });
      packageLease.assertCurrent();
      if (!preflight.ok) {
        throw new Error(
          preflight.code === "plugin_version_conflict"
            ? `Plugin ${pkg.ref}@${pkg.version} conflicts with installed version ${preflight.installedVersion}.`
            : preflight.error,
        );
      }
      if (preflight.action !== pkg.ownerAction) {
        throw new ClawPackageInstallError(
          "package_owner_state_changed",
          `Plugin ${pkg.ref}@${pkg.version} owner state changed from ${pkg.ownerAction} to ${preflight.action}; run add --dry-run again.`,
          installedPackages,
        );
      }
      if (!pkg.installId) {
        throw new ClawPackageInstallError(
          "plugin_identity_unresolved",
          `Plugin ${pkg.ref}@${pkg.version} has no resolved install identity.`,
          installedPackages,
        );
      }
      if (preflight.action === "reuse") {
        if (
          preflight.installedId !== pkg.installId ||
          !preflight.installedIntegrity ||
          normalizeClawHubSha256Integrity(preflight.installedIntegrity) !==
            normalizeClawHubSha256Integrity(pkg.integrity)
        ) {
          throw new ClawPackageInstallError(
            "package_owner_state_changed",
            `Plugin ${pkg.ref}@${pkg.version} identity changed after planning; run add --dry-run again.`,
            installedPackages,
          );
        }
        const existingRefs = readPackageRefs({
          ...options,
          kind: pkg.kind,
          source: pkg.source,
          ref: pkg.ref,
          version: pkg.version,
        });
        const inheritsClawOrigin =
          existingRefs.length > 0 &&
          existingRefs.every(
            (candidate) => candidate.origin === "claw-introduced" && !candidate.independentOwner,
          ) &&
          !ownerInstallIsNewerThanRefs(preflight.installedAt, existingRefs);
        installedPackages.push(
          persistPackageRef(plan, pkg, {
            ...options,
            status: "complete",
            relationship: "referenced",
            origin: inheritsClawOrigin ? "claw-introduced" : "pre-existing",
            independentOwner: !inheritsClawOrigin,
          }),
        );
        continue;
      }

      let packageRef = persistPackageRef(plan, pkg, {
        ...options,
        status: "pending",
        relationship: "referenced",
        origin: "claw-introduced",
        independentOwner: false,
      });
      installedPackages.push(packageRef);

      // The installer has no mutation receipt. Mark the boundary before calling it so a throw
      // after an on-disk change is treated as uncertain instead of falsely reported as rolled back.
      options.onExternalMutation?.(pkg);
      await installPlugin({
        raw: `clawhub:${pkg.ref}@${pkg.version}`,
        opts: {
          acknowledgeClawHubRisk: true,
          expectedIntegrity: pkg.integrity,
          expectedPluginId: pkg.installId,
        },
        invalidateRuntimeCache: false,
        clawManaged: true,
        runtime: installerRuntime(runtime),
      });
      installedPlugins.push({
        installId: pkg.installId,
        packageIndex: installedPackages.length - 1,
      });
      packageLease.assertCurrent();
      packageRef = completePackageRef(packageRef, "complete", options);
      installedPackages[installedPackages.length - 1] = packageRef;
    } catch (error) {
      try {
        packageLease?.release();
        packageLease = null;
      } catch {
        // The rollback path will report a busy lease instead of mutating without ownership.
      }
      const pending = installedPackages.at(-1);
      if (pending?.status === "pending") {
        try {
          installedPackages[installedPackages.length - 1] = completePackageRef(
            pending,
            "failed",
            options,
          );
        } catch {
          // Preserve the installer error; pending provenance still exposes uncertain ownership.
        }
      }
      const rollbackErrors: string[] = [];
      for (const installedPlugin of installedPlugins.toReversed()) {
        const packageRef = installedPackages[installedPlugin.packageIndex];
        if (!packageRef) {
          continue;
        }
        let rollbackLease: MaintainedClawPackageLifecycleLease | null = null;
        try {
          const acquiredRollbackLease = acquirePackageLease(
            { kind: "plugin", source: "clawhub", ref: packageRef.ref },
            { env: options.env, path: options.path, required: true },
          );
          if (!acquiredRollbackLease) {
            throw new Error(`Could not acquire package lifecycle lease for ${packageRef.ref}.`, {
              cause: error,
            });
          }
          rollbackLease = maintainClawPackageLifecycleLease(acquiredRollbackLease);
          const sharedRefs = readPackageRefs({
            ...options,
            kind: "plugin",
            source: "clawhub",
            ref: packageRef.ref,
            version: packageRef.version,
            integrity: packageRef.integrity,
          }).filter(
            (ref) =>
              ref.agentId !== plan.agent.finalId &&
              (ref.status === "pending" || ref.status === "complete"),
          );
          if (sharedRefs.length > 0) {
            rollbackErrors.push(
              `kept plugin ${installedPlugin.installId} because another Claw now references it`,
            );
            continue;
          }
          const currentRefs = readPackageRefs({
            ...options,
            kind: "plugin",
            source: "clawhub",
            ref: packageRef.ref,
            version: packageRef.version,
          });
          if (currentRefs.some((candidate) => candidate.independentOwner)) {
            rollbackErrors.push(
              `kept plugin ${installedPlugin.installId} because it now has a direct owner`,
            );
            continue;
          }
          const installed = await resolvePlugin({ clawhubPackage: packageRef.ref });
          const installedIntegrity =
            installed.status === "found" && installed.record.integrity
              ? normalizeClawHubSha256Integrity(installed.record.integrity)
              : null;
          if (
            installed.status !== "found" ||
            installed.pluginId !== installedPlugin.installId ||
            installed.installedVersion !== packageRef.version ||
            installedIntegrity !== normalizeClawHubSha256Integrity(packageRef.integrity) ||
            ownerInstallIsNewerThanRefs(installed.record.installedAt, currentRefs)
          ) {
            rollbackErrors.push(
              `kept plugin ${installedPlugin.installId} because its installed identity changed after Claw installation`,
            );
            continue;
          }
          await uninstallPlugin(
            installedPlugin.installId,
            { force: true, invalidateRuntimeCache: false, clawManaged: true },
            installerRuntime(runtime),
          );
          rollbackLease.assertCurrent();
          installedPackages[installedPlugin.packageIndex] = completePackageRef(
            installedPackages[installedPlugin.packageIndex] ?? packageRef,
            "rolled_back",
            options,
          );
        } catch (rollbackError) {
          rollbackErrors.push(
            `could not remove plugin ${installedPlugin.installId}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          );
          continue;
        } finally {
          try {
            rollbackLease?.release();
          } catch {
            // Lease expiry recovers cleanup when the shared state database is unavailable.
          }
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      if (rollbackErrors.length > 0) {
        throw new ClawPackageInstallError(
          "package_rollback_failed",
          `${message} Rollback incomplete: ${rollbackErrors.join("; ")}.`,
          installedPackages,
        );
      }
      if (error instanceof ClawPackageInstallError) {
        throw new ClawPackageInstallError(error.code, error.message, installedPackages);
      }
      throw new ClawPackageInstallError("package_install_failed", message, installedPackages);
    } finally {
      try {
        packageLease?.release();
      } catch {
        // Lease expiry recovers cleanup when the shared state database is unavailable.
      }
    }
  }

  return installedPackages;
}
