import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentMessage, AgentToolResult } from "./runtime/index.js";
import { toToolSearchJsonSafe } from "./tool-search-json.js";
import type { ToolSearchTargetTranscriptProjection } from "./tool-search-types.js";

function readMessageToolResultId(message: AgentMessage): string | undefined {
  const record = message as unknown as Record<string, unknown>;
  const role = typeof record.role === "string" ? record.role : "";
  const canUseDirectId = role === "toolResult" || role === "tool";
  const direct = record.toolCallId ?? record.toolUseId ?? record.tool_use_id;
  if (canUseDirectId && typeof direct === "string" && direct.trim()) {
    return direct;
  }
  const content = record.content;
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
): AgentMessage[] {
  const input = toToolSearchJsonSafe(projection.input);
  const timestamp = projection.timestamp ?? Date.now();
  const resultRecord = isRecord(projection.result) ? projection.result : undefined;
  const resultContent =
    Array.isArray(resultRecord?.content) && resultRecord.content.length > 0
      ? toToolSearchJsonSafe(resultRecord.content)
      : [
          {
            type: "text",
            text: textFromToolSearchProjectionResult(
              projection.result,
              projection.isError === true,
            ),
          },
        ];
  return [
    {
      role: "assistant",
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
    } as unknown as AgentMessage,
    {
      role: "toolResult",
      toolCallId: projection.toolCallId,
      toolName: projection.toolName,
      isError: projection.isError === true,
      content: resultContent,
      timestamp,
    } as unknown as AgentMessage,
  ];
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
  return freezeJsonSnapshot(snapshot) as AgentToolResult<unknown>;
}
