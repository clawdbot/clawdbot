import { createHash } from "node:crypto";
import { stableStringify } from "../agents/stable-stringify.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { readClawStatus } from "./lifecycle-status.js";
import { createClawUpdatePersonalizationSeeds } from "./personalization.js";
import { buildClawSetupReconciliation } from "./setup-reconcile.js";
import {
  finalizeClawSetupUpdate,
  readClawSetupPending,
  readClawSetupState,
} from "./setup-state.js";
import {
  CLAW_OUTPUT_STABILITY,
  CLAW_SETUP_SCHEMA_VERSION,
  type ClawManifest,
  type ClawSourceIdentity,
} from "./types.js";
import type { ClawUpdateAction, ClawUpdatePlan } from "./update-plan-types.js";

export const CLAW_CONFIGURE_PLAN_SCHEMA_VERSION = "openclaw.clawConfigurePlan.v1" as const;
export const CLAW_CONFIGURE_RESULT_SCHEMA_VERSION = "openclaw.clawConfigureResult.v1" as const;

export type ClawConfigurePlan = {
  schemaVersion: typeof CLAW_CONFIGURE_PLAN_SCHEMA_VERSION;
  stability: typeof CLAW_OUTPUT_STABILITY;
  dryRun: true;
  mutationAllowed: false;
  planIntegrity: string;
  found: boolean;
  agentId: string;
  claw?: { name: string; version: string; integrity: string };
  setup?: ClawUpdatePlan["setup"];
  actions: ClawUpdateAction[];
  blockers: Array<{ code: string; message: string; path?: string }>;
};

export class ClawConfigureError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ClawConfigureError";
  }
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

export async function buildClawConfigurePlan(params: {
  target: string;
  manifest: ClawManifest;
  source: ClawSourceIdentity;
  config: OpenClawConfig;
  sourceMcpServers: Record<string, Record<string, unknown>>;
  answers?: unknown;
  clearAnswers?: readonly string[];
  regenerateSeeds?: readonly string[];
  stateOptions?: OpenClawStateDatabaseOptions;
}): Promise<ClawConfigurePlan> {
  const status = await readClawStatus(params.target, {
    ...params.stateOptions,
    config: params.config,
    sourceMcpServers: params.sourceMcpServers,
  });
  const record = status.records.length === 1 ? status.records[0] : undefined;
  const blockers: ClawConfigurePlan["blockers"] = [];
  if (!record) {
    blockers.push({
      code: status.records.length === 0 ? "claw_not_found" : "claw_ambiguous",
      message:
        status.records.length === 0
          ? `No installed Claw matches ${JSON.stringify(params.target)}.`
          : `Claw name ${JSON.stringify(params.target)} matches multiple agents; use an agent id.`,
    });
  } else if (
    record.install.claw.name !== params.source.name ||
    record.install.claw.version !== params.source.version ||
    record.install.claw.integrity !== params.source.integrity
  ) {
    blockers.push({
      code: "configure_source_mismatch",
      message:
        "Configure requires the exact installed Claw source; use `claws update` for a different package version.",
    });
  }
  if (params.manifest.schemaVersion !== CLAW_SETUP_SCHEMA_VERSION) {
    blockers.push({
      code: "setup_unsupported",
      message: "This Claw schema does not declare personalization setup.",
    });
  }

  const reconciliation = record
    ? await buildClawSetupReconciliation({
        currentManifestSchemaVersion: record.install.manifestSchemaVersion,
        currentSetup: readClawSetupState(record.install.agentId, params.stateOptions),
        currentPending: readClawSetupPending(record.install.agentId, params.stateOptions),
        targetManifest: params.manifest,
        targetSource: params.source,
        workspace: record.install.workspace,
        workspaceFiles: record.workspaceFiles,
        answers: params.answers,
        clearAnswers: params.clearAnswers,
        regenerateSeeds: params.regenerateSeeds,
      })
    : undefined;
  blockers.push(
    ...(reconciliation?.blockers.map((entry) => ({
      code: entry.code,
      message: entry.message,
      path: entry.path,
    })) ?? []),
  );
  const setup = reconciliation
    ? {
        currentSchemaDigest: reconciliation.currentSchemaDigest,
        targetSchemaDigest: reconciliation.targetSchemaDigest,
        answerDigest: reconciliation.answerDigest,
        createdSeeds: reconciliation.createdSeeds,
        regeneratedSeeds: reconciliation.regeneratedSeeds,
        preservedSeeds: reconciliation.preservedSeeds,
        releasedSeeds: reconciliation.releasedSeeds,
      }
    : undefined;
  const withoutIntegrity: Omit<ClawConfigurePlan, "planIntegrity"> = {
    schemaVersion: CLAW_CONFIGURE_PLAN_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    dryRun: true,
    mutationAllowed: false,
    found: Boolean(record),
    agentId: record?.install.agentId ?? params.target,
    ...(record
      ? {
          claw: {
            name: record.install.claw.name,
            version: record.install.claw.version,
            integrity: record.install.claw.integrity,
          },
        }
      : {}),
    ...(setup ? { setup } : {}),
    actions: reconciliation?.actions ?? [],
    blockers,
  };
  return { ...withoutIntegrity, planIntegrity: digest(withoutIntegrity) };
}

export async function applyClawConfigurePlan(
  plan: ClawConfigurePlan,
  params: {
    manifest: ClawManifest;
    source: ClawSourceIdentity;
    config: OpenClawConfig;
    sourceMcpServers: Record<string, Record<string, unknown>>;
    answers?: unknown;
    clearAnswers?: readonly string[];
    regenerateSeeds?: readonly string[];
  },
  options: OpenClawStateDatabaseOptions & {
    consentPlanIntegrity?: string;
    rebuildPlan?: typeof buildClawConfigurePlan;
    applySetup?: typeof createClawUpdatePersonalizationSeeds;
    finalizeSetup?: typeof finalizeClawSetupUpdate;
  } = {},
): Promise<{
  schemaVersion: typeof CLAW_CONFIGURE_RESULT_SCHEMA_VERSION;
  stability: typeof CLAW_OUTPUT_STABILITY;
  dryRun: false;
  mutationAllowed: true;
  status: "complete";
  agentId: string;
  appliedActions: ClawUpdateAction[];
}> {
  if (options.consentPlanIntegrity !== plan.planIntegrity) {
    throw new ClawConfigureError(
      "plan_integrity_mismatch",
      "Consent does not match the current configure plan; run configure --dry-run again.",
    );
  }
  if (!plan.found || plan.blockers.length > 0 || plan.actions.some((action) => action.blocked)) {
    throw new ClawConfigureError("configure_blocked", "The configure plan contains blockers.");
  }
  const fresh = await (options.rebuildPlan ?? buildClawConfigurePlan)({
    target: plan.agentId,
    manifest: params.manifest,
    source: params.source,
    config: params.config,
    sourceMcpServers: params.sourceMcpServers,
    answers: params.answers,
    clearAnswers: params.clearAnswers,
    regenerateSeeds: params.regenerateSeeds,
    stateOptions: options,
  });
  if (fresh.planIntegrity !== plan.planIntegrity) {
    throw new ClawConfigureError(
      "configure_changed",
      "Claw personalization state changed after planning; build a new dry-run plan.",
    );
  }
  const status = await readClawStatus(plan.agentId, {
    ...options,
    config: params.config,
    sourceMcpServers: params.sourceMcpServers,
  });
  const record = status.records[0];
  if (!record) {
    throw new ClawConfigureError("configure_changed", "The installed Claw disappeared.");
  }
  const reconciliation = await buildClawSetupReconciliation({
    currentManifestSchemaVersion: record.install.manifestSchemaVersion,
    currentSetup: readClawSetupState(record.install.agentId, options),
    currentPending: readClawSetupPending(record.install.agentId, options),
    targetManifest: params.manifest,
    targetSource: params.source,
    workspace: record.install.workspace,
    workspaceFiles: record.workspaceFiles,
    answers: params.answers,
    clearAnswers: params.clearAnswers,
    regenerateSeeds: params.regenerateSeeds,
  });
  if (!reconciliation.materialization || !reconciliation.targetState) {
    throw new ClawConfigureError("configure_changed", "Setup materialization is unavailable.");
  }
  const appliedActions = fresh.actions.filter(
    (action) => action.action === "add" || action.action === "change",
  );
  if (appliedActions.length > 0) {
    try {
      await (options.applySetup ?? createClawUpdatePersonalizationSeeds)(
        fresh,
        record.install.workspace,
        reconciliation.materialization,
        reconciliation.targetState,
        options,
      );
      (options.finalizeSetup ?? finalizeClawSetupUpdate)(fresh.agentId, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ClawConfigureError("configure_partial", message);
    }
  }
  return {
    schemaVersion: CLAW_CONFIGURE_RESULT_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    dryRun: false,
    mutationAllowed: true,
    status: "complete",
    agentId: fresh.agentId,
    appliedActions,
  };
}
