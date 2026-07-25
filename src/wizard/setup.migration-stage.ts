// Setup migration staging keeps provider writes isolated until verified promotion.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveAgentDir } from "../agents/agent-scope-config.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { clearRuntimeAuthProfileStoreSnapshot } from "../agents/auth-profiles/store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isNotFoundPathError } from "../infra/path-guards.js";
import { summarizeMigrationItems } from "../plugin-sdk/migration.js";
import type {
  MigrationApplyResult,
  MigrationConfigRuntime,
  MigrationItem,
  MigrationPlan,
} from "../plugins/types.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  disposeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseByPath } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  assertDisjointPromotionTargets,
  assertSupportedStagedStateTree,
  createPromotionResume,
  moveRecordedEmptyTarget,
  PROMOTION_JOURNAL_FILE,
  PROMOTION_JOURNAL_VERSION,
  recordPromotionTargetState,
  rollbackComponents,
  writePromotionJournal,
  type PromotionComponent,
  type PromotionJournal,
  type SetupMigrationPromotionContinuation,
  type SetupMigrationPromotionResume,
} from "./setup.migration-promotion.js";

export { recoverSetupMigrationPromotion } from "./setup.migration-promotion.js";
export type {
  SetupMigrationPromotionOutcome,
  SetupMigrationPromotionResume,
} from "./setup.migration-promotion.js";

const DEFERRED_REASON = "deferred until durable onboarding promotion";

type SetupMigrationStagePaths = {
  stateDir: string;
  workspaceDir: string;
  agentDir: string;
  reportDir: string;
};

type SetupMigrationStage = {
  staged: SetupMigrationStagePaths;
  final: SetupMigrationStagePaths;
  configRuntime: MigrationConfigRuntime;
  getFinalConfig: () => OpenClawConfig;
  getStagedConfig: () => OpenClawConfig;
  replaceStagedConfig: (config: OpenClawConfig) => void;
  projectPlanToStage: (plan: MigrationPlan) => MigrationPlan;
  projectResultToFinal: (result: MigrationApplyResult) => MigrationApplyResult;
  promote: (params: {
    expectedConfig: OpenClawConfig;
    continuation: Omit<
      SetupMigrationPromotionContinuation,
      "stagedReportDir" | "stagedRoots" | "workspaceDir"
    >;
    readConfigFile: () => Promise<OpenClawConfig>;
    commitConfigFile: (
      config: OpenClawConfig,
      expectedConfig: OpenClawConfig,
    ) => Promise<OpenClawConfig>;
  }) => Promise<{ config: OpenClawConfig; resume: SetupMigrationPromotionResume }>;
  cleanup: () => Promise<void>;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .toSorted()
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, canonicalize(record[key])]),
  );
}

function hashConfig(config: OpenClawConfig): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(config)))
    .digest("hex");
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.lstat(candidate);
    return true;
  } catch (error) {
    if (isNotFoundPathError(error)) {
      return false;
    }
    throw error;
  }
}

async function findExistingAncestor(candidate: string): Promise<string> {
  let current = path.resolve(candidate);
  while (!(await pathExists(current))) {
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Could not find an existing parent for migration staging at ${candidate}.`);
    }
    current = parent;
  }
  return current;
}

async function makePrivateStageNear(target: string, label: string): Promise<string> {
  const ancestor = await findExistingAncestor(path.dirname(path.resolve(target)));
  const staged = await fs.mkdtemp(path.join(ancestor, `.openclaw-${label}-`));
  await fs.chmod(staged, 0o700);
  return staged;
}

function replacePathPrefix(value: string, from: string, to: string): string {
  if (value === from) {
    return to;
  }
  const prefix = `${from}${path.sep}`;
  return value.startsWith(prefix) ? `${to}${value.slice(from.length)}` : value;
}

function projectPath(value: string, mappings: ReadonlyArray<readonly [string, string]>): string {
  const mapping = mappings
    .filter(([from]) => value === from || value.startsWith(`${from}${path.sep}`))
    .toSorted(([left], [right]) => right.length - left.length)[0];
  return mapping ? replacePathPrefix(value, mapping[0], mapping[1]) : value;
}

function projectValue(value: unknown, mappings: ReadonlyArray<readonly [string, string]>): unknown {
  if (typeof value === "string") {
    return projectPath(value, mappings);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => projectValue(entry, mappings));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, projectValue(entry, mappings)]),
  );
}

function projectPlanTargets(
  plan: MigrationPlan,
  mappings: ReadonlyArray<readonly [string, string]>,
): MigrationPlan {
  return {
    ...plan,
    ...(plan.target ? { target: projectValue(plan.target, mappings) as string } : {}),
    items: plan.items.map((item) => ({
      ...item,
      ...(item.target ? { target: projectValue(item.target, mappings) as string } : {}),
    })),
    ...(plan.metadata
      ? { metadata: projectValue(plan.metadata, mappings) as Record<string, unknown> }
      : {}),
  };
}

function createInMemoryConfigRuntime(params: {
  finalConfig: OpenClawConfig;
  stagedConfig: OpenClawConfig;
  projectToFinal: (config: OpenClawConfig) => OpenClawConfig;
}): {
  runtime: MigrationConfigRuntime;
  getFinalConfig: () => OpenClawConfig;
  getStagedConfig: () => OpenClawConfig;
  replaceConfigs: (next: { finalConfig: OpenClawConfig; stagedConfig: OpenClawConfig }) => void;
} {
  let finalConfig = structuredClone(params.finalConfig);
  let stagedConfig = structuredClone(params.stagedConfig);
  const mutateConfigFile = async (
    mutation: Parameters<MigrationConfigRuntime["mutateConfigFile"]>[0],
  ) => {
    const stagedDraft = structuredClone(stagedConfig);
    const context = { snapshot: {} as never, previousHash: null };
    const result = await mutation.mutate(stagedDraft, context);
    // Provider mutations may carry state or generate values. Execute them once,
    // then project the staged result into the publishable config.
    stagedConfig = stagedDraft;
    finalConfig = params.projectToFinal(stagedDraft);
    return {
      nextConfig: stagedConfig,
      result,
      path: "<onboarding-migration-stage>",
      previousHash: null,
      snapshot: {} as never,
      persistedHash: null,
      afterWrite: mutation.afterWrite,
      followUp: { mode: "none", reason: "staged migration config", requiresRestart: false },
    };
  };
  const runtime: MigrationConfigRuntime = {
    current: () => stagedConfig,
    mutateConfigFile: mutateConfigFile as MigrationConfigRuntime["mutateConfigFile"],
  };
  return {
    runtime,
    getFinalConfig: () => structuredClone(finalConfig),
    getStagedConfig: () => structuredClone(stagedConfig),
    replaceConfigs(next) {
      finalConfig = structuredClone(next.finalConfig);
      stagedConfig = structuredClone(next.stagedConfig);
    },
  };
}

function phasePlan(
  plan: MigrationPlan,
  phase: "before-promotion" | "after-promotion",
): MigrationPlan {
  const items = plan.items.map((item) => {
    const itemPhase = item.applyPhase ?? "before-promotion";
    if (itemPhase === phase || item.status !== "planned") {
      return item;
    }
    return { ...item, status: "skipped" as const, reason: DEFERRED_REASON };
  });
  return { ...plan, items, summary: summarizeMigrationItems(items) };
}

export function buildSetupMigrationPhasePlan(
  plan: MigrationPlan,
  phase: "before-promotion" | "after-promotion",
): MigrationPlan {
  return phasePlan(plan, phase);
}

function takeMatchingItem(items: MigrationItem[], item: MigrationItem): MigrationItem | undefined {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) {
    return undefined;
  }
  return items.splice(index, 1)[0];
}

export function mergeSetupMigrationPhaseResults(params: {
  plan: MigrationPlan;
  staged: MigrationApplyResult;
  deferred?: MigrationApplyResult;
}): MigrationApplyResult {
  const stagedItems = [...params.staged.items];
  const deferredItems = [...(params.deferred?.items ?? [])];
  const items = params.plan.items.map((item) => {
    const source = item.applyPhase === "after-promotion" ? deferredItems : stagedItems;
    return takeMatchingItem(source, item) ?? item;
  });
  const plannedItemIds = new Set(params.plan.items.map((item) => item.id));
  items.push(
    ...stagedItems.filter((item) => !plannedItemIds.has(item.id)),
    ...deferredItems.filter((item) => !plannedItemIds.has(item.id)),
  );
  return {
    ...params.staged,
    items,
    summary: summarizeMigrationItems(items),
    warnings: [
      ...new Set([...(params.staged.warnings ?? []), ...(params.deferred?.warnings ?? [])]),
    ],
    nextSteps: [
      ...new Set([...(params.staged.nextSteps ?? []), ...(params.deferred?.nextSteps ?? [])]),
    ],
  };
}

export async function createSetupMigrationStage(params: {
  providerId: string;
  stateDir: string;
  workspaceDir: string;
  reportDir: string;
  targetConfig: OpenClawConfig;
}): Promise<SetupMigrationStage> {
  const agentId = resolveDefaultAgentId(params.targetConfig);
  const finalEnv = { ...process.env, OPENCLAW_STATE_DIR: params.stateDir };
  const finalAgentDir = resolveAgentDir(params.targetConfig, agentId, finalEnv);
  const stagedStateDir = await makePrivateStageNear(params.stateDir, "migration-state");
  const stagedWorkspaceDir = await makePrivateStageNear(params.workspaceDir, "migration-workspace");
  const stagedAgentDir = path.join(stagedStateDir, "agents", agentId, "agent");
  const stagedReportDir = path.join(
    stagedStateDir,
    "migration",
    params.providerId,
    path.basename(params.reportDir),
  );
  const stageEnv = { ...process.env, OPENCLAW_STATE_DIR: stagedStateDir };
  const stagedConfig: OpenClawConfig = {
    ...structuredClone(params.targetConfig),
    agents: {
      ...structuredClone(params.targetConfig.agents),
      defaults: {
        ...structuredClone(params.targetConfig.agents?.defaults),
        workspace: stagedWorkspaceDir,
      },
    },
  };
  const finalPaths: SetupMigrationStagePaths = {
    stateDir: params.stateDir,
    workspaceDir: params.workspaceDir,
    agentDir: finalAgentDir,
    reportDir: params.reportDir,
  };
  const stagedPaths: SetupMigrationStagePaths = {
    stateDir: stagedStateDir,
    workspaceDir: stagedWorkspaceDir,
    agentDir: stagedAgentDir,
    reportDir: stagedReportDir,
  };
  const toStage = [
    [finalPaths.workspaceDir, stagedPaths.workspaceDir],
    [finalPaths.agentDir, stagedPaths.agentDir],
    [finalPaths.stateDir, stagedPaths.stateDir],
    [finalPaths.reportDir, stagedPaths.reportDir],
  ] as const;
  const toFinal = toStage.map(([finalPath, stagedPath]) => [stagedPath, finalPath] as const);
  const projectConfigToFinal = (config: OpenClawConfig) =>
    projectValue(config, toFinal) as OpenClawConfig;
  const configs = createInMemoryConfigRuntime({
    finalConfig: params.targetConfig,
    stagedConfig,
    projectToFinal: projectConfigToFinal,
  });
  openOpenClawAgentDatabase({ agentId, env: stageEnv });
  let databasesDisposed = false;
  let retainForRecovery = false;

  const disposeDatabases = () => {
    if (databasesDisposed) {
      return;
    }
    clearRuntimeAuthProfileStoreSnapshot(stagedAgentDir);
    const stagedAgentDatabasePath = path.join(stagedAgentDir, "openclaw-agent.sqlite");
    disposeOpenClawAgentDatabaseByPath(stagedAgentDatabasePath, { env: stageEnv });
    // Verification may already close this handle. The staged registry still must
    // publish the final path before its shared database is promoted.
    registerOpenClawAgentDatabase({
      agentId,
      path: path.join(finalAgentDir, "openclaw-agent.sqlite"),
      env: stageEnv,
    });
    closeOpenClawStateDatabaseByPath(resolveOpenClawStateSqlitePath(stageEnv));
    databasesDisposed = true;
  };

  return {
    staged: stagedPaths,
    final: finalPaths,
    configRuntime: configs.runtime,
    getFinalConfig: configs.getFinalConfig,
    getStagedConfig: configs.getStagedConfig,
    replaceStagedConfig(config) {
      configs.replaceConfigs({
        stagedConfig: config,
        finalConfig: projectConfigToFinal(config),
      });
    },
    projectPlanToStage: (plan) => projectPlanTargets(plan, toStage),
    projectResultToFinal: (result) => projectValue(result, toFinal) as MigrationApplyResult,
    async promote({ expectedConfig, continuation, readConfigFile, commitConfigFile }) {
      disposeDatabases();
      const configBefore = await readConfigFile();
      if (hashConfig(configBefore) !== hashConfig(expectedConfig)) {
        throw new Error("Migration config changed before promotion. Review it and retry.");
      }
      const configTarget = configs.getFinalConfig();
      const components: PromotionComponent[] = [
        {
          name: "workspace",
          stagedPath: stagedWorkspaceDir,
          finalPath: params.workspaceDir,
          status: "staged",
        },
        {
          name: "agent",
          stagedPath: stagedAgentDir,
          finalPath: finalAgentDir,
          status: "staged",
        },
        {
          name: "state",
          stagedPath: path.join(stagedStateDir, "state"),
          finalPath: path.join(params.stateDir, "state"),
          status: "staged",
        },
      ];
      const existingComponents: PromotionComponent[] = [];
      for (const component of components) {
        if (component.name === "workspace" || (await pathExists(component.stagedPath))) {
          existingComponents.push(component);
        }
      }
      await assertSupportedStagedStateTree({
        stagedStateDir,
        agentId,
        providerId: params.providerId,
        reportDirName: path.basename(params.reportDir),
      });
      await assertDisjointPromotionTargets([
        ...existingComponents,
        { finalPath: params.reportDir },
      ]);
      await fs.mkdir(params.reportDir, { recursive: true, mode: 0o700 });
      // Snapshot every permitted pre-existing empty target before the journal
      // becomes recoverable, including components promoted later in this loop.
      for (const component of existingComponents) {
        await recordPromotionTargetState(component);
      }
      const journalPath = path.join(params.reportDir, PROMOTION_JOURNAL_FILE);
      const journal: PromotionJournal = {
        version: PROMOTION_JOURNAL_VERSION,
        status: "prepared",
        providerId: params.providerId,
        configHashBefore: hashConfig(configBefore),
        configHashTarget: hashConfig(configTarget),
        components: existingComponents,
        continuation: {
          ...continuation,
          workspaceDir: params.workspaceDir,
          stagedReportDir,
          stagedRoots: [stagedStateDir, stagedWorkspaceDir],
        },
        updatedAt: new Date().toISOString(),
      };
      await writePromotionJournal(journalPath, journal);
      journal.status = "promoting";
      await writePromotionJournal(journalPath, journal);
      try {
        for (const component of journal.components) {
          if (component.targetWasEmptyDirectory) {
            // The target state was journaled before promotion began. Persist the
            // current phase before removal so recovery can recreate the directory.
            await writePromotionJournal(journalPath, journal);
            await moveRecordedEmptyTarget(component);
          }
          await fs.mkdir(path.dirname(component.finalPath), { recursive: true, mode: 0o700 });
          await fs.rename(component.stagedPath, component.finalPath);
          component.status = "promoted";
          await writePromotionJournal(journalPath, journal);
        }
        let committed: OpenClawConfig;
        try {
          committed = await commitConfigFile(configTarget, expectedConfig);
        } catch (error) {
          const current = await readConfigFile().catch(() => undefined);
          if (current && hashConfig(current) === journal.configHashTarget) {
            committed = current;
          } else if (current && hashConfig(current) === journal.configHashBefore) {
            throw error;
          } else {
            journal.status = "indeterminate";
            retainForRecovery = true;
            await writePromotionJournal(journalPath, journal);
            throw new Error(
              `Migration config commit is indeterminate. Review ${journalPath} and run openclaw doctor before retrying.`,
              { cause: error },
            );
          }
        }
        journal.configHashTarget = hashConfig(committed);
        journal.status = "committed";
        retainForRecovery = true;
        await writePromotionJournal(journalPath, journal);
        return { config: committed, resume: createPromotionResume(journalPath, journal) };
      } catch (error) {
        if (retainForRecovery) {
          throw error;
        }
        if (await rollbackComponents(journal.components)) {
          journal.status = "rolled-back";
          await writePromotionJournal(journalPath, journal);
          throw error;
        }
        journal.status = "indeterminate";
        retainForRecovery = true;
        await writePromotionJournal(journalPath, journal);
        throw new Error(
          `Migration promotion could not be rolled back. Review ${journalPath} and run openclaw doctor before retrying.`,
          { cause: error },
        );
      }
    },
    async cleanup() {
      if (retainForRecovery) {
        return;
      }
      disposeDatabases();
      await Promise.all([
        fs.rm(stagedStateDir, { recursive: true, force: true }),
        fs.rm(stagedWorkspaceDir, { recursive: true, force: true }),
      ]);
    },
  };
}
