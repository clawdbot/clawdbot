import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { stableStringify } from "@openclaw/normalization-core";
import { prepareAgentDeleteDatabases } from "../agents/agent-delete-databases.js";
import { beginAgentDeletion } from "../agents/agent-lifecycle-registry.js";
import { listAgentEntries } from "../agents/agent-scope.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  AgentConfigPreconditionError,
  deleteAgentConfigEntry,
} from "../gateway/server-methods/agents-config-mutations.js";
import { withAgentExecApprovalsRemoved } from "../infra/exec-approvals.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  completeAgentDeletionJournalInDatabase,
  readAgentDeletionJournal,
} from "../state/agent-deletion-journal.js";
import type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db-contract.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { digestClawAgentConfig } from "./agent-config-digest.js";
import {
  deletionEffects,
  type ClawCleanupTargets,
  type ClawTrashPath,
} from "./lifecycle-delete-support.js";
import {
  readClawInstallRecordFromDatabase,
  updateClawInstallRecordStatus,
  type PersistedClawInstall,
} from "./provenance.js";

export type ConfigCommit = (transform: (config: OpenClawConfig) => OpenClawConfig) => Promise<void>;

type ClawAgentConfigRemovalParams = {
  agentId: string;
  expectedDigest: string;
  expectedInstall?: PersistedClawInstall | null;
  expectedRemovalSurfaceDigest: string;
  expectedState: "present" | "missing";
  fallbackWorkspace: string;
  config?: OpenClawConfig;
  commitConfig?: ConfigCommit;
  stateDatabase?: OpenClawStateDatabaseOptions;
  trashPath?: ClawTrashPath;
  onModified: () => Error;
  quiesceMonitors?: (operationId: string) => Promise<void>;
  drainMonitors?: (operationId: string) => Promise<void>;
};

type ClawAgentConfigRemovalResult = {
  agentRemoved: boolean;
  cleanupTargets?: ClawCleanupTargets;
  configBeforeDelete: OpenClawConfig;
  nextConfig: OpenClawConfig;
};

export { digestClawAgentConfig } from "./agent-config-digest.js";

export function digestClawAgentRemovalSurface(config: OpenClawConfig, agentId: string): string {
  const normalizedId = normalizeAgentId(agentId);
  const surface = {
    bindings: (config.bindings ?? []).filter(
      (binding) => normalizeAgentId(binding.agentId) === normalizedId,
    ),
    agentToAgentAllow: (config.tools?.agentToAgent?.allow ?? []).filter(
      (entry) => entry === normalizedId,
    ),
  };
  return `sha256:${createHash("sha256").update(stableStringify(surface)).digest("hex")}`;
}

async function commitClawAgentConfigRemoval(
  params: ClawAgentConfigRemovalParams,
  assertCurrent: () => void,
): Promise<ClawAgentConfigRemovalResult> {
  if (params.commitConfig) {
    let result: ClawAgentConfigRemovalResult | undefined;
    await params.commitConfig((config) => {
      assertCurrent();
      const effects = deletionEffects(
        config,
        params.agentId,
        params.fallbackWorkspace,
        params.stateDatabase?.env,
      );
      const agent = listAgentEntries(config).find((candidate) => candidate.id === params.agentId);
      if (
        (agent && digestClawAgentConfig(agent) !== params.expectedDigest) ||
        digestClawAgentRemovalSurface(config, params.agentId) !==
          params.expectedRemovalSurfaceDigest
      ) {
        throw params.onModified();
      }
      result = {
        agentRemoved: Boolean(agent),
        ...(params.trashPath
          ? {
              cleanupTargets: {
                workspaceDir: effects.workspace,
                agentDir: effects.agentDir,
                sessionsDir: effects.sessionsDir,
              },
            }
          : {}),
        configBeforeDelete: config,
        nextConfig: effects.pruned.config,
      };
      return effects.pruned.config;
    });
    if (!result) {
      throw new Error("Claw config removal did not run its commit transform.");
    }
    return result;
  }

  const configBeforeDelete = params.config ?? getRuntimeConfig();
  try {
    const committed = await deleteAgentConfigEntry({
      agentId: params.agentId,
      allowConfigSizeDrop: true,
      allowMissing: params.expectedState === "missing",
      fallbackWorkspace: params.fallbackWorkspace,
      validateConfig: (config) => {
        assertCurrent();
        if (
          digestClawAgentRemovalSurface(config, params.agentId) !==
          params.expectedRemovalSurfaceDigest
        ) {
          throw params.onModified();
        }
      },
      validate: (agent) => {
        if (params.expectedState === "missing") {
          throw params.onModified();
        }
        if (digestClawAgentConfig(agent) !== params.expectedDigest) {
          throw params.onModified();
        }
      },
    });
    const fallbackEffects = deletionEffects(
      configBeforeDelete,
      params.agentId,
      params.fallbackWorkspace,
      params.stateDatabase?.env,
    );
    return {
      agentRemoved: Boolean(committed.result),
      cleanupTargets: committed.result ?? {
        workspaceDir: fallbackEffects.workspace,
        agentDir: fallbackEffects.agentDir,
        sessionsDir: fallbackEffects.sessionsDir,
      },
      configBeforeDelete,
      nextConfig: committed.nextConfig,
    };
  } catch (error) {
    if (!(error instanceof AgentConfigPreconditionError)) {
      throw error;
    }
    const latestConfig = getRuntimeConfig();
    if (listAgentEntries(latestConfig).some((agent) => agent.id === params.agentId)) {
      throw params.onModified();
    }
    const effects = deletionEffects(
      latestConfig,
      params.agentId,
      params.fallbackWorkspace,
      params.stateDatabase?.env,
    );
    return {
      agentRemoved: false,
      cleanupTargets: {
        workspaceDir: effects.workspace,
        agentDir: effects.agentDir,
        sessionsDir: effects.sessionsDir,
      },
      configBeforeDelete,
      nextConfig: latestConfig,
    };
  }
}

type CommittedClawAgentRemoval = ClawAgentConfigRemovalResult & {
  assertCurrent: (database?: OpenClawStateDatabase) => void;
  drainMonitors: () => Promise<void>;
  completeDeletion: (database: OpenClawStateDatabase) => void;
  runDatabaseCleanup: ReturnType<typeof beginAgentDeletion>["runDatabaseCleanup"];
};

export async function withClawAgentConfigRemoval<T>(
  params: ClawAgentConfigRemovalParams,
  apply: (commitRemoval: () => Promise<CommittedClawAgentRemoval>) => Promise<T>,
): Promise<T> {
  const config = params.config ?? getRuntimeConfig();
  const stateOptions = {
    ...params.stateDatabase,
    path: openOpenClawStateDatabase(params.stateDatabase).path,
  };
  const effects = deletionEffects(
    config,
    params.agentId,
    params.fallbackWorkspace,
    stateOptions.env,
  );
  const expectedInstall = structuredClone(params.expectedInstall);
  const matchesInstall = (database: OpenClawStateDatabase) =>
    expectedInstall === undefined ||
    isDeepStrictEqual(
      readClawInstallRecordFromDatabase(database.db, params.agentId) ?? null,
      expectedInstall,
    );
  // Validate and claim together: a stale install snapshot must never fence a replacement.
  const { existingJournal, deletion } = runOpenClawStateWriteTransaction((database) => {
    if (!matchesInstall(database)) {
      throw params.onModified();
    }
    const transactionOptions = { ...stateOptions, database };
    const previousJournal = readAgentDeletionJournal(params.agentId, transactionOptions);
    const claimedDeletion = beginAgentDeletion(
      {
        agentId: params.agentId,
        workspaceDir: effects.workspace,
        agentDir: effects.agentDir,
        sessionsDir: effects.sessionsDir,
        // Selective cleanup may retain modified or untracked workspace entries.
        deleteFiles: previousJournal?.deleteFiles ?? false,
      },
      transactionOptions,
    );
    return { existingJournal: previousJournal, deletion: claimedDeletion };
  }, stateOptions);
  let committed = false;
  let monitorEffectsStarted = false;
  const ownsRemoval = (database: OpenClawStateDatabase) => {
    if (database.path !== stateOptions.path) {
      return false;
    }
    const current = readAgentDeletionJournal(params.agentId, {
      ...stateOptions,
      path: database.path,
      database,
    });
    return (
      current?.operationId === deletion.entry.operationId &&
      !current.cleanupCompleted &&
      matchesInstall(database)
    );
  };
  const assertCurrent = (database?: OpenClawStateDatabase) => {
    const check = (current: OpenClawStateDatabase) => {
      if (!ownsRemoval(current)) {
        throw new Error(`Claw removal no longer owns agent ${params.agentId}.`);
      }
    };
    if (database) {
      check(database);
    } else {
      runOpenClawStateWriteTransaction(check, stateOptions);
    }
  };
  try {
    // Fence new claims and drain existing owners before any external or local removal effect.
    if (params.quiesceMonitors) {
      // A lost RPC response can hide accepted cancellation. Keep the durable fence
      // until a retry has observed the serving owner and completed cleanup.
      monitorEffectsStarted = true;
      await params.quiesceMonitors(deletion.entry.operationId);
    }
    assertCurrent();
    prepareAgentDeleteDatabases(config, params.agentId, effects.agentDir, stateOptions);
    return await apply(async () => {
      assertCurrent();
      const result = await withAgentExecApprovalsRemoved(
        params.agentId,
        async () =>
          commitClawAgentConfigRemoval(
            { ...params, config, stateDatabase: stateOptions },
            assertCurrent,
          ),
        stateOptions,
      );
      committed = true;
      assertCurrent();
      return {
        ...result,
        assertCurrent,
        drainMonitors: async () => {
          await params.drainMonitors?.(deletion.entry.operationId);
        },
        runDatabaseCleanup: deletion.runDatabaseCleanup,
        completeDeletion: (database: OpenClawStateDatabase) => {
          if (
            !completeAgentDeletionJournalInDatabase(
              database,
              params.agentId,
              deletion.entry.operationId,
            )
          ) {
            throw new Error(`Failed to complete deletion journal for agent ${params.agentId}.`);
          }
        },
      };
    });
  } finally {
    // Pre-config partial results release only this attempt's fence; committed cleanup retains it.
    if (!committed && !monitorEffectsStarted && !existingJournal) {
      deletion.rollback();
    }
    if (expectedInstall) {
      // Result construction is pure; only the live operation may publish retry status.
      runOpenClawStateWriteTransaction((database) => {
        if (ownsRemoval(database)) {
          updateClawInstallRecordStatus(params.agentId, "partial", {
            ...stateOptions,
            path: database.path,
            database,
          });
        }
      }, stateOptions);
    }
  }
}
