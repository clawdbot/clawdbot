// Reconciles configured plugin installs after the core package update has completed.
import path from "node:path";
import { repairMissingConfiguredPluginInstalls } from "../../commands/doctor/shared/missing-configured-plugin-install.js";
import { UPDATE_POST_CORE_CONVERGENCE_ENV } from "../../commands/doctor/shared/update-phase.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import type { ClawHubRiskAcknowledgementRequest } from "../../infra/clawhub-install-trust.js";
import { resolveDefaultPluginNpmDir } from "../../plugins/install-paths.js";
import { listManagedPluginNpmRoots } from "../../plugins/npm-project-roots.js";
import { relinkOpenClawPeerDependenciesInManagedNpmRoot } from "../../plugins/plugin-peer-link.js";
import { pruneStaleLocalBundledPluginInstallRecords } from "../../plugins/stale-local-bundled-plugin-install-records.js";
import { resolveUserPath } from "../../utils.js";
import { VERSION } from "../../version.js";
import {
  filterRecordsToActive,
  runActivePluginPayloadSmokeCheck,
} from "./active-plugin-payload-validation.js";
import type { PluginPayloadSmokeFailure } from "./plugin-payload-validation.js";

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

async function repairManagedNpmOpenClawPeerLinks(params: { env: NodeJS.ProcessEnv }): Promise<{
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
    return {
      changes:
        repaired > 0
          ? [`Repaired OpenClaw host peer link(s) for ${repaired} managed npm plugin package(s).`]
          : [],
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
 * the gateway is restarted. Missing-plugin repair failures stay nonblocking:
 * an external package fetch may be transient, and failing the core update
 * would strand the user. Explicit `openclaw update` callers keep reporting
 * payload smoke failures as errors. Gateway startup consumes the same typed
 * failures by quarantining each known plugin owner before any module import,
 * then boots with that plugin marked configured-unavailable.
 */
export async function runPostCorePluginConvergence(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  /**
   * Optional in-memory install records from earlier post-core steps (e.g.
   * `syncPluginsForUpdateChannel`, `updateNpmInstalledPlugins`) whose
   * mutations have not been persisted to the installed-plugin index yet.
   * When provided, repair layers its mutations on top of these records
   * instead of reading the stale pre-update disk snapshot, and the merged
   * map is what gets persisted and returned via `installRecords`.
   */
  baselineInstallRecords?: Record<string, PluginInstallRecord>;
  acknowledgeClawHubRisk?: boolean;
  onClawHubRisk?: (request: ClawHubRiskAcknowledgementRequest) => boolean | Promise<boolean>;
}): Promise<PostCoreConvergenceResult> {
  const env: NodeJS.ProcessEnv = {
    ...params.env,
    OPENCLAW_COMPATIBILITY_HOST_VERSION: VERSION,
    [UPDATE_POST_CORE_CONVERGENCE_ENV]: "1",
  };
  const prunedBaseline = params.baselineInstallRecords
    ? pruneStaleLocalBundledPluginInstallRecords({
        installRecords: params.baselineInstallRecords,
        env,
      })
    : null;

  const repair = await repairMissingConfiguredPluginInstalls({
    cfg: params.cfg,
    env,
    ...(prunedBaseline ? { baselineRecords: prunedBaseline.records } : {}),
    ...(params.acknowledgeClawHubRisk ? { acknowledgeClawHubRisk: true } : {}),
    ...(params.onClawHubRisk ? { onClawHubRisk: params.onClawHubRisk } : {}),
  });

  const warnings: PostCoreConvergenceWarning[] = repair.warnings.map((message) => ({
    reason: message,
    message,
    guidance: [REPAIR_GUIDANCE],
  }));
  const peerLinkRepair = await repairManagedNpmOpenClawPeerLinks({ env });
  warnings.push(...peerLinkRepair.warnings);
  const notices: PostCoreConvergenceWarning[] = (repair.notices ?? []).map((message) => ({
    reason: message,
    message,
    guidance: [],
  }));

  const records: Record<string, PluginInstallRecord> = repair.records;
  // Filter the smoke-check input to active records ONLY: configured /
  // enabled plugins, plus trusted-source-linked official sync targets
  // (mirroring the existing `collectMissingPluginInstallPayloads` policy
  // at update-command.ts:~218 with `skipDisabledPlugins: true`). Without
  // this filter, a stale install record for a disabled or no-longer-
  // configured plugin whose payload was deleted on disk would block the
  // entire update — even though the gateway will never load that plugin.
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
      ...(prunedBaseline?.stale.map(
        (record) => `Removed stale local bundled plugin install record "${record.pluginId}".`,
      ) ?? []),
      ...repair.changes,
      ...peerLinkRepair.changes,
    ],
    notices,
    warnings,
    errored: smoke.failures.length > 0,
    smokeFailures: smoke.failures,
    installRecords: records,
  };
}

/**
 * Drop install records that the gateway would never activate: disabled
 * plugin entries, plugins listed in `plugins.deny`, etc. Records that
 * resolve as a trusted-source-linked official install (npm or ClawHub)
 * are retained even when the entry is disabled, mirroring the existing
 * `collectMissingPluginInstallPayloads({ skipDisabledPlugins: true,
 * syncOfficialPluginInstalls: true })` policy at
 * `update-command.ts:~218`. We do NOT collapse to the configured plugin
 * id set here — that would over-filter and miss e.g. providers/runtimes
 * that are enabled implicitly via auth profiles or model refs. Effective
 * enable state is the right precision boundary.
 */
/**
 * Pure helper used by `updatePluginsAfterCoreUpdate` to fold a convergence
 * result into the existing `PluginUpdateOutcome[]` / warning shape that the
 * post-core update result carries.
 *
 * Returns:
 *  - `outcomes` to append to `pluginUpdateOutcomes`. Only convergence
 *    warnings that name a `pluginId` produce per-plugin error outcomes; the
 *    rest are surfaced via `warnings`.
 *  - `errored` boolean that callers translate into `status: "error"`.
 *    Repair warnings are nonblocking; smoke failures remain errors on the
 *    explicit update path even though Gateway startup can quarantine them.
 */
export function convergenceWarningsToOutcomes(convergence: PostCoreConvergenceResult): {
  warnings: PostCoreConvergenceWarning[];
  outcomes: Array<{ pluginId: string; status: "error"; message: string }>;
  errored: boolean;
} {
  const outcomes = convergence.warnings
    .filter((w): w is PostCoreConvergenceWarning & { pluginId: string } => Boolean(w.pluginId))
    .map((w) => ({ pluginId: w.pluginId, status: "error" as const, message: w.message }));
  return {
    warnings: [...convergence.warnings, ...(convergence.notices ?? [])],
    outcomes,
    errored: convergence.errored,
  };
}
