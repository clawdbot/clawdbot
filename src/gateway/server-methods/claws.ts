// Claw gateway methods expose secret-safe lifecycle inventory to trusted operator clients.
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  type ClawResourceStatus,
  type ClawStatusEntry,
  type ClawsAddApplyParams,
  type ClawsAddPlanParams,
  type ClawsCatalogDetailParams,
  type ClawsCatalogSearchParams,
  type ClawsRemoveApplyParams,
  type ClawsRemovePlanParams,
  type ClawsUpdateApplyParams,
  type ClawsUpdatePlanParams,
  type ValidationError,
  type ClawsDoctorResult,
  type ClawsStatusParams,
  type ClawsStatusResult,
  validateClawsAddApplyParams,
  validateClawsAddPlanParams,
  validateClawsCatalogDetailParams,
  validateClawsCatalogSearchParams,
  validateClawsDoctorParams,
  validateClawsRemoveApplyParams,
  validateClawsRemovePlanParams,
  validateClawsUpdateApplyParams,
  validateClawsUpdatePlanParams,
  validateClawsStatusParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { readClawHubClawDetail, searchClawHubClaws } from "../../claws/clawhub-source.js";
import {
  applyClawAddFromCatalog,
  applyClawRemove,
  applyClawUpdate,
  planClawAddFromCatalog,
  planClawRemove,
  planClawUpdate,
} from "../../claws/control-ui-lifecycle.js";
import { collectClawStateHealthFindings } from "../../claws/doctor.js";
import { assertExperimentalClawsEnabled } from "../../claws/experimental.js";
import { readClawStatus, type ClawStatusRecord } from "../../claws/lifecycle-state.js";
import type { HealthFinding } from "../../flows/health-checks.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { formatError } from "../server-utils.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

const STATUS_SCHEMA_VERSION = "openclaw.clawsGatewayStatus.v1" as const;
const DOCTOR_SCHEMA_VERSION = "openclaw.clawsGatewayDoctor.v1" as const;
const log = createSubsystemLogger("gateway/claws");

function requireClawsEnabled(respond: RespondFn): boolean {
  try {
    assertExperimentalClawsEnabled();
    return true;
  } catch (error) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        error instanceof Error ? error.message : String(error),
      ),
    );
    return false;
  }
}

function invalidParams(
  method: string,
  errors: ValidationError[] | null | undefined,
  respond: RespondFn,
): void {
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `invalid ${method} params: ${formatValidationErrors(errors)}`,
    ),
  );
}

async function respondWithLifecycleResult(
  method: string,
  respond: RespondFn,
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    respond(true, await operation());
  } catch (error) {
    const message = formatError(error);
    log.error(`${method} failed: ${message}`);
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        error instanceof Error && error.message.includes("preview it again")
          ? error.message
          : "Claw lifecycle request failed. Review Gateway logs and retry.",
      ),
    );
  }
}

function projectResourceStatus(record: ClawStatusRecord): ClawResourceStatus[] {
  return [
    {
      kind: "agent",
      id: record.install.agentId,
      state: record.agentState,
      relationship: "managed",
      origin: "claw-introduced",
      independentOwner: false,
    },
    ...record.workspaceFiles.map((file) => ({
      kind: "workspace-file" as const,
      id: file.path,
      state: file.state,
      relationship: "managed" as const,
      origin: "claw-introduced" as const,
      independentOwner: false,
    })),
    ...record.packages.map((pkg) => ({
      kind: pkg.kind,
      id: `${pkg.ref}@${pkg.version}`,
      state: pkg.state,
      relationship: pkg.relationship,
      origin: pkg.origin,
      independentOwner: pkg.independentOwner,
    })),
    ...record.mcpServers.map((server) => ({
      kind: "mcp-server" as const,
      id: server.name,
      state: server.state,
      relationship: server.relationship,
      origin: server.origin,
      independentOwner: server.independentOwner,
    })),
    ...record.cronJobs.map((cron) => ({
      kind: "cron-job" as const,
      id: cron.manifestId,
      state: cron.status,
      relationship: "managed" as const,
      origin: "claw-introduced" as const,
      independentOwner: false,
    })),
  ];
}

function projectStatusRecord(record: ClawStatusRecord): ClawStatusEntry {
  return {
    agentId: record.install.agentId,
    name: record.install.claw.name,
    version: record.install.claw.version,
    sourceKind: record.install.claw.kind,
    status: record.install.status,
    agentState: record.agentState,
    bootstrapState: record.bootstrapState,
    orphaned: record.orphaned === true,
    addedAtMs: record.install.addedAtMs,
    updatedAtMs: record.install.updatedAtMs,
    resources: projectResourceStatus(record),
  };
}

function isHealthy(record: ClawStatusEntry): boolean {
  const healthyResourceStates = new Set(["present", "unchanged", "complete"]);
  return (
    record.status === "complete" &&
    record.bootstrapState === "complete" &&
    !record.orphaned &&
    record.resources.every((resource) => healthyResourceStates.has(resource.state))
  );
}

export function projectClawsStatus(records: readonly ClawStatusRecord[]): ClawsStatusResult {
  const projected = records.map(projectStatusRecord);
  const resources = projected.flatMap((record) => record.resources);
  const healthy = projected.filter(isHealthy).length;
  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    records: projected,
    summary: {
      claws: projected.length,
      healthy,
      attention: projected.length - healthy,
      managed: resources.filter((resource) => resource.relationship === "managed").length,
      referenced: resources.filter((resource) => resource.relationship === "referenced").length,
    },
  };
}

function safeDoctorMessage(finding: HealthFinding): string {
  const path = finding.path ?? "";
  if (path.startsWith("agents.list.")) {
    return "Claw-owned agent configuration needs attention.";
  }
  if (path.includes(".workspace.")) {
    return "Claw-managed workspace file needs attention.";
  }
  if (path.includes(".packages.")) {
    return "Claw package lifecycle state needs attention.";
  }
  if (path.startsWith("mcp.servers.")) {
    return "Claw MCP ownership state needs attention.";
  }
  if (path.includes(".cronJobs.")) {
    return "Claw scheduled work needs attention.";
  }
  return "Claw lifecycle state needs attention.";
}

export function projectClawsDoctor(findings: readonly HealthFinding[]): ClawsDoctorResult {
  const projected = findings.map((finding) => ({
    severity: finding.severity,
    message: safeDoctorMessage(finding),
    ...(finding.path ? { path: finding.path } : {}),
    ...(finding.requirement ? { requirement: finding.requirement } : {}),
    ...(finding.fixHint ? { fixHint: finding.fixHint } : {}),
  }));
  return {
    schemaVersion: DOCTOR_SCHEMA_VERSION,
    findings: projected,
    summary: {
      info: projected.filter((finding) => finding.severity === "info").length,
      warnings: projected.filter((finding) => finding.severity === "warning").length,
      errors: projected.filter((finding) => finding.severity === "error").length,
    },
  };
}

export const clawsHandlers: GatewayRequestHandlers = {
  "claws.status": async ({ params, respond, context }) => {
    if (!requireClawsEnabled(respond)) {
      return;
    }
    if (!validateClawsStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid claws.status params: ${formatValidationErrors(validateClawsStatusParams.errors)}`,
        ),
      );
      return;
    }
    const typedParams = params as ClawsStatusParams;
    const result = await readClawStatus(typedParams.target, {
      config: context.getRuntimeConfig(),
      readOnly: true,
    });
    respond(true, projectClawsStatus(result.records));
  },
  "claws.doctor": async ({ params, respond, context }) => {
    if (!requireClawsEnabled(respond)) {
      return;
    }
    if (!validateClawsDoctorParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid claws.doctor params: ${formatValidationErrors(validateClawsDoctorParams.errors)}`,
        ),
      );
      return;
    }
    const findings = await collectClawStateHealthFindings({
      cfg: context.getRuntimeConfig(),
      cronGateway: context.cron,
    });
    respond(true, projectClawsDoctor(findings));
  },
  "claws.catalog.search": async ({ params, respond }) => {
    if (!requireClawsEnabled(respond)) {
      return;
    }
    if (!validateClawsCatalogSearchParams(params)) {
      invalidParams("claws.catalog.search", validateClawsCatalogSearchParams.errors, respond);
      return;
    }
    const typed = params as ClawsCatalogSearchParams;
    await respondWithLifecycleResult("claws.catalog.search", respond, async () => ({
      schemaVersion: "openclaw.clawsCatalogSearch.v1",
      entries: await searchClawHubClaws(typed),
    }));
  },
  "claws.catalog.detail": async ({ params, respond }) => {
    if (!requireClawsEnabled(respond)) {
      return;
    }
    if (!validateClawsCatalogDetailParams(params)) {
      invalidParams("claws.catalog.detail", validateClawsCatalogDetailParams.errors, respond);
      return;
    }
    const typed = params as ClawsCatalogDetailParams;
    await respondWithLifecycleResult("claws.catalog.detail", respond, async () => ({
      schemaVersion: "openclaw.clawsCatalogDetail.v1",
      detail: await readClawHubClawDetail(typed),
    }));
  },
  "claws.add.plan": async ({ params, respond, context }) => {
    if (!requireClawsEnabled(respond)) {
      return;
    }
    if (!validateClawsAddPlanParams(params)) {
      invalidParams("claws.add.plan", validateClawsAddPlanParams.errors, respond);
      return;
    }
    await respondWithLifecycleResult("claws.add.plan", respond, async () =>
      planClawAddFromCatalog({
        ...(params as ClawsAddPlanParams),
        context: { config: context.getRuntimeConfig(), cron: context.cron },
      }),
    );
  },
  "claws.add.apply": async ({ params, respond, context }) => {
    if (!requireClawsEnabled(respond)) {
      return;
    }
    if (!validateClawsAddApplyParams(params)) {
      invalidParams("claws.add.apply", validateClawsAddApplyParams.errors, respond);
      return;
    }
    await respondWithLifecycleResult("claws.add.apply", respond, async () =>
      applyClawAddFromCatalog({
        ...(params as ClawsAddApplyParams),
        context: { config: context.getRuntimeConfig(), cron: context.cron },
      }),
    );
  },
  "claws.update.plan": async ({ params, respond, context }) => {
    if (!requireClawsEnabled(respond)) {
      return;
    }
    if (!validateClawsUpdatePlanParams(params)) {
      invalidParams("claws.update.plan", validateClawsUpdatePlanParams.errors, respond);
      return;
    }
    await respondWithLifecycleResult("claws.update.plan", respond, async () =>
      planClawUpdate({
        ...(params as ClawsUpdatePlanParams),
        context: { config: context.getRuntimeConfig(), cron: context.cron },
      }),
    );
  },
  "claws.update.apply": async ({ params, respond, context }) => {
    if (!requireClawsEnabled(respond)) {
      return;
    }
    if (!validateClawsUpdateApplyParams(params)) {
      invalidParams("claws.update.apply", validateClawsUpdateApplyParams.errors, respond);
      return;
    }
    await respondWithLifecycleResult("claws.update.apply", respond, async () =>
      applyClawUpdate({
        ...(params as ClawsUpdateApplyParams),
        context: { config: context.getRuntimeConfig(), cron: context.cron },
      }),
    );
  },
  "claws.remove.plan": async ({ params, respond, context }) => {
    if (!requireClawsEnabled(respond)) {
      return;
    }
    if (!validateClawsRemovePlanParams(params)) {
      invalidParams("claws.remove.plan", validateClawsRemovePlanParams.errors, respond);
      return;
    }
    await respondWithLifecycleResult("claws.remove.plan", respond, async () =>
      planClawRemove({
        ...(params as ClawsRemovePlanParams),
        context: { config: context.getRuntimeConfig(), cron: context.cron },
      }),
    );
  },
  "claws.remove.apply": async ({ params, respond, context }) => {
    if (!requireClawsEnabled(respond)) {
      return;
    }
    if (!validateClawsRemoveApplyParams(params)) {
      invalidParams("claws.remove.apply", validateClawsRemoveApplyParams.errors, respond);
      return;
    }
    await respondWithLifecycleResult("claws.remove.apply", respond, async () =>
      applyClawRemove({
        ...(params as ClawsRemoveApplyParams),
        context: { config: context.getRuntimeConfig(), cron: context.cron },
      }),
    );
  },
};
