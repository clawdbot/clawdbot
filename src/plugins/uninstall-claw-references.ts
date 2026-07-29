import { readClawPackageRefs, type PersistedClawPackageRef } from "../claws/provenance.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";

function clawPackageRefMatchesPluginInstall(
  ref: PersistedClawPackageRef,
  pluginId: string,
  record: PluginInstallRecord,
): boolean {
  if (ref.kind !== "plugin" || ref.source !== "clawhub" || record.source !== "clawhub") {
    return false;
  }
  const installedRef =
    record.clawhubPackage ?? record.spec?.replace(/^clawhub:/i, "").replace(/@[^@]+$/, "");
  return (installedRef ?? pluginId) === ref.ref;
}

/** Explain Claw dependents without blocking the operator-owned uninstall. */
export function collectClawPluginUninstallWarnings(params: {
  pluginId: string;
  installRecord?: PluginInstallRecord;
  env?: OpenClawStateDatabaseOptions["env"];
}): string[] {
  const installRecord = params.installRecord;
  if (!installRecord || installRecord.source !== "clawhub") {
    return [];
  }
  const refs = readClawPackageRefs({
    kind: "plugin",
    source: "clawhub",
    ...(params.env ? { env: params.env } : {}),
  }).filter(
    (ref) =>
      ref.status !== "rolled_back" &&
      clawPackageRefMatchesPluginInstall(ref, params.pluginId, installRecord),
  );
  const clawIds = [...new Set(refs.map((ref) => ref.clawName))].toSorted();
  if (clawIds.length === 0) {
    return [];
  }

  const installedVersion = installRecord.resolvedVersion ?? installRecord.version;
  const expectedVersions = [...new Set(refs.map((ref) => ref.version))].toSorted();
  const drifted =
    installedVersion !== undefined &&
    expectedVersions.some((version) => version !== installedVersion);

  const warnings = [
    `Warning: plugin "${params.pluginId}" is referenced by Claw${clawIds.length === 1 ? "" : "s"}: ${clawIds.join(", ")}.`,
  ];
  if (drifted) {
    warnings.push(
      `Installed version ${installedVersion} differs from the Claw reference${expectedVersions.length === 1 ? "" : "s"} ${expectedVersions.join(", ")}.`,
    );
  }
  warnings.push(
    "Uninstalling it may break those Claws until the plugin is reinstalled or the Claws are updated.",
  );
  return warnings;
}
