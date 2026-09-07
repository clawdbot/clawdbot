import { preserveCompactionReplayWindow } from "@openclaw/ai/transports";
import { buildHierarchyReinforcementMessage } from "../../../auto-reply/handoff-summarizer.js";
import { filterHeartbeatTranscriptArtifacts } from "../../../auto-reply/heartbeat-filter.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import {
  listSessionEntriesReadOnly,
  updateSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../../context-engine/host-compat.js";
import type { AssembleResult } from "../../../context-engine/types.js";
import { resolveHeartbeatSummaryForAgent } from "../../../infra/heartbeat-summary.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../defaults.js";
import { assembleHarnessContextEngine } from "../../harness/context-engine-lifecycle.js";
import type { AgentMessage } from "../../runtime/index.js";
import { sanitizeToolUseResultPairingForModel } from "../../session-transcript-repair.js";
import { getHistoryLimitFromSessionKey, limitHistoryTurns } from "../history.js";
import { log } from "../logger.js";
import { sanitizeSessionHistory, validateReplayTurns } from "../replay-history.js";
import type { EmbeddedAttemptExecutionPhaseInput } from "./attempt-execution-types.js";
import { prependSystemPromptAddition } from "./attempt-prompt-helpers.js";
import { resolveAttemptStreamAuthProfileId } from "./attempt-run-decisions.js";
import { loadAttemptSessionEntryAfterQuotaMaintenance } from "./attempt-transcript-helpers.js";
import { estimateRenderedLlmBoundaryTokenPressure } from "./preemptive-compaction.js";

/**
 * Prepares restored transcript history and applies context-engine assembly.
 */

type PreparedEmbeddedAttemptHistory = {
  contextEnginePromptAuthority: NonNullable<AssembleResult["promptAuthority"]>;
  contextEngineAssemblySucceeded: boolean;
  unwindowedContextEngineMessagesForPrecheck?: AgentMessage[];
};

export async function prepareEmbeddedAttemptHistory(
  input: EmbeddedAttemptExecutionPhaseInput,
): Promise<PreparedEmbeddedAttemptHistory> {
  const { attempt, activeContextEngine, isRawModelRun } = input;
  const {
    agentSession: { activeSession, settingsManager, setActiveSessionSystemPrompt },
    boundary: { orphanRepair },
    cacheTrace,
    isOpenAIResponsesApi,
    sessionManager,
    transcriptPolicy,
    transport: { compactionReplayEnabled },
  } = input.prepared.sessionRuntime;
  const { capabilityToolNames, replayAllowedToolNames } =
    input.prepared.toolCatalog.toolSearchRunPlan;
  const { effectiveWorkspace, sessionAgentId } = input.setup;
  const sandboxed = input.setup.sandbox?.enabled === true;
  const isSettledTurnFinalization = attempt.operation === "settled-tool-finalization";
  let systemPromptText = input.prepared.sessionRuntime.state.systemPromptText;
  const setSystemPrompt = (nextSystemPrompt: string) => {
    systemPromptText = nextSystemPrompt;
    setActiveSessionSystemPrompt(nextSystemPrompt);
  };

  if (isRawModelRun) {
    activeSession.agent.reset();
    setSystemPrompt("");
    cacheTrace?.recordStage("session:raw-model-run", {
      messages: activeSession.messages,
      system: systemPromptText,
    });
  } else {
    const replayContext = () => ({
      modelApi: attempt.model.api,
      modelId: attempt.modelId,
      provider: attempt.provider,
      config: attempt.config,
      workspaceDir: effectiveWorkspace,
      env: process.env,
      model: attempt.model,
      sessionId: attempt.sessionId,
      policy: transcriptPolicy,
    });
    const prior = await sanitizeSessionHistory({
      ...replayContext(),
      messages: activeSession.messages,
      allowedToolNames: replayAllowedToolNames,
      sessionManager,
    });
    cacheTrace?.recordStage("session:sanitized", { messages: prior });
    const validated = await validateReplayTurns({ ...replayContext(), messages: prior });

    if (
      attempt.sessionKey &&
      attempt.sessionPersistence !== "detached" &&
      !isSettledTurnFinalization
    ) {
      const storePath = resolveSessionStorePathCore(attempt.config?.session?.store, {
        agentId: sessionAgentId,
      });
      const sessionEntry = await loadAttemptSessionEntryAfterQuotaMaintenance({
        agentId: sessionAgentId,
        storePath,
        sessionKey: attempt.sessionKey,
      });
      const suspension = sessionEntry?.quotaSuspension;
      if (sessionEntry && suspension?.state === "resuming") {
        const subagents = listSessionEntriesReadOnly({
          agentId: sessionAgentId,
          storePath,
          clone: false,
        })
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
          { agentId: sessionAgentId, storePath, sessionKey: attempt.sessionKey },
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

    const limited = (() => {
      if (isSettledTurnFinalization) {
        return validated;
      }
      const heartbeatSummary =
        attempt.config && sessionAgentId
          ? resolveHeartbeatSummaryForAgent(attempt.config, sessionAgentId)
          : undefined;
      const heartbeatFiltered = filterHeartbeatTranscriptArtifacts(
        validated,
        heartbeatSummary?.ackMaxChars,
        heartbeatSummary?.prompt,
      );
      const truncated = preserveCompactionReplayWindow(
        heartbeatFiltered,
        limitHistoryTurns(
          heartbeatFiltered,
          getHistoryLimitFromSessionKey(attempt.sessionKey, attempt.config, {
            accountId: attempt.agentAccountId,
            peerId: attempt.conversationRoutePeerId,
            chatType: attempt.chatType,
          }),
        ),
        attempt.model,
        {
          sessionId: attempt.sessionId,
          authProfileId: resolveAttemptStreamAuthProfileId(attempt),
          enabled: compactionReplayEnabled,
        },
      );
      // Truncation can orphan tool_result blocks by removing the assistant message
      // that contained the matching tool_use, so repair the pairs once more.
      return transcriptPolicy.repairToolUseResultPairing
        ? sanitizeToolUseResultPairingForModel(truncated, isOpenAIResponsesApi)
        : truncated;
    })();
    cacheTrace?.recordStage("session:limited", { messages: limited });
    if (limited.length > 0 || prior.length > 0) {
      activeSession.agent.state.messages = limited;
    }
  }

  let contextEnginePromptAuthority: NonNullable<AssembleResult["promptAuthority"]> = "assembled";
  let contextEngineAssemblySucceeded = false;
  let unwindowedContextEngineMessagesForPrecheck: AgentMessage[] | undefined;
  if (activeContextEngine) {
    try {
      // Assemble may window the input in place. Preserve the original history for
      // the overflow precheck when the engine says preassembly can still overflow.
      const preassemblyMessages = activeSession.messages.slice();
      const reserveTokens = Math.max(0, Math.floor(settingsManager.getCompactionReserveTokens()));
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
      const prompt = orphanRepair?.contextEnginePrompt ?? attempt.prompt ?? "";
      const renderedPromptTokens = estimateRenderedLlmBoundaryTokenPressure({
        systemPrompt: systemPromptText,
        prompt,
      });
      const messageBudget = Math.max(1, promptBudget - renderedPromptTokens);
      const transcriptReadFence = attempt.userTurnTranscriptRecorder?.getAdmissionReceipt();
      const assembled = await assembleHarnessContextEngine({
        contextEngine: activeContextEngine,
        sessionId: attempt.sessionId,
        sessionKey: attempt.sessionKey,
        agentId: sessionAgentId,
        appendOnlyRuntimeContext: transcriptPolicy.appendOnlyRuntimeContext,
        messages: activeSession.messages,
        tokenBudget: messageBudget,
        availableTools: new Set(capabilityToolNames),
        citationsMode: attempt.config?.memory?.citations,
        sandboxed,
        modelId: attempt.modelId,
        maxOutputTokens: reserveTokens,
        contextEngineHostSupport: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
        providerId: attempt.provider,
        requestedModelId: attempt.requestedModelId,
        fallbackReason: attempt.fallbackReason,
        degradedReason: attempt.degradedReason,
        transcriptReadFence,
        ...(attempt.prompt !== undefined ? { prompt } : {}),
      });
      if (!assembled) {
        throw new Error("context engine assemble returned no result");
      }
      const assembledMessages = transcriptPolicy.repairToolUseResultPairing
        ? sanitizeToolUseResultPairingForModel(assembled.messages, isOpenAIResponsesApi)
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
