import {
  asOptionalObjectRecord,
  asOptionalRecord as readRecordField,
} from "@openclaw/normalization-core/record-coerce";
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import type {
  AgentCommandOutputEventData,
  AgentItemEventData,
} from "../infra/agent-activity-events.js";
import { emitAgentCommandOutputEvent } from "../infra/agent-activity-events.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { extractLiveExecOutput } from "./embedded-agent-subscribe.handlers.tools.results.js";
import {
  buildCommandItemId,
  buildCommandItemTitle,
  buildToolItemId,
  buildToolItemTitle,
  emitAgentEventCallbackBestEffort,
  emitTrackedItemEvent,
  isExecToolName,
} from "./embedded-agent-subscribe.handlers.tools.start.js";
import type { ToolHandlerContext } from "./embedded-agent-subscribe.handlers.types.js";
import {
  capLiveExecResult,
  sanitizeToolResult,
  truncateLiveExecOutput,
} from "./embedded-agent-subscribe.tools.js";
import type { AgentEvent } from "./runtime/index.js";
import { normalizeToolName } from "./tool-policy.js";

type ChannelToolProgress = {
  text: string;
};

const LIVE_EXEC_UPDATE_MIN_INTERVAL_MS = 250;

function readChannelToolProgress(result: unknown): ChannelToolProgress | undefined {
  const progress = readRecordField(asOptionalObjectRecord(result)?.progress);
  // Only typed progress crosses into UI; tool output/details may contain private data.
  if (progress?.visibility !== "channel" || progress.privacy !== "public") {
    return undefined;
  }
  const text = readStringValue(progress.text)?.trim();
  if (!text) {
    return undefined;
  }
  return { text: truncateLiveExecOutput(text) };
}

function shouldEmitLiveExecUpdate(ctx: ToolHandlerContext, toolCallId: string): boolean {
  const now = Date.now();
  const state = ctx.state.execLiveUpdateStateById ?? new Map<string, { lastEmittedAtMs: number }>();
  ctx.state.execLiveUpdateStateById = state;
  const previous = state.get(toolCallId);
  if (previous && now - previous.lastEmittedAtMs < LIVE_EXEC_UPDATE_MIN_INTERVAL_MS) {
    return false;
  }
  state.set(toolCallId, { lastEmittedAtMs: now });
  return true;
}

/** Handles partial tool output and emits throttled live UI updates. */
export function handleToolExecutionUpdate(
  ctx: ToolHandlerContext,
  evt: AgentEvent & {
    toolName: string;
    toolCallId: string;
    partialResult?: unknown;
    hideFromChannelProgress?: boolean;
  },
) {
  const toolName = normalizeToolName(evt.toolName);
  const toolCallId = evt.toolCallId;
  const hideFromChannelProgress = evt.hideFromChannelProgress === true;
  const partial = evt.partialResult;
  const sanitized = sanitizeToolResult(partial);
  const isExecTool = isExecToolName(toolName);
  const liveResult = isExecTool ? capLiveExecResult(sanitized) : sanitized;
  const toolProgress = isExecTool ? undefined : readChannelToolProgress(liveResult);
  // Typed progress already has a sanitized path; suppress duplicate raw previews.
  const emitDetailedLiveUpdate =
    !toolProgress && (!isExecTool || shouldEmitLiveExecUpdate(ctx, toolCallId));
  if (emitDetailedLiveUpdate) {
    emitAgentEvent({
      runId: ctx.params.runId,
      stream: "tool",
      data: {
        phase: "update",
        name: toolName,
        toolCallId,
        partialResult: liveResult,
        ...(hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
      },
    });
  }
  const itemData: AgentItemEventData = {
    itemId: buildToolItemId(toolCallId),
    phase: "update",
    kind: "tool",
    title: buildToolItemTitle(toolName, ctx.state.toolMetaById.get(toolCallId)?.meta),
    status: "running",
    name: toolName,
    toolCallId,
    commandBearing: ctx.state.toolMetaById.get(toolCallId)?.commandBearing,
    ...(hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
    ...(ctx.state.toolMetaById.get(toolCallId)?.commandBearing && !isExecTool
      ? { suppressChannelProgress: true }
      : {}),
    ...(toolProgress
      ? { progressText: toolProgress.text }
      : { meta: ctx.state.toolMetaById.get(toolCallId)?.meta }),
  };
  emitTrackedItemEvent(ctx, itemData);
  if (!toolProgress) {
    emitAgentEventCallbackBestEffort(ctx, {
      stream: "tool",
      data: {
        phase: "update",
        name: toolName,
        toolCallId,
        ...(hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
      },
    });
  }
  if (isExecTool) {
    const output = extractLiveExecOutput(liveResult);
    const commandData: AgentItemEventData = {
      itemId: buildCommandItemId(toolCallId),
      phase: "update",
      kind: "command",
      title: buildCommandItemTitle(toolName, ctx.state.toolMetaById.get(toolCallId)?.meta),
      status: "running",
      name: toolName,
      meta: ctx.state.toolMetaById.get(toolCallId)?.meta,
      toolCallId,
      ...(emitDetailedLiveUpdate && output ? { progressText: output } : {}),
    };
    emitTrackedItemEvent(ctx, commandData);
    if (emitDetailedLiveUpdate && output) {
      const outputData: AgentCommandOutputEventData = {
        itemId: commandData.itemId,
        phase: "delta",
        title: commandData.title,
        toolCallId,
        name: toolName,
        output,
        status: "running",
      };
      emitAgentCommandOutputEvent({
        runId: ctx.params.runId,
        ...(ctx.params.sessionKey ? { sessionKey: ctx.params.sessionKey } : {}),
        data: outputData,
      });
      emitAgentEventCallbackBestEffort(ctx, {
        stream: "command_output",
        data: outputData,
      });
    }
  }
}
