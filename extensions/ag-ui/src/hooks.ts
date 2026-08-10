import { EventType } from "@ag-ui/core";
import {
  extractToolResultText,
  tryParseA2UIOperations,
  groupBySurface,
  A2UI_OPERATIONS_KEY,
} from "./a2ui.js";
import {
  getWriter,
  getMessageId,
  isClientTool,
  isStateWriterTool,
  setClientToolCalled,
} from "./tool-store.js";

// ---------------------------------------------------------------------------
// before_tool_call / tool_result_persist hooks
//
// These translate the OpenClaw agent's server-side tool lifecycle into AG-UI
// TOOL_CALL_* events on the SSE stream. They are registered in registerFull()
// (index.ts) and exercised directly by tool-hooks.test.ts.
// ---------------------------------------------------------------------------

interface BeforeToolCallEvent {
  toolName: string;
  params?: Record<string, unknown>;
  /** Host-authoritative id for this call. */
  toolCallId?: string;
}

interface ToolCallContext {
  sessionKey?: string;
  /** Host-authoritative id for the owning tool call. */
  toolCallId?: string;
}

/**
 * Handles the `before_tool_call` OpenClaw hook.
 * Emits TOOL_CALL_START + TOOL_CALL_ARGS (and TOOL_CALL_END for client tools).
 */
export function handleBeforeToolCall(event: BeforeToolCallEvent, ctx: ToolCallContext): void {
  const sk = ctx.sessionKey;
  if (!sk) {
    return;
  }
  const writer = getWriter(sk);
  if (!writer) {
    return;
  }
  // Marked client/frontend + state-writer tools are emitted by the HTTP
  // handler's pendingToolCalls path (client tools) or intercepted into
  // STATE_SNAPSHOTs (state writers). The writer is now registered on EVERY turn
  // so BACKEND (server-side) tools render even when the turn also carries client
  // tools — so skip the marked names here to avoid a duplicate TOOL_CALL_*
  // sequence for the same call.
  if (isClientTool(sk, event.toolName)) {
    // Client/frontend tool: the HTTP handler emits its TOOL_CALL_* events via
    // the pendingToolCalls path, so skip emitting them here either way.
    //
    // Only a REAL browser tool sets clientToolCalled — that flag suppresses
    // trailing assistant text and ends the run so the browser can execute the
    // call. A state writer is executed by the handler itself and is deliberately
    // followed by a narration turn; setting the flag for it would suppress that
    // narration, leaving the user with a silent state change and no confirmation.
    if (!isStateWriterTool(sk, event.toolName)) {
      setClientToolCalled(sk);
    }
    return;
  }
  // Server (backend) tool: emit START + ARGS keyed on the HOST's tool call id.
  // Never invent one and never track it on a stack: the host runs tools in
  // parallel and persists their results in source order, so a LIFO stack
  // attaches result A to call B's card. The id the host gives us is the only
  // correlation that survives concurrency.
  const toolCallId = event.toolCallId ?? ctx.toolCallId;
  if (!toolCallId) {
    return;
  }
  writer({
    type: EventType.TOOL_CALL_START,
    toolCallId,
    toolCallName: event.toolName,
  });
  if (event.params && Object.keys(event.params).length > 0) {
    writer({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId,
      delta: JSON.stringify(event.params),
    });
  }
}

/**
 * Handles the `tool_result_persist` OpenClaw hook.
 * Emits TOOL_CALL_RESULT + TOOL_CALL_END for server-side tools.
 */
export function handleToolResultPersist(
  event: Record<string, unknown>,
  ctx: ToolCallContext,
): void {
  const sk = ctx.sessionKey;
  if (!sk) {
    return;
  }
  const writer = getWriter(sk);
  const toolCallId = (event as { toolCallId?: string }).toolCallId ?? ctx.toolCallId;
  const messageId = getMessageId(sk);
  // Mirror the skip in handleBeforeToolCall. Marked tools have their whole
  // TOOL_CALL_* sequence emitted by the handler's pendingToolCalls path, so if a
  // result is ever persisted for one, emitting RESULT/END here would duplicate
  // events against a toolCallId the client already saw closed. Skipping in the
  // before-hook but not here left the two halves of one contract disagreeing.
  //
  // `event.isSynthetic` results are NOT skipped on purpose. Core fabricates them
  // for a call that never returned (session-tool-result-guard flushes pending
  // results on an interrupted run), and we already emitted START/ARGS for it —
  // so this RESULT/END is what closes a card that would otherwise spin forever.
  const toolName = (event as { toolName?: string }).toolName;
  if (toolName && isClientTool(sk, toolName)) {
    return;
  }
  if (writer && toolCallId && messageId) {
    // Extract actual tool result text from event.message.content
    const msg = (event as Record<string, unknown>).message as { content?: unknown } | undefined;
    const resultText = msg?.content ? extractToolResultText(msg.content) : "";

    // Use a dedicated messageId for the tool result so it doesn't collide
    // with the text message messageId. Tool events are linked via toolCallId.
    const toolResultMessageId = `msg-tool-${toolCallId}`;
    writer({
      type: EventType.TOOL_CALL_RESULT,
      toolCallId,
      messageId: toolResultMessageId,
      content: resultText,
    });

    // Detect A2UI and emit ACTIVITY_SNAPSHOT per surface
    const a2uiOps = tryParseA2UIOperations(resultText);
    if (a2uiOps) {
      const groups = groupBySurface(a2uiOps);
      for (const [surfaceId, ops] of groups) {
        writer({
          type: EventType.ACTIVITY_SNAPSHOT,
          messageId: `a2ui-surface-${surfaceId}-${toolCallId}`,
          activityType: "a2ui-surface",
          content: { [A2UI_OPERATIONS_KEY]: ops },
          replace: true,
        });
      }
    }

    writer({
      type: EventType.TOOL_CALL_END,
      toolCallId,
    });
  }
}
