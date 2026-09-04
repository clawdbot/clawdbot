// Builds read-only, agent-centric Claw update plans from grouped manifests and ownership state.
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { stableStringify } from "@openclaw/normalization-core";
import { normalizeConfiguredMcpServers } from "../config/mcp-config-normalize.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { root as fsSafeRoot } from "../infra/fs-safe.js";
import {
  openExistingOpenClawStateDatabaseReadOnly,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { preserveAdoptedAgentDefault } from "./adopted-agent-update.js";
import { resolveCanonicalClawAgent } from "./agent-adoption-apply.js";
import {
  clawExtensionProvenanceChanged,
  clawPackageActionsById,
  clawPackageKey,
  clawTargetPackages,
  clawWorkspaceActionsById,
  isApplicationUpdateBlocker,
  recordingClawPackagePreflight,
} from "./application-provenance.js";
import { readClawStatus } from "./lifecycle-state.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { digestClawMcpServer, readClawMcpServerRefsByName } from "./mcp.js";
import type { PackageRemovalDeps } from "./package-remove.js";
import { digestClawPackageRef } from "./package-update-provenance.js";
import { readClawPackageRefs } from "./provenance.js";
import {
  CLAW_OUTPUT_STABILITY,
  type ClawDiagnostic,
  type ClawManifest,
  type ClawOpenClawProfile,
  type ClawPackagePreflight,
  type ClawPackagePreflightResult,
  type ClawSourceIdentity,
} from "./types.js";
import {
  cronCapabilityChange,
  mcpCapabilityChange,
  packageCapabilityChange,
  pushResolvedAgentCapabilityChanges,
  type ClawUpdateCapabilityChange,
} from "./update-capability-changes.js";
import { makeEmptyClawUpdatePlan } from "./update-plan-empty.js";
import { summarizeClawUpdatePlan } from "./update-plan-summary.js";
import {
  CLAW_UPDATE_PLAN_SCHEMA_VERSION,
  type ClawUpdateAction,
  type ClawUpdatePlan,
} from "./update-plan-types.js";

export {
  CLAW_UPDATE_PLAN_SCHEMA_VERSION,
  type ClawUpdateAction,
  type ClawUpdatePlan,
} from "./update-plan-types.js";

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function diagnostic(code: string, path: string, message: string): ClawDiagnostic {
  return { level: "error", code, phase: "plan", path, message };
}

function manualState(state: string): boolean {
  return state === "modified" || state === "unsafe" || state === "pending" || state === "failed";
}

export async function buildClawUpdatePlan(params: {
  agentId: string;
  targetManifest: ClawManifest;
  targetClawMarkdownBody?: Buffer;
  targetOpenClawProfile?: ClawOpenClawProfile;
  targetSource: ClawSourceIdentity;
  config: OpenClawConfig;
  sourceMcpServers: Record<string, Record<string, unknown>>;
  stateOptions?: OpenClawStateDatabaseOptions & { packageDeps?: PackageRemovalDeps };
  packagePreflight?: ClawPackagePreflight;
  diagnostics?: ClawDiagnostic[];
}): Promise<ClawUpdatePlan> {
  const ownsDatabase = !params.stateOptions?.database;
  const database =
    params.stateOptions?.database ??
    (await openExistingOpenClawStateDatabaseReadOnly(params.stateOptions));
  if (!database) {
    return makeEmptyClawUpdatePlan({
      agentId: params.agentId,
      source: params.targetSource,
      blockers: [
        diagnostic(
          "claw_not_found",
          "$",
          `No installed Claw agent matches ${JSON.stringify(params.agentId)}.`,
        ),
      ],
      diagnostics: params.diagnostics,
      digest,
    });
  }
  if (
    !database.db /* sqlite-allow-raw: read-only Claw install table-existence probe. */
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'claw_installs'")
      .get()
  ) {
    if (ownsDatabase) {
      database.walMaintenance.close();
    }
    return makeEmptyClawUpdatePlan({
      agentId: params.agentId,
      source: params.targetSource,
      blockers: [
        diagnostic(
          "claw_not_found",
          "$",
          `No installed Claw agent matches ${JSON.stringify(params.agentId)}.`,
        ),
      ],
      diagnostics: params.diagnostics,
      digest,
    });
  }
  const readOnlyStateOptions: OpenClawStateDatabaseOptions & {
    packageDeps?: PackageRemovalDeps;
  } = {
    ...params.stateOptions,
    database,
    readOnly: true,
  };
  try {
    const status = await readClawStatus(params.agentId, {
      ...readOnlyStateOptions,
      config: params.config,
      sourceMcpServers: params.sourceMcpServers,
      ...(params.packagePreflight ? { packagePreflight: params.packagePreflight } : {}),
    });
    if (status.records.length === 0) {
      return makeEmptyClawUpdatePlan({
        agentId: params.agentId,
        source: params.targetSource,
        blockers: [
          diagnostic(
            "claw_not_found",
            "$",
            `No installed Claw agent matches ${JSON.stringify(params.agentId)}.`,
          ),
        ],
        diagnostics: params.diagnostics,
        digest,
      });
    }
    if (status.records.length > 1) {
      return makeEmptyClawUpdatePlan({
        agentId: params.agentId,
        source: params.targetSource,
        found: true,
        blockers: [
          diagnostic(
            "claw_ambiguous",
            "$",
            `Claw name ${JSON.stringify(params.agentId)} matches multiple agents; use an agent id.`,
          ),
        ],
        diagnostics: params.diagnostics,
        digest,
      });
    }
    const record = status.records[0]!;
    const agentId = record.install.agentId;
    if (record.install.claw.name !== params.targetSource.name) {
      return makeEmptyClawUpdatePlan({
        agentId,
        source: params.targetSource,
        found: true,
        currentClaw: {
          name: record.install.claw.name,
          version: record.install.claw.version,
          integrity: record.install.claw.integrity,
        },
        blockers: [
          diagnostic(
            "claw_identity_mismatch",
            "$.name",
            `Target package ${JSON.stringify(params.targetSource.name)} does not match installed Claw ${JSON.stringify(record.install.claw.name)}.`,
          ),
        ],
        diagnostics: params.diagnostics,
        digest,
      });
    }

    const packagePreflights = new Map<string, ClawPackagePreflightResult>();
    const currentPackages = new Map(
      record.packages.map((pkg) => [clawPackageKey(pkg), pkg] as const),
    );
    const rawTargetPlan = await buildClawAddPlan({
      manifest: params.targetManifest,
      clawMarkdownBody: params.targetClawMarkdownBody,
      includePackageBootstrap: false,
      openClawProfile: params.targetOpenClawProfile,
      source: params.targetSource,
      diagnostics: params.diagnostics,
      context: {
        agentId,
        workspace: record.install.workspace,
        packagePreflight: recordingClawPackagePreflight(
          params.packagePreflight,
          record.install.workspace,
          packagePreflights,
          currentPackages,
        ),
      },
    });
    const liveAgent = resolveCanonicalClawAgent(params.config, agentId);
    const targetPlan =
      preserveAdoptedAgentDefault({
        plan: rawTargetPlan,
        install: record.install,
        liveAgent,
      }) ?? rawTargetPlan;
    const blockers = targetPlan.blockers.filter(isApplicationUpdateBlocker);
    const actions: ClawUpdateAction[] = [];
    const capabilityChanges: ClawUpdateCapabilityChange[] = [];

    const desiredAgentDigest = digest(targetPlan.agent.config);
    const adoptedAgentUnavailable =
      record.install.agentOrigin === "adopted" && record.agentState !== "present";
    const agentAction =
      record.agentState === "modified" || adoptedAgentUnavailable
        ? "manual"
        : record.agentState === "missing"
          ? "change"
          : record.install.agentConfigDigest === desiredAgentDigest
            ? "unchanged"
            : "change";
    actions.push({
      kind: "agent",
      id: agentId,
      action: agentAction,
      target: `agents.entries[${JSON.stringify(agentId)}]`,
      blocked: agentAction === "manual",
      reason:
        agentAction === "manual"
          ? adoptedAgentUnavailable && record.agentState === "missing"
            ? "The adopted agent is missing; its pre-adoption default marker cannot be reconstructed safely."
            : "Live agent config changed after installation and must be reconciled manually."
          : record.agentState === "missing"
            ? "Owned agent config is missing and would be restored from the target manifest."
            : agentAction === "unchanged"
              ? "Owned agent config already matches the target manifest."
              : "Target manifest changes owned agent config.",
      ...(record.agentState === "missing"
        ? {}
        : { currentDigest: record.install.agentConfigDigest }),
      desiredDigest: desiredAgentDigest,
    });
    pushResolvedAgentCapabilityChanges({
      changes: capabilityChanges,
      agentId,
      config: params.config,
      desiredAgent: targetPlan.agent.config,
    });

    const targetFiles = clawWorkspaceActionsById(targetPlan.actions);
    const currentFiles = new Map(record.workspaceFiles.map((file) => [file.path, file] as const));
    let workspace: Awaited<ReturnType<typeof fsSafeRoot>> | undefined;
    let workspaceState: "present" | "missing" | "unsafe" = "present";
    try {
      const workspaceStat = await lstat(record.install.workspace);
      if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) {
        workspaceState = "unsafe";
      } else {
        workspace = await fsSafeRoot(record.install.workspace, {
          hardlinks: "reject",
          symlinks: "reject",
        });
      }
    } catch (error) {
      workspaceState =
        error && typeof error === "object" && "code" in error && error.code === "ENOENT"
          ? "missing"
          : "unsafe";
    }
    for (const [path, target] of targetFiles) {
      const current = currentFiles.get(path);
      if (!target.digest) {
        actions.push({
          kind: "workspaceFile",
          id: path,
          action: "manual",
          target: `${record.install.workspace}:${path}`,
          blocked: true,
          reason: target.reason ?? "Target workspace source could not be verified.",
        });
        continue;
      }
      let unownedDestination: "absent" | "occupied" | "unsafe" =
        workspaceState === "unsafe" ? "unsafe" : "absent";
      if (!current) {
        if (workspace) {
          try {
            unownedDestination = (await workspace.exists(path)) ? "occupied" : "absent";
          } catch {
            unownedDestination = "unsafe";
          }
        }
      }
      const currentFileRequiresManual =
        current !== undefined &&
        manualState(current.state) &&
        !(workspaceState === "missing" && current.state === "unsafe");
      const action =
        workspaceState === "unsafe"
          ? "manual"
          : !current && unownedDestination !== "absent"
            ? "manual"
            : !current
              ? "add"
              : currentFileRequiresManual
                ? "manual"
                : current.contentDigest === target.digest && current.state === "unchanged"
                  ? "unchanged"
                  : "change";
      actions.push({
        kind: "workspaceFile",
        id: path,
        action,
        target: `${record.install.workspace}:${path}`,
        blocked: action === "manual",
        reason:
          unownedDestination === "occupied"
            ? "Workspace path already exists without Claw ownership and must be preserved."
            : unownedDestination === "unsafe"
              ? "Workspace path is unsafe to inspect and cannot be claimed automatically."
              : workspaceState === "missing" && current
                ? "Owned workspace is missing and this file would be restored."
                : action === "add"
                  ? "Target manifest adds a managed workspace file."
                  : action === "manual"
                    ? "Local workspace content changed or became unsafe and must be reconciled manually."
                    : action === "unchanged"
                      ? "Managed workspace content already matches the target source."
                      : "Target source changes or restores managed workspace content.",
        ...(current ? { currentDigest: current.contentDigest } : {}),
        ...(current ? { currentPresent: current.state !== "missing" } : {}),
        desiredDigest: target.digest,
      });
    }
    for (const current of record.workspaceFiles) {
      if (targetFiles.has(current.path)) {
        continue;
      }
      const manual =
        workspaceState === "unsafe" ||
        (manualState(current.state) &&
          !(workspaceState === "missing" && current.state === "unsafe"));
      actions.push({
        kind: "workspaceFile",
        id: current.path,
        action: manual ? "manual" : "remove",
        target: `${current.workspace}:${current.path}`,
        blocked: manual,
        reason: manual
          ? "Target removes this file, but local drift must be preserved manually."
          : "Target manifest removes this managed workspace file.",
        currentDigest: current.contentDigest,
        currentPresent: current.state !== "missing",
      });
    }

    const allPackages = readClawPackageRefs(readOnlyStateOptions);
    const targetPackages = clawTargetPackages(params.targetManifest, params.targetOpenClawProfile);
    const targetPackageActions = clawPackageActionsById(targetPlan.actions);
    for (const [key, target] of targetPackages) {
      const current = currentPackages.get(key);
      const preflight = packagePreflights.get(key);
      const targetAction = targetPackageActions.get(key);
      const extensionChanged = clawExtensionProvenanceChanged(current?.extension, targetAction);
      const requiresPackageMutation =
        !current ||
        (current.origin === "claw-introduced" &&
          !current.independentOwner &&
          (current.state === "missing" || current.version !== target.version));
      const failedPackageMutationPreflight = requiresPackageMutation && !preflight?.ok;
      const conflictingPluginPin =
        target.kind === "plugin" &&
        allPackages.some(
          (candidate) =>
            candidate.agentId !== agentId &&
            candidate.kind === target.kind &&
            candidate.source === target.source &&
            candidate.ref === target.ref &&
            candidate.version !== target.version,
        );
      const unresolvedCurrent =
        current && ["modified", "ambiguous", "incomplete"].includes(current.state);
      const independentlyOwnedMutation =
        current &&
        (current.origin === "pre-existing" || current.independentOwner) &&
        (current.state === "missing" || current.version !== target.version);
      const action =
        conflictingPluginPin ||
        unresolvedCurrent ||
        independentlyOwnedMutation ||
        failedPackageMutationPreflight
          ? "manual"
          : !current
            ? "add"
            : current.state === "missing"
              ? "change"
              : current.version === target.version && !extensionChanged
                ? "unchanged"
                : "change";
      actions.push({
        kind: "package",
        id: key,
        action,
        target: `${target.source}:${target.ref}@${target.version}`,
        blocked: action === "manual",
        reason:
          action === "manual"
            ? conflictingPluginPin
              ? "Another Claw pins an incompatible version of this shared plugin."
              : independentlyOwnedMutation
                ? "Package is independently owned and cannot be restored or changed by this Claw."
                : failedPackageMutationPreflight
                  ? (preflight?.message ?? "Package preflight failed.")
                  : `Current package lifecycle state is ${current?.state ?? "unknown"} and must be reconciled manually.`
            : action === "add"
              ? "Target manifest adds a package reference."
              : action === "unchanged"
                ? "Recorded package reference already matches the exact target version and extension mapping."
                : current?.version === target.version
                  ? "Target profile changes extension provenance without reinstalling the package."
                  : "Target manifest changes the exact package version.",
        ...(current ? { currentDigest: digestClawPackageRef(current) } : {}),
        desiredDigest: digest({
          package: target,
          integrity: preflight?.integrity,
          installId: preflight?.installId,
          riskWarning: preflight?.warning,
          prerequisites: preflight?.requirements,
          extension: targetAction?.details?.extension,
        }),
      });
      const capabilityChange = packageCapabilityChange({
        pkg: target,
        action,
        currentVersion: current?.version,
        desiredVersion: target.version,
        integrity: preflight?.integrity,
        installId: preflight?.installId,
        riskWarning: preflight?.warning,
        currentExtension: current?.extension,
        desiredExtension: targetAction?.details?.extension,
      });
      if (capabilityChange) {
        capabilityChanges.push(capabilityChange);
      }
      if (failedPackageMutationPreflight) {
        const packageIndex = params.targetManifest.packages.findIndex(
          (pkg) => clawPackageKey(pkg) === key,
        );
        const extensionIndex =
          params.targetOpenClawProfile?.extensions?.findIndex(
            (extension) => clawPackageKey(extension) === key,
          ) ?? -1;
        const path =
          packageIndex >= 0
            ? `$.packages[${packageIndex}]`
            : `$.profiles.openclaw.extensions[${extensionIndex}]`;
        const code = preflight?.code ?? "package_install_unavailable";
        if (!blockers.some((entry) => entry.code === code && entry.path === path)) {
          blockers.push(diagnostic(code, path, preflight?.message ?? "Package preflight failed."));
        }
      }
    }
    for (const [key, current] of currentPackages) {
      if (!targetPackages.has(key)) {
        const manual = current.state !== "present";
        const action = manual ? "manual" : "release";
        actions.push({
          kind: "package",
          id: key,
          action,
          target: `${current.source}:${current.ref}@${current.version}`,
          blocked: manual,
          reason: manual
            ? `Target removes this package, but current lifecycle state is ${current.state}.`
            : "Target manifest releases this package dependency while preserving the artifact.",
          currentDigest: digestClawPackageRef(current),
        });
        const capabilityChange = packageCapabilityChange({
          pkg: current,
          action,
          currentVersion: current.version,
        });
        if (capabilityChange) {
          capabilityChanges.push(capabilityChange);
        }
      }
    }

    const configuredMcpServers = normalizeConfiguredMcpServers(params.sourceMcpServers);
    const currentMcp = new Map(record.mcpServers.map((server) => [server.name, server] as const));
    for (const [name, target] of Object.entries(params.targetManifest.mcpServers)) {
      const current = currentMcp.get(name);
      const desiredDigest = digestClawMcpServer(target);
      const unownedLiveServer = !current && Object.hasOwn(configuredMcpServers, name);
      const sharedWithOtherClaws =
        current &&
        readClawMcpServerRefsByName(name, readOnlyStateOptions).some(
          (candidate) => candidate.agentId !== agentId,
        );
      const independentlyOwnedMutation =
        current !== undefined &&
        (current.origin === "pre-existing" || current.independentOwner) &&
        (current.configDigest !== desiredDigest || current.state !== "present");
      const sharedChange = sharedWithOtherClaws && current?.configDigest !== desiredDigest;
      const action =
        unownedLiveServer || independentlyOwnedMutation || sharedChange
          ? "manual"
          : !current
            ? "add"
            : manualState(current.state)
              ? "manual"
              : current.configDigest === desiredDigest && current.state === "present"
                ? "unchanged"
                : "change";
      actions.push({
        kind: "mcpServer",
        id: name,
        action,
        target: `mcp.servers.${name}`,
        blocked: action === "manual",
        reason: unownedLiveServer
          ? "MCP server name already exists without this Claw's ownership."
          : independentlyOwnedMutation
            ? "MCP server is independently owned and cannot be restored or changed by this Claw."
            : sharedChange
              ? "Another Claw shares this MCP declaration and blocks changing global config."
              : action === "manual"
                ? "MCP ownership is unresolved or live config drifted and must be reconciled manually."
                : action === "unchanged"
                  ? "Owned MCP config digest already matches the target declaration."
                  : `Target manifest ${action === "add" ? "adds" : "changes or restores"} this MCP declaration.`,
        ...(current ? { currentDigest: current.configDigest } : {}),
        desiredDigest,
      });
      const capabilityChange = mcpCapabilityChange({
        id: name,
        action,
        current: current ? configuredMcpServers[name] : undefined,
        desired: target,
      });
      if (capabilityChange) {
        capabilityChanges.push(capabilityChange);
      }
    }
    for (const current of record.mcpServers) {
      if (Object.hasOwn(params.targetManifest.mcpServers, current.name)) {
        continue;
      }
      const manual = current.state === "pending" || current.state === "failed";
      const sharedOrIndependent =
        current.relationship === "referenced" ||
        current.origin === "pre-existing" ||
        current.independentOwner ||
        readClawMcpServerRefsByName(current.name, readOnlyStateOptions).some(
          (candidate) => candidate.agentId !== agentId,
        );
      const ownerAction =
        current.state === "present" && !sharedOrIndependent ? "remove" : "release";
      const action = manual ? "manual" : ownerAction;
      actions.push({
        kind: "mcpServer",
        id: current.name,
        action,
        target: `mcp.servers.${current.name}`,
        blocked: manual,
        reason: manual
          ? "Target removes this MCP declaration, but ownership is incomplete."
          : ownerAction === "release"
            ? "Target manifest releases this Claw's reference while preserving shared or independently owned MCP config."
            : "Target manifest removes this solely owned MCP declaration.",
        currentDigest: current.configDigest,
      });
      const capabilityChange = mcpCapabilityChange({
        id: current.name,
        action,
        current: configuredMcpServers[current.name],
      });
      if (capabilityChange) {
        capabilityChanges.push(capabilityChange);
      }
    }

    const currentCron = new Map(record.cronJobs.map((cron) => [cron.manifestId, cron] as const));
    for (const target of params.targetManifest.cronJobs) {
      const current = currentCron.get(target.id);
      const desiredDigest = digest(target);
      const unresolved = current && (current.status !== "complete" || !current.schedulerJobId);
      const action = !current
        ? "add"
        : unresolved
          ? "manual"
          : digest(current.job) === desiredDigest
            ? "unchanged"
            : "change";
      actions.push({
        kind: "cronJob",
        id: target.id,
        action,
        target: current?.schedulerJobId ?? `claw:${agentId}:${target.id}`,
        blocked: action === "manual",
        reason:
          action === "manual"
            ? "Cron ownership is unresolved and must be reconciled with the gateway."
            : action === "unchanged"
              ? "Recorded cron declaration already matches the target manifest."
              : `Target manifest ${action === "add" ? "adds" : "changes"} this cron declaration.`,
        ...(current ? { currentDigest: digest(current.job) } : {}),
        desiredDigest,
      });
      const capabilityChange = cronCapabilityChange({
        id: target.id,
        action,
        current: current?.job,
        desired: target,
      });
      if (capabilityChange) {
        capabilityChanges.push(capabilityChange);
      }
    }
    for (const current of record.cronJobs) {
      if (params.targetManifest.cronJobs.some((cron) => cron.id === current.manifestId)) {
        continue;
      }
      const manual = current.status !== "complete" || !current.schedulerJobId;
      const action = manual ? "manual" : "remove";
      actions.push({
        kind: "cronJob",
        id: current.manifestId,
        action,
        target: current.schedulerJobId ?? current.declarationKey,
        blocked: manual,
        reason: manual
          ? "Target removes this cron declaration, but scheduler ownership is unresolved."
          : "Target manifest removes this owned cron declaration.",
        currentDigest: digest(current.job),
      });
      const capabilityChange = cronCapabilityChange({
        id: current.manifestId,
        action,
        current: current.job,
      });
      if (capabilityChange) {
        capabilityChanges.push(capabilityChange);
      }
    }

    actions.sort((left, right) =>
      `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`),
    );
    capabilityChanges.sort((left, right) =>
      `${left.kind}:${left.id}:${left.path}`.localeCompare(
        `${right.kind}:${right.id}:${right.path}`,
      ),
    );
    const plan: Omit<ClawUpdatePlan, "planIntegrity"> = {
      schemaVersion: CLAW_UPDATE_PLAN_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      dryRun: true,
      mutationAllowed: false,
      found: true,
      agentId,
      currentClaw: {
        name: record.install.claw.name,
        version: record.install.claw.version,
        integrity: record.install.claw.integrity,
      },
      targetClaw: {
        name: params.targetSource.name,
        version: params.targetSource.version,
        integrity: params.targetSource.integrity,
      },
      summary: summarizeClawUpdatePlan(actions, capabilityChanges),
      actions,
      capabilityChanges,
      readiness: targetPlan.readiness,
      blockers,
      diagnostics: params.diagnostics ?? [],
    };
    return { ...plan, planIntegrity: digest(plan) };
  } finally {
    if (ownsDatabase) {
      database.walMaintenance.close();
    }
  }
}
