import { repairMissingConfiguredPluginInstalls } from "../../commands/doctor/shared/missing-configured-plugin-install.js";
import { UPDATE_POST_CORE_CONVERGENCE_ENV } from "../../commands/doctor/shared/update-phase.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "../../plugins/config-state.js";
import {
  resolveTrustedSourceLinkedOfficialClawHubSpec,
  resolveTrustedSourceLinkedOfficialNpmSpec,
} from "../../plugins/update.js";
import {
  runPluginPayloadSmokeCheck,
  type PluginPayloadSmokeFailure,
} from "./plugin-payload-validation.js";

export type PostCoreConvergenceWarning = {
  pluginId?: string;
  reason: string;
  message: string;
  guidance: string[];
};

export type PostCoreConvergenceResult = {
  changes: string[];
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

const REPAIR_GUIDANCE = "Run `openclaw doctor --fix` to retry plugin repair.";
const inspectGuidance = (pluginId: string) =>
  `Run \`openclaw plugins inspect ${pluginId} --runtime --json\` for details.`;

/**
 * Mandatory post-core convergence pass. Runs AFTER the core package files
 * are swapped and the in-update doctor pass has already returned, but BEFORE
 * the gateway is restarted. Failures here must block the restart so we
 * never restart with a configured plugin whose payload is unloadable.
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
}): Promise<PostCoreConvergenceResult> {
  const env: NodeJS.ProcessEnv = {
    ...params.env,
    [UPDATE_POST_CORE_CONVERGENCE_ENV]: "1",
  };

  const repair = await repairMissingConfiguredPluginInstalls({
    cfg: params.cfg,
    env,
    ...(params.baselineInstallRecords ? { baselineRecords: params.baselineInstallRecords } : {}),
  });

  const warnings: PostCoreConvergenceWarning[] = repair.warnings.map((message) => ({
    reason: message,
    message,
    guidance: [REPAIR_GUIDANCE],
  }));

  const records: Record<string, PluginInstallRecord> = repair.records;
  // Filter the smoke-check input to active records ONLY: configured /
  // enabled plugins, plus trusted-source-linked official sync targets
  // (mirroring the existing `collectMissingPluginInstallPayloads` policy
  // at update-command.ts:~218 with `skipDisabledPlugins: true`). Without
  // this filter, a stale install record for a disabled or no-longer-
  // configured plugin whose payload was deleted on disk would block the
  // entire update — even though the gateway will never load that plugin.
  const smokeRecords = filterRecordsToActive({ cfg: params.cfg, records });
  const smoke = await runPluginPayloadSmokeCheck({ records: smokeRecords, env });
  for (const failure of smoke.failures) {
    warnings.push({
      pluginId: failure.pluginId,
      reason: `${failure.reason}: ${failure.detail}`,
      message: `Plugin "${failure.pluginId}" failed post-core payload smoke check (${failure.reason}): ${failure.detail}`,
      guidance: [REPAIR_GUIDANCE, inspectGuidance(failure.pluginId)],
    });
  }

  return {
    changes: repair.changes,
    warnings,
    errored: warnings.length > 0,
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
export function filterRecordsToActive(params: {
  cfg: OpenClawConfig;
  records: Record<string, PluginInstallRecord>;
}): Record<string, PluginInstallRecord> {
  const normalizedPluginConfig = normalizePluginsConfig(params.cfg.plugins);
  const filtered: Record<string, PluginInstallRecord> = {};
  for (const [pluginId, record] of Object.entries(params.records)) {
    if (!record || typeof record !== "object") {
      continue;
    }
    const enableState = resolveEffectiveEnableState({
      id: pluginId,
      origin: "global",
      config: normalizedPluginConfig,
      rootConfig: params.cfg,
    });
    if (enableState.enabled) {
      filtered[pluginId] = record;
      continue;
    }
    // Even when disabled, retain trusted-source-linked official installs
    // because the existing post-update sync path treats them as
    // authoritative regardless of the entry's enable flag.
    const officialNpm = resolveTrustedSourceLinkedOfficialNpmSpec({ pluginId, record });
    const officialClawHub = resolveTrustedSourceLinkedOfficialClawHubSpec({ pluginId, record });
    if (officialNpm || officialClawHub) {
      filtered[pluginId] = record;
    }
  }
  return filtered;
}

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
    warnings: convergence.warnings,
    outcomes,
    errored: convergence.errored,
  };
}
