/**
 * Prepares restored transcript history and applies context-engine assembly.
 */
import { buildHierarchyReinforcementMessage } from "../../../auto-reply/handoff-summarizer.js";
import { filterHeartbeatTranscriptArtifacts } from "../../../auto-reply/heartbeat-filter.js";
import { resolveStorePath } from "../../../config/sessions/paths.js";
import {
  listSessionEntries,
  updateSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../../context-engine/host-compat.js";
import type { AssembleResult } from "../../../context-engine/types.js";
import { resolveHeartbeatSummaryForAgent } from "../../../infra/heartbeat-summary.js";
import type { createPreparedEmbeddedAgentSettingsManager } from "../../agent-project-settings.js";
import type { createCacheTrace } from "../../cache-trace.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../defaults.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { AgentSession, SessionManager } from "../../sessions/index.js";
import { buildActiveSubagentSystemPromptAddition } from "../../subagent-active-context.js";
import type { TranscriptPolicy } from "../../transcript-policy.js";
import { getHistoryLimitFromSessionKey, limitHistoryTurns } from "../history.js";
import { log } from "../logger.js";
import { sanitizeSessionHistory, validateReplayTurns } from "../replay-history.js";
import type { resolveOrphanRepairPlan } from "./attempt-orphan-repair.js";
import {
  loadAttemptSessionEntryAfterQuotaMaintenance,
  repairAttemptToolUseResultPairing,
} from "./attempt-transcript-helpers.js";
import {
  assembleAttemptContextEngine,
  type AttemptContextEngine,
} from "./attempt.context-engine-helpers.js";
import { prependSystemPromptAddition } from "./attempt.prompt-helpers.js";
import { estimateRenderedLlmBoundaryTokenPressure } from "./preemptive-compaction.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type CacheTrace = ReturnType<typeof createCacheTrace>;
type OrphanRepairPlan = ReturnType<typeof resolveOrphanRepairPlan>;
type SettingsManager = Pick<
  ReturnType<typeof createPreparedEmbeddedAgentSettingsManager>,
  "getCompactionReserveTokens"
>;

type PreparedEmbeddedAttemptHistory = {
  contextEnginePromptAuthority: NonNullable<AssembleResult["promptAuthority"]>;
  contextEngineAssemblySucceeded: boolean;
  unwindowedContextEngineMessagesForPrecheck?: AgentMessage[];
};

export async function prepareEmbeddedAttemptHistory(input: {
  attempt: EmbeddedRunAttemptParams;
  activeSession: AgentSession;
  sessionManager: SessionManager;
  activeContextEngine?: AttemptContextEngine;
  cacheTrace: CacheTrace;
  capabilityToolNames: ReadonlySet<string>;
  effectiveWorkspace: string;
  isOpenAIResponsesApi: boolean;
  isRawModelRun: boolean;
  orphanRepair?: OrphanRepairPlan;
  replayAllowedToolNames: Set<string>;
  sandboxed: boolean;
  sessionAgentId: string;
  settingsManager: SettingsManager;
  systemPromptText: string;
  transcriptPolicy: TranscriptPolicy;
  setActiveSessionSystemPrompt: (systemPrompt: string) => void;
}): Promise<PreparedEmbeddedAttemptHistory> {
  const { activeSession, attempt } = input;
  let systemPromptText = input.systemPromptText;
  const setSystemPrompt = (nextSystemPrompt: string) => {
    systemPromptText = nextSystemPrompt;
    input.setActiveSessionSystemPrompt(nextSystemPrompt);
  };

  if (input.isRawModelRun) {
    activeSession.agent.reset();
    setSystemPrompt("");
    input.cacheTrace?.recordStage("session:raw-model-run", {
      messages: activeSession.messages,
      system: systemPromptText,
    });
  } else {
    const prior = await sanitizeSessionHistory({
      messages: activeSession.messages,
      modelApi: attempt.model.api,
      modelId: attempt.modelId,
      provider: attempt.provider,
      allowedToolNames: input.replayAllowedToolNames,
      config: attempt.config,
      workspaceDir: input.effectiveWorkspace,
      env: process.env,
      model: attempt.model,
      sessionManager: input.sessionManager,
      sessionId: attempt.sessionId,
      policy: input.transcriptPolicy,
    });
    input.cacheTrace?.recordStage("session:sanitized", { messages: prior });
    const validated = await validateReplayTurns({
      messages: prior,
      modelApi: attempt.model.api,
      modelId: attempt.modelId,
      provider: attempt.provider,
      config: attempt.config,
      workspaceDir: input.effectiveWorkspace,
      env: process.env,
      model: attempt.model,
      sessionId: attempt.sessionId,
      policy: input.transcriptPolicy,
    });

    if (attempt.sessionKey) {
      const storePath = resolveStorePath(attempt.config?.session?.store, {
        agentId: input.sessionAgentId,
      });
      const sessionEntry = await loadAttemptSessionEntryAfterQuotaMaintenance({
        storePath,
        sessionKey: attempt.sessionKey,
      });
      const suspension = sessionEntry?.quotaSuspension;
      if (sessionEntry && suspension?.state === "resuming") {
        const subagents = listSessionEntries({ storePath, clone: false })
          .map(({ entry }) => entry)
          .filter((entry) => entry.spawnedBy === sessionEntry.sessionId)
          .map((entry) => ({
            sessionId: entry.sessionId,
            role: entry.subagentRole,
            lastStatus: entry.status,
          }));
        validated.push(
          buildHierarchyReinforcementMessage({
            summary: suspension.summary ?? "No recovery briefing was captured.",
            activeSubagents: subagents,
          }),
        );
        await updateSessionEntry(
          { storePath, sessionKey: attempt.sessionKey },
          async (entry) => {
            if (entry.quotaSuspension?.state !== "resuming") {
              return null;
            }
            return {
              quotaSuspension: { ...entry.quotaSuspension, state: "active" },
            };
          },
          { skipMaintenance: true, takeCacheOwnership: true },
        );
      }
    }

    if (attempt.sessionKey && attempt.config) {
      // Capability guidance must include deferred OpenClaw tools without
      // interpreting arbitrary client tool names as native capabilities.
      const activeSubagentPromptAddition = buildActiveSubagentSystemPromptAddition({
        cfg: attempt.config,
        controllerSessionKey: attempt.sessionKey,
        hasSessionsYield: input.capabilityToolNames.has("sessions_yield"),
      });
      if (activeSubagentPromptAddition) {
        setSystemPrompt(
          prependSystemPromptAddition({
            systemPrompt: systemPromptText,
            systemPromptAddition: activeSubagentPromptAddition,
          }),
        );
      }
    }

    const heartbeatSummary =
      attempt.config && input.sessionAgentId
        ? resolveHeartbeatSummaryForAgent(attempt.config, input.sessionAgentId)
        : undefined;
    const heartbeatFiltered = filterHeartbeatTranscriptArtifacts(
      validated,
      heartbeatSummary?.ackMaxChars,
      heartbeatSummary?.prompt,
    );
    const truncated = limitHistoryTurns(
      heartbeatFiltered,
      getHistoryLimitFromSessionKey(attempt.sessionKey, attempt.config),
    );
    // Truncation can orphan tool_result blocks by removing the assistant message
    // that contained the matching tool_use, so repair the pairs once more.
    const limited = input.transcriptPolicy.repairToolUseResultPairing
      ? repairAttemptToolUseResultPairing(truncated, input.isOpenAIResponsesApi)
      : truncated;
    input.cacheTrace?.recordStage("session:limited", { messages: limited });
    if (limited.length > 0 || prior.length > 0) {
      activeSession.agent.state.messages = limited;
    }
  }

  let contextEnginePromptAuthority: NonNullable<AssembleResult["promptAuthority"]> = "assembled";
  let contextEngineAssemblySucceeded = false;
  let unwindowedContextEngineMessagesForPrecheck: AgentMessage[] | undefined;
  if (input.activeContextEngine) {
    try {
      // Assemble may window the input in place. Preserve the original history for
      // the overflow precheck when the engine says preassembly can still overflow.
      const preassemblyMessages = activeSession.messages.slice();
      const reserveTokens = Math.max(
        0,
        Math.floor(input.settingsManager.getCompactionReserveTokens()),
      );
      const contextTokenBudget = Math.max(
        1,
        Math.floor(
          attempt.contextTokenBudget ??
            attempt.model.contextWindow ??
            attempt.model.maxTokens ??
            DEFAULT_CONTEXT_TOKENS,
        ),
      );
      const promptBudget = Math.max(1, contextTokenBudget - reserveTokens);
      const prompt = input.orphanRepair?.contextEnginePrompt ?? attempt.prompt ?? "";
      const renderedPromptTokens = estimateRenderedLlmBoundaryTokenPressure({
        systemPrompt: systemPromptText,
        prompt,
      });
      const messageBudget = Math.max(1, promptBudget - renderedPromptTokens);
      const assembled = await assembleAttemptContextEngine({
        contextEngine: input.activeContextEngine,
        sessionId: attempt.sessionId,
        sessionKey: attempt.sessionKey,
        messages: activeSession.messages,
        tokenBudget: messageBudget,
        availableTools: new Set(input.capabilityToolNames),
        citationsMode: attempt.config?.memory?.citations,
        sandboxed: input.sandboxed,
        modelId: attempt.modelId,
        maxOutputTokens: reserveTokens,
        contextEngineHostSupport: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
        providerId: attempt.provider,
        requestedModelId: attempt.requestedModelId,
        fallbackReason: attempt.fallbackReason,
        degradedReason: attempt.degradedReason,
        ...(attempt.prompt !== undefined ? { prompt } : {}),
      });
      if (!assembled) {
        throw new Error("context engine assemble returned no result");
      }
      const assembledMessages = input.transcriptPolicy.repairToolUseResultPairing
        ? repairAttemptToolUseResultPairing(assembled.messages, input.isOpenAIResponsesApi)
        : assembled.messages;
      if (assembledMessages !== activeSession.messages) {
        activeSession.agent.state.messages = assembledMessages;
      }
      contextEnginePromptAuthority = assembled.promptAuthority ?? "assembled";
      contextEngineAssemblySucceeded = true;
      if (contextEnginePromptAuthority === "preassembly_may_overflow") {
        unwindowedContextEngineMessagesForPrecheck = preassemblyMessages;
      }
      if (assembled.systemPromptAddition) {
        setSystemPrompt(
          prependSystemPromptAddition({
            systemPrompt: systemPromptText,
            systemPromptAddition: assembled.systemPromptAddition,
          }),
        );
        log.debug(
          `context engine: prepended system prompt addition (${assembled.systemPromptAddition.length} chars)`,
        );
      }
    } catch (error) {
      log.warn(`context engine assemble failed, using pipeline messages: ${String(error)}`);
    }
  }

  return {
    contextEnginePromptAuthority,
    contextEngineAssemblySucceeded,
    ...(unwindowedContextEngineMessagesForPrecheck
      ? { unwindowedContextEngineMessagesForPrecheck }
      : {}),
  };
}
