import type { ThinkLevel, VerboseLevel } from "../../auto-reply/thinking.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { assertAgentRunLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import { registerAgentRunContext } from "../../infra/agent-run-registry.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { applyVerboseOverride } from "../../sessions/level-overrides.js";
import { recordSessionHumanDirectMessage } from "../../sessions/session-state-events.js";
import { resolveEffectiveAgentSkillFilter } from "../../skills/discovery/agent-filter.js";
import { persistAgentSession } from "./attempt-execution.shared.js";
import { resolveAgentRunContext } from "./run-context.js";
import { loadExecDefaultsRuntime, loadSkillsRuntime } from "./runtime-loaders.js";
import type { AgentCommandOpts } from "./types.js";

export async function prepareEmbeddedSessionState(params: {
  cfg: OpenClawConfig;
  opts: AgentCommandOpts;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  sessionId: string;
  storePath: string;
  sessionAgentId: string;
  lifecycleGeneration: string;
  runId: string;
  workspaceDir: string;
  executionSkillsDir: string;
  watchSkills: boolean;
  isNewSession: boolean;
  isSubagentLaneTurn: boolean;
  suppressVisibleSessionEffects: boolean;
  thinkOnce?: ThinkLevel;
  thinkOverride?: ThinkLevel;
  persistedThinking?: ThinkLevel;
  verboseOverride?: VerboseLevel;
  persistedVerbose?: VerboseLevel;
  verboseDefault?: VerboseLevel;
  sessionStateActor: Parameters<typeof recordSessionHumanDirectMessage>[0]["actor"];
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
}) {
  const requestedThinkLevel = params.thinkOnce ?? params.thinkOverride ?? params.persistedThinking;
  const resolvedVerboseLevel =
    params.verboseOverride ?? params.persistedVerbose ?? params.verboseDefault;

  assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration);
  if (params.sessionKey || params.suppressVisibleSessionEffects) {
    registerAgentRunContext(params.runId, {
      ...(params.sessionKey ? { sessionKey: params.sessionKey, sessionId: params.sessionId } : {}),
      agentId: params.sessionAgentId,
      lifecycleGeneration: params.lifecycleGeneration,
      verboseLevel: resolvedVerboseLevel,
      isControlUiVisible: !params.suppressVisibleSessionEffects,
      // Node and local command ingress may not have a separate chat activity owner.
      projectSessionActive: !params.suppressVisibleSessionEffects,
    });
  }

  let sessionEntry = params.sessionEntry;
  const skillFilter = resolveEffectiveAgentSkillFilter(params.cfg, params.sessionAgentId);
  const currentSkillsSnapshot = sessionEntry?.skillsSnapshot;
  const [
    { getRemoteSkillEligibility, resolveReusableWorkspaceSkillSnapshot },
    { resolveNodeExecEligibility },
  ] = await Promise.all([loadSkillsRuntime(), loadExecDefaultsRuntime()]);
  const nodeSkillsEligibility = resolveNodeExecEligibility({
    cfg: params.cfg,
    sessionEntry,
    sessionKey: params.sessionKey,
    agentId: params.sessionAgentId,
  });
  const skillSnapshotState = resolveReusableWorkspaceSkillSnapshot({
    workspaceDir: params.workspaceDir,
    executionSkillsDir: params.executionSkillsDir,
    config: params.cfg,
    agentId: params.sessionAgentId,
    existingSnapshot: params.isNewSession ? undefined : currentSkillsSnapshot,
    skillFilter,
    eligibility: {
      nodeSkills: nodeSkillsEligibility,
      remote: getRemoteSkillEligibility({
        advertiseExecNode: nodeSkillsEligibility.canExec,
      }),
    },
    // A one-shot caller has no later turn to consume invalidations; persistent
    // watchers would keep its process alive after the reply has completed.
    watch: params.watchSkills && params.opts.oneShotCliRun !== true,
    ...(params.pluginMetadataSnapshot
      ? { pluginMetadataSnapshot: params.pluginMetadataSnapshot }
      : {}),
  });
  const needsSkillsSnapshot =
    params.isNewSession || !currentSkillsSnapshot || skillSnapshotState.shouldRefresh;
  const skillsSnapshot = skillSnapshotState.snapshot;

  if (
    skillsSnapshot &&
    params.sessionStore &&
    params.sessionKey &&
    needsSkillsSnapshot &&
    !params.suppressVisibleSessionEffects
  ) {
    const now = Date.now();
    const current = sessionEntry ?? {
      sessionId: params.sessionId,
      updatedAt: now,
      sessionStartedAt: now,
    };
    const next: SessionEntry = {
      ...current,
      sessionId: params.sessionId,
      updatedAt: now,
      sessionStartedAt: current.sessionStartedAt ?? now,
      skillsSnapshot,
    };
    sessionEntry = await persistAgentSession({
      sessionStore: params.sessionStore,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      initialEntry: current,
      entry: next,
    });
  }

  // Persist non-model-dependent command state before provider/model resolution.
  // Thinking is written only after the selected runtime validates it.
  const shouldPersistInitialSessionTouch =
    params.opts.skipInitialSessionTouch !== true || Boolean(params.verboseOverride);
  if (
    params.sessionStore &&
    params.sessionKey &&
    !params.suppressVisibleSessionEffects &&
    shouldPersistInitialSessionTouch
  ) {
    const now = Date.now();
    const entry = params.sessionStore[params.sessionKey] ??
      sessionEntry ?? { sessionId: params.sessionId, updatedAt: now, sessionStartedAt: now };
    const next: SessionEntry = {
      ...entry,
      sessionId: params.sessionId,
      updatedAt: now,
      sessionStartedAt: entry.sessionStartedAt ?? now,
      lastInteractionAt: now,
      agentStatus: undefined,
    };
    applyVerboseOverride(next, params.verboseOverride);
    sessionEntry = await persistAgentSession({
      sessionStore: params.sessionStore,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      initialEntry: entry,
      entry: next,
    });
  }
  if (params.sessionKey && !params.isSubagentLaneTurn) {
    recordSessionHumanDirectMessage({
      sessionKey: params.sessionKey,
      entry: sessionEntry,
      agentId: params.sessionAgentId,
      actor: params.sessionStateActor,
      channel: params.opts.channel,
      runId: params.runId,
    });
  }

  return {
    sessionEntry,
    requestedThinkLevel,
    resolvedVerboseLevel,
    skillsSnapshot,
    runContext: resolveAgentRunContext(params.opts),
  };
}

export type EmbeddedSessionState = Awaited<ReturnType<typeof prepareEmbeddedSessionState>>;
