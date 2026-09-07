import type { FollowupRun } from "../../auto-reply/reply/queue.js";
import { resolveCollapsedSessionAuthPinSource } from "../../config/sessions/auth-profile-override-provenance.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { assertAgentRunLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import { readPendingUserTurnTranscriptAdmission } from "../../sessions/user-turn-transcript-admission.js";
import {
  prepareAgentCommandExecutionIdentity,
  type AgentCommandAdmissionIngress,
} from "../agent-command-execution-identity.js";
import { createSessionMaintenanceFollowup } from "../session-maintenance/run.js";
import { createCommandBudget } from "./maintenance-budget.js";
import type { EmbeddedModelSelection } from "./model-selection.js";
import type { PreparedAgentCommandExecution } from "./prepare.js";
import { loadAgentRunnerMemoryRuntime } from "./runtime-loaders.js";
import type { EmbeddedSessionState } from "./session-preparation.js";
import type { AgentCommandOpts } from "./types.js";

/** Build a new system-owned request, without retaining foreground callbacks or writer custody. */
export function createCommandMaintenanceFollowup(params: {
  prepared: PreparedAgentCommandExecution;
  sessionEntry: SessionEntry;
  embeddedSessionState: EmbeddedSessionState;
  provider: string;
  model: string;
  thinkLevel: FollowupRun["run"]["thinkLevel"];
  auth?: Pick<FollowupRun["run"], "authProfileId" | "authProfileIdSource">;
}): FollowupRun {
  const { prepared, sessionEntry } = params;
  return createSessionMaintenanceFollowup({
    run: {
      agentId: prepared.sessionAgentId,
      agentDir: prepared.agentDir,
      workspaceDir: prepared.workspaceDir,
      cwd: prepared.cwd,
      messageProvider: params.embeddedSessionState.runContext.messageChannel,
      agentAccountId: params.embeddedSessionState.runContext.accountId,
      chatType: sessionEntry.chatType,
      groupId: params.embeddedSessionState.runContext.groupId ?? undefined,
      groupChannel: params.embeddedSessionState.runContext.groupChannel ?? undefined,
      groupSpace: params.embeddedSessionState.runContext.groupSpace ?? undefined,
      skillsSnapshot: params.embeddedSessionState.skillsSnapshot,
      thinkLevel: params.thinkLevel,
      verboseLevel: params.embeddedSessionState.resolvedVerboseLevel ?? "off",
      timeoutMs: prepared.timeoutMs,
    },
    sessionEntry,
    cfg: prepared.cfg,
    sessionKey: prepared.sessionKey,
    provider: params.provider,
    model: params.model,
    auth: params.auth ?? {
      authProfileId: sessionEntry.authProfileOverride?.trim() || undefined,
      authProfileIdSource: resolveCollapsedSessionAuthPinSource(sessionEntry),
    },
  });
}

type CommandPreflight = {
  prepared: PreparedAgentCommandExecution;
  opts: AgentCommandOpts;
  sessionEntry?: SessionEntry;
  embeddedSessionState: EmbeddedSessionState;
  modelSelection: EmbeddedModelSelection;
  lifecycleGeneration: string;
  onCommittedSessionId: (sessionId: string) => void;
};

/** Bind recovery and runtime preparation to the accepted preflight successor. */
export async function prepareCommandForegroundRun(
  params: CommandPreflight & {
    ingress: AgentCommandAdmissionIngress;
    suppressVisibleSessionEffects: boolean;
    preserveUserFacingSessionModelState: boolean;
  },
) {
  const budget = createCommandBudget(
    Date.now(),
    params.prepared.timeoutMs,
    params.opts.abortSignal,
  );
  let entry: SessionEntry | undefined;
  let timeoutMs: number;
  try {
    entry =
      params.opts.modelRun === true ||
      params.opts.promptMode === "none" ||
      params.suppressVisibleSessionEffects ||
      params.preserveUserFacingSessionModelState
        ? params.sessionEntry
        : await runCommandPreflightMaintenance({
            ...params,
            opts: { ...params.opts, abortSignal: budget.signal },
          });
    timeoutMs = budget.remainingMs();
    budget.signal.throwIfAborted();
  } finally {
    budget.dispose();
  }
  const prepared = {
    ...params.prepared,
    timeoutMs,
    ...(entry ? { sessionId: entry.sessionId, sessionEntry: entry } : {}),
  };
  if (entry && entry.sessionId !== params.prepared.sessionId) {
    params.modelSelection.sessionEntryForAttempt = {
      ...(params.modelSelection.sessionEntryForAttempt ?? entry),
      sessionId: entry.sessionId,
      lifecycleRevision: entry.lifecycleRevision,
    };
    params.modelSelection.sessionFile = prepared.sessionKey ?? entry.sessionId;
  }
  params.modelSelection.sessionEntry = entry;
  params.embeddedSessionState.sessionEntry = entry;
  return {
    prepared,
    admission: prepareAgentCommandExecutionIdentity({
      opts: params.opts,
      prepared,
      ingress: params.ingress,
      lifecycleGeneration: params.lifecycleGeneration,
    }),
  };
}

/** Required checkpointing stays with the foreground owner before its first inference. */
async function runCommandPreflightMaintenance(
  params: CommandPreflight,
): Promise<SessionEntry | undefined> {
  const { prepared, opts, sessionEntry, modelSelection } = params;
  if (
    prepared.isNewSession ||
    !sessionEntry ||
    !prepared.sessionKey ||
    prepared.cfg.agents?.defaults?.compaction?.enabled === false
  ) {
    return sessionEntry;
  }
  const assertActive = () => {
    opts.abortSignal?.throwIfAborted();
    assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration);
  };
  assertActive();
  const preflightAdmission = readPendingUserTurnTranscriptAdmission(
    opts.userTurnTranscriptRecorder,
  );
  const memory = await loadAgentRunnerMemoryRuntime();
  assertActive();
  const followupRun = createCommandMaintenanceFollowup({
    ...params,
    sessionEntry,
    provider: modelSelection.provider,
    model: modelSelection.model,
    thinkLevel: modelSelection.effectiveTurnThinkLevel,
    auth: {
      authProfileId: modelSelection.sessionEntryForAttempt?.authProfileOverride,
      authProfileIdSource: resolveCollapsedSessionAuthPinSource(
        modelSelection.sessionEntryForAttempt,
      ),
    },
  });
  followupRun.prompt = prepared.body;
  return memory.runSessionCompactionIfNeeded({
    pendingUserEntryId: preflightAdmission?.entryId,
    cfg: prepared.cfg,
    followupRun,
    promptForEstimate: prepared.body,
    defaultModel: modelSelection.defaultModel,
    sessionEntry,
    sessionStore: prepared.sessionStore,
    sessionKey: prepared.sessionKey,
    runtimePolicySessionKey: prepared.sessionKey,
    storePath: prepared.storePath,
    isHeartbeat: opts.bootstrapContextRunKind === "heartbeat",
    abortSignal: opts.abortSignal,
    authorize: () => {
      assertActive();
      return true;
    },
    onSessionIdChanged: opts.onSessionIdChanged,
    onCompactionCommitted: (accepted) => params.onCommittedSessionId(accepted.sessionId),
    beforeCompaction: async (entry) => {
      const flushed = await memory.runMemoryFlushIfNeeded({
        preflightAdmission,
        cfg: prepared.cfg,
        followupRun,
        promptForEstimate: prepared.body,
        defaultModel: modelSelection.defaultModel,
        resolvedVerboseLevel: params.embeddedSessionState.resolvedVerboseLevel ?? "off",
        sessionEntry: entry,
        sessionStore: prepared.sessionStore,
        sessionKey: prepared.sessionKey,
        runtimePolicySessionKey: prepared.sessionKey,
        storePath: prepared.storePath,
        isHeartbeat: opts.bootstrapContextRunKind === "heartbeat",
        abortSignal: opts.abortSignal,
      });
      assertActive();
      return flushed.sessionEntry;
    },
  });
}
