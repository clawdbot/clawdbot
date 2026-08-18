/**
 * Transcript recorder for CLI-dispatched embedded runs.
 *
 * The CLI backend runs its tool loop inside the external process and writes
 * no OpenClaw transcript records, but one-shot callers (e.g. active-memory
 * recall) read the run's transcript for timeout partial-text salvage,
 * tool-result evidence, and a live terminal-search watcher that polls
 * mid-run. Mirror the run into canonical transcript records through the
 * session accessor: the user turn at start, tool calls/results as they
 * stream, and the final assistant snapshot at run end.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  appendTranscriptMessage,
  publishTranscriptUpdate,
  readTranscriptEventAtSeqSync,
  rewriteTranscriptEventRowsExact,
} from "../../config/sessions/session-accessor.js";
import type { TranscriptEntryAnchor } from "../../config/sessions/transcript-entry-anchor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { AgentMessage } from "../runtime/index.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "../stream-message-shared.js";

const log = createSubsystemLogger("agents/embedded-cli-dispatch");

type ToolResultContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

type CliDispatchTranscriptToolEvent = {
  phase: "start" | "update" | "result";
  toolName: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
  resultContentSource?: "network";
};

type PendingToolCall = {
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  tainted: boolean;
  anchor?: TranscriptEntryAnchor;
  messageId?: string;
  writtenArgsJson?: string;
};

type TranscriptAppendResult = {
  anchor?: TranscriptEntryAnchor;
  messageId: string;
};

type CliDispatchTranscriptRecorder = {
  noteToolEvent: (event: CliDispatchTranscriptToolEvent) => void;
  noteAssistantText: (text: string) => void;
  /**
   * Writes the latest streamed assistant snapshot immediately. Called on
   * abort: the killed CLI child can take seconds to settle, while timeout
   * salvage reads the transcript within a short grace window.
   */
  flushAssistantSnapshot: () => void;
  /** Appends the final assistant snapshot and drains pending writes. */
  finalize: (finalText?: string) => Promise<void>;
};

/**
 * Records a CLI-dispatched run into the run's session transcript by session
 * identity. Tool records append as events arrive (the terminal-search
 * watcher polls the transcript live); the assistant snapshot is held in
 * memory and flushed once at finalize (or immediately on abort) so streamed
 * text does not append a record per delta while timeout salvage still finds
 * the last text the model produced.
 */
export function createCliDispatchTranscriptRecorder(params: {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  sessionFile?: string;
  runId: string;
  prompt: string;
  provider: string;
  model?: string;
  cwd?: string;
  config?: OpenClawConfig;
  expectedLifecycleRevision?: string;
  expectedWriterRunId?: string;
  senderIsOwner?: boolean;
}): CliDispatchTranscriptRecorder {
  let tail: Promise<void> = Promise.resolve();
  let lastAssistantText = "";
  let lastWrittenAssistantText = "";
  let finalized = false;
  let turnTainted = false;
  let toolRecordSequence = 0;
  const pendingToolCalls = new Map<string, PendingToolCall>();

  const scope = {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    sessionFile: params.sessionFile,
    expectedLifecycleRevision: params.expectedLifecycleRevision,
    expectedWriterRunId: params.expectedWriterRunId,
  };

  const enqueue = (operation: () => Promise<void> | void, label = "append") => {
    tail = tail.then(operation);
    // Transcript mirroring is best-effort; a failed operation must not fail the
    // run or poison later appends in the chain.
    tail = tail.catch((error: unknown) => {
      log.warn(
        `cli dispatch transcript ${label} failed: runId=${params.runId} error=${String(error)}`,
      );
    });
  };

  const enqueueAppend = (
    build: () => AgentMessage,
    onAppended?: (result: TranscriptAppendResult | undefined) => void,
  ) => {
    enqueue(async () => {
      const result = await appendTranscriptMessage(scope, {
        message: build(),
        config: params.config,
        cwd: params.cwd,
      });
      onAppended?.(result);
    });
  };

  const model = {
    api: "cli",
    provider: params.provider,
    id: params.model ?? "",
  };

  type AssistantBuildParams = Parameters<typeof buildAssistantMessage>[0];
  // Mirrored records carry zero usage: the CLI child's token accounting is
  // not visible on this bridge, and cost fields must not invent values.
  const buildZeroUsageAssistantMessage = (
    content: AssistantBuildParams["content"],
    stopReason: AssistantBuildParams["stopReason"],
    tainted = turnTainted,
  ) => {
    const message = buildAssistantMessage({
      model,
      content,
      stopReason,
      usage: buildUsageWithNoCost({}),
    });
    return tainted ? ({ ...message, __openclaw: { turnTainted: true } } as AgentMessage) : message;
  };

  enqueueAppend(() => ({
    role: "user",
    content: [{ type: "text", text: params.prompt }],
    timestamp: Date.now(),
    ...(params.senderIsOwner !== undefined
      ? { __openclaw: { senderIsOwner: params.senderIsOwner } }
      : {}),
  }));

  const enqueueToolCall = (tool: PendingToolCall) => {
    // Capture the start payload before later updates replace tool.args. The
    // empty start is visible immediately; recovered args are applied by an
    // exact-row rewrite instead of appending a second tool-call message.
    const initialArgs = tool.args;
    enqueueAppend(
      () =>
        buildZeroUsageAssistantMessage(
          [
            {
              type: "toolCall",
              id: tool.toolCallId,
              name: tool.toolName,
              arguments: initialArgs,
            },
          ],
          "toolUse",
          tool.tainted,
        ),
      (result) => {
        tool.anchor = result?.anchor;
        tool.messageId = result?.messageId;
        tool.writtenArgsJson = JSON.stringify(initialArgs);
      },
    );
  };

  const enqueueToolCallArgumentsRewrite = (tool: PendingToolCall) => {
    const args = tool.args;
    const argsJson = JSON.stringify(args);
    if (argsJson === undefined) {
      return;
    }
    enqueue(async () => {
      const anchor = tool.anchor;
      const messageId = tool.messageId;
      if (!anchor || !messageId || tool.writtenArgsJson === argsJson) {
        return;
      }
      const current = readTranscriptEventAtSeqSync(scope, anchor.rawSeq);
      if (
        !current ||
        current.seq !== anchor.rawSeq ||
        !isRecord(current.event) ||
        current.event.id !== messageId
      ) {
        return;
      }
      const expectedEventJson = JSON.stringify(current.event);
      const rewrittenEvent = replaceTranscriptToolCallArguments(
        current.event,
        tool.toolCallId,
        args,
      );
      if (!rewrittenEvent || expectedEventJson === undefined) {
        return;
      }
      const rewritten = await rewriteTranscriptEventRowsExact(scope, {
        expectedGeneration: anchor.generation,
        rows: [
          {
            event: rewrittenEvent,
            expectedEventJson,
            seq: anchor.rawSeq,
          },
        ],
      });
      if (!rewritten) {
        return;
      }
      tool.anchor = { ...anchor, generation: rewritten.generation };
      if (tool.args === args) {
        tool.writtenArgsJson = argsJson;
      }
      await publishTranscriptUpdate(scope, { messageId });
    }, "rewrite");
  };
  const flushPendingToolCall = (toolCallId: string) => {
    const pending = pendingToolCalls.get(toolCallId);
    if (!pending) {
      return;
    }
    pendingToolCalls.delete(toolCallId);
    enqueueToolCallArgumentsRewrite(pending);
  };
  const flushPendingToolCalls = () => {
    for (const toolCallId of pendingToolCalls.keys()) {
      flushPendingToolCall(toolCallId);
    }
  };

  return {
    noteToolEvent: (event) => {
      if (finalized) {
        return;
      }
      toolRecordSequence += 1;
      const toolCallId =
        event.toolCallId?.trim() || `${params.runId}-tool-${String(toolRecordSequence)}`;
      if (event.phase === "start") {
        const tool = {
          toolName: event.toolName,
          toolCallId,
          args: event.args ?? {},
          tainted: turnTainted,
        };
        enqueueToolCall(tool);
        if (Object.keys(tool.args).length === 0) {
          pendingToolCalls.set(toolCallId, tool);
        }
        return;
      }
      if (event.phase === "update") {
        const pending = pendingToolCalls.get(toolCallId);
        if (pending && event.args && Object.keys(event.args).length > 0) {
          pending.args = event.args;
          enqueueToolCallArgumentsRewrite(pending);
        }
        return;
      }
      const pending = pendingToolCalls.get(toolCallId);
      if (pending) {
        flushPendingToolCall(toolCallId);
      }
      turnTainted ||= event.resultContentSource === "network";
      enqueueAppend(() => ({
        role: "toolResult",
        toolCallId,
        toolName: event.toolName,
        content: normalizeToolResultContent(event.result),
        details: readToolResultDetails(event.result),
        isError: event.isError === true,
        timestamp: Date.now(),
        ...(event.resultContentSource
          ? { __openclaw: { resultContentSource: event.resultContentSource } }
          : {}),
      }));
    },
    noteAssistantText: (text) => {
      if (!finalized && text.trim()) {
        lastAssistantText = text;
      }
    },
    flushAssistantSnapshot: () => {
      if (finalized) {
        return;
      }
      flushPendingToolCalls();
      const text = lastAssistantText.trim();
      if (!text || text === lastWrittenAssistantText) {
        return;
      }
      lastWrittenAssistantText = text;
      enqueueAppend(() => buildZeroUsageAssistantMessage([{ type: "text", text }], "aborted"));
    },
    finalize: async (finalText) => {
      if (finalized) {
        await tail;
        return;
      }
      flushPendingToolCalls();
      finalized = true;
      const text = finalText?.trim() || lastAssistantText.trim();
      if (text && text !== lastWrittenAssistantText) {
        lastWrittenAssistantText = text;
        enqueueAppend(() => buildZeroUsageAssistantMessage([{ type: "text", text }], "stop"));
      }
      await tail;
    },
  };
}

function replaceTranscriptToolCallArguments(
  event: unknown,
  toolCallId: string,
  args: Record<string, unknown>,
): unknown {
  if (!isRecord(event) || event.type !== "message" || !isRecord(event.message)) {
    return undefined;
  }
  if (!Array.isArray(event.message.content)) {
    return undefined;
  }
  let replaced = false;
  const content = event.message.content.map((block) => {
    if (!isRecord(block) || block.type !== "toolCall" || block.id !== toolCallId) {
      return block;
    }
    replaced = true;
    return { ...block, arguments: args };
  });
  return replaced ? { ...event, message: { ...event.message, content } } : undefined;
}

/** Maps a sanitized CLI tool result onto transcript content blocks. */
function normalizeToolResultContent(result: unknown): ToolResultContent[] {
  if (typeof result === "string") {
    return result ? [{ type: "text", text: result }] : [];
  }
  if (!result || typeof result !== "object") {
    return [];
  }
  // Claude stream-json echoes MCP tool_result content as a bare block array;
  // dropping it starves transcript consumers (active-memory reads these
  // records to decide whether the recall summary is grounded in tool output).
  const content = Array.isArray(result) ? result : (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return [];
  }
  const blocks: ToolResultContent[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      blocks.push({ type: "text", text: block });
      continue;
    }
    if (!block || typeof block !== "object") {
      continue;
    }
    const type = (block as { type?: unknown }).type;
    const text = (block as { text?: unknown }).text;
    if (type === "text" && typeof text === "string") {
      blocks.push({ type: "text", text });
      continue;
    }
    const data = (block as { data?: unknown }).data;
    const mimeType = (block as { mimeType?: unknown }).mimeType;
    if (type === "image" && typeof data === "string" && typeof mimeType === "string") {
      blocks.push({ type: "image", data, mimeType });
    }
  }
  return blocks;
}

function readToolResultDetails(result: unknown): unknown {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const details = (result as { details?: unknown }).details;
  return details && typeof details === "object" ? details : undefined;
}
