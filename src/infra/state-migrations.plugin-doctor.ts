import os from "node:os";
import { tryResolveConfiguredAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace-default.js";
import { resolveOAuthDir, resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  listPluginDoctorStateMigrationEntries,
  PluginDoctorStateMigrationDeclarationError,
  type PluginDoctorStateMigration,
  type PluginDoctorStateMigrationDetection,
} from "../plugins/doctor-contract-registry.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { withAgentDatabaseMaintenanceLease } from "../state/openclaw-agent-db.js";
import { repairOpenClawStateDatabaseSchemaIfNeeded } from "../state/openclaw-state-db.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import { formatStartupMigrationFailure } from "./state-migrations.messages.js";
import { createPluginDoctorStateMigrationContext } from "./state-migrations.plugin-doctor-context.js";
import { autoMigrateLegacyStateDir } from "./state-migrations.state-dir.js";
import type {
  DetectedPluginDoctorStateMigrationPlan,
  LegacyStateDetection,
  MigrationLogger,
  MigrationMessages,
  PlannedPluginDoctorAction,
  PluginDoctorRepairAuthority,
} from "./state-migrations.types.js";

type PluginDoctorInput = Omit<
  Parameters<PluginDoctorStateMigration["detectLegacyState"]>[0],
  "context"
>;

const PLUGIN_DOCTOR_MIGRATION_LOCK_TIMEOUT_MS = 250;
const PLUGIN_DOCTOR_MIGRATION_LOCK_POLL_INTERVAL_MS = 25;

function validatePluginDoctorPlanOrder(params: {
  actions: readonly PlannedPluginDoctorAction[];
  plannedActions: readonly PlannedPluginDoctorAction[];
}): string | undefined {
  const uniqueActions = new Set(
    params.actions.map((action) => JSON.stringify([action.pluginId, action.id])),
  );
  if (
    uniqueActions.size !== params.actions.length ||
    params.actions.length !== params.plannedActions.length ||
    params.actions.some((action, index) => {
      const planned = params.plannedActions[index];
      return action.pluginId !== planned?.pluginId || action.id !== planned?.id;
    })
  ) {
    return `Refused plugin migrations that do not match the immutable action order: ${params.actions
      .map((action) => `${action.pluginId}:${action.id}`)
      .join(", ")}.`;
  }
  return undefined;
}

export async function collectPluginDoctorStateMigrationPlans(
  input: PluginDoctorInput,
  params: {
    includeDoctorOnly?: boolean;
    phase?: PluginDoctorStateMigration["phase"];
    repairAuthority?: PluginDoctorRepairAuthority;
    warnings?: string[];
    plannedActions?: readonly PlannedPluginDoctorAction[];
    validateDeclarations?: boolean;
  },
): Promise<DetectedPluginDoctorStateMigrationPlan[]> {
  const plans: DetectedPluginDoctorStateMigrationPlan[] = [];
  const { config, env } = input;
  let entries: ReturnType<typeof listPluginDoctorStateMigrationEntries>;
  try {
    entries = listPluginDoctorStateMigrationEntries({
      config,
      env,
      validateDeclarations: params.validateDeclarations,
    });
  } catch (error) {
    if (!(error instanceof PluginDoctorStateMigrationDeclarationError)) {
      throw error;
    }
    params.warnings?.push(error.message);
    return [];
  }
  entries = entries.filter(
    ({ migration }) =>
      migration.phase === params.phase &&
      (migration.doctorOnly !== true || params.includeDoctorOnly === true),
  );
  // Validate all exports before detection removes completed actions. Otherwise a
  // reordered or missing export can hide behind the currently pending subset.
  if (params.plannedActions) {
    const refusal = validatePluginDoctorPlanOrder({
      actions: entries.map(({ pluginId, migration }) => ({ pluginId, id: migration.id })),
      plannedActions: params.plannedActions,
    });
    if (refusal) {
      params.warnings?.push(refusal);
      return [];
    }
  }
  for (const entry of entries) {
    let detected: PluginDoctorStateMigrationDetection | null;
    try {
      detected = await entry.migration.detectLegacyState({
        ...input,
        serviceWorkspaceDir:
          tryResolveConfiguredAgentWorkspaceDir(config, env) ??
          resolveDefaultAgentWorkspaceDir(env),
        context: createPluginDoctorStateMigrationContext({
          pluginId: entry.pluginId,
          env,
          config,
          repairAuthority: params.repairAuthority,
          // Detection runs before exclusive state ownership, so it is handed
          // inspection-only ingress access and no mutation gate. Untrusted owners get
          // no ingress lane at all: Doctor must not widen the runtime's durable-store
          // trust gate.
          // `?? true` keeps older or hand-built hosts working; a real registry record
          // always carries the decision explicitly.
          ...((entry.trustedForDurableStores ?? true)
            ? {
                channelIngress: {
                  channelIds: entry.channelIds ?? [],
                  stateDir: input.stateDir,
                },
              }
            : {}),
        }),
      });
    } catch (err) {
      params.warnings?.push(`Failed detecting ${entry.migration.label}: ${String(err)}`);
      continue;
    }
    if (detected?.preview.length) {
      plans.push({
        pluginId: entry.pluginId,
        channelIds: entry.channelIds,
        trustedForDurableStores: entry.trustedForDurableStores,
        migration: entry.migration,
        preview: detected.preview,
      });
    }
  }
  return plans;
}

export async function runPluginDoctorStateMigrationPlans(params: {
  detected: LegacyStateDetection;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  plannedActions?: readonly PlannedPluginDoctorAction[];
}): Promise<MigrationMessages> {
  const input: PluginDoctorInput = {
    config: params.config,
    env: params.env,
    stateDir: params.detected.stateDir,
    oauthDir: params.detected.oauthDir,
  };
  const warnings: string[] = [];
  const refreshedPlans = await collectPluginDoctorStateMigrationPlans(input, {
    includeDoctorOnly: params.detected.doctorOnlyStateMigrations,
    warnings,
    plannedActions: params.plannedActions,
  });
  const hasDetectorFailure = warnings.length > 0;
  // Previously detected plans are only safe when refresh found no current work.
  // If any detector failed, skip stale plans instead of migrating on old assumptions.
  const plans =
    refreshedPlans.length > 0 || hasDetectorFailure
      ? refreshedPlans
      : (params.detected.pluginPlans?.plans ?? []);
  const migrated = await migratePluginDoctorStatePlans(input, plans);
  return { ...migrated, warnings: [...warnings, ...migrated.warnings] };
}

async function migratePluginDoctorStatePlans(
  input: PluginDoctorInput,
  plans: readonly DetectedPluginDoctorStateMigrationPlan[],
  repairAuthority?: PluginDoctorRepairAuthority,
): Promise<MigrationMessages> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const notices: string[] = [];
  if (plans.length === 0) {
    return { changes, warnings };
  }

  // Mutable ingress access lives and dies with this call. Handles a migration keeps
  // past its own return re-check this gate and fail rather than writing outside the
  // section that owns the state.
  let ingressMutationActive = false;
  const assertIngressMutationCurrent = () => {
    if (!ingressMutationActive) {
      throw new Error("Plugin Doctor ingress queue access has expired.");
    }
    repairAuthority?.assertCurrent();
  };

  const migrate = async () => {
    ingressMutationActive = true;
    try {
      return await migrateWithIngressAuthority();
    } finally {
      ingressMutationActive = false;
    }
  };

  const migrateWithIngressAuthority = async () => {
    for (const plan of plans) {
      try {
        repairAuthority?.assertCurrent();
        const result = await plan.migration.migrateLegacyState({
          ...input,
          serviceWorkspaceDir:
            tryResolveConfiguredAgentWorkspaceDir(input.config, input.env) ??
            resolveDefaultAgentWorkspaceDir(input.env),
          context: createPluginDoctorStateMigrationContext({
            pluginId: plan.pluginId,
            env: input.env,
            config: input.config,
            repairAuthority,
            ...((plan.trustedForDurableStores ?? true)
              ? {
                  channelIngress: {
                    channelIds: plan.channelIds ?? [],
                    stateDir: input.stateDir,
                    mutation: { assertCurrent: assertIngressMutationCurrent },
                  },
                }
              : {}),
          }),
        });
        repairAuthority?.assertCurrent();
        changes.push(...result.changes);
        warnings.push(...result.warnings);
        notices.push(...(result.notices ?? []));
      } catch (err) {
        warnings.push(`Failed migrating ${plan.migration.label}: ${String(err)}`);
      }
    }
    return notices.length > 0 ? { changes, warnings, notices } : { changes, warnings };
  };
  // Session repair already holds the Gateway lock and cross-process database fences.
  if (repairAuthority) {
    return migrate();
  }

  let lock: Awaited<ReturnType<typeof acquireGatewayLock>>;
  try {
    lock = await acquireGatewayLock({
      allowInTests: true,
      env: { ...input.env, OPENCLAW_STATE_DIR: input.stateDir },
      pollIntervalMs: PLUGIN_DOCTOR_MIGRATION_LOCK_POLL_INTERVAL_MS,
      role: "sqlite-maintenance",
      timeoutMs: PLUGIN_DOCTOR_MIGRATION_LOCK_TIMEOUT_MS,
    });
  } catch (error) {
    return {
      changes,
      warnings: [
        `Skipped plugin doctor state migrations because exclusive state ownership is unavailable: ${String(error)}`,
      ],
    };
  }
  if (!lock) {
    return {
      changes,
      warnings: [
        "Skipped plugin doctor state migrations because exclusive state ownership is unavailable",
      ],
    };
  }

  try {
    // Plugin migrations may claim retired files after verified import. Keep the
    // predecessor Gateway excluded for the full read, import, and archive window.
    return await migrate();
  } finally {
    await lock.release();
  }
}

/** Detect after canonical inspection; destructive repair also requires offline maintenance ownership. */
export async function runPostSessionPluginDoctorStateRepairs(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  maintenanceAuthority?: { assertCurrent(): void };
  plannedActions?: readonly PlannedPluginDoctorAction[];
}): Promise<MigrationMessages> {
  const stateDir = resolveStateDir(params.env);
  const input: PluginDoctorInput = {
    config: params.config,
    env: params.env,
    stateDir,
    oauthDir: resolveOAuthDir(params.env, stateDir),
  };
  const run = async (repairAuthority?: PluginDoctorRepairAuthority): Promise<MigrationMessages> => {
    const warnings: string[] = [];
    repairAuthority?.assertCurrent();
    const plans = await collectPluginDoctorStateMigrationPlans(input, {
      includeDoctorOnly: true,
      phase: "after-session-repair",
      repairAuthority,
      warnings,
      plannedActions: params.plannedActions,
    });
    if (!repairAuthority) {
      return {
        changes: [],
        warnings: [
          ...warnings,
          ...plans.flatMap((plan) => plan.preview),
          ...(plans.length
            ? ['Run "openclaw doctor --fix" to repair plugin session ownership.']
            : []),
        ],
      };
    }
    const result = await migratePluginDoctorStatePlans(input, plans, repairAuthority);
    return { ...result, warnings: [...warnings, ...result.warnings] };
  };
  const maintenance = params.maintenanceAuthority;
  if (!maintenance) {
    return run();
  }
  maintenance.assertCurrent();
  let completed: MigrationMessages = { changes: [], warnings: [] };
  try {
    return await withAgentDatabaseMaintenanceLease({ env: params.env }, async (agentLease) =>
      withPluginLifecycleLease({ env: params.env, waitMs: 5_000 }, async (pluginLease) => {
        let active = true;
        const assertCurrent = () => {
          if (!active) {
            throw new Error("Plugin Doctor repair authority has expired.");
          }
          maintenance.assertCurrent();
        };
        const authority: PluginDoctorRepairAuthority = {
          assertCurrent() {
            assertCurrent();
            agentLease.assertOwned();
            pluginLease.assertOwned();
          },
          assertOwnedInTransaction(database) {
            assertCurrent();
            agentLease.assertOwnedInTransaction(database);
            pluginLease.assertOwnedInTransaction(database);
          },
        };
        try {
          // Lease settlement can reject after the callback's mutations committed.
          // Retain those facts without treating a failed settlement as success.
          completed = await run(authority);
          return completed;
        } finally {
          active = false;
        }
      }),
    );
  } catch (error) {
    return {
      ...completed,
      warnings: [...completed.warnings, `Plugin session repair did not settle: ${String(error)}.`],
    };
  }
}

export async function autoMigrateLegacyPluginDoctorState(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  log?: MigrationLogger;
  doctorOnlyStateMigrations?: boolean;
}): Promise<{
  migrated: boolean;
  skipped: boolean;
  changes: string[];
  warnings: string[];
  notices?: string[];
}> {
  const env = params.env ?? process.env;
  const stateDirResult = await autoMigrateLegacyStateDir({
    env,
    homedir: params.homedir,
    log: params.log,
  });
  const stateDir = resolveStateDir(env, params.homedir ?? os.homedir);
  const oauthDir = resolveOAuthDir(env, stateDir);
  const stateSchema = repairOpenClawStateDatabaseSchemaIfNeeded({
    env: { ...env, OPENCLAW_STATE_DIR: stateDir },
  });
  const changes = [...stateDirResult.changes, ...stateSchema.changes];
  const warnings = [...stateDirResult.warnings, ...stateSchema.warnings];
  const notices = [...(stateDirResult.notices ?? [])];
  if (stateSchema.warnings.length > 0 && params.doctorOnlyStateMigrations !== true) {
    throw new Error(formatStartupMigrationFailure(stateSchema.warnings));
  }
  const input: PluginDoctorInput = { config: params.config, env, stateDir, oauthDir };
  const plans =
    stateSchema.warnings.length > 0
      ? []
      : await collectPluginDoctorStateMigrationPlans(input, {
          includeDoctorOnly: params.doctorOnlyStateMigrations === true,
          warnings,
        });
  const migrated = await migratePluginDoctorStatePlans(input, plans);
  changes.push(...migrated.changes);
  warnings.push(...migrated.warnings);
  notices.push(...(migrated.notices ?? []));
  return {
    migrated: stateDirResult.migrated || stateSchema.changes.length > 0 || plans.length > 0,
    skipped: false,
    changes,
    warnings,
    ...(notices.length > 0 ? { notices } : {}),
  };
}
