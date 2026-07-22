import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { stableStringify } from "../agents/stable-stringify.js";
import {
  applyClawAddPlan,
  CLAW_ADD_RESULT_SCHEMA_VERSION,
  ClawAddMutationError,
} from "../claws/add.js";
import { assertExperimentalClawsEnabled } from "../claws/experimental.js";
import { buildClawAddPlan } from "../claws/lifecycle.js";
import { readClawInstallRecord } from "../claws/provenance.js";
import { readClawManifestFile } from "../claws/reader.js";
import {
  CLAW_INSPECT_RESULT_SCHEMA_VERSION,
  CLAW_ADD_PLAN_SCHEMA_VERSION,
  CLAW_OUTPUT_STABILITY,
  type ClawAddPlan,
} from "../claws/types.js";
// Runtime handlers for experimental local Claws commands.
import { getRuntimeConfig } from "../config/config.js";
import {
  loadCronJobsStoreWithConfigJobsReadOnly,
  resolveCronJobsStorePath,
} from "../cron/store.js";
import { redactSensitiveText } from "../logging/redact.js";
import { defaultRuntime, writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import type { ClawsAddOptions, ClawsInspectOptions } from "./claws-cli.js";

type DiagnosticLike = { level: string; code: string; path: string; message: string };

function formatDiagnostics(diagnostics: DiagnosticLike[]): string {
  return diagnostics
    .map(
      (diagnostic) =>
        `${diagnostic.level.toUpperCase()} ${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`,
    )
    .join("\n");
}

function logExperimentalWarning(runtime: RuntimeEnv): void {
  runtime.log("Experimental: Claws contracts may change while RFC 0016 is under review.");
}

function logClawAddPlanSummary(plan: ClawAddPlan, runtime: RuntimeEnv): void {
  runtime.log(`Agent: ${plan.agent.finalId}`);
  runtime.log(`Workspace: ${plan.agent.workspace}`);
  runtime.log(`Actions: ${plan.summary.totalActions}`);
  runtime.log(`Packages: ${plan.summary.packageActions}`);
  runtime.log(`MCP servers: ${plan.summary.mcpServerActions}`);
  runtime.log(`Cron jobs: ${plan.summary.cronJobActions}`);
  if (plan.capabilityChanges.length > 0) {
    runtime.log(`Capability escalations (${plan.capabilityChanges.length}):`);
    for (const change of plan.capabilityChanges) {
      runtime.log(
        redactSensitiveText(`  ! ${change.kind}:${change.id} ${JSON.stringify(change.effect)}`),
      );
    }
    runtime.log("The plan integrity binds every capability line above.");
  }
  if (plan.summary.blockedActions > 0) {
    runtime.log(`Blocked actions: ${plan.summary.blockedActions}`);
  }
}

function matchingResumeRecord(plan: ClawAddPlan, opts: ClawsAddOptions) {
  if (opts.dryRun || !opts.yes || !opts.planIntegrity) {
    return undefined;
  }
  const record = readClawInstallRecord(plan.agent.finalId);
  if (
    !record ||
    record.status === "complete" ||
    record.planIntegrity !== opts.planIntegrity ||
    record.workspace !== plan.agent.workspace ||
    record.claw.kind !== plan.claw.kind ||
    record.claw.name !== plan.claw.name ||
    record.claw.version !== plan.claw.version ||
    record.claw.integrity !== plan.claw.integrity
  ) {
    return undefined;
  }
  return record;
}

function failNonDryRun(opts: ClawsAddOptions, runtime: RuntimeEnv): boolean {
  if (opts.dryRun) {
    return false;
  }
  const consented = opts.yes && opts.planIntegrity;
  if (consented) {
    return false;
  }
  const code = opts.yes ? "plan_integrity_required" : "consent_required";
  const message = opts.yes
    ? "Claw add consent must include --plan-integrity from the exact dry-run plan."
    : "Claw add requires explicit consent; pass --dry-run to preview or --yes with --plan-integrity to create the new agent and workspace.";
  if (opts.json) {
    writeRuntimeJson(runtime, {
      schemaVersion: CLAW_ADD_PLAN_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      ok: false,
      error: { code, message },
    });
  } else {
    runtime.error(message);
  }
  runtime.exit(1);
  return true;
}

export async function runClawsInspectCommand(
  sourcePath: string,
  opts: ClawsInspectOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  assertExperimentalClawsEnabled();
  const result = await readClawManifestFile(sourcePath);
  if (!result.ok) {
    if (opts.json) {
      writeRuntimeJson(runtime, {
        schemaVersion: CLAW_INSPECT_RESULT_SCHEMA_VERSION,
        stability: CLAW_OUTPUT_STABILITY,
        valid: false,
        diagnostics: result.diagnostics,
      });
    } else {
      runtime.error(formatDiagnostics(result.diagnostics));
    }
    runtime.exit(1);
    return;
  }

  const payload = {
    schemaVersion: CLAW_INSPECT_RESULT_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    valid: true,
    source: result.source,
    manifest: result.manifest,
    diagnostics: result.diagnostics,
  };
  if (opts.json) {
    writeRuntimeJson(runtime, payload);
    return;
  }
  logExperimentalWarning(runtime);
  runtime.log(`Claw: ${result.source.name}@${result.source.version}`);
  runtime.log(`Agent: ${result.manifest.agent.name ?? result.manifest.agent.id}`);
  runtime.log(`Packages: ${result.manifest.packages.length}`);
  runtime.log(`MCP servers: ${Object.keys(result.manifest.mcpServers).length}`);
  runtime.log(`Cron jobs: ${result.manifest.cronJobs.length}`);
}

export async function runClawsAddCommand(
  sourcePath: string,
  opts: ClawsAddOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  assertExperimentalClawsEnabled();
  if (failNonDryRun(opts, runtime)) {
    return;
  }
  const result = await readClawManifestFile(sourcePath);
  if (!result.ok) {
    if (opts.json) {
      writeRuntimeJson(runtime, {
        schemaVersion: CLAW_ADD_PLAN_SCHEMA_VERSION,
        stability: CLAW_OUTPUT_STABILITY,
        valid: false,
        diagnostics: result.diagnostics,
      });
    } else {
      runtime.error(formatDiagnostics(result.diagnostics));
    }
    runtime.exit(1);
    return;
  }

  const config = getRuntimeConfig();
  const existingAgentIds = listAgentIds(config);
  const existingWorkspacePaths = existingAgentIds.map((agentId) =>
    resolveAgentWorkspaceDir(config, agentId),
  );
  const cronStore = await loadCronJobsStoreWithConfigJobsReadOnly(
    resolveCronJobsStorePath(config.cron?.store),
  );
  const basePlanContext = {
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
    ...(opts.workspace ? { workspace: opts.workspace } : {}),
    existingAgentIds,
    existingWorkspacePaths,
    existingMcpServerNames: Object.keys(config.mcp?.servers ?? {}),
    existingCronJobIds: cronStore.store.jobs.map((job) => job.id),
  };
  let plan = await buildClawAddPlan({
    manifest: result.manifest,
    source: result.source,
    diagnostics: result.diagnostics,
    context: basePlanContext,
  });
  const resumeRecord = matchingResumeRecord(plan, opts);
  if (resumeRecord && plan.blockers.length > 0) {
    const canResumeWorkspace =
      resumeRecord.status === "workspace_ready" || resumeRecord.status === "config_committed";
    const committedAgent = config.agents?.list?.find(
      (agent) => stableStringify(agent) === stableStringify(plan.agent.config),
    );
    const canResumeAgent =
      resumeRecord.status === "config_committed" ||
      (resumeRecord.status === "workspace_ready" && committedAgent !== undefined);
    plan = await buildClawAddPlan({
      manifest: result.manifest,
      source: result.source,
      diagnostics: result.diagnostics,
      context: {
        ...basePlanContext,
        existingAgentIds: canResumeAgent
          ? existingAgentIds.filter((agentId) => agentId !== resumeRecord.agentId)
          : existingAgentIds,
        existingWorkspacePaths: canResumeWorkspace
          ? existingAgentIds
              .filter((agentId) => agentId !== resumeRecord.agentId)
              .map((agentId) => resolveAgentWorkspaceDir(config, agentId))
          : existingWorkspacePaths,
        ...(canResumeWorkspace ? { resumableWorkspace: resumeRecord.workspace } : {}),
      },
    });
  }

  if (plan.blockers.length > 0) {
    if (opts.json) {
      writeRuntimeJson(runtime, plan);
    } else {
      logExperimentalWarning(runtime);
      logClawAddPlanSummary(plan, runtime);
      runtime.error(formatDiagnostics(plan.blockers));
    }
    runtime.exit(1);
    return;
  }

  if (opts.dryRun) {
    if (opts.json) {
      writeRuntimeJson(runtime, plan);
    } else {
      logExperimentalWarning(runtime);
      runtime.log(`Claw add plan: ${plan.claw.name}@${plan.claw.version}`);
      logClawAddPlanSummary(plan, runtime);
    }
    return;
  }

  if (opts.planIntegrity !== plan.planIntegrity) {
    const message = "The consented Claw plan no longer matches; run add --dry-run again.";
    if (opts.json) {
      writeRuntimeJson(runtime, {
        schemaVersion: CLAW_ADD_RESULT_SCHEMA_VERSION,
        stability: CLAW_OUTPUT_STABILITY,
        status: "failed",
        planIntegrity: plan.planIntegrity,
        error: { code: "plan_integrity_mismatch", message },
      });
    } else {
      runtime.error(message);
    }
    runtime.exit(1);
    return;
  }

  let addResult;
  try {
    addResult = await applyClawAddPlan(plan, { consentPlanIntegrity: opts.planIntegrity });
  } catch (error) {
    const code = error instanceof ClawAddMutationError ? error.code : "add_failed";
    const message = (error as Error).message;
    if (opts.json) {
      writeRuntimeJson(runtime, {
        schemaVersion: CLAW_ADD_RESULT_SCHEMA_VERSION,
        stability: CLAW_OUTPUT_STABILITY,
        status: "failed",
        error: { code, message },
      });
    } else {
      runtime.error(message);
    }
    runtime.exit(1);
    return;
  }

  if (opts.json) {
    writeRuntimeJson(runtime, addResult);
  } else {
    logExperimentalWarning(runtime);
    runtime.log(`Added agent: ${addResult.agent.finalId}`);
    runtime.log(`Workspace: ${addResult.agent.workspace}`);
    runtime.log(`Status: ${addResult.status}`);
  }
  if (addResult.status !== "complete") {
    runtime.exit(1);
  }
}
