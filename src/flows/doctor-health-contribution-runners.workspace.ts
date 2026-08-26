import type { DoctorOptions } from "../commands/doctor-prompter.js";
import { shouldManageGatewayService } from "../commands/doctor-service-repair-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";
import { resolveDoctorWorkspaceSuggestionScopes } from "./doctor-workspace-suggestion-scopes.js";
import type { HealthCheckContext, HealthFinding } from "./health-checks.js";

type PluginVersionDriftReport =
  import("../plugins/plugin-version-drift.js").PluginVersionDriftReport;

const loadDoctorStateIntegrityModule = async () =>
  await import("../commands/doctor-state-integrity.js");

export async function runActiveToolSchemaWarningsHealth(
  ctx: DoctorHealthFlowContext,
): Promise<void> {
  // Preview mode already collects these while deciding whether to apply repairs.
  // Repair mode defers the runtime-backed diagnostic until migrations are durable.
  if (!ctx.prompter.shouldRepair) {
    return;
  }
  const { collectActiveToolSchemaProjectionWarnings } =
    await import("../commands/doctor/shared/active-tool-schema-warnings.js");
  const warnings = await collectActiveToolSchemaProjectionWarnings({
    cfg: ctx.cfg,
    env: ctx.env ?? process.env,
    ...(ctx.runWithPluginMetadataSnapshot
      ? { runWithPluginMetadataSnapshot: ctx.runWithPluginMetadataSnapshot }
      : {}),
  });
  if (warnings.length === 0) {
    return;
  }
  const { note } = await import("../../packages/terminal-core/src/note.js");
  note(warnings.join("\n"), "Doctor warnings");
}

export async function runHooksModelHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  if (!ctx.cfg.hooks?.gmail?.model?.trim()) {
    return;
  }
  const { DEFAULT_MODEL, DEFAULT_PROVIDER } = await import("../agents/defaults.js");
  const { loadPreparedModelCatalog } = await import("../agents/prepared-model-catalog.js");
  const { getModelRefStatus, resolveConfiguredModelRef, resolveHooksGmailModel } =
    await import("../agents/model-selection.js");
  const { note } = await import("../../packages/terminal-core/src/note.js");
  const hooksModelRef = resolveHooksGmailModel({ cfg: ctx.cfg, defaultProvider: DEFAULT_PROVIDER });
  if (!hooksModelRef) {
    note(`- hooks.gmail.model "${ctx.cfg.hooks.gmail.model}" could not be resolved`, "Hooks");
    return;
  }
  const { provider: defaultProvider, model: defaultModel } = resolveConfiguredModelRef({
    cfg: ctx.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const catalog = await loadPreparedModelCatalog({
    config: ctx.cfg,
    readOnly: true,
    providerDiscoveryProviderIds: [],
  });
  const status = getModelRefStatus({
    cfg: ctx.cfg,
    catalog,
    ref: hooksModelRef,
    defaultProvider,
    defaultModel,
  });
  const warnings: string[] = [];
  if (!status.allowed) {
    warnings.push(
      `- hooks.gmail.model "${status.key}" not allowed by agents.defaults.modelPolicy.allow (will use primary instead)`,
    );
  }
  if (!status.inCatalog) {
    warnings.push(
      `- hooks.gmail.model "${status.key}" not in the model catalog (may fail at runtime)`,
    );
  }
  if (warnings.length > 0) {
    note(warnings.join("\n"), "Hooks");
  }
}

export async function collectWorkspaceStatusPluginVersionDrift(params: {
  cfg: OpenClawConfig;
  options?: Pick<DoctorOptions, "allowExec" | "deep" | "nonInteractive">;
}): Promise<PluginVersionDriftReport | undefined> {
  if (params.cfg.gateway?.mode === "remote" || !(await shouldManageGatewayService())) {
    return undefined;
  }
  try {
    const { gatherDaemonStatus } = await import("../cli/daemon-cli/status.gather.js");
    const status = await gatherDaemonStatus({
      rpc: { timeout: params.options?.nonInteractive === true ? "3000" : "10000", json: true },
      probe: true,
      requireRpc: false,
      deep: params.options?.deep === true,
      allowExecSecretRefs: params.options?.allowExec === true,
    });
    const hasProbedGatewayVersion =
      typeof status.gateway?.version === "string" && status.gateway.version.trim() !== "";
    if (status.pluginVersionDrift && hasProbedGatewayVersion && !status.rpc?.authWarning) {
      return status.pluginVersionDrift;
    }
  } catch {
    // Best-effort diagnostic: doctor should keep running if daemon status is unavailable.
  }
  return undefined;
}

export async function runWorkspaceStatusHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const pluginVersionDrift = await collectWorkspaceStatusPluginVersionDrift({
    cfg: ctx.cfg,
    options: ctx.options,
  });
  const { noteWorkspaceStatus } = await import("../commands/doctor-workspace-status.js");
  noteWorkspaceStatus(ctx.cfg, {
    pluginVersionDrift,
    ...(ctx.runWithPluginMetadataSnapshot
      ? { runWithPluginMetadataSnapshot: ctx.runWithPluginMetadataSnapshot }
      : {}),
  });
}

export async function runSkillsHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { maybeRepairSkillReadiness } = await import("../commands/doctor-skills.js");
  ctx.cfg = await maybeRepairSkillReadiness({
    cfg: ctx.cfg,
    prompter: ctx.prompter,
    ...(ctx.runWithPluginMetadataSnapshot
      ? { runWithPluginMetadataSnapshot: ctx.runWithPluginMetadataSnapshot }
      : {}),
  });
}

export async function runBootstrapSizeHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { noteBootstrapFileSize } = await import("../commands/doctor-bootstrap-size.js");
  await noteBootstrapFileSize(ctx.cfg);
}

export async function runHeartbeatCadenceMigrationHealth(
  ctx: DoctorHealthFlowContext,
): Promise<void> {
  const { maybeMigrateHeartbeatCadenceToCron } =
    await import("../commands/doctor-heartbeat-cadence-migration.js");
  await maybeMigrateHeartbeatCadenceToCron({
    cfg: ctx.cfg,
    shouldRepair: ctx.prompter.shouldRepair,
    env: ctx.env,
  });
}

export async function runHeartbeatScratchMigrationHealth(
  ctx: DoctorHealthFlowContext,
): Promise<void> {
  const { maybeMigrateHeartbeatFilesToScratch } =
    await import("../commands/doctor-heartbeat-scratch-migration.js");
  await maybeMigrateHeartbeatFilesToScratch({
    cfg: ctx.cfg,
    shouldRepair: ctx.prompter.shouldRepair,
    env: ctx.env,
  });
}

export async function runToolsMdMigrationHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { maybeMigrateToolsMd } = await import("../commands/doctor-tools-md-migration.js");
  await maybeMigrateToolsMd({
    cfg: ctx.cfg,
    shouldRepair: ctx.prompter.shouldRepair,
    env: ctx.env,
  });
}

export async function runHeartbeatTaskMigrationHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { maybeMigrateHeartbeatTasksToCron } =
    await import("../commands/doctor-heartbeat-task-migration.js");
  await maybeMigrateHeartbeatTasksToCron({
    cfg: ctx.cfg,
    shouldRepair: ctx.prompter.shouldRepair,
    env: ctx.env,
  });
}

export async function runMemorySearchHealthContribution(
  ctx: DoctorHealthFlowContext,
): Promise<void> {
  const { maybeRepairMemoryRecallHealth, noteMemoryRecallHealth, noteMemorySearchHealth } =
    await import("../commands/doctor-memory-search.js");
  if (ctx.prompter.shouldRepair) {
    await maybeRepairMemoryRecallHealth({ cfg: ctx.cfg, prompter: ctx.prompter });
  }
  await noteMemorySearchHealth(ctx.cfg, {
    gatewayMemoryProbe: ctx.gatewayMemoryProbe ?? { checked: false, ready: false, skipped: false },
  });
  if (ctx.options.deep === true) {
    await noteMemoryRecallHealth(ctx.cfg);
  }
}

function memorySearchNoteToFinding(message: string): HealthFinding | null {
  const lines = message.split("\n");
  const firstLine = (lines[0] ?? message).trim();
  if (firstLine === "Memory search is explicitly disabled (enabled: false).") {
    return null;
  }
  const fixHint = lines
    .slice(1)
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
  let path = "memory.search.provider";
  if (firstLine.includes("No active memory plugin")) {
    path = "plugins.slots.memory";
  } else if (firstLine.includes("OpenAI-compatible embeddings endpoint")) {
    path = "memory.search.remote.baseUrl";
  } else if (firstLine.includes("OpenAI-compatible embedding model")) {
    path = "memory.search.model";
  }
  return {
    checkId: "core/doctor/memory-search",
    severity: "warning",
    message: firstLine,
    path,
    ...(fixHint ? { fixHint } : {}),
  };
}

export async function collectMemorySearchHealthFindings(
  ctx: HealthCheckContext,
): Promise<readonly HealthFinding[]> {
  const { noteMemorySearchHealth } = await import("../commands/doctor-memory-search.js");
  const notes: string[] = [];
  await noteMemorySearchHealth(ctx.cfg, {
    includeWorkspaceMemoryHealth: false,
    skipAuthProfileResolution: true,
    gatewayMemoryProbe: { checked: false, ready: false, skipped: true },
    noteFn: (message) => notes.push(String(message)),
  });
  return notes.flatMap((message) => {
    const finding = memorySearchNoteToFinding(message);
    return finding ? [finding] : [];
  });
}

export async function runWorkspaceSuggestionsHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  if (ctx.options.workspaceSuggestions === false) {
    return;
  }
  const { collectWorkspaceBackupTip } = await loadDoctorStateIntegrityModule();
  const { MEMORY_SYSTEM_PROMPT, shouldSuggestMemorySystem } =
    await import("../commands/doctor-workspace.js");
  const { note } = await import("../../packages/terminal-core/src/note.js");
  for (const { agentId, workspaceDir, labelAgent } of resolveDoctorWorkspaceSuggestionScopes(
    ctx.cfg,
  )) {
    const prefix = labelAgent ? `Agent "${agentId}": ` : "";
    const backupTip = collectWorkspaceBackupTip(workspaceDir);
    if (backupTip) {
      note(`${prefix}${backupTip}`, "Workspace");
    }
    if (await shouldSuggestMemorySystem(workspaceDir)) {
      note(`${prefix}${MEMORY_SYSTEM_PROMPT}`, "Workspace");
    }
  }
}
