// Reconciles configured plugin installs after the core package update has completed.
import path from "node:path";
import { PLUGIN_CAPABILITY_CONSENT_REQUIRED } from "../../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import {
  filterRecordsToActive,
  runActivePluginPayloadSmokeCheck,
} from "../../../plugins/active-payload-verification.js";
import type { PluginCapabilityConsentHandler } from "../../../plugins/capability-consent.js";
import {
  resolveDefaultPluginExtensionsDir,
  resolveDefaultPluginNpmDir,
} from "../../../plugins/install-paths.js";
import { listManagedPluginNpmRoots } from "../../../plugins/npm-project-roots.js";
import type { PluginPayloadSmokeFailure } from "../../../plugins/payload-verification.js";
import {
  reconcileRegisteredOpenClawHostLinks,
  relinkOpenClawPeerDependenciesInManagedNpmRoot,
} from "../../../plugins/plugin-peer-link.js";
import { pruneStaleLocalBundledPluginInstallRecords } from "../../../plugins/stale-local-bundled-plugin-install-records.js";
import type { PluginUpdateOutcome } from "../../../plugins/update.js";
import { resolveUserPath } from "../../../utils.js";
import { VERSION } from "../../../version.js";
// Link mandatory repairs before a package swap can remove this updater's old chunks.
import { maybeRepairStaleManagedNpmBundledPlugins } from "../../doctor-plugin-registry.js";
import { repairMissingConfiguredPluginInstalls } from "./missing-configured-plugin-install.js";
import { UPDATE_POST_CORE_CONVERGENCE_ENV } from "./update-phase.js";

type PostCoreConvergenceWarning = {
  pluginId?: string;
  reason: string;
  message: string;
  guidance: string[];
};

type PostCoreConvergenceResult = {
  changes: string[];
  notices?: PostCoreConvergenceWarning[];
  warnings: PostCoreConvergenceWarning[];
  outcomes?: PluginUpdateOutcome[];
  errored: boolean;
  smokeFailures: PluginPayloadSmokeFailure[];
  /**
   * Final install-record map after convergence: this is the
   * `baselineInstallRecords` the caller passed in (their in-memory state
   * including any sync/npm mutations that happened earlier in the
   * post-core flow) WITH convergence's repair mutations layered on top.
   * Convergence has already persisted this map to the installed-plugin
   * index, so the caller's subsequent commit MUST seed its write from
   * these records — otherwise the stale pre-convergence snapshot will
   * overwrite both the sync/npm mutations AND the fresh repairs.
   */
  installRecords: Record<string, PluginInstallRecord>;
};

const REPAIR_GUIDANCE = "Run `openclaw update repair` to retry plugin repair.";
const inspectGuidance = (pluginId: string) =>
  `Run \`openclaw plugins inspect ${pluginId} --runtime --json\` for details.`;

function smokeFailureGuidance(failure: PluginPayloadSmokeFailure): string[] {
  if (failure.reason !== "unreadable-package-json") {
    return [REPAIR_GUIDANCE, inspectGuidance(failure.pluginId)];
  }
  const packageJsonPath = failure.installPath
    ? path.join(failure.installPath, "package.json")
    : "the plugin package.json";
  return [
    `Fix file access for ${packageJsonPath} so it is readable by the user running OpenClaw. For EACCES or EPERM, correct its ownership or permissions; otherwise resolve the reported filesystem I/O error, then retry.`,
    inspectGuidance(failure.pluginId),
  ];
}

async function repairInstalledNpmOpenClawHostLinks(params: {
  env: NodeJS.ProcessEnv;
  installRecords: Record<string, PluginInstallRecord>;
}): Promise<{
  changes: string[];
  warnings: PostCoreConvergenceWarning[];
  packageReadFailures: Array<{ error: unknown; packageDir: string }>;
}> {
  const packageReadFailures: Array<{ error: unknown; packageDir: string }> = [];
  try {
    const npmRoots = await listManagedPluginNpmRoots(resolveDefaultPluginNpmDir(params.env));
    const results = await Promise.all(
      npmRoots.map((npmRoot) =>
        relinkOpenClawPeerDependenciesInManagedNpmRoot({
          npmRoot,
          logger: {},
          onPackageReadError: (error, packageDir) => {
            packageReadFailures.push({ error, packageDir });
          },
        }),
      ),
    );
    const repaired = results.reduce((total, result) => total + result.repaired, 0);
    // Legacy npm-owned installs live under extensions/, outside every managed npm project root.
    const registeredRepair = await reconcileRegisteredOpenClawHostLinks({
      installRecords: params.installRecords,
      extensionsDir: resolveDefaultPluginExtensionsDir(params.env),
      env: params.env,
      mode: "repair",
      onPackageReadError: (error, packageDir) => {
        packageReadFailures.push({ error, packageDir });
      },
    });
    return {
      changes: [
        ...(repaired > 0
          ? [`Repaired OpenClaw host peer link(s) for ${repaired} managed npm plugin package(s).`]
          : []),
        ...(registeredRepair.repaired > 0
          ? [
              `Repaired OpenClaw host peer link(s) for ${registeredRepair.repaired} registered npm plugin package(s).`,
            ]
          : []),
      ],
      warnings: [],
      packageReadFailures,
    };
  } catch (err) {
    const message = `Failed to repair managed npm OpenClaw host peer links: ${err instanceof Error ? err.message : String(err)}`;
    return {
      changes: [],
      warnings: [
        {
          reason: message,
          message,
          guidance: [REPAIR_GUIDANCE],
        },
      ],
      packageReadFailures,
    };
  }
}

function formatPeerLinkPackageReadWarning(failure: { error: unknown }): PostCoreConvergenceWarning {
  const message = `Failed to repair managed npm OpenClaw host peer links: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`;
  return {
    reason: message,
    message,
    guidance: [REPAIR_GUIDANCE],
  };
}

/**
 * Mandatory post-core convergence pass. Runs AFTER the core package files
 * are swapped and the in-update doctor pass has already returned, but BEFORE
 * the gateway is restarted. Transient repair fetch failures stay nonblocking;
 * consent that prevents activation and payload smoke failures are errors.
 * Gateway startup quarantines known payload failures before any module import,
 * then boots with those plugins marked configured-unavailable.
 */
export async function runPostCorePluginConvergence(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  compatibilityHostVersion?: string;
  /**
   * Optional in-memory install records from earlier post-core steps (e.g.
   * `syncPluginsForUpdateChannel`, `updateNpmInstalledPlugins`) whose
   * mutations have not been persisted to the installed-plugin index yet.
   * When provided, repair layers its mutations on top of these records
   * instead of reading the stale pre-update disk snapshot, and the merged
   * map is what gets persisted and returned via `installRecords`.
   */
  baselineInstallRecords?: Record<string, PluginInstallRecord>;
  onCapabilityConsent?: PluginCapabilityConsentHandler;
}): Promise<PostCoreConvergenceResult> {
  const env: NodeJS.ProcessEnv = {
    ...params.env,
    OPENCLAW_COMPATIBILITY_HOST_VERSION: params.compatibilityHostVersion ?? VERSION,
    [UPDATE_POST_CORE_CONVERGENCE_ENV]: "1",
  };
  // Retire obsolete managed shadows before relinking or smoke-checking them. A package that
  // became bundled with the new core must not survive into the next startup's contract graph.
  const staleManagedNpmBundledPluginRepair = maybeRepairStaleManagedNpmBundledPlugins({
    config: params.cfg,
    env,
    prompter: { shouldRepair: true },
    ...(params.baselineInstallRecords ? { installRecords: params.baselineInstallRecords } : {}),
  });
  const convergenceBaseline =
    staleManagedNpmBundledPluginRepair?.installRecords ?? params.baselineInstallRecords;
  const prunedBaseline = convergenceBaseline
    ? pruneStaleLocalBundledPluginInstallRecords({
        installRecords: convergenceBaseline,
        env,
      })
    : null;

  const repair = await repairMissingConfiguredPluginInstalls({
    cfg: params.cfg,
    env,
    ...(prunedBaseline ? { baselineRecords: prunedBaseline.records } : {}),
    onCapabilityConsent: params.onCapabilityConsent,
  });

  const warnings: PostCoreConvergenceWarning[] = repair.warnings.map((message) => ({
    reason: message,
    message,
    guidance: [REPAIR_GUIDANCE],
  }));
  const peerLinkRepair = await repairInstalledNpmOpenClawHostLinks({
    env,
    installRecords: repair.records,
  });
  warnings.push(...peerLinkRepair.warnings);
  const notices: PostCoreConvergenceWarning[] = (repair.notices ?? []).map((message) => ({
    reason: message,
    message,
    guidance: [],
  }));

  const records: Record<string, PluginInstallRecord> = repair.records;
  // Filter the smoke-check input to active records ONLY: configured /
  // enabled plugins, plus trusted-source-linked official sync targets
  // selected by `filterRecordsToActive`. Without this filter, a stale install
  // record for an inactive plugin could block the update even though the
  // gateway will never load it.
  const smoke = await runActivePluginPayloadSmokeCheck({
    cfg: params.cfg,
    records,
    env,
  });
  const smokeRecords = filterRecordsToActive({ cfg: params.cfg, records });
  const resolveInstallRecordPaths = (
    installRecords: Record<string, PluginInstallRecord>,
  ): Set<string> =>
    new Set(
      Object.values(installRecords).flatMap((record) => {
        const installPath = record.installPath?.trim();
        return installPath ? [path.resolve(resolveUserPath(installPath, env))] : [];
      }),
    );
  const knownInstallPaths = resolveInstallRecordPaths(records);
  const activeInstallPaths = resolveInstallRecordPaths(smokeRecords);
  const smokeFailureInstallPaths = new Set(
    smoke.failures.flatMap((failure) =>
      failure.installPath ? [path.resolve(failure.installPath)] : [],
    ),
  );
  for (const failure of peerLinkRepair.packageReadFailures.toSorted((left, right) =>
    left.packageDir.localeCompare(right.packageDir),
  )) {
    // A typed smoke failure owns this exact package and startup quarantines it.
    // Re-emitting the repair error without that owner would turn it back into
    // an unknown warning and incorrectly block gateway readiness.
    const packageDir = path.resolve(failure.packageDir);
    const hasTypedFailure = smokeFailureInstallPaths.has(packageDir);
    const belongsToInactivePlugin =
      knownInstallPaths.has(packageDir) && !activeInstallPaths.has(packageDir);
    if (!hasTypedFailure && !belongsToInactivePlugin) {
      warnings.push(formatPeerLinkPackageReadWarning(failure));
    }
  }
  for (const failure of smoke.failures) {
    warnings.push({
      pluginId: failure.pluginId,
      reason: `${failure.reason}: ${failure.detail}`,
      message: `Plugin "${failure.pluginId}" failed post-core payload smoke check (${failure.reason}): ${failure.detail}`,
      guidance: smokeFailureGuidance(failure),
    });
  }

  return {
    changes: [
      ...(staleManagedNpmBundledPluginRepair?.removedPluginIds.map(
        (pluginId) => `Removed stale managed install record for bundled plugin "${pluginId}".`,
      ) ?? []),
      ...(prunedBaseline?.stale.map(
        (record) => `Removed stale local bundled plugin install record "${record.pluginId}".`,
      ) ?? []),
      ...repair.changes,
      ...peerLinkRepair.changes,
    ],
    notices,
    warnings,
    outcomes: repair.outcomes,
    errored:
      repair.outcomes?.some(
        (outcome) =>
          outcome.status === "error" && outcome.code === PLUGIN_CAPABILITY_CONSENT_REQUIRED,
      ) === true || smoke.failures.length > 0,
    smokeFailures: smoke.failures,
    installRecords: records,
  };
}
