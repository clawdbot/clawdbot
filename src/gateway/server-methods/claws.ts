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
  type ClawsConfigureApplyParams,
  type ClawsConfigurePlanParams,
  type ClawsDoctorResult,
  type ClawsRemoveApplyParams,
  type ClawsRemovePlanParams,
  type ClawsStatusParams,
  type ClawsStatusResult,
  type ClawsUpdateApplyParams,
  type ClawsUpdatePlanParams,
  type ValidationError,
  validateClawsAddApplyParams,
  validateClawsAddPlanParams,
  validateClawsCatalogDetailParams,
  validateClawsCatalogSearchParams,
  validateClawsConfigureApplyParams,
  validateClawsConfigurePlanParams,
  validateClawsDoctorParams,
  validateClawsRemoveApplyParams,
  validateClawsRemovePlanParams,
  validateClawsStatusParams,
  validateClawsUpdateApplyParams,
  validateClawsUpdatePlanParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { readClawHubClawDetail, searchClawHubClaws } from "../../claws/clawhub-source.js";
import {
  applyClawAddFromCatalog,
  applyClawConfigure,
  applyClawRemove,
  applyClawUpdate,
  planClawAddFromCatalog,
  planClawConfigure,
  planClawRemove,
  planClawUpdate,
} from "../../claws/control-ui-lifecycle.js";
import { collectClawStateHealthFindings } from "../../claws/doctor.js";
import { assertExperimentalClawsEnabled } from "../../claws/experimental.js";
import { readClawStatus, type ClawStatusRecord } from "../../claws/lifecycle-state.js";
import type { HealthFinding } from "../../flows/health-checks.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

const STATUS_SCHEMA_VERSION = "openclaw.clawsGatewayStatus.v1" as const;
const DOCTOR_SCHEMA_VERSION = "openclaw.clawsGatewayDoctor.v1" as const;

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
  respond: RespondFn,
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    respond(true, await operation());
  } catch (error) {
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
  const setup = record.setupUpdate ?? record.setup;
  return {
    agentId: record.install.agentId,
    name: record.install.claw.name,
    version: record.install.claw.version,
    sourceKind: record.install.claw.kind,
    status: record.install.status,
    agentState: record.agentState,
    orphaned: record.orphaned === true,
    addedAtMs: record.install.addedAtMs,
    updatedAtMs: record.install.updatedAtMs,
    ...(setup
      ? {
          personalization: {
            status: setup.status,
            answers: setup.answers,
            seeds: setup.seeds.map((seed) => ({
              destination: seed.destination,
              status: seed.status,
            })),
            updatePending: Boolean(record.setupUpdate),
          },
        }
      : {}),
    resources: projectResourceStatus(record),
  };
}

function isHealthy(record: ClawStatusEntry): boolean {
  const healthyResourceStates = new Set(["present", "unchanged", "complete"]);
  return (
    record.status === "complete" &&
    !record.orphaned &&
    (!record.personalization ||
      (record.personalization.status === "complete" &&
        !record.personalization.updatePending &&
        record.personalization.seeds.every((seed) => seed.status === "complete"))) &&
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
    await respondWithLifecycleResult(respond, async () => ({
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
    await respondWithLifecycleResult(respond, async () => ({
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
    const typed = params as ClawsAddPlanParams;
    await respondWithLifecycleResult(respond, async () =>
      planClawAddFromCatalog({
        ...typed,
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
    const typed = params as ClawsAddApplyParams;
    await respondWithLifecycleResult(respond, async () =>
      applyClawAddFromCatalog({
        ...typed,
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
    const typed = params as ClawsUpdatePlanParams;
    await respondWithLifecycleResult(respond, async () =>
      planClawUpdate({
        ...typed,
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
    const typed = params as ClawsUpdateApplyParams;
    await respondWithLifecycleResult(respond, async () =>
      applyClawUpdate({
        ...typed,
        context: { config: context.getRuntimeConfig(), cron: context.cron },
      }),
    );
  },
  "claws.configure.plan": async ({ params, respond, context }) => {
    if (!requireClawsEnabled(respond)) {
      return;
    }
    if (!validateClawsConfigurePlanParams(params)) {
      invalidParams("claws.configure.plan", validateClawsConfigurePlanParams.errors, respond);
      return;
    }
    const typed = params as ClawsConfigurePlanParams;
    await respondWithLifecycleResult(respond, async () =>
      planClawConfigure({
        ...typed,
        context: { config: context.getRuntimeConfig(), cron: context.cron },
      }),
    );
  },
  "claws.configure.apply": async ({ params, respond, context }) => {
    if (!requireClawsEnabled(respond)) {
      return;
    }
    if (!validateClawsConfigureApplyParams(params)) {
      invalidParams("claws.configure.apply", validateClawsConfigureApplyParams.errors, respond);
      return;
    }
    const typed = params as ClawsConfigureApplyParams;
    await respondWithLifecycleResult(respond, async () =>
      applyClawConfigure({
        ...typed,
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
    const typed = params as ClawsRemovePlanParams;
    await respondWithLifecycleResult(respond, async () =>
      planClawRemove({
        ...typed,
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
    const typed = params as ClawsRemoveApplyParams;
    await respondWithLifecycleResult(respond, async () =>
      applyClawRemove({
        ...typed,
        context: { config: context.getRuntimeConfig(), cron: context.cron },
      }),
    );
  },
};
