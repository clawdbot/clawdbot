import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { stableStringify } from "@openclaw/normalization-core";
import {
  assertAgentSessionStoreDeletionSafe,
  prepareAgentDeleteDatabases,
} from "../agents/agent-delete-databases.js";
import {
  withAgentDeletion,
  type AgentDeletionOperation,
} from "../agents/agent-lifecycle-registry.js";
import { listAgentEntries } from "../agents/agent-scope.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  AgentConfigPreconditionError,
  deleteAgentConfigEntry,
} from "../gateway/server-methods/agents-config-mutations.js";
import { withAgentExecApprovalsRemoved } from "../infra/exec-approvals.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { readAgentDeletionJournalInDatabase } from "../state/agent-deletion-journal.js";
import type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db-contract.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { digestClawAgentConfig } from "./agent-config-digest.js";
import { deletionEffects, type ClawCleanupTargets } from "./lifecycle-delete-support.js";
import {
  readClawInstallRecordFromDatabase,
  updateClawInstallRecordStatus,
  type PersistedClawInstall,
} from "./provenance.js";

type ClawAgentConfigRemovalParams = {
  agentId: string;
  expectedDigest: string;
  expectedInstall?: PersistedClawInstall | null;
  expectedRemovalSurfaceDigest: string;
  expectedState: "present" | "missing";
  fallbackWorkspace: string;
  config?: OpenClawConfig;
  stateDatabase?: OpenClawStateDatabaseOptions;
  onModified: () => Error;
  quiesceMonitors?: (operationId: string) => Promise<void>;
  drainMonitors?: (operationId: string) => Promise<void>;
};

type ClawAgentConfigRemovalResult = {
  agentRemoved: boolean;
  cleanupTargets: ClawCleanupTargets;
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
  const configBeforeDelete = params.config ?? getRuntimeConfig();
  try {
    const committed = await deleteAgentConfigEntry({
      agentId: params.agentId,
      assertCurrent,
      allowConfigSizeDrop: true,
      allowMissing: params.expectedState === "missing",
      fallbackWorkspace: params.fallbackWorkspace,
      validateConfig: (config) => {
        assertCurrent();
        assertAgentSessionStoreDeletionSafe(config, params.agentId, params.stateDatabase);
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
  runDatabaseCleanup: AgentDeletionOperation["runDatabaseCleanup"];
};

export async function withClawAgentConfigRemoval<T>(
  params: ClawAgentConfigRemovalParams,
  apply: (
    commitRemoval: () => Promise<CommittedClawAgentRemoval>,
    assertCurrent: () => void,
  ) => Promise<T>,
): Promise<T> {
  const expectedInstall = structuredClone(params.expectedInstall);
  const stateOptions = {
    ...params.stateDatabase,
    path: openOpenClawStateDatabase(params.stateDatabase).path,
  };
  return await withAgentDeletion(
    params.agentId,
    async (begin) => {
      const config = params.config ?? getRuntimeConfig();
      assertAgentSessionStoreDeletionSafe(config, params.agentId, stateOptions);
      const effects = deletionEffects(
        config,
        params.agentId,
        params.fallbackWorkspace,
        stateOptions.env,
      );
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
        const previousJournal = readAgentDeletionJournalInDatabase(database, params.agentId);
        const claimedDeletion = begin({
          agentId: params.agentId,
          workspaceDir: effects.workspace,
          agentDir: effects.agentDir,
          sessionsDir: effects.sessionsDir,
          // Selective cleanup may retain modified or untracked workspace entries.
          deleteFiles: previousJournal?.deleteFiles ?? false,
        });
        return { existingJournal: previousJournal, deletion: claimedDeletion };
      }, stateOptions);
      let committed = false;
      let monitorEffectsStarted = false;
      const assertCurrent = (database?: OpenClawStateDatabase) => {
        const check = (current: OpenClawStateDatabase) => {
          deletion.assertCurrent(current);
          if (!matchesInstall(current)) {
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
              assertCurrent();
              await params.drainMonitors?.(deletion.entry.operationId);
              assertCurrent();
            },
            runDatabaseCleanup: deletion.runDatabaseCleanup,
            completeDeletion: deletion.completeInTransaction,
          };
        }, assertCurrent);
      } finally {
        // Pre-config partial results release only this attempt's fence; committed cleanup retains it.
        if (!committed && !monitorEffectsStarted && !existingJournal) {
          deletion.rollback();
        }
        if (expectedInstall) {
          // Result construction is pure; only the live operation may publish retry status.
          runOpenClawStateWriteTransaction((database) => {
            try {
              assertCurrent(database);
            } catch {
              return;
            }
            updateClawInstallRecordStatus(params.agentId, "partial", {
              ...stateOptions,
              database,
            });
          }, stateOptions);
        }
      }
    },
    stateOptions,
  );
}
