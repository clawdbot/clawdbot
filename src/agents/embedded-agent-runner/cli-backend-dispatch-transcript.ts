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
import { appendTranscriptMessage } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { AgentMessage } from "../runtime/index.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "../stream-message-shared.js";

const log = createSubsystemLogger("agents/embedded-cli-dispatch");

type ToolResultContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

type CliDispatchTranscriptToolEvent = {
  phase: "start" | "result";
  toolName: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
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
}): CliDispatchTranscriptRecorder {
  let tail: Promise<void> = Promise.resolve();
  let lastAssistantText = "";
  let lastWrittenAssistantText = "";
  let finalized = false;
  let toolRecordSequence = 0;

  const scope = {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    sessionFile: params.sessionFile,
  };

  const enqueue = (build: () => AgentMessage) => {
    tail = tail.then(async () => {
      await appendTranscriptMessage(scope, {
        message: build(),
        config: params.config,
        cwd: params.cwd,
      });
    });
    // Transcript mirroring is best-effort; a failed append must not fail the
    // run or poison later appends in the chain.
    tail = tail.catch((error: unknown) => {
      log.warn(
        `cli dispatch transcript append failed: runId=${params.runId} error=${String(error)}`,
      );
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
  ) => buildAssistantMessage({ model, content, stopReason, usage: buildUsageWithNoCost({}) });

  enqueue(() => ({
    role: "user",
    content: [{ type: "text", text: params.prompt }],
    timestamp: Date.now(),
  }));

  return {
    noteToolEvent: (event) => {
      if (finalized) {
        return;
      }
      toolRecordSequence += 1;
      const toolCallId =
        event.toolCallId?.trim() || `${params.runId}-tool-${String(toolRecordSequence)}`;
      if (event.phase === "start") {
        enqueue(() =>
          buildZeroUsageAssistantMessage(
            [
              {
                type: "toolCall",
                id: toolCallId,
                name: event.toolName,
                arguments: event.args ?? {},
              },
            ],
            "toolUse",
          ),
        );
        return;
      }
      enqueue(() => ({
        role: "toolResult",
        toolCallId,
        toolName: event.toolName,
        content: normalizeToolResultContent(event.result),
        details: readToolResultDetails(event.result),
        isError: event.isError === true,
        timestamp: Date.now(),
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
      const text = lastAssistantText.trim();
      if (!text || text === lastWrittenAssistantText) {
        return;
      }
      lastWrittenAssistantText = text;
      enqueue(() => buildZeroUsageAssistantMessage([{ type: "text", text }], "aborted"));
    },
    finalize: async (finalText) => {
      if (finalized) {
        await tail;
        return;
      }
      finalized = true;
      const text = finalText?.trim() || lastAssistantText.trim();
      if (text && text !== lastWrittenAssistantText) {
        lastWrittenAssistantText = text;
        enqueue(() => buildZeroUsageAssistantMessage([{ type: "text", text }], "stop"));
      }
      await tail;
    },
  };
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
