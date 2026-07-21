import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { assertExperimentalClawsEnabled } from "../claws/experimental.js";
import { buildClawAddPlan } from "../claws/lifecycle.js";
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

function failNonDryRun(opts: ClawsAddOptions, runtime: RuntimeEnv): boolean {
  if (opts.dryRun) {
    return false;
  }
  const message =
    "Claw add is dry-run only in this OpenClaw build; pass --dry-run to preview lifecycle actions.";
  if (opts.json) {
    writeRuntimeJson(runtime, {
      schemaVersion: CLAW_ADD_PLAN_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      ok: false,
      error: { code: "dry_run_required", message },
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
  const cronStore = await loadCronJobsStoreWithConfigJobsReadOnly(
    resolveCronJobsStorePath(config.cron?.store),
  );
  const plan = await buildClawAddPlan({
    manifest: result.manifest,
    source: result.source,
    snapshot: result.snapshot,
    diagnostics: result.diagnostics,
    context: {
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
      ...(opts.workspace ? { workspace: opts.workspace } : {}),
      existingAgentIds,
      existingWorkspacePaths: existingAgentIds.map((agentId) =>
        resolveAgentWorkspaceDir(config, agentId),
      ),
      existingMcpServerNames: Object.keys(config.mcp?.servers ?? {}),
      existingCronJobIds: cronStore.store.jobs.map((job) => job.id),
    },
  });

  if (opts.json) {
    writeRuntimeJson(runtime, plan);
  } else {
    logExperimentalWarning(runtime);
    runtime.log(`Claw add plan: ${plan.claw.name}@${plan.claw.version}`);
    logClawAddPlanSummary(plan, runtime);
    if (plan.blockers.length > 0) {
      runtime.error(formatDiagnostics(plan.blockers));
    }
  }
  if (plan.blockers.length > 0) {
    runtime.exit(1);
  }
}
