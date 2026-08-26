import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { NESTED_TOOL_TRANSCRIPT_ARTIFACT_KIND } from "../shared/transcript-only-openclaw-assistant.js";
import { transferMcpCodeModeGuestResult } from "./mcp-content.js";
import type { AgentMessage, AgentToolResult } from "./runtime/index.js";
import type { SessionManager } from "./sessions/index.js";
import { toToolSearchJsonSafe } from "./tool-search-json.js";
import type { ToolSearchTargetTranscriptProjection } from "./tool-search-types.js";

type ToolSearchTargetTranscriptPair = [
  Extract<AgentMessage, { role: "assistant" }>,
  Extract<AgentMessage, { role: "toolResult" }>,
];

function readMessageToolResultId(message: AgentMessage): string | undefined {
  const role: unknown = message.role;
  const canUseDirectId = role === "toolResult" || role === "tool";
  const direct =
    Reflect.get(message, "toolCallId") ??
    Reflect.get(message, "toolUseId") ??
    Reflect.get(message, "tool_use_id");
  if (canUseDirectId && typeof direct === "string" && direct.trim()) {
    return direct;
  }
  const content = Reflect.get(message, "content");
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const block of content) {
    if (!isRecord(block) || block.type !== "toolResult") {
      continue;
    }
    const nested = block.toolCallId ?? block.toolUseId ?? block.tool_use_id ?? block.id;
    if (typeof nested === "string" && nested.trim()) {
      return nested;
    }
  }
  return undefined;
}

function textFromToolSearchProjectionResult(result: unknown, isError: boolean): string {
  if (isRecord(result)) {
    const details = isRecord(result.details) ? result.details : undefined;
    const detailError = details?.error;
    if (typeof detailError === "string" && detailError.trim()) {
      return detailError;
    }
    const content = result.content;
    if (Array.isArray(content)) {
      const text = content
        .map((item) => (isRecord(item) && typeof item.text === "string" ? item.text : ""))
        .filter(Boolean)
        .join("\n");
      if (text.trim()) {
        return text;
      }
    }
  }
  const safe = toToolSearchJsonSafe(result);
  if (typeof safe === "string") {
    return safe;
  }
  const encoded = JSON.stringify(safe);
  if (typeof encoded === "string") {
    return encoded;
  }
  return isError ? "Tool Search target tool failed." : "Tool Search target tool completed.";
}

function buildToolSearchTargetTranscriptMessages(
  projection: ToolSearchTargetTranscriptProjection,
): ToolSearchTargetTranscriptPair {
  const input = toToolSearchJsonSafe(projection.input);
  const timestamp = projection.timestamp ?? Date.now();
  const resultRecord = isRecord(projection.result) ? projection.result : undefined;
  const resultContent =
    Array.isArray(resultRecord?.content) && resultRecord.content.length > 0
      ? toToolSearchJsonSafe(resultRecord.content)
      : [
          {
            type: "text",
            text: textFromToolSearchProjectionResult(projection.result, projection.isError),
          },
        ];
  return [
    // SAFETY: this synthetic assistant has the canonical tool-call shape; provider
    // identity is attached only for durable artifacts below.
    {
      role: "assistant",
      parentToolCallId: projection.parentToolCallId,
      content: [
        {
          type: "toolCall",
          id: projection.toolCallId,
          name: projection.toolName,
          arguments: input,
          input,
        },
      ],
      stopReason: "toolUse",
      timestamp,
    } as unknown as Extract<AgentMessage, { role: "assistant" }>,
    {
      role: "toolResult",
      parentToolCallId: projection.parentToolCallId,
      toolCallId: projection.toolCallId,
      toolName: projection.toolName,
      isError: projection.isError,
      content: resultContent,
      timestamp,
    } as Extract<AgentMessage, { role: "toolResult" }>,
  ];
}

/** Build a canonical durable pair that replay filters as display-only evidence. */
function buildToolSearchTargetTranscriptArtifactMessages(
  projection: ToolSearchTargetTranscriptProjection,
): ToolSearchTargetTranscriptPair {
  const [toolCall, toolResult] = buildToolSearchTargetTranscriptMessages(projection);
  const openclawTranscriptArtifact = {
    kind: NESTED_TOOL_TRANSCRIPT_ARTIFACT_KIND,
    version: 1 as const,
  };
  // Older readers ignore this marker and replay both standard messages; current
  // readers drop both, so rollback never leaves an orphan tool result.
  return [
    Object.assign({}, toolCall, {
      openclawTranscriptArtifact,
    }),
    Object.assign({}, toolResult, {
      openclawTranscriptArtifact,
    }),
  ];
}

/**
 * Persist nested target activity immediately after its wrapper result. The
 * terminal model assistant is appended later and remains the authoritative leaf.
 */
export function installToolSearchTargetTranscriptPersistence(params: {
  sessionManager: SessionManager;
  projections: readonly ToolSearchTargetTranscriptProjection[];
}): () => void {
  const originalAppend = params.sessionManager.appendMessage.bind(params.sessionManager);
  const persisted = new Set<ToolSearchTargetTranscriptProjection>();
  const wrappedAppend: SessionManager["appendMessage"] = function (message, options) {
    const entryId = originalAppend(message, options);
    const parentToolCallId = readMessageToolResultId(message);
    if (!entryId || !parentToolCallId) {
      return entryId;
    }
    for (const projection of params.projections) {
      if (persisted.has(projection) || projection.parentToolCallId !== parentToolCallId) {
        continue;
      }
      const [toolCall, toolResult] = buildToolSearchTargetTranscriptArtifactMessages(projection);
      const toolCallEntryId = originalAppend(toolCall);
      if (!toolCallEntryId) {
        continue;
      }
      originalAppend(toolResult);
      persisted.add(projection);
    }
    return entryId;
  };
  params.sessionManager.appendMessage = wrappedAppend;
  return () => {
    if (params.sessionManager.appendMessage === wrappedAppend) {
      params.sessionManager.appendMessage = originalAppend;
    }
  };
}

export function projectToolSearchTargetTranscriptMessages(
  messages: AgentMessage[],
  projections: readonly ToolSearchTargetTranscriptProjection[],
): AgentMessage[] {
  if (projections.length === 0) {
    return messages;
  }
  const byParent = new Map<string, ToolSearchTargetTranscriptProjection[]>();
  const unmatched: ToolSearchTargetTranscriptProjection[] = [];
  for (const projection of projections) {
    const parent = projection.parentToolCallId?.trim();
    if (!parent) {
      unmatched.push(projection);
      continue;
    }
    const group = byParent.get(parent) ?? [];
    group.push(projection);
    byParent.set(parent, group);
  }
  const inserted = new Set<ToolSearchTargetTranscriptProjection>();
  const projected: AgentMessage[] = [];
  for (const message of messages) {
    projected.push(message);
    const toolResultId = readMessageToolResultId(message);
    const group = toolResultId ? byParent.get(toolResultId) : undefined;
    if (!group) {
      continue;
    }
    for (const projection of group) {
      projected.push(...buildToolSearchTargetTranscriptMessages(projection));
      inserted.add(projection);
    }
  }
  for (const projection of [...unmatched, ...projections]) {
    if (inserted.has(projection)) {
      continue;
    }
    projected.push(...buildToolSearchTargetTranscriptMessages(projection));
    inserted.add(projection);
  }
  return projected;
}

function freezeJsonSnapshot(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  for (const nested of Object.values(value)) {
    freezeJsonSnapshot(nested);
  }
  return Object.freeze(value);
}

/** Capture a stable JSON-safe result before delayed transcript settlement. */
export function snapshotToolSearchTargetTranscriptResult(
  result: AgentToolResult<unknown>,
): AgentToolResult<unknown> {
  const hasDetails = "details" in result;
  const snapshot = toToolSearchJsonSafe(result);
  if (!isRecord(snapshot)) {
    throw new Error("Tool Search target result could not be captured for transcript projection.");
  }
  if (hasDetails && !("details" in snapshot)) {
    // `details` presence selects callValue unwrapping. JSON serialization drops
    // an explicit undefined, so restore that marker before freezing the envelope.
    snapshot.details =
      result.details === undefined ? undefined : toToolSearchJsonSafe(result.details);
  }
  return transferMcpCodeModeGuestResult(
    result,
    freezeJsonSnapshot(snapshot) as AgentToolResult<unknown>,
  );
}
