// Gateway lifecycle orchestration reuses canonical Claw planners and executors.
import { createHash } from "node:crypto";
import path from "node:path";
import type {
  ClawLifecycleApplyResult,
  ClawLifecyclePlanResult,
} from "../../packages/gateway-protocol/src/index.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { stableStringify } from "../agents/stable-stringify.js";
import { normalizeConfiguredMcpServers } from "../config/mcp-config-normalize.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayCronServiceContract } from "../gateway/server-cron-contract.js";
import { applyClawAddPlan } from "./add.js";
import { withResolvedClawHubSource, type ClawHubCoordinate } from "./clawhub-source.js";
import type { ClawRemovePlan } from "./lifecycle-remove-contract.js";
import { applyClawRemovePlan, buildClawRemovePlan, readClawStatus } from "./lifecycle-state.js";
import { buildClawAddPlan } from "./lifecycle.js";
import type { ClawReferencedCleanup } from "./package-remove.js";
import { preflightClawPackage } from "./packages.js";
import { readClawManifestFile } from "./reader.js";
import type {
  ClawAddPlan,
  ClawDiagnostic,
  ClawLocalPrerequisite,
  ClawReadResult,
} from "./types.js";
import { applyClawUpdatePlan, ClawUpdateMutationError } from "./update-apply.js";
import type { ClawUpdatePlan } from "./update-plan-types.js";
import { buildClawUpdatePlan } from "./update-plan.js";

const PLAN_SCHEMA_VERSION = "openclaw.clawsGatewayPlan.v1" as const;
const APPLY_SCHEMA_VERSION = "openclaw.clawsGatewayApply.v1" as const;

type LifecycleContext = {
  config: OpenClawConfig;
  cron: GatewayCronServiceContract;
};

type LoadedClaw = Extract<ClawReadResult, { ok: true }>;

function addCronJob(context: LifecycleContext, input: Record<string, unknown>) {
  // Claw cron declarations have already passed the canonical manifest planner.
  return context.cron.add(input as Parameters<GatewayCronServiceContract["add"]>[0]);
}

function safeBlocker(diagnostic: Pick<ClawDiagnostic, "code" | "path">) {
  return {
    code: diagnostic.code,
    path: diagnostic.path,
    message: "Resolve this OpenClaw state conflict before continuing.",
  };
}

function safeAction(action: {
  kind: string;
  id: string;
  action: string;
  blocked: boolean;
  reason?: string;
}) {
  return {
    kind: action.kind,
    id: action.id,
    action: action.action,
    blocked: action.blocked,
    ...(action.blocked ? { reason: "Current OpenClaw state blocks this action." } : {}),
  };
}

function safeCapability(change: { kind: string; id: string; action: string; reason: string }) {
  return { kind: change.kind, id: change.id, action: change.action, reason: change.reason };
}

function projectReadinessRequirement(requirement: ClawLocalPrerequisite) {
  return requirement.kind === "plugin-setup"
    ? { kind: requirement.kind, owner: `${requirement.plugin}/${requirement.provider}` }
    : { kind: requirement.kind, owner: requirement.mcpServer };
}

export function sealClawLifecyclePlan(
  plan: Omit<ClawLifecyclePlanResult, "schemaVersion" | "planIntegrity">,
  canonicalPlanIntegrity: string,
): ClawLifecyclePlanResult {
  const planIntegrity = `sha256:${createHash("sha256")
    .update(stableStringify({ canonicalPlanIntegrity, plan }))
    .digest("hex")}`;
  return { schemaVersion: PLAN_SCHEMA_VERSION, planIntegrity, ...plan };
}

function sourceStablePlanIntegrity(plan: { planIntegrity: string }, sourceRoot?: string): string {
  if (!sourceRoot) {
    return plan.planIntegrity;
  }
  const { planIntegrity: _planIntegrity, ...content } = plan;
  return `sha256:${createHash("sha256")
    .update(stableStringify(canonicalizeClawSourcePlan(content, sourceRoot)))
    .digest("hex")}`;
}

export function projectClawAddPlan(
  plan: ClawAddPlan,
  sourceRoot?: string,
): ClawLifecyclePlanResult {
  return sealClawLifecyclePlan(
    {
      operation: "add",
      target: {
        agentId: plan.agent.finalId,
        name: plan.claw.name,
        targetVersion: plan.claw.version,
      },
      actions: plan.actions.map(safeAction),
      capabilities: plan.capabilityChanges.map(safeCapability),
      blockers: plan.blockers.map(safeBlocker),
      riskAcknowledgementRequired: false,
      readiness: {
        ready: plan.readiness.ready,
        requirements: plan.readiness.requirements.map(projectReadinessRequirement),
      },
    },
    sourceStablePlanIntegrity(plan, sourceRoot),
  );
}

function projectUpdatePlan(plan: ClawUpdatePlan, sourceRoot?: string): ClawLifecyclePlanResult {
  return sealClawLifecyclePlan(
    {
      operation: "update",
      target: {
        agentId: plan.agentId,
        ...(plan.currentClaw?.name ? { name: plan.currentClaw.name } : {}),
        ...(plan.currentClaw?.version ? { currentVersion: plan.currentClaw.version } : {}),
        ...(plan.targetClaw?.version ? { targetVersion: plan.targetClaw.version } : {}),
      },
      actions: plan.actions.map(safeAction),
      capabilities: plan.capabilityChanges.map(safeCapability),
      blockers: plan.blockers.map(safeBlocker),
      riskAcknowledgementRequired: false,
    },
    sourceStablePlanIntegrity(plan, sourceRoot),
  );
}

function projectRemovePlan(plan: ClawRemovePlan): ClawLifecyclePlanResult {
  return sealClawLifecyclePlan(
    {
      operation: "remove",
      target: plan.agentId ? { agentId: plan.agentId } : {},
      actions: plan.actions.map(safeAction),
      capabilities: [],
      blockers: plan.blockers.map((blocker) => ({
        code: blocker.code,
        path: "$",
        message: "Resolve this OpenClaw state conflict before continuing.",
      })),
      riskAcknowledgementRequired: false,
    },
    plan.planIntegrity,
  );
}

export function bindClawLifecycleTrust(
  plan: ClawLifecyclePlanResult,
  trust: { trustWarning?: string; riskAcknowledgementRequired: boolean },
): ClawLifecyclePlanResult {
  const { schemaVersion: _schemaVersion, planIntegrity, ...projection } = plan;
  return sealClawLifecyclePlan(
    {
      ...projection,
      ...(trust.trustWarning ? { trustWarning: trust.trustWarning } : {}),
      riskAcknowledgementRequired: trust.riskAcknowledgementRequired,
    },
    planIntegrity,
  );
}

export function canonicalizeClawSourcePlan(value: unknown, sourceRoot: string): unknown {
  const root = path.resolve(sourceRoot);
  const visit = (current: unknown): unknown => {
    if (typeof current === "string" && path.isAbsolute(current)) {
      const relative = path.relative(root, path.resolve(current));
      if (relative === "") {
        return "$CLAW_SOURCE";
      }
      if (
        !relative.startsWith(`..${path.sep}`) &&
        relative !== ".." &&
        !path.isAbsolute(relative)
      ) {
        return `$CLAW_SOURCE/${relative.split(path.sep).join("/")}`;
      }
      return current;
    }
    if (Array.isArray(current)) {
      return current.map(visit);
    }
    if (current && typeof current === "object") {
      return Object.fromEntries(Object.entries(current).map(([key, entry]) => [key, visit(entry)]));
    }
    return current;
  };
  return visit(value);
}

export function plansMatchAcrossSourceRoots(params: {
  preview: Record<string, unknown> & { planIntegrity: string };
  previewRoot: string;
  persisted: Record<string, unknown> & { planIntegrity: string };
  persistedRoot: string;
}): boolean {
  const { planIntegrity: _previewIntegrity, ...preview } = params.preview;
  const { planIntegrity: _persistedIntegrity, ...persisted } = params.persisted;
  return (
    stableStringify(canonicalizeClawSourcePlan(preview, params.previewRoot)) ===
    stableStringify(canonicalizeClawSourcePlan(persisted, params.persistedRoot))
  );
}

export async function addPlanContext(context: LifecycleContext, agentId?: string) {
  const existingAgentIds = listAgentIds(context.config);
  const cronJobs = await context.cron.list({ includeDisabled: true });
  return {
    ...(agentId ? { agentId } : {}),
    existingAgentIds,
    existingWorkspacePaths: existingAgentIds.map((id) =>
      resolveAgentWorkspaceDir(context.config, id),
    ),
    existingMcpServers: normalizeConfiguredMcpServers(context.config.mcp?.servers),
    existingCronJobIds: cronJobs.map((job) => job.id),
    packagePreflight: preflightClawPackage,
  };
}

async function buildAdd(params: {
  loaded: LoadedClaw;
  agentId?: string;
  context: LifecycleContext;
}) {
  return await buildClawAddPlan({
    manifest: params.loaded.manifest,
    ...(params.loaded.clawMarkdownBody ? { clawMarkdownBody: params.loaded.clawMarkdownBody } : {}),
    ...(params.loaded.packageBootstrap ? { packageBootstrap: params.loaded.packageBootstrap } : {}),
    ...(params.loaded.openClawProfile ? { openClawProfile: params.loaded.openClawProfile } : {}),
    source: params.loaded.source,
    diagnostics: params.loaded.diagnostics,
    context: await addPlanContext(params.context, params.agentId),
  });
}

async function readUpdateSource(params: {
  target: string;
  context: LifecycleContext;
}): Promise<LoadedClaw> {
  const status = await readClawStatus(params.target, {
    config: params.context.config,
    readOnly: true,
  });
  if (status.records.length !== 1) {
    throw new Error("Select exactly one installed Claw agent before updating.");
  }
  const source = status.records[0]!.install.claw;
  const loaded = await readClawManifestFile(
    source.kind === "package" ? source.packageRoot : source.manifestPath,
  );
  if (!loaded.ok) {
    throw new Error("The recorded Claw source is unavailable; select a ClawHub release.");
  }
  return loaded;
}

async function buildUpdate(params: {
  target: string;
  loaded: LoadedClaw;
  context: LifecycleContext;
}) {
  const sourceMcpServers = normalizeConfiguredMcpServers(params.context.config.mcp?.servers);
  const plan = await buildClawUpdatePlan({
    agentId: params.target,
    targetManifest: params.loaded.manifest,
    ...(params.loaded.clawMarkdownBody
      ? { targetClawMarkdownBody: params.loaded.clawMarkdownBody }
      : {}),
    ...(params.loaded.openClawProfile
      ? { targetOpenClawProfile: params.loaded.openClawProfile }
      : {}),
    targetSource: params.loaded.source,
    config: params.context.config,
    sourceMcpServers,
    packagePreflight: preflightClawPackage,
    diagnostics: params.loaded.diagnostics,
  });
  return { plan, sourceMcpServers };
}

function referencedCleanup(removeUnused?: boolean): ClawReferencedCleanup {
  return removeUnused ? { mode: "remove-if-unused" } : { mode: "retain" };
}

export async function planClawAddFromCatalog(params: {
  source: ClawHubCoordinate;
  agentId?: string;
  context: LifecycleContext;
}): Promise<ClawLifecyclePlanResult> {
  const resolved = await withResolvedClawHubSource({
    coordinate: params.source,
    mode: "preview",
    run: async (loaded, trust) =>
      bindClawLifecycleTrust(
        projectClawAddPlan(await buildAdd({ ...params, loaded }), loaded.source.packageRoot),
        trust,
      ),
  });
  return resolved.value;
}

export async function applyClawAddFromCatalog(params: {
  source: ClawHubCoordinate;
  agentId?: string;
  planIntegrity: string;
  acknowledgeClawHubRisk?: boolean;
  context: LifecycleContext;
}): Promise<ClawLifecycleApplyResult> {
  const resolved = await withResolvedClawHubSource({
    coordinate: params.source,
    mode: "apply",
    acknowledgeClawHubRisk: params.acknowledgeClawHubRisk,
    run: async (loaded, trust, persistSource) => {
      const previewPlan = await buildAdd({ ...params, loaded });
      if (
        bindClawLifecycleTrust(projectClawAddPlan(previewPlan, loaded.source.packageRoot), trust)
          .planIntegrity !== params.planIntegrity
      ) {
        throw new Error("The Claw add plan changed; preview it again.");
      }
      const persisted = await persistSource();
      const plan = await buildAdd({ ...params, loaded: persisted });
      if (
        !plansMatchAcrossSourceRoots({
          preview: previewPlan,
          previewRoot: loaded.source.packageRoot,
          persisted: plan,
          persistedRoot: persisted.source.packageRoot,
        })
      ) {
        throw new Error("The Claw add plan changed while preparing it; preview it again.");
      }
      const result = await applyClawAddPlan(plan, {
        consentPlanIntegrity: plan.planIntegrity,
        runtime: { log: () => undefined, error: () => undefined, exit: () => undefined },
        cronGateway: {
          add: async (input) => await addCronJob(params.context, input),
          list: async () => await params.context.cron.list({ includeDisabled: true }),
        },
      });
      return {
        schemaVersion: APPLY_SCHEMA_VERSION,
        operation: "add" as const,
        status: result.status === "complete" ? ("complete" as const) : ("partial" as const),
        agentId: result.agent.finalId,
        message:
          result.status === "complete" ? "Claw agent added." : "Claw add needs operator attention.",
      };
    },
  });
  return resolved.value;
}

async function withUpdateSource<T>(params: {
  target: string;
  source?: ClawHubCoordinate;
  mode: "preview" | "apply";
  acknowledgeClawHubRisk?: boolean;
  context: LifecycleContext;
  run: (
    loaded: LoadedClaw,
    trust: { trustWarning?: string; riskAcknowledgementRequired: boolean },
    persistSource: () => Promise<LoadedClaw>,
  ) => Promise<T>;
}): Promise<{ value: T; trustWarning?: string; riskAcknowledgementRequired: boolean }> {
  if (params.source) {
    return await withResolvedClawHubSource({
      coordinate: params.source,
      mode: params.mode,
      acknowledgeClawHubRisk: params.acknowledgeClawHubRisk,
      run: params.run,
    });
  }
  const loaded = await readUpdateSource(params);
  return {
    value: await params.run(loaded, { riskAcknowledgementRequired: false }, async () => loaded),
    riskAcknowledgementRequired: false,
  };
}

export async function planClawUpdate(params: {
  target: string;
  source?: ClawHubCoordinate;
  context: LifecycleContext;
}): Promise<ClawLifecyclePlanResult> {
  const resolved = await withUpdateSource({
    ...params,
    mode: "preview",
    run: async (loaded, trust) => {
      const { plan } = await buildUpdate({ ...params, loaded });
      return bindClawLifecycleTrust(projectUpdatePlan(plan, loaded.source.packageRoot), trust);
    },
  });
  return resolved.value;
}

export async function applyClawUpdate(params: {
  target: string;
  source?: ClawHubCoordinate;
  planIntegrity: string;
  acknowledgeClawHubRisk?: boolean;
  context: LifecycleContext;
}): Promise<ClawLifecycleApplyResult> {
  const resolved = await withUpdateSource({
    ...params,
    mode: "apply",
    run: async (loaded, trust, persistSource) => {
      const preview = await buildUpdate({ ...params, loaded });
      if (
        bindClawLifecycleTrust(projectUpdatePlan(preview.plan, loaded.source.packageRoot), trust)
          .planIntegrity !== params.planIntegrity
      ) {
        throw new Error("The Claw update plan changed; preview it again.");
      }
      const persisted = await persistSource();
      const { plan, sourceMcpServers } = await buildUpdate({ ...params, loaded: persisted });
      if (
        !plansMatchAcrossSourceRoots({
          preview: preview.plan,
          previewRoot: loaded.source.packageRoot,
          persisted: plan,
          persistedRoot: persisted.source.packageRoot,
        })
      ) {
        throw new Error("The Claw update plan changed while preparing it; preview it again.");
      }
      try {
        const result = await applyClawUpdatePlan(
          plan,
          {
            targetManifest: persisted.manifest,
            ...(persisted.clawMarkdownBody
              ? { targetClawMarkdownBody: persisted.clawMarkdownBody }
              : {}),
            ...(persisted.openClawProfile
              ? { targetOpenClawProfile: persisted.openClawProfile }
              : {}),
            targetSource: persisted.source,
          },
          {
            config: params.context.config,
            sourceMcpServers,
            consentPlanIntegrity: plan.planIntegrity,
            packagePreflight: preflightClawPackage,
            cronGateway: {
              add: async (input) => await addCronJob(params.context, input),
              get: async (id) => await params.context.cron.readJob(id),
              remove: async (id) => await params.context.cron.remove(id),
            },
          },
        );
        return {
          schemaVersion: APPLY_SCHEMA_VERSION,
          operation: "update" as const,
          status: "complete" as const,
          agentId: result.agentId,
          message: "Claw agent updated.",
        };
      } catch (error) {
        if (error instanceof ClawUpdateMutationError && error.code === "update_partial") {
          return {
            schemaVersion: APPLY_SCHEMA_VERSION,
            operation: "update" as const,
            status: "partial" as const,
            agentId: plan.agentId,
            message: "Claw update needs operator attention.",
          };
        }
        throw error;
      }
    },
  });
  return resolved.value;
}

export async function planClawRemove(params: {
  target: string;
  removeUnused?: boolean;
  context: LifecycleContext;
}): Promise<ClawLifecyclePlanResult> {
  const plan = await buildClawRemovePlan(params.target, {
    config: params.context.config,
    referencedCleanup: referencedCleanup(params.removeUnused),
  });
  return projectRemovePlan(plan);
}

export async function applyClawRemove(params: {
  target: string;
  removeUnused?: boolean;
  planIntegrity: string;
  context: LifecycleContext;
}): Promise<ClawLifecycleApplyResult> {
  const cleanup = referencedCleanup(params.removeUnused);
  const plan = await buildClawRemovePlan(params.target, {
    config: params.context.config,
    referencedCleanup: cleanup,
  });
  if (projectRemovePlan(plan).planIntegrity !== params.planIntegrity) {
    throw new Error("The Claw removal plan changed; preview it again.");
  }
  const result = await applyClawRemovePlan(plan, {
    config: params.context.config,
    referencedCleanup: cleanup,
    consentPlanIntegrity: plan.planIntegrity,
    cronGateway: {
      get: async (id) => await params.context.cron.readJob(id),
      remove: async (id) => await params.context.cron.remove(id),
    },
  });
  return {
    schemaVersion: APPLY_SCHEMA_VERSION,
    operation: "remove",
    status: result.status === "complete" ? "complete" : "partial",
    agentId: result.agentId,
    message:
      result.status === "complete"
        ? "Claw agent removed."
        : "Claw removal needs operator attention.",
  };
}
