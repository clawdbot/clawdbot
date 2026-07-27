import { isLegacyParentWritableUpdateDoctorPass } from "../commands/doctor/shared/update-phase.js";
import { writeConfigMachineState } from "../state/config-machine-state.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";

const loadDoctorStateIntegrityModule = async () =>
  await import("../commands/doctor-state-integrity.js");

export async function runLegacyPluginManifestHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { maybeRepairLegacyPluginManifestContracts } =
    await import("../commands/doctor-plugin-manifests.js");
  await maybeRepairLegacyPluginManifestContracts({
    config: ctx.cfg,
    env: process.env,
    runtime: ctx.runtime,
    prompter: ctx.prompter,
  });
}

export async function runPluginRegistryHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { maybeRepairPluginRegistryState } = await import("../commands/doctor-plugin-registry.js");
  ctx.cfg = await maybeRepairPluginRegistryState({
    config: ctx.cfg,
    env: process.env,
    prompter: ctx.prompter,
  });
}

export async function runReleaseConfiguredPluginInstallsHealth(
  ctx: DoctorHealthFlowContext,
): Promise<void> {
  if (!ctx.sourceConfigValid || !ctx.prompter.shouldRepair) {
    return;
  }
  const { maybeRunConfiguredPluginInstallReleaseStep } =
    await import("../commands/doctor/shared/release-configured-plugin-installs.js");
  const { note } = await import("../../packages/terminal-core/src/note.js");
  const { VERSION } = await import("../version.js");
  const result = await maybeRunConfiguredPluginInstallReleaseStep({
    cfg: ctx.cfg,
    env: ctx.env ?? process.env,
    touchedVersion: ctx.configResult.sourceLastTouchedVersion ?? ctx.cfg.meta?.lastTouchedVersion,
  });
  if (result.postInstallDoctorResult) {
    ctx.postInstallDoctorResult = result.postInstallDoctorResult;
  }
  if (result.changes.length > 0) {
    note(result.changes.join("\n"), "Doctor changes");
  }
  if (result.warnings.length > 0) {
    note(result.warnings.join("\n"), "Doctor warnings");
  }
  if (!result.touchedConfig) {
    return;
  }
  const lastTouchedVersion = isLegacyParentWritableUpdateDoctorPass(ctx.env ?? process.env)
    ? ctx.configResult.sourceLastTouchedVersion?.trim() ||
      ctx.cfg.meta?.lastTouchedVersion ||
      VERSION
    : VERSION;
  ctx.cfg = { ...ctx.cfg, meta: { ...ctx.cfg.meta, lastTouchedVersion } };
  writeConfigMachineState("config.lastTouchedAt", new Date().toISOString());
}

export async function runDiskSpaceHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { noteDiskSpace } = await import("../commands/doctor-disk-space.js");
  noteDiskSpace(ctx.cfg);
}

export async function runDatabaseBloatHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { noteSqliteDatabaseBloat } = await import("../commands/doctor-db-bloat.js");
  noteSqliteDatabaseBloat(ctx.cfg);
}

export async function runChannelIngressDeadLettersHealth(): Promise<void> {
  const { noteChannelIngressDeadLetters } = await import("../commands/doctor-channel-ingress.js");
  noteChannelIngressDeadLetters();
}

export async function runStateIntegrityHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { noteStateIntegrity } = await loadDoctorStateIntegrityModule();
  await noteStateIntegrity(ctx.cfg, ctx.prompter, ctx.configPath);
}

export async function runCodexSessionRouteHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { maybeRepairCodexSessionRoutes } =
    await import("../commands/doctor/shared/codex-route-warnings.js");
  const { note } = await import("../../packages/terminal-core/src/note.js");
  const result = await maybeRepairCodexSessionRoutes({
    cfg: ctx.cfg,
    env: ctx.env ?? process.env,
    shouldRepair: ctx.prompter.shouldRepair,
    ...(ctx.configResult.blockedCodexModelIdentities?.length
      ? { blockedModelIdentities: new Set(ctx.configResult.blockedCodexModelIdentities) }
      : {}),
  });
  if (result.changes.length > 0) {
    note(result.changes.join("\n"), "Doctor changes");
  }
  if (result.warnings.length > 0) {
    note(result.warnings.join("\n"), "Doctor warnings");
  }
}

export async function runSessionLocksHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { noteSessionLockHealth } = await import("../commands/doctor-session-locks.js");
  await noteSessionLockHealth({
    shouldRepair: ctx.prompter.shouldRepair,
    config: ctx.cfg,
    env: ctx.env,
  });
}

export async function runSessionTranscriptsHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { noteSessionTranscriptHealth } = await import("../commands/doctor-session-transcripts.js");
  await noteSessionTranscriptHealth({
    cfg: ctx.cfg,
    env: ctx.env ?? process.env,
    shouldRepair: ctx.prompter.shouldRepair,
  });
}

export async function runSessionTranscriptLabelsHealth(
  ctx: DoctorHealthFlowContext,
): Promise<void> {
  const { noteSessionTranscriptLabelHealth } =
    await import("../commands/doctor-session-transcript-labels.js");
  await noteSessionTranscriptLabelHealth({
    cfg: ctx.cfg,
    env: ctx.env ?? process.env,
    shouldRepair: ctx.prompter.shouldRepair,
  });
}

export async function runSessionSnapshotsHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { noteSessionSnapshotHealth } = await import("../commands/doctor-session-snapshots.js");
  await noteSessionSnapshotHealth({
    cfg: ctx.cfg,
    env: ctx.env ?? process.env,
    shouldRepair: ctx.prompter.shouldRepair,
  });
}

export async function runConfigAuditScrubHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { maybeRepairLegacyRuntimeFiles } = await import("../commands/doctor-usage-cost-cache.js");
  await maybeRepairLegacyRuntimeFiles(ctx.prompter.shouldRepair, ctx.env);
}

export async function runLegacyCronHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { maybeRepairLegacyCronStore, noteLegacyWhatsAppCrontabHealthCheck } =
    await import("../commands/doctor/cron/index.js");
  await noteLegacyWhatsAppCrontabHealthCheck();
  await maybeRepairLegacyCronStore({
    cfg: ctx.cfg,
    options: ctx.options,
    prompter: ctx.prompter,
  });
}

export async function runSandboxHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { maybeRepairSandboxImages, maybeRepairSandboxRegistryFiles, noteSandboxScopeWarnings } =
    await import("../commands/doctor-sandbox.js");
  await maybeRepairSandboxRegistryFiles(ctx.prompter);
  ctx.cfg = await maybeRepairSandboxImages(ctx.cfg, ctx.runtime, ctx.prompter);
  noteSandboxScopeWarnings(ctx.cfg);
}
