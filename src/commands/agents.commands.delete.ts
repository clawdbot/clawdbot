// Implements agent deletion with gateway delegation and local cleanup fallback.
import { findOverlappingWorkspaceAgentIds } from "../agents/agent-delete-safety.js";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import {
  prepareLegacyWorkspaceStateReset,
  removeLegacyWorkspaceStateForReset,
} from "../agents/workspace-legacy-state.js";
import {
  deleteWorkspaceState,
  prepareWorkspaceStateDeletion,
} from "../agents/workspace-state-store.js";
import { formatCliCommand } from "../cli/command-format.js";
import { replaceConfigFile } from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import {
  purgeAgentSessionStoreEntries,
  resolveSessionTranscriptsDirForAgent,
} from "../config/sessions.js";
import {
  callGateway,
  isGatewayCredentialsRequiredError,
  isGatewayTransportError,
} from "../gateway/call.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";
import { createQuietRuntime, requireValidConfigFileSnapshot } from "./agents.command-shared.js";
import { findAgentEntryIndex, listAgentEntries, pruneAgentConfig } from "./agents.config.js";
import { moveToTrash } from "./onboard-helpers.js";

type AgentsDeleteOptions = {
  id: string;
  force?: boolean;
  json?: boolean;
};

type AgentsDeleteGatewayResult = {
  ok: true;
  agentId: string;
  removedBindings: number;
  removed?: Array<{ path: string; method: "trash" | "missing" }>;
  failed?: Array<{ path: string; reason: string }>;
};

async function maybeDeleteAgentThroughGateway(params: {
  agentId: string;
  deleteFiles: boolean;
}): Promise<AgentsDeleteGatewayResult | null> {
  try {
    return await callGateway<AgentsDeleteGatewayResult>({
      method: "agents.delete",
      params: {
        agentId: params.agentId,
        deleteFiles: params.deleteFiles,
      },
      mode: GATEWAY_CLIENT_MODES.CLI,
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      requiredMethods: ["agents.delete"],
    });
  } catch (error) {
    if (isGatewayTransportError(error) || isGatewayCredentialsRequiredError(error)) {
      return null;
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
    runtime.error(
      `Agent id is required. Run ${formatCliCommand("openclaw agents list")} to choose one.`,
    );
    runtime.exit(1);
    return;
  }

  const agentId = normalizeAgentId(input);
  if (agentId !== input) {
    runtime.log(`Normalized agent id to "${agentId}".`);
  }
  if (findAgentEntryIndex(listAgentEntries(cfg), agentId) < 0) {
    runtime.error(
      `Agent "${agentId}" not found. Run ${formatCliCommand("openclaw agents list")} to see configured agents.`,
    );
    runtime.exit(1);
    return;
  }
  if (listAgentEntries(cfg).length > 0 && agentId === resolveDefaultAgentId(cfg)) {
    runtime.error(
      `Agent "${agentId}" is the default and cannot be deleted. Reassign default first.`,
    );
    runtime.exit(1);
    return;
  }

  if (!opts.force) {
    if (!process.stdin.isTTY) {
      runtime.error("Non-interactive session. Re-run with --force.");
      runtime.exit(1);
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

  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const agentDir = resolveAgentDir(cfg, agentId);
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
  const result = pruneAgentConfig(cfg, agentId);

  const gatewayResult = await maybeDeleteAgentThroughGateway({
    agentId,
    deleteFiles: true,
  });
  if (gatewayResult) {
    const workspaceSharedWith = findOverlappingWorkspaceAgentIds(cfg, agentId, workspaceDir);
    const workspaceRetained = workspaceSharedWith.length > 0;
    if (opts.json) {
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
        removed: gatewayResult.removed,
        failed: gatewayResult.failed,
        transport: "gateway",
      });
    } else {
      runtime.log(`Deleted agent: ${agentId}`);
      for (const failure of gatewayResult.failed ?? []) {
        runtime.error(
          `Warning: path could not be moved to Trash: ${failure.reason}; remove it manually at ${failure.path}`,
        );
      }
    }
    return;
  }

  await replaceConfigFile({
    nextConfig: result.config,
    ...(baseHash !== undefined ? { baseHash } : {}),
    writeOptions: opts.json ? { skipOutputLogs: true } : undefined,
  });
  if (!opts.json) {
    logConfigUpdated(runtime);
  }

  // Purge session store entries for this agent so orphaned sessions cannot be targeted (#65524).
  await purgeAgentSessionStoreEntries(cfg, agentId);

  const quietRuntime = opts.json ? createQuietRuntime(runtime) : runtime;
  // Only trash the workspace if no other agent can depend on that path (#70890).
  const workspaceSharedWith = findOverlappingWorkspaceAgentIds(cfg, agentId, workspaceDir);
  const workspaceRetained = workspaceSharedWith.length > 0;
  let workspaceCleanupError: Error | undefined;
  if (workspaceRetained) {
    quietRuntime.log(
      `Skipped workspace removal (shared with other agents: ${workspaceSharedWith.join(", ")}): ${workspaceDir}`,
    );
  } else {
    const legacyPlan = prepareLegacyWorkspaceStateReset(workspaceDir);
    const statePlan = prepareWorkspaceStateDeletion(workspaceDir);
    const workspaceRemoved = await moveToTrash(workspaceDir, quietRuntime);
    if (workspaceRemoved) {
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
  await moveToTrash(agentDir, quietRuntime);
  await moveToTrash(sessionsDir, quietRuntime);
  if (workspaceCleanupError) {
    throw workspaceCleanupError;
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
    });
  } else {
    runtime.log(`Deleted agent: ${agentId}`);
  }
}
