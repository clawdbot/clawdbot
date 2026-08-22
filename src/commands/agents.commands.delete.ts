// Implements agent deletion with gateway delegation and local cleanup fallback.
import type { AgentsDeleteResult } from "../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import {
  findOverlappingWorkspaceAgentIds,
  formatSharedAuthStoreOwnerDeleteError,
  isSharedAuthStoreOwner,
} from "../agents/agent-delete-safety.js";
import {
  beginAgentDeletion,
  claimCompletedAgentDeletion,
} from "../agents/agent-lifecycle-registry.js";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  tryResolveSoleAgentId,
} from "../agents/agent-scope.js";
import {
  resolveSharedAuthStoreOwnership,
  resolveSharedAuthStorePath,
} from "../agents/auth-profiles/path-resolve.js";
import { resolveAuthProfileDatabasePath } from "../agents/auth-profiles/sqlite.js";
import { resolveLegacyInheritedAuthAgentId } from "../agents/legacy-inherited-auth-dir.js";
import {
  prepareLegacyWorkspaceStateReset,
  removeLegacyWorkspaceStateForReset,
} from "../agents/workspace-legacy-state.js";
import {
  deleteWorkspaceState,
  prepareWorkspaceStateDeletion,
} from "../agents/workspace-state-store.js";
import { formatCliCommand } from "../cli/command-format.js";
import { formatCliJsonFailure } from "../cli/failure-output.js";
import { isTerminalInteractive } from "../cli/terminal-interactivity.js";
import { replaceConfigFile } from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import {
  purgeAgentSessionStoreEntries,
  resolveSessionTranscriptsDirForAgent,
} from "../config/sessions.js";
import { withLocalAgentCronJobsRemoved } from "../cron/local-service.js";
import {
  callGateway,
  isGatewayCredentialsRequiredError,
  isGatewayTransportError,
} from "../gateway/call.js";
import { withAgentExecApprovalsRemoved } from "../infra/exec-approvals.js";
import { normalizeAgentId, normalizeAgentIdStrict } from "../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { readAgentDeletionJournal } from "../state/agent-deletion-journal.js";
import { unregisterOpenClawAgentDatabases } from "../state/openclaw-agent-db-registry.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";
import { createQuietRuntime } from "./agents.command-shared.js";
import { findAgentEntryIndex, listAgentEntries, pruneAgentConfig } from "./agents.config.js";
import { moveToTrashResult } from "./cleanup-utils.js";
import { requireValidConfigFileSnapshot } from "./config-validation.js";

type AgentsDeleteOptions = {
  id: string;
  force?: boolean;
  json?: boolean;
};

type AgentDeleteRemovedPath = NonNullable<AgentsDeleteResult["removed"]>[number];
type AgentDeleteFailedPath = NonNullable<AgentsDeleteResult["failed"]>[number];
type AgentDeleteGatewayAttempt =
  | { kind: "deleted"; result: AgentsDeleteResult }
  | { kind: "fallback-unreachable" }
  | { kind: "fallback-credentials-required" };

function failAgentsDelete(opts: AgentsDeleteOptions, runtime: RuntimeEnv, message: string): void {
  if (opts.json) {
    writeRuntimeJson(runtime, formatCliJsonFailure(message));
    runtime.exit(1, { resetStream: process.stderr });
  } else {
    runtime.error(message);
    runtime.exit(1);
  }
}

function logClearedOwnerRefs(runtime: RuntimeEnv, clearedOwnerRefs: readonly string[]): void {
  if (clearedOwnerRefs.length > 0) {
    runtime.log(`Cleared owner references: ${clearedOwnerRefs.join(", ")}`);
  }
}

function logSessionPurgeWarning(runtime: RuntimeEnv, agentId: string, purgeFailed: boolean): void {
  if (purgeFailed) {
    runtime.error(
      `Warning: session-store purge failed for deleted agent "${agentId}"; stale shared-store rows may remain.`,
    );
  }
}

async function maybeDeleteAgentThroughGateway(params: {
  agentId: string;
  deleteFiles: boolean;
}): Promise<AgentDeleteGatewayAttempt> {
  try {
    const result = await callGateway<AgentsDeleteResult>({
      method: "agents.delete",
      params: {
        agentId: params.agentId,
        deleteFiles: params.deleteFiles,
      },
      mode: GATEWAY_CLIENT_MODES.CLI,
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      requiredMethods: ["agents.delete"],
    });
    return { kind: "deleted", result };
  } catch (error) {
    if (isGatewayTransportError(error) && error.kind === "closed" && error.code === undefined) {
      return { kind: "fallback-unreachable" };
    }
    if (isGatewayCredentialsRequiredError(error)) {
      return { kind: "fallback-credentials-required" };
    }
    throw error;
  }
}

/** Delete an agent, pruning config plus workspace/session state when it is safe to do so. */
export async function agentsDeleteCommand(
  opts: AgentsDeleteOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const configSnapshot = await requireValidConfigFileSnapshot(runtime);
  if (!configSnapshot) {
    return;
  }
  const cfg = configSnapshot.sourceConfig ?? configSnapshot.config;
  const baseHash = configSnapshot.hash;

  const input = opts.id?.trim();
  if (!input) {
    failAgentsDelete(
      opts,
      runtime,
      `Agent id is required. Run ${formatCliCommand("openclaw agents list")} to choose one.`,
    );
    return;
  }

  const normalized = normalizeAgentIdStrict(input);
  if (!normalized.ok) {
    failAgentsDelete(
      opts,
      runtime,
      `Agent "${input}" not found. Run ${formatCliCommand("openclaw agents list")} to see configured agents.`,
    );
    return;
  }
  const agentId = normalized.value;
  if (!opts.json && agentId !== input) {
    runtime.log(`Normalized agent id to "${agentId}".`);
  }
  const configured = findAgentEntryIndex(listAgentEntries(cfg), agentId) >= 0;
  let existingJournal = configured ? undefined : readAgentDeletionJournal(agentId);
  if (!configured && (!existingJournal || existingJournal.cleanupCompleted)) {
    failAgentsDelete(
      opts,
      runtime,
      `Agent "${agentId}" not found. Run ${formatCliCommand("openclaw agents list")} to see configured agents.`,
    );
    return;
  }
  const configuredAgentDir = configured ? resolveAgentDir(cfg, agentId) : undefined;
  const safetyAgentDir = existingJournal?.agentDir ?? configuredAgentDir;
  if (!safetyAgentDir) {
    throw new Error(`Agent "${agentId}" deletion has no state directory.`);
  }
  const sharedAuthOwnership = resolveSharedAuthStoreOwnership();
  if (
    isSharedAuthStoreOwner({
      ownership: sharedAuthOwnership,
      agentAuthDbPath: resolveAuthProfileDatabasePath(safetyAgentDir),
      sharedAuthDbPath: resolveSharedAuthStorePath(),
    })
  ) {
    failAgentsDelete(opts, runtime, formatSharedAuthStoreOwnerDeleteError(agentId));
    return;
  }

  if (configured && agentId === tryResolveSoleAgentId(cfg)) {
    failAgentsDelete(
      opts,
      runtime,
      `Agent "${agentId}" is the only configured agent and cannot be deleted.`,
    );
    return;
  }
  const explicitInheritedAuthAgentId = cfg.agents?.defaults?.authInheritance?.agentId?.trim();
  const inheritedAuthAgentId =
    explicitInheritedAuthAgentId ||
    (sharedAuthOwnership.location === "legacy-main" ? resolveLegacyInheritedAuthAgentId(cfg) : "");
  if (inheritedAuthAgentId && agentId === normalizeAgentId(inheritedAuthAgentId)) {
    failAgentsDelete(
      opts,
      runtime,
      `Agent "${agentId}" owns inherited credentials through agents.defaults.authInheritance.agentId and cannot be deleted. Relocate those credentials, then re-point or remove that binding before retrying.`,
    );
    return;
  }

  if (configured) {
    existingJournal = readAgentDeletionJournal(agentId);
    if (existingJournal?.cleanupCompleted) {
      if (!claimCompletedAgentDeletion(agentId, existingJournal.operationId)) {
        throw new Error(`Agent "${agentId}" deletion tombstone changed before fresh deletion.`);
      }
      existingJournal = undefined;
    }
  }
  const agentDir = existingJournal?.agentDir ?? configuredAgentDir;
  if (!agentDir) {
    throw new Error(`Agent "${agentId}" deletion has no state directory.`);
  }

  if (!opts.force) {
    if (!isTerminalInteractive()) {
      failAgentsDelete(opts, runtime, "Non-interactive session. Re-run with --force.");
      return;
    }
    const prompter = createClackPrompter();
    const confirmed = await prompter.confirm({
      message: `Delete agent "${agentId}" and prune workspace/state?`,
      initialValue: false,
    });
    if (!confirmed) {
      runtime.log("Cancelled.");
      return;
    }
  }

  const workspaceDir = existingJournal?.workspaceDir ?? resolveAgentWorkspaceDir(cfg, agentId);
  const sessionsDir = existingJournal?.sessionsDir ?? resolveSessionTranscriptsDirForAgent(agentId);
  const result = configured
    ? pruneAgentConfig(cfg, agentId)
    : { config: cfg, removedBindings: 0, removedAllow: 0, clearedOwnerRefs: [] };

  const gatewayAttempt = await maybeDeleteAgentThroughGateway({
    agentId,
    deleteFiles: true,
  });
  if (gatewayAttempt.kind === "deleted") {
    const gatewayResult = gatewayAttempt.result;
    if (opts.json) {
      const workspaceSharedWith = findOverlappingWorkspaceAgentIds(cfg, agentId, workspaceDir);
      const workspaceRetained = workspaceSharedWith.length > 0;
      writeRuntimeJson(runtime, {
        agentId,
        workspace: workspaceDir,
        workspaceRetained: workspaceRetained || undefined,
        workspaceRetainedReason: workspaceRetained ? "shared" : undefined,
        workspaceSharedWith: workspaceRetained ? workspaceSharedWith : undefined,
        agentDir,
        sessionsDir,
        removedBindings: gatewayResult.removedBindings,
        removedAllow: result.removedAllow,
        clearedOwnerRefs: result.clearedOwnerRefs.length > 0 ? result.clearedOwnerRefs : undefined,
        removed: gatewayResult.removed,
        failed: gatewayResult.failed,
        ...(gatewayResult.purgeFailed ? { purgeFailed: true } : {}),
        transport: "gateway",
      });
    } else {
      runtime.log(`Deleted agent: ${agentId}`);
      logClearedOwnerRefs(runtime, result.clearedOwnerRefs);
      logSessionPurgeWarning(runtime, agentId, gatewayResult.purgeFailed === true);
      for (const failure of gatewayResult.failed ?? []) {
        runtime.error(
          `Warning: path could not be moved to Trash: ${failure.reason}; remove it manually at ${failure.path}`,
        );
      }
    }
    return;
  }

  const workspaceSharedWith = findOverlappingWorkspaceAgentIds(cfg, agentId, workspaceDir);
  const workspaceRetained = workspaceSharedWith.length > 0;

  const deleteFiles = existingJournal?.deleteFiles ?? true;
  const deletion = beginAgentDeletion(
    existingJournal ?? { agentId, agentDir, workspaceDir, sessionsDir, deleteFiles },
  );
  try {
    const commitRoster = async () =>
      await withAgentExecApprovalsRemoved(agentId, async () => {
        if (configured) {
          await replaceConfigFile({
            nextConfig: result.config,
            ...(baseHash !== undefined ? { baseHash } : {}),
            writeOptions: {
              allowedAgentRosterRemovals: [agentId],
              ...(opts.json ? { skipOutputLogs: true } : {}),
            },
          });
          if (!opts.json) {
            logConfigUpdated(runtime);
          }
        }
      });
    if (gatewayAttempt.kind === "fallback-unreachable") {
      await withLocalAgentCronJobsRemoved(agentId, () => cfg, commitRoster);
    } else {
      // Credential resolution fails before transport, so a live scheduler may still own the store.
      await commitRoster();
    }
    deletion.commit();
  } catch (error) {
    if (!existingJournal) {
      deletion.rollback();
    }
    throw error;
  }

  // Purge session store entries for this agent so orphaned sessions cannot be targeted (#65524).
  const purgeFailed = await purgeAgentSessionStoreEntries(cfg, agentId);

  const quietRuntime = opts.json ? createQuietRuntime(runtime) : runtime;
  // Only trash the workspace if no other agent can depend on that path (#70890).
  let workspaceCleanupError: Error | undefined;
  const removed: AgentDeleteRemovedPath[] = [];
  const failed: AgentDeleteFailedPath[] = [];
  const removePath = async (pathname: string) => {
    const outcome = await moveToTrashResult(pathname, quietRuntime);
    if ("removed" in outcome) {
      removed.push(outcome.removed);
    } else {
      failed.push(outcome.failed);
    }
    return outcome;
  };
  if (deleteFiles && workspaceRetained) {
    quietRuntime.log(
      `Skipped workspace removal (shared with other agents: ${workspaceSharedWith.join(", ")}): ${workspaceDir}`,
    );
  } else if (deleteFiles) {
    const legacyPlan = prepareLegacyWorkspaceStateReset(workspaceDir);
    const statePlan = prepareWorkspaceStateDeletion(workspaceDir);
    const workspaceResult = await removePath(workspaceDir);
    if ("removed" in workspaceResult) {
      try {
        const legacyCleanup = await removeLegacyWorkspaceStateForReset(legacyPlan);
        for (const warning of legacyCleanup.warnings) {
          quietRuntime.log(warning);
        }
        deleteWorkspaceState(statePlan);
      } catch (error) {
        workspaceCleanupError = error instanceof Error ? error : new Error(String(error));
      }
    }
  }
  if (deleteFiles) {
    await removePath(agentDir);
    await removePath(sessionsDir);
  }
  if (workspaceCleanupError) {
    throw workspaceCleanupError;
  }
  if (failed.length === 0) {
    if (deleteFiles) {
      // Keep registry ownership until every cleanup target is terminal. A crash before journal
      // completion leaves this idempotent deregistration reachable on the next delete attempt.
      unregisterOpenClawAgentDatabases({ agentId });
    }
    deletion.finish();
  }

  if (opts.json) {
    writeRuntimeJson(runtime, {
      agentId,
      workspace: workspaceDir,
      workspaceRetained: workspaceRetained || undefined,
      workspaceRetainedReason: workspaceRetained ? "shared" : undefined,
      workspaceSharedWith: workspaceRetained ? workspaceSharedWith : undefined,
      agentDir,
      sessionsDir,
      removedBindings: result.removedBindings,
      removedAllow: result.removedAllow,
      clearedOwnerRefs: result.clearedOwnerRefs.length > 0 ? result.clearedOwnerRefs : undefined,
      removed,
      failed,
      ...(purgeFailed ? { purgeFailed: true } : {}),
      ...(gatewayAttempt.kind === "fallback-credentials-required"
        ? { cronCleanupSkipped: true }
        : {}),
    });
  } else {
    runtime.log(`Deleted agent: ${agentId}`);
    logClearedOwnerRefs(runtime, result.clearedOwnerRefs);
    logSessionPurgeWarning(runtime, agentId, purgeFailed);
  }
  if (gatewayAttempt.kind === "fallback-credentials-required") {
    runtime.error(
      `Warning: cron cleanup was skipped for deleted agent "${agentId}" because the Gateway could not be authenticated; scheduled jobs may remain.`,
    );
  }
}
