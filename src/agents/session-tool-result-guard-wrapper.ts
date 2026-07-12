/**
 * Session manager wrapper for tool-result transcript guards.
 *
 * Installs message-write hooks, input provenance handling, and pending tool-result flush behavior once per manager.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  applyInputProvenanceToUserMessage,
  type InputProvenance,
} from "../sessions/input-provenance.js";
import {
  attachRuntimeUserTurnTranscriptRecorder,
  takeRuntimeUserTurnTranscriptContext,
  takeRuntimeUserTurnTranscriptRecorder,
} from "../sessions/user-turn-transcript-runtime-context.js";
import {
  mergePreparedUserTurnMessageForRuntime,
  restorePreparedUserTurnOperationalMetaForRuntime,
  type PersistedUserTurnMessage,
  type UserTurnTranscriptRecorder,
} from "../sessions/user-turn-transcript.js";
import { resolveLiveToolResultMaxChars } from "./embedded-agent-runner/tool-result-truncation.js";
import type { AgentMessage } from "./runtime/index.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";
import type { SessionManager } from "./sessions/index.js";
import { redactTranscriptMessage } from "./transcript-redact.js";

type GuardedSessionManager = SessionManager & {
  /** Flush any synthetic tool results for pending tool calls. Idempotent. */
  flushPendingToolResults?: () => void;
  /** Clear pending tool calls without persisting synthetic tool results. Idempotent. */
  clearPendingToolResults?: () => void;
  /** Persist the next user message when an earlier canonical entry was removed. */
  clearNextUserMessagePersistenceSuppression?: () => void;
};

/**
 * Apply the tool-result guard to a SessionManager exactly once and expose
 * a flush method on the instance for easy teardown handling.
 */
export function guardSessionManager(
  sessionManager: SessionManager,
  opts?: {
    agentId?: string;
    sessionKey?: string;
    config?: OpenClawConfig;
    contextWindowTokens?: number;
    inputProvenance?: InputProvenance;
    allowSyntheticToolResults?: boolean;
    missingToolResultText?: string;
    allowedToolNames?: Iterable<string>;
    preparedUserTurnMessage?: PersistedUserTurnMessage;
    suppressNextUserMessagePersistence?: boolean;
    suppressTranscriptOnlyAssistantPersistence?: boolean;
    suppressAssistantErrorPersistence?: boolean;
    onUserMessagePersisted?: (
      message: Extract<AgentMessage, { role: "user" }>,
    ) => void | Promise<void>;
    onUserMessageBlocked?: (message: Extract<AgentMessage, { role: "user" }>) => void;
    onMessagePersisted?: (message: AgentMessage) => void | Promise<void>;
    withCompactionPersistence?: (
      append: () => string,
      validateAppend: (entryId: string, appendedText: string) => boolean,
    ) => string;
    onAssistantErrorMessagePersisted?: (
      message: Extract<AgentMessage, { role: "assistant" }>,
    ) => void | Promise<void>;
  },
): GuardedSessionManager {
  if (typeof (sessionManager as GuardedSessionManager).flushPendingToolResults === "function") {
    return sessionManager as GuardedSessionManager;
  }

  const hookRunner = getGlobalHookRunner();
  let pendingPreparedUserTurnMessage = opts?.preparedUserTurnMessage;
  let queuedUserTurnTranscriptRecorder: UserTurnTranscriptRecorder | undefined;
  const beforeMessageWrite = (event: { message: AgentMessage }) => {
    let message = event.message;
    let changed = false;
    if (hookRunner?.hasHooks("before_message_write")) {
      const result = hookRunner.runBeforeMessageWrite(event, {
        agentId: opts?.agentId,
        sessionKey: opts?.sessionKey,
      });
      if (result?.block) {
        queuedUserTurnTranscriptRecorder?.markBlocked();
        queuedUserTurnTranscriptRecorder = undefined;
        return result;
      }
      if (result?.message) {
        message = restorePreparedUserTurnOperationalMetaForRuntime({
          runtimeMessage: result.message,
          ...(event.message.role === "user" ? { preparedMessage: event.message } : {}),
        });
        changed = true;
      }
    }
    const redacted = redactTranscriptMessage(message, opts?.config);
    if (redacted !== message) {
      message = redacted;
      changed = true;
    }
    if (message.role !== "user" && queuedUserTurnTranscriptRecorder) {
      queuedUserTurnTranscriptRecorder.markBlocked();
      queuedUserTurnTranscriptRecorder = undefined;
    }
    if (message.role === "user" && queuedUserTurnTranscriptRecorder) {
      message = attachRuntimeUserTurnTranscriptRecorder(message, queuedUserTurnTranscriptRecorder);
      queuedUserTurnTranscriptRecorder = undefined;
    }
    return changed ? { message } : undefined;
  };

  const transform = hookRunner?.hasHooks("tool_result_persist")
    ? (
        message: AgentMessage,
        meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean },
      ) => {
        const out = hookRunner.runToolResultPersist(
          {
            toolName: meta.toolName,
            toolCallId: meta.toolCallId,
            message,
            isSynthetic: meta.isSynthetic,
          },
          {
            agentId: opts?.agentId,
            sessionKey: opts?.sessionKey,
            toolName: meta.toolName,
            toolCallId: meta.toolCallId,
          },
        );
        return out?.message ?? message;
      }
    : undefined;

  const guard = installSessionToolResultGuard(sessionManager, {
    sessionKey: opts?.sessionKey,
    agentId: opts?.agentId,
    transformMessageForPersistence: (message) => {
      queuedUserTurnTranscriptRecorder = undefined;
      const withProvenance = applyInputProvenanceToUserMessage(message, opts?.inputProvenance);
      const runtimeContext = takeRuntimeUserTurnTranscriptContext(message);
      const prepared = runtimeContext?.message ?? pendingPreparedUserTurnMessage;
      const merged = mergePreparedUserTurnMessageForRuntime({
        runtimeMessage: withProvenance,
        ...(prepared ? { preparedMessage: prepared } : {}),
      });
      if (merged !== withProvenance) {
        if (runtimeContext) {
          queuedUserTurnTranscriptRecorder = runtimeContext.recorder;
        } else {
          pendingPreparedUserTurnMessage = undefined;
        }
      }
      return merged;
    },
    transformToolResultForPersistence: transform,
    allowSyntheticToolResults: opts?.allowSyntheticToolResults,
    missingToolResultText: opts?.missingToolResultText,
    allowedToolNames: opts?.allowedToolNames,
    beforeMessageWriteHook: beforeMessageWrite,
    redactLoggingConfig: opts?.config?.logging,
    maxToolResultChars:
      typeof opts?.contextWindowTokens === "number"
        ? resolveLiveToolResultMaxChars({
            contextWindowTokens: opts.contextWindowTokens,
            cfg: opts.config,
            agentId: opts.agentId,
          })
        : undefined,
    suppressNextUserMessagePersistence: opts?.suppressNextUserMessagePersistence,
    suppressTranscriptOnlyAssistantPersistence: opts?.suppressTranscriptOnlyAssistantPersistence,
    suppressAssistantErrorPersistence: opts?.suppressAssistantErrorPersistence,
    onMessagePersisted: opts?.onMessagePersisted,
    withCompactionPersistence: opts?.withCompactionPersistence,
    onUserMessagePersisted: async (message) => {
      const recorder = takeRuntimeUserTurnTranscriptRecorder(message);
      recorder?.markRuntimePersisted(message);
      await opts?.onUserMessagePersisted?.(message);
    },
    onUserMessageBlocked: opts?.onUserMessageBlocked,
    onAssistantErrorMessagePersisted: opts?.onAssistantErrorMessagePersisted,
  });
  (sessionManager as GuardedSessionManager).flushPendingToolResults = guard.flushPendingToolResults;
  (sessionManager as GuardedSessionManager).clearPendingToolResults = guard.clearPendingToolResults;
  (sessionManager as GuardedSessionManager).clearNextUserMessagePersistenceSuppression =
    guard.clearNextUserMessagePersistenceSuppression;
  return sessionManager as GuardedSessionManager;
}
