import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { HealthFinding, HealthRepairEffect } from "../flows/health-checks.js";
import { normalizeWindowsPathForComparison } from "../infra/path-guards.js";
import { listRecoveredManagedNpmInstallCandidates } from "../plugins/installed-plugin-index-record-reader.js";
import {
  clearLoadInstalledPluginIndexInstallRecordsCache,
  loadInstalledPluginIndexInstallRecords,
  type InstalledPluginIndexRecordStoreOptions,
} from "../plugins/installed-plugin-index-records.js";
import { markRetainedManagedNpmInstall } from "../plugins/managed-npm-retention.js";
import { shortenHomePath } from "../utils.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

export const PLUGIN_REGISTRY_CHECK_ID = "core/doctor/plugin-registry";

export type StaleManagedNpmInstallGenerationIssue = {
  kind: "stale-managed-npm-install-generation";
  activePackageDir: string;
  packageDir: string;
  pluginId: string;
  version?: string;
};

type PluginGenerationDoctorParams = InstalledPluginIndexRecordStoreOptions & {
  prompter: Pick<DoctorPrompter, "shouldRepair">;
};

function normalizeManagedInstallPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? normalizeWindowsPathForComparison(resolved) : resolved;
}

export async function listStaleManagedNpmInstallGenerations(
  params: InstalledPluginIndexRecordStoreOptions,
): Promise<StaleManagedNpmInstallGenerationIssue[]> {
  // The reader keeps a persisted active path authoritative and supplies its
  // deterministic recovery choice when that authority is absent or dangling.
  const activeRecords = await loadInstalledPluginIndexInstallRecords(params);
  const candidates = listRecoveredManagedNpmInstallCandidates(params);
  const candidatesByPluginId = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const entries = candidatesByPluginId.get(candidate.pluginId) ?? [];
    entries.push(candidate);
    candidatesByPluginId.set(candidate.pluginId, entries);
  }

  const stale: StaleManagedNpmInstallGenerationIssue[] = [];
  for (const [pluginId, pluginCandidates] of candidatesByPluginId) {
    const activeRecord = activeRecords[pluginId];
    if (activeRecord?.source !== "npm" || !activeRecord.installPath) {
      continue;
    }
    const activePath = normalizeManagedInstallPath(activeRecord.installPath);
    const active = pluginCandidates.find(
      (candidate) =>
        candidate.installRecord.installPath &&
        normalizeManagedInstallPath(candidate.installRecord.installPath) === activePath,
    );
    if (!active) {
      continue;
    }
    for (const candidate of pluginCandidates) {
      const packageDir = candidate.installRecord.installPath;
      if (!packageDir || normalizeManagedInstallPath(packageDir) === activePath) {
        continue;
      }
      stale.push({
        kind: "stale-managed-npm-install-generation",
        pluginId,
        activePackageDir: activeRecord.installPath,
        packageDir,
        ...(candidate.installRecord.resolvedVersion
          ? { version: candidate.installRecord.resolvedVersion }
          : {}),
      });
    }
  }
  return stale.toSorted((left, right) => left.packageDir.localeCompare(right.packageDir));
}

/** Marks non-authoritative managed npm trees for safe cleanup after gateway shutdown. */
export async function maybeRepairStaleManagedNpmInstallGenerations(
  params: PluginGenerationDoctorParams,
): Promise<boolean> {
  const stale = await listStaleManagedNpmInstallGenerations(params);
  if (stale.length === 0) {
    return false;
  }
  if (!params.prompter.shouldRepair) {
    note(
      [
        "Managed npm plugin installs have stale non-authoritative generations:",
        ...stale.map(
          (generation) =>
            `- ${generation.pluginId}: ${shortenHomePath(generation.packageDir)}${generation.version ? ` (${generation.version})` : ""}`,
        ),
        `Repair with ${formatCliCommand("openclaw doctor --fix")} to retire stale generations after the gateway restarts.`,
      ].join("\n"),
      "Plugin registry",
    );
    return false;
  }

  const retired: StaleManagedNpmInstallGenerationIssue[] = [];
  for (const generation of stale) {
    if (
      await markRetainedManagedNpmInstall({
        packageDir: generation.packageDir,
        pluginId: generation.pluginId,
        reason: "doctor-repaired-stale-managed-npm-generation",
      })
    ) {
      retired.push(generation);
    }
  }
  if (retired.length === 0) {
    return false;
  }
  clearLoadInstalledPluginIndexInstallRecordsCache();
  note(
    [
      "Retired stale managed npm plugin generation(s); they will be pruned after the gateway restarts:",
      ...retired.map(
        (generation) =>
          `- ${generation.pluginId}: ${shortenHomePath(generation.packageDir)}${generation.version ? ` (${generation.version})` : ""}`,
      ),
    ].join("\n"),
    "Plugin registry",
  );
  return true;
}

export function staleManagedNpmInstallGenerationToHealthFinding(
  issue: StaleManagedNpmInstallGenerationIssue,
): HealthFinding {
  return {
    checkId: PLUGIN_REGISTRY_CHECK_ID,
    severity: "warning",
    message: `Managed npm plugin ${issue.pluginId}${issue.version ? `@${issue.version}` : ""} is a stale non-authoritative generation.`,
    path: issue.packageDir,
    target: issue.pluginId,
    fixHint:
      "Run `openclaw doctor --fix` to retire the stale generation for pruning after the gateway restarts.",
  };
}

export function staleManagedNpmInstallGenerationToRepairEffect(
  issue: StaleManagedNpmInstallGenerationIssue,
): HealthRepairEffect {
  return {
    kind: "package",
    action: "would-retire-stale-managed-npm-install-generation",
    target: issue.packageDir,
    dryRunSafe: false,
  };
}
