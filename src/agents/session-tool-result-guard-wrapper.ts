import type { PrepareAssistantTranscriptMessage } from "../config/sessions/transcript-assistant-delivery.js";
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
import type { AssistantErrorTranscript } from "./assistant-error-transcript.js";
import { isMidTurnPrecheckAssistantError } from "./embedded-agent-runner/run/midturn-precheck.js";
import type { EmbeddedRunTrigger } from "./embedded-agent-runner/run/params.js";
import { resolveLiveToolResultMaxChars } from "./embedded-agent-runner/tool-result-truncation.js";
import { runAgentHarnessBeforeMessageWriteHook } from "./harness/hook-helpers.js";
import { projectAgentHarnessTranscriptMessageForDisplay } from "./harness/transcript-visibility.js";
import type { AgentMessage } from "./runtime/index.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";
import type { SessionManager } from "./sessions/index.js";
import {
  copyCodeModeSourceAppend,
  type CodeModeSourceAppend,
} from "./transcript-code-mode-source.js";
import { redactTranscriptMessage } from "./transcript-redact.js";

type GuardedSessionManager = SessionManager & {
  /** Flush any synthetic tool results for pending tool calls. Idempotent. */
  flushPendingToolResults?: () => void;
  /** Clear pending tool calls without persisting synthetic tool results. Idempotent. */
  clearPendingToolResults?: () => void;
  /** Persist the next user message when an earlier canonical entry was removed. */
  clearNextUserMessagePersistenceSuppression?: () => void;
  /** Refresh the exact owning run when a caller reuses this guarded manager. */
  setTranscriptRunContext?: (
    runId: string | undefined,
    prepareAssistantTranscriptMessage: PrepareAssistantTranscriptMessage | undefined,
    skipBeforeMessageWriteHooks: boolean | undefined,
    assistantErrorTranscript: AssistantErrorTranscript | undefined,
  ) => void;
};

/**
 * Apply the tool-result guard to a SessionManager exactly once and expose
 * a flush method on the instance for easy teardown handling.
 */
export function guardSessionManager(
  sessionManager: SessionManager,
  opts?: {
    agentId?: string;
    runId?: string;
    prepareAssistantTranscriptMessage?: PrepareAssistantTranscriptMessage;
    sessionKey?: string;
    config?: OpenClawConfig;
    contextWindowTokens?: number;
    inputProvenance?: InputProvenance;
    allowSyntheticToolResults?: boolean;
    missingToolResultText?: string;
    allowedToolNames?: Iterable<string>;
    trigger?: EmbeddedRunTrigger;
    preparedUserTurnMessage?: PersistedUserTurnMessage;
    preparedUserTurnTranscriptRecorder?: UserTurnTranscriptRecorder;
    suppressNextUserMessagePersistence?: boolean;
    suppressTranscriptOnlyAssistantPersistence?: boolean;
    assistantErrorTranscript?: AssistantErrorTranscript;
    /** Finalization keeps core redaction but must not run plugin write hooks. */
    skipBeforeMessageWriteHooks?: boolean;
    onUserMessagePersisted?: (
      message: Extract<AgentMessage, { role: "user" }>,
      runtimeMessage: Extract<AgentMessage, { role: "user" }> | undefined,
    ) => void | Promise<void>;
    onUserMessagePersistenceSuppressed?: (
      message: Extract<AgentMessage, { role: "user" }>,
      runtimeMessage: Extract<AgentMessage, { role: "user" }> | undefined,
    ) => void | Promise<void>;
    onUserMessagePreparingForPersistence?: (
      message: Extract<AgentMessage, { role: "user" }>,
      recorder: UserTurnTranscriptRecorder | undefined,
      preparedMessage: PersistedUserTurnMessage | undefined,
    ) => void;
    onUserMessageBlocked?: (message: Extract<AgentMessage, { role: "user" }>) => void;
    onMessagePersisted?: (message: AgentMessage) => void | Promise<void>;
    withCompactionPersistence?: (
      append: () => string,
      validateAppend: (entryId: string, appendedText: string) => boolean,
    ) => string;
  },
): GuardedSessionManager {
  const guardedSessionManager: GuardedSessionManager = sessionManager;
  let prepareAssistantTranscriptMessage =
    opts?.trigger === "memory" ? undefined : opts?.prepareAssistantTranscriptMessage;
  let skipBeforeMessageWriteHooks = opts?.skipBeforeMessageWriteHooks;
  if (typeof guardedSessionManager.flushPendingToolResults === "function") {
    guardedSessionManager.setTranscriptRunContext?.(
      opts?.runId,
      prepareAssistantTranscriptMessage,
      skipBeforeMessageWriteHooks,
      opts?.assistantErrorTranscript,
    );
    return guardedSessionManager;
  }

  const hookRunner = getGlobalHookRunner();
  let pendingPreparedUserTurnMessage = opts?.preparedUserTurnMessage;
  const preparedUserReplayKey =
    opts?.preparedUserTurnTranscriptRecorder?.getPersistedMessage?.()?.idempotencyKey ===
    pendingPreparedUserTurnMessage?.idempotencyKey
      ? pendingPreparedUserTurnMessage?.idempotencyKey
      : undefined;
  let queuedUserTurnTranscriptRecorder: UserTurnTranscriptRecorder | undefined;
  const runtimeUserMessageByPersistedMessage = new WeakMap<
    AgentMessage,
    Extract<AgentMessage, { role: "user" }>
  >();
  const beforeMessageWrite = (
    event: { message: AgentMessage },
    sourceAppend?: CodeModeSourceAppend,
  ) => {
    // Persisting a routing signal would force recovery to rewrite the whole archive to remove it.
    if (isMidTurnPrecheckAssistantError(event.message)) {
      return { block: true };
    }
    const runtimeUserMessage = runtimeUserMessageByPersistedMessage.get(event.message);
    let message = event.message;
    let changed = false;
    // Accepted source bytes already passed the plugin hook before ACK. Only
    // core redaction and visibility still run when the native turn consumes them.
    const skipUserWriteHook =
      skipBeforeMessageWriteHooks ||
      (message.role === "user" &&
        queuedUserTurnTranscriptRecorder?.getPendingInputMessage?.() !== undefined);
    if (
      (!skipUserWriteHook && hookRunner?.hasHooks("before_message_write")) ||
      prepareAssistantTranscriptMessage
    ) {
      const preparedMessage =
        message.role === "user"
          ? { ...message, __openclaw: { ...Reflect.get(message, "__openclaw") } }
          : undefined;
      if (preparedMessage?.["__openclaw"].humanMentions !== undefined) {
        // Hooks may mutate text and spans in place; compare against the submitted selection.
        preparedMessage.content = structuredClone(preparedMessage.content);
        preparedMessage["__openclaw"].humanMentions = structuredClone(
          preparedMessage["__openclaw"].humanMentions,
        );
      }
      const next = runAgentHarnessBeforeMessageWriteHook({
        message,
        agentId: opts?.agentId,
        sessionKey: opts?.sessionKey,
        prepareAssistantTranscriptMessage,
        skipBeforeMessageWriteHooks: skipUserWriteHook,
      });
      if (!next) {
        runtimeUserMessageByPersistedMessage.delete(event.message);
        queuedUserTurnTranscriptRecorder?.markBlocked();
        queuedUserTurnTranscriptRecorder = undefined;
        return { block: true };
      }
      message = restorePreparedUserTurnOperationalMetaForRuntime({
        runtimeMessage: next,
        preparedMessage,
      });
      changed = true;
    }
    copyCodeModeSourceAppend(event.message, message, sourceAppend);
    const redacted = redactTranscriptMessage(message, opts?.config, sourceAppend);
    if (redacted !== message) {
      message = redacted;
      changed = true;
    }
    const projectedMessage = projectAgentHarnessTranscriptMessageForDisplay({
      hidden: opts?.trigger === "memory",
      message,
    });
    if (projectedMessage !== message) {
      copyCodeModeSourceAppend(message, projectedMessage, sourceAppend);
      message = projectedMessage;
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
    if (runtimeUserMessage && message.role === "user") {
      runtimeUserMessageByPersistedMessage.set(message, runtimeUserMessage);
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
    runId: opts?.runId,
    transformMessageForPersistence: (message) => {
      queuedUserTurnTranscriptRecorder = undefined;
      const withProvenance = applyInputProvenanceToUserMessage(message, opts?.inputProvenance);
      const runtimeContext = takeRuntimeUserTurnTranscriptContext(message);
      // Replay may reuse the current user without appending it. Its prepared
      // metadata must not leak onto a later queued user, including staged steering.
      if (
        message.role === "user" &&
        preparedUserReplayKey !== undefined &&
        Reflect.get(runtimeContext?.message ?? message, "idempotencyKey") !== preparedUserReplayKey
      ) {
        pendingPreparedUserTurnMessage = undefined;
      }
      const prepared = runtimeContext?.message ?? pendingPreparedUserTurnMessage;
      const recorder =
        runtimeContext?.recorder ??
        (prepared !== undefined && prepared === pendingPreparedUserTurnMessage
          ? opts?.preparedUserTurnTranscriptRecorder
          : undefined);
      if (message.role === "user") {
        opts?.onUserMessagePreparingForPersistence?.(message, recorder, prepared);
      }
      const merged = mergePreparedUserTurnMessageForRuntime({
        runtimeMessage: withProvenance,
        ...(prepared ? { preparedMessage: prepared } : {}),
      });
      if (merged !== withProvenance) {
        queuedUserTurnTranscriptRecorder = recorder;
        if (!runtimeContext) {
          pendingPreparedUserTurnMessage = undefined;
        }
      }
      if (message.role === "user" && merged.role === "user") {
        // Persistence callbacks may be re-entrant. Correlate through the exact
        // transformed object instead of a mutable latest-message slot.
        runtimeUserMessageByPersistedMessage.set(merged, message);
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
          })
        : undefined,
    suppressNextUserMessagePersistence:
      preparedUserReplayKey === undefined && opts?.suppressNextUserMessagePersistence,
    suppressTranscriptOnlyAssistantPersistence: opts?.suppressTranscriptOnlyAssistantPersistence,
    assistantErrorTranscript: opts?.assistantErrorTranscript,
    onMessagePersisted: opts?.onMessagePersisted,
    withCompactionPersistence: opts?.withCompactionPersistence,
    onUserMessagePersisted: async (message, persistence) => {
      const runtimeMessage = runtimeUserMessageByPersistedMessage.get(message);
      runtimeUserMessageByPersistedMessage.delete(message);
      const recorder = takeRuntimeUserTurnTranscriptRecorder(message);
      recorder?.markRuntimePersisted(persistence.persistedMessage, persistence.anchor, {
        appended: persistence.appended,
      });
      await opts?.onUserMessagePersisted?.(persistence.persistedMessage, runtimeMessage);
    },
    onUserMessagePersistenceSuppressed: async (message) => {
      const runtimeMessage = runtimeUserMessageByPersistedMessage.get(message);
      runtimeUserMessageByPersistedMessage.delete(message);
      await opts?.onUserMessagePersistenceSuppressed?.(message, runtimeMessage);
    },
    onUserMessageBlocked: opts?.onUserMessageBlocked,
  });
  guardedSessionManager.flushPendingToolResults = guard.flushPendingToolResults;
  guardedSessionManager.clearPendingToolResults = guard.clearPendingToolResults;
  guardedSessionManager.clearNextUserMessagePersistenceSuppression =
    guard.clearNextUserMessagePersistenceSuppression;
  guardedSessionManager.setTranscriptRunContext = (runId, prepare, skipHooks, errors) => {
    guard.setTranscriptRunId(runId, errors);
    prepareAssistantTranscriptMessage = prepare;
    skipBeforeMessageWriteHooks = skipHooks;
  };
  return guardedSessionManager;
}
