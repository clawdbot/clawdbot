// Chat transcript injection appends gateway-authored assistant rows while
// preserving agent-session parent links and transcript update notifications.
import type { SessionManager } from "../../agents/sessions/session-manager.js";
import { persistSessionTranscriptTurn } from "../../config/sessions/session-accessor.js";
import type { SessionLifecycleRevisionExpectation } from "../../config/sessions/session-transcript-turn-lifecycle.types.js";
import { applyAssistantDeliveryDirectives } from "../../config/sessions/transcript-assistant-delivery.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  readSessionTranscriptRunId,
  resolveTerminalAssistantTranscriptRunId,
} from "../../sessions/transcript-events.js";
import { extractAssistantPhaseText } from "../../shared/chat-message-content.js";

type AppendMessageArg = Parameters<SessionManager["appendMessage"]>[0];
type AssistantMessageContent = Extract<AppendMessageArg, { role: "assistant" }>["content"];

/** Metadata persisted on gateway-injected assistant messages that mark a stopped run. */
type GatewayInjectedAbortMeta = {
  aborted: true;
  origin: "rpc" | "stop-command" | "placement-abandon";
  runId: string;
};

/** Result shape returned after appending an assistant row to a session transcript. */
type GatewayInjectedTranscriptAppendResult = {
  ok: boolean;
  messageId?: string;
  message?: Record<string, unknown>;
  /** Set when the commit predicate declined the append; not an error. */
  skipped?: boolean;
  error?: string;
};

/** Hash marker used to dedupe companion TTS text/audio supplements. */
export type GatewayInjectedTtsSupplementMarker = {
  textSha256: string;
};

function resolveInjectedAssistantContent(params: {
  message: string;
  label?: string;
  content?: Array<Record<string, unknown>>;
}): Array<Record<string, unknown>> {
  const labelPrefix = params.label ? `[${params.label}]\n\n` : "";
  // Preserve rich content arrays when callers already prepared media blocks;
  // only the first text block is rewritten so block ordering stays intact.
  if (params.content && params.content.length > 0) {
    if (!labelPrefix) {
      return params.content;
    }
    const first = params.content[0];
    if (
      first &&
      typeof first === "object" &&
      first.type === "text" &&
      typeof first.text === "string"
    ) {
      return [{ ...first, text: `${labelPrefix}${first.text}` }, ...params.content.slice(1)];
    }
    return [{ type: "text", text: labelPrefix.trim() }, ...params.content];
  }
  return [{ type: "text", text: `${labelPrefix}${params.message}` }];
}

/** Clone Gateway display blocks into the transcript's assistant-content boundary. */
export function prepareGatewayInjectedAssistantContent(
  content: readonly Record<string, unknown>[],
): AssistantMessageContent {
  return content.map((block) => Object.assign({}, block)) as unknown as AssistantMessageContent;
}

/** Append a gateway-authored assistant message while preserving transcript parent links. */
export async function appendInjectedAssistantMessageToTranscript(params: {
  transcriptPath?: string;
  storePath?: string;
  sessionId?: string;
  expectedSessionId?: string;
  expectedLifecycleRevision?: SessionLifecycleRevisionExpectation;
  sessionKey?: string;
  agentId?: string;
  message: string;
  label?: string;
  /** When set, used as the assistant `content` array (e.g. text + embedded audio blocks). */
  content?: Array<Record<string, unknown>>;
  idempotencyKey?: string;
  abortMeta?: GatewayInjectedAbortMeta;
  ttsSupplement?: GatewayInjectedTtsSupplementMarker;
  now?: number;
  config?: OpenClawConfig;
}): Promise<GatewayInjectedTranscriptAppendResult> {
  const now = params.now ?? Date.now();
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
  const resolvedContent = resolveInjectedAssistantContent({
    message: params.message,
    label: params.label,
    content: params.content,
  });
  const rawDeliveryMessage: {
    role: "assistant";
    content: Array<Record<string, unknown>>;
    openclawDelivery?: unknown;
  } = {
    role: "assistant",
    content: [{ type: "text", text: params.message }],
  };
  const rawDeliveryFacts = applyAssistantDeliveryDirectives(rawDeliveryMessage).openclawDelivery;
  const abortRunId = params.abortMeta?.runId;
  const messageBody: AppendMessageArg & Record<string, unknown> = applyAssistantDeliveryDirectives({
    role: "assistant",
    // Gateway-injected assistant messages can include non-model content blocks (e.g. embedded TTS audio).
    content: prepareGatewayInjectedAssistantContent(resolvedContent),
    timestamp: now,
    // stopReason is a strict runner enum; this is not model output, but we still store it as a
    // normal assistant message so it participates in the session parentId chain.
    stopReason: "stop",
    usage,
    // Make these explicit so downstream tooling never treats this as model output.
    api: "openai-responses",
    provider: "openclaw",
    model: "gateway-injected",
    ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
    ...(params.ttsSupplement ? { openclawTtsSupplement: params.ttsSupplement } : {}),
    ...(params.abortMeta
      ? {
          openclawAbort: {
            aborted: true,
            origin: params.abortMeta.origin,
            runId: params.abortMeta.runId,
          },
        }
      : {}),
  });
  if (rawDeliveryFacts && messageBody.openclawDelivery === undefined) {
    messageBody.openclawDelivery = rawDeliveryFacts;
  }

  try {
    if (!params.transcriptPath && (!params.storePath || !params.sessionId || !params.sessionKey)) {
      return { ok: false, error: "transcript identity not resolved" };
    }
    let predicateDeclined = false;
    const turn = await persistSessionTranscriptTurn(
      {
        sessionKey: params.sessionKey ?? "",
        ...(params.transcriptPath ? { sessionFile: params.transcriptPath } : {}),
        ...(params.storePath ? { storePath: params.storePath } : {}),
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        ...(params.agentId ? { agentId: params.agentId } : {}),
      },
      {
        expectedSessionId: params.expectedSessionId,
        expectedLifecycleRevision: params.expectedLifecycleRevision,
        updateMode: "inline",
        ...(params.abortMeta ? { runId: params.abortMeta.runId } : {}),
        touchSessionEntry: Boolean(params.storePath && params.sessionId && params.sessionKey),
        ...(params.config ? { config: params.config } : {}),
        messages: [
          {
            message: messageBody,
            idempotencyLookup: "scan-assistant",
            ...(params.abortMeta
              ? {
                  shouldAppendInTransaction: (latestAssistantMessage: unknown) => {
                    const committedRunId = resolveTerminalAssistantTranscriptRunId(
                      latestAssistantMessage,
                      readSessionTranscriptRunId(latestAssistantMessage),
                    );
                    const committedText = extractAssistantPhaseText(latestAssistantMessage)?.trim();
                    // The same run can commit before its live buffer clears. Recheck after
                    // BEGIN IMMEDIATE so a direct writer cannot land between this fact and insert.
                    predicateDeclined =
                      committedRunId === abortRunId && committedText === params.message.trim();
                    return !predicateDeclined;
                  },
                }
              : {}),
            now,
            useRawWhenLinear: true,
          },
        ],
      },
    );
    if (turn.rejectedReason) {
      return { ok: false, error: turn.rejectedReason };
    }
    const appended = turn.messages[0];
    if (!appended) {
      // A declined predicate is a decision, not a failure: no row was wanted.
      if (predicateDeclined) {
        return { ok: true, skipped: true };
      }
      return { ok: false, error: "gateway-injected assistant message was not appended" };
    }
    return {
      ok: true,
      messageId: appended.messageId,
      message: appended.message as Record<string, unknown>,
    };
  } catch (err) {
    return { ok: false, error: formatErrorMessage(err) };
  }
}
