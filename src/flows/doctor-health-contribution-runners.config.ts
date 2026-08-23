import fs from "node:fs";
import nodePath from "node:path";
import { UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV } from "../commands/doctor/shared/update-phase.js";
import { resolveIsNixMode } from "../config/paths.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";
import {
  isUpdateDoctorRun,
  resolveDoctorMode,
  resolveLegacyParentVersionOverride,
} from "./doctor-health-contribution-utils.js";
import type { HealthCheckContext, HealthFinding } from "./health-checks.js";

function isExplicitOptOutEnvValue(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  // Update handoff predates canonical opt-in flags: every non-false value means the
  // parent opted in, so preserve its broad acceptance until that protocol is retired.
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

function shouldSkipLegacyUpdateDoctorConfigWrite(env: NodeJS.ProcessEnv): boolean {
  return (
    isExplicitOptOutEnvValue(env.OPENCLAW_UPDATE_IN_PROGRESS) &&
    !isExplicitOptOutEnvValue(env[UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV])
  );
}

export async function runWriteConfigHealth(
  ctx: DoctorHealthFlowContext,
  options: { runPostWriteRepairs?: boolean } = {},
): Promise<void> {
  if (ctx.configWriteRefusal) {
    // The initial write already reported the refusal; retrying the
    // same candidate would fail identically and duplicate the warning.
    return;
  }
  const { applyWizardMetadata } = await import("../commands/onboard-helpers.js");
  const { replaceConfigFile } = await import("../config/config.js");
  const { logConfigUpdated } = await import("../config/logging.js");
  const { shortenHomePath } = await import("../utils.js");
  const configResultWritePending =
    ctx.configResult.shouldWriteConfig === true && ctx.configResultWriteCommitted !== true;
  const shouldWriteConfig =
    configResultWritePending || JSON.stringify(ctx.cfg) !== JSON.stringify(ctx.cfgForPersistence);
  if (shouldWriteConfig) {
    const updateDoctorRun = isUpdateDoctorRun(ctx.env ?? process.env);
    if (ctx.configResult.skipWizardMetadataForIncludeWrite !== true) {
      ctx.cfg = applyWizardMetadata(ctx.cfg, {
        command: "doctor",
        mode: resolveDoctorMode(ctx.cfg),
      });
    }
    if (shouldSkipLegacyUpdateDoctorConfigWrite(ctx.env ?? process.env)) {
      ctx.runtime.log("Skipping doctor config write during legacy update handoff.");
      return;
    }
    const legacyParentVersionOverride =
      resolveLegacyParentVersionOverride(ctx).lastTouchedVersionOverride;
    try {
      await replaceConfigFile({
        nextConfig: ctx.cfg,
        afterWrite: { mode: "auto" },
        writeOptions: {
          auditOrigin: "doctor",
          allowConfigSizeDrop: ctx.configResult.shouldWriteConfig === true || updateDoctorRun,
          skipPluginValidation:
            ctx.configResult.skipPluginValidationOnWrite === true || updateDoctorRun,
          ...(configResultWritePending && ctx.configResult.explicitSetPaths
            ? { explicitSetPaths: ctx.configResult.explicitSetPaths }
            : {}),
          preservedLegacyRootKeys: ctx.configResult.preservedLegacyRootKeys,
          ...(legacyParentVersionOverride
            ? { lastTouchedVersionOverride: legacyParentVersionOverride }
            : {}),
        },
      });
    } catch (error) {
      const { isConfigValidationFailedError } = await import("../config/io.write-errors.js");
      if (isConfigValidationFailedError(error)) {
        // This refused write persisted nothing. Queued "Doctor changes" panels stay
        // unprinted: reporting them would claim repairs that never reached disk.
        // An earlier pass through this shared runner may have already committed, so
        // describe only the pending write as unpersisted, never the whole run.
        const { note } = await import("../../packages/terminal-core/src/note.js");
        const { formatConfigIssueLines } = await import("../config/issue-format.js");
        const issueLines = Array.isArray(error.issues)
          ? formatConfigIssueLines(error.issues, "-", { normalizeRoot: true })
          : [error.message];
        const unpersistedLine =
          ctx.configResultWriteCommitted === true
            ? "Earlier config fixes were already saved; the remaining changes were not written."
            : "No config changes were written.";
        note(
          [
            "Doctor could not apply config fixes: the repaired config still fails validation.",
            ...issueLines,
            `${unpersistedLine} Fix the value(s) above in ${shortenHomePath(ctx.configPath)} by hand, then rerun "openclaw doctor --fix".`,
          ].join("\n"),
          "Doctor warnings",
        );
        ctx.configWriteRefusal = "validation";
        return;
      }
      const { isCronOwnerWriteRefusalError } = await import("../config/io.cron-owner-refusal.js");
      if (!isCronOwnerWriteRefusalError(error)) {
        throw error;
      }
      const { note } = await import("../../packages/terminal-core/src/note.js");
      note(
        [
          error.message,
          "Doctor left the config unchanged, preserving any retained legacy owner for a later repair.",
          'Resolve the reported Gateway or cron-store condition, then rerun "openclaw doctor --fix".',
        ].join("\n"),
        "Doctor warnings",
      );
      ctx.configWriteRefusal = "cron-owner-safety";
      return;
    }
    // The atomic write committed: repair panels queued by the config flow are now
    // true statements about disk state, so print them exactly once.
    const pendingChangePanels = ctx.configResult.pendingChangePanels;
    if (pendingChangePanels?.length) {
      const { note } = await import("../../packages/terminal-core/src/note.js");
      for (const panel of pendingChangePanels) {
        note(panel, "Doctor changes");
      }
      delete ctx.configResult.pendingChangePanels;
    }
    // The final writer runs again after health repairs. Advance its baseline only
    // after the atomic write succeeds so later failures cannot mark volatile state durable.
    ctx.cfgForPersistence = structuredClone(ctx.cfg);
    if (ctx.configResult.shouldWriteConfig === true) {
      ctx.configResultWriteCommitted = true;
    }
    // logConfigUpdated already prints the `.bak` backup line when it exists.
    logConfigUpdated(ctx.runtime);
    const preUpdateSnapshotPath = `${ctx.configPath}.pre-update`;
    if (updateDoctorRun && fs.existsSync(preUpdateSnapshotPath)) {
      ctx.runtime.log(
        `Update changed config; pre-update backup: ${shortenHomePath(preUpdateSnapshotPath)}`,
      );
    }
  }
  if (options.runPostWriteRepairs === false) {
    return;
  }
  if (ctx.configResult.retiredPhoneControlStateCleanupPending === true) {
    const { finalizeRetiredPhoneControlCleanup } =
      await import("../commands/doctor-retired-phone-control.js");
    const { note } = await import("../../packages/terminal-core/src/note.js");
    const cleanup = await finalizeRetiredPhoneControlCleanup({ env: ctx.env ?? process.env });
    if (cleanup.changes.length > 0) {
      note(cleanup.changes.join("\n"), "Doctor changes");
    }
    if (cleanup.warnings.length > 0) {
      note(cleanup.warnings.join("\n"), "Doctor warnings");
    }
  }
  if (
    ctx.configResult.shouldRepairCronCodexModelRefsAfterConfigWrite !== true ||
    ctx.postConfigWriteRepairsCommitted === true
  ) {
    return;
  }
  // The config write above must finish before cron rows are rewritten against
  // the now-durable model policy; otherwise a failed write could corrupt them.
  const { repairCronCodexModelRefsAfterConfigWrite } =
    await import("../commands/doctor/cron/legacy-repair.js");
  const result = await repairCronCodexModelRefsAfterConfigWrite({
    cfg: ctx.cfg,
    ...(ctx.configResult.blockedCodexModelIdentities?.length
      ? { blockedModelIdentities: new Set(ctx.configResult.blockedCodexModelIdentities) }
      : {}),
  });
  ctx.postConfigWriteRepairsCommitted = true;
  const { note } = await import("../../packages/terminal-core/src/note.js");
  if (result.changes.length > 0) {
    note(result.changes.join("\n"), "Doctor changes");
  }
  if (result.warnings.length > 0) {
    note(result.warnings.join("\n"), "Doctor warnings");
  }
}

/** Commits the finalized config-flow candidate before fallible health diagnostics start. */
export async function runInitialConfigWriteHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  if (ctx.configResult.shouldWriteConfig !== true) {
    return;
  }
  await runWriteConfigHealth(ctx, { runPostWriteRepairs: false });
}

export async function collectWriteConfigHealthFindings(
  ctx: HealthCheckContext,
): Promise<readonly HealthFinding[]> {
  const findings: HealthFinding[] = [];
  const configPath = ctx.configPath;
  if (resolveIsNixMode(process.env)) {
    findings.push({
      checkId: "core/doctor/write-config",
      severity: "warning",
      message: "Doctor config writes are disabled because OpenClaw is running in Nix mode.",
      ...(configPath ? { path: configPath } : {}),
      requirement: "mutable-config-write-path",
      fixHint:
        "Edit the Nix source for this install and rebuild; do not run doctor --fix against this config file.",
    });
  }
  if (!configPath) {
    return findings;
  }
  const configDirectory = nodePath.dirname(configPath);
  const configPathExists = fs.existsSync(configPath);
  const existingParent = configPathExists
    ? configDirectory
    : findNearestExistingParent(configDirectory);
  if (!isDirectoryPath(existingParent)) {
    findings.push({
      checkId: "core/doctor/write-config",
      severity: "warning",
      message: "Doctor cannot create the config directory because a path component is a file.",
      path: existingParent,
      target: configDirectory,
      requirement: "config-directory-path",
      fixHint: "Move the file blocking the config directory path before running doctor --fix.",
    });
    return findings;
  }
  try {
    fs.accessSync(existingParent, fs.constants.W_OK | fs.constants.X_OK);
  } catch {
    findings.push({
      checkId: "core/doctor/write-config",
      severity: "warning",
      message: configPathExists
        ? "Doctor cannot write config because the config directory is not writable."
        : "Doctor cannot create the config directory because the nearest existing parent is not writable.",
      path: existingParent,
      target: configPathExists ? configPath : configDirectory,
      requirement: "writable-config-directory",
      fixHint:
        "Make the existing config directory or parent directory writable before running doctor --fix.",
    });
  }
  return findings;
}

function findNearestExistingParent(path: string): string {
  let candidate = path;
  while (!pathEntryExists(candidate)) {
    const parent = nodePath.dirname(candidate);
    if (parent === candidate) {
      return candidate;
    }
    candidate = parent;
  }
  return candidate;
}

function pathEntryExists(path: string): boolean {
  if (fs.existsSync(path)) {
    return true;
  }
  try {
    fs.lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isDirectoryPath(path: string): boolean {
  try {
    return fs.statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export async function runFinalConfigValidationHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { readConfigFileSnapshot } = await import("../config/config.js");
  const finalSnapshot = await readConfigFileSnapshot({
    skipPluginValidation: isUpdateDoctorRun(ctx.env ?? process.env),
    preservedLegacyRootKeys: ctx.configResult.preservedLegacyRootKeys,
  });
  if (finalSnapshot.exists && !finalSnapshot.valid) {
    ctx.runtime.error("Invalid config:");
    for (const issue of finalSnapshot.issues) {
      ctx.runtime.error(`- ${issue.path || "<root>"}: ${issue.message}`);
    }
  }
}
