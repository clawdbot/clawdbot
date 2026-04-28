import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  readStringValue,
} from "../shared/string-coerce.js";
import { extractToolCallsFromAssistant, extractToolResultId } from "./tool-call-id.js";
import {
  REDACTED_SESSIONS_SPAWN_ATTACHMENT_CONTENT,
  SESSIONS_SPAWN_ATTACHMENT_METADATA_KEYS,
  isAllowedToolCallName,
  isRedactedSessionsSpawnAttachment,
  normalizeAllowedToolNames,
} from "./tool-call-shared.js";

export { isRedactedSessionsSpawnAttachment } from "./tool-call-shared.js";

type RawToolCallBlock = {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  arguments?: unknown;
};

function isThinkingLikeBlock(block: unknown): boolean {
  if (!block || typeof block !== "object") {
    return false;
  }
  const type = (block as { type?: unknown }).type;
  return type === "thinking" || type === "redacted_thinking";
}

function isRawToolCallBlock(block: unknown): block is RawToolCallBlock {
  if (!block || typeof block !== "object") {
    return false;
  }
  const type = (block as { type?: unknown }).type;
  return (
    typeof type === "string" &&
    (type === "toolCall" || type === "toolUse" || type === "functionCall")
  );
}

function hasToolCallInput(block: RawToolCallBlock): boolean {
  const hasInput = "input" in block ? block.input !== undefined && block.input !== null : false;
  const hasArguments =
    "arguments" in block ? block.arguments !== undefined && block.arguments !== null : false;
  return hasInput || hasArguments;
}

function hasNonEmptyStringField(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function hasToolCallId(block: RawToolCallBlock): boolean {
  return hasNonEmptyStringField(block.id);
}

function redactSessionsSpawnAttachmentsArgs(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  const rec = value as Record<string, unknown>;
  const raw = rec.attachments;
  if (!Array.isArray(raw)) {
    return value;
  }
  let changed = false;
  const next = raw.map((item) => {
    if (isRedactedSessionsSpawnAttachment(item)) {
      return item;
    }
    changed = true;
    return redactSessionsSpawnAttachment(item);
  });
  if (!changed) {
    return value;
  }
  return { ...rec, attachments: next };
}

function redactSessionsSpawnAcpArgs(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  const rec = value as Record<string, unknown>;
  const next = { ...rec };
  let changed = false;

  for (const key of ["resumeSessionId", "streamTo"] as const) {
    if (Object.hasOwn(rec, key)) {
      next[key] = REDACTED_SESSIONS_SPAWN_ATTACHMENT_CONTENT;
      changed = true;
    }
  }

  return changed ? next : value;
}

function redactSessionsSpawnArgs(value: unknown): unknown {
  return redactSessionsSpawnAcpArgs(redactSessionsSpawnAttachmentsArgs(value));
}

function redactSessionsSpawnAttachment(item: unknown): Record<string, unknown> {
  const next: Record<string, unknown> = {
    content: REDACTED_SESSIONS_SPAWN_ATTACHMENT_CONTENT,
  };
  if (!item || typeof item !== "object") {
    return next;
  }
  const attachment = item as Record<string, unknown>;
  for (const key of SESSIONS_SPAWN_ATTACHMENT_METADATA_KEYS) {
    const value = attachment[key];
    if (typeof value === "string" && value.trim().length > 0) {
      next[key] = value;
    }
  }
  return next;
}

function sanitizeToolCallBlock(block: RawToolCallBlock): RawToolCallBlock {
  const rawName = readStringValue(block.name);
  const trimmedName = rawName?.trim();
  const hasTrimmedName = typeof trimmedName === "string" && trimmedName.length > 0;
  const normalizedName = hasTrimmedName ? trimmedName : undefined;
  const nameChanged = hasTrimmedName && rawName !== trimmedName;

  const isSessionsSpawn = normalizeLowercaseStringOrEmpty(normalizedName) === "sessions_spawn";

  if (!isSessionsSpawn) {
    if (!nameChanged) {
      return block;
    }
    return { ...(block as Record<string, unknown>), name: normalizedName } as RawToolCallBlock;
  }

  // Redact sensitive sessions_spawn payload fields from persisted transcripts.
  // Apply redaction to both `.arguments` and `.input` properties since block structures can vary.
  const nextArgs = redactSessionsSpawnArgs(block.arguments);
  const nextInput = redactSessionsSpawnArgs(block.input);
  if (nextArgs === block.arguments && nextInput === block.input && !nameChanged) {
    return block;
  }

  const next = { ...(block as Record<string, unknown>) };
  if (nameChanged && normalizedName) {
    next.name = normalizedName;
  }
  if (nextArgs !== block.arguments || Object.hasOwn(block, "arguments")) {
    next.arguments = nextArgs;
  }
  if (nextInput !== block.input || Object.hasOwn(block, "input")) {
    next.input = nextInput;
  }
  return next as RawToolCallBlock;
}

function countRawToolCallBlocks(content: unknown[]): number {
  let count = 0;
  for (const block of content) {
    if (isRawToolCallBlock(block)) {
      count += 1;
    }
  }
  return count;
}

function isReplaySafeThinkingAssistantTurn(
  content: unknown[],
  allowedToolNames: Set<string> | null,
): boolean {
  let sawToolCall = false;
  const seenToolCallIds = new Set<string>();
  for (const block of content) {
    if (!isRawToolCallBlock(block)) {
      continue;
    }
    sawToolCall = true;
    const toolCallId = typeof block.id === "string" ? block.id.trim() : "";
    if (
      !hasToolCallInput(block) ||
      !toolCallId ||
      seenToolCallIds.has(toolCallId) ||
      !isAllowedToolCallName(block.name, allowedToolNames)
    ) {
      return false;
    }
    seenToolCallIds.add(toolCallId);
    if (sanitizeToolCallBlock(block) !== block) {
      return false;
    }
  }
  return sawToolCall;
}

function makeMissingToolResult(params: {
  toolCallId: string;
  toolName?: string;
  // OpenAI Responses/Codex replay should match upstream Codex's "aborted"
  // function_call_output normalization; live coverage in
  // openai-reasoning-compat.live.test.ts and tool-replay-repair.live.test.ts
  // sends this repaired history to real models. Other providers keep the older,
  // explicit OpenClaw diagnostic text unless the caller opts in.
  text?: string;
}): Extract<AgentMessage, { role: "toolResult" }> {
  return {
    role: "toolResult",
    toolCallId: params.toolCallId,
    toolName: params.toolName ?? "unknown",
    content: [
      {
        type: "text",
        text:
          params.text ??
          "[openclaw] missing tool result in session history; inserted synthetic error result for transcript repair.",
      },
    ],
    isError: true,
    timestamp: Date.now(),
  } as Extract<AgentMessage, { role: "toolResult" }>;
}

function normalizeToolResultName(
  message: Extract<AgentMessage, { role: "toolResult" }>,
  fallbackName?: string,
): Extract<AgentMessage, { role: "toolResult" }> {
  const rawToolName = (message as { toolName?: unknown }).toolName;
  const normalizedToolName = normalizeOptionalString(rawToolName);
  if (normalizedToolName) {
    if (rawToolName === normalizedToolName) {
      return message;
    }
    return { ...message, toolName: normalizedToolName };
  }

  const normalizedFallback = normalizeOptionalString(fallbackName);
  if (normalizedFallback) {
    return { ...message, toolName: normalizedFallback };
  }

  if (typeof rawToolName === "string") {
    return { ...message, toolName: "unknown" };
  }
  return message;
}

export { makeMissingToolResult };

export type ToolCallInputRepairReport = {
  messages: AgentMessage[];
  droppedToolCalls: number;
  droppedAssistantMessages: number;
};

export type ToolCallInputRepairOptions = {
  allowedToolNames?: Iterable<string>;
  allowProviderOwnedThinkingReplay?: boolean;
};

export type ErroredAssistantResultPolicy = "preserve" | "drop";

export type ToolUseResultPairingOptions = {
  erroredAssistantResultPolicy?: ErroredAssistantResultPolicy;
  missingToolResultText?: string;
};

export function stripToolResultDetails(messages: AgentMessage[]): AgentMessage[] {
  let touched = false;
  const out: AgentMessage[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object" || (msg as { role?: unknown }).role !== "toolResult") {
      out.push(msg);
      continue;
    }
    if (!("details" in msg)) {
      out.push(msg);
      continue;
    }
    const sanitized = { ...(msg as object) } as { details?: unknown };
    delete sanitized.details;
    touched = true;
    out.push(sanitized as unknown as AgentMessage);
  }
  return touched ? out : messages;
}

export function repairToolCallInputs(
  messages: AgentMessage[],
  options?: ToolCallInputRepairOptions,
): ToolCallInputRepairReport {
  let droppedToolCalls = 0;
  let droppedAssistantMessages = 0;
  let changed = false;
  const out: AgentMessage[] = [];
  const allowedToolNames = normalizeAllowedToolNames(options?.allowedToolNames);
  const allowProviderOwnedThinkingReplay = options?.allowProviderOwnedThinkingReplay === true;
  const claimedReplaySafeToolCallIds = new Set<string>();

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      out.push(msg);
      continue;
    }

    if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
      out.push(msg);
      continue;
    }

    if (
      allowProviderOwnedThinkingReplay &&
      msg.content.some((block) => isThinkingLikeBlock(block)) &&
      countRawToolCallBlocks(msg.content) > 0
    ) {
      // Signed Anthropic thinking blocks must remain byte-for-byte stable on
      // replay. Preserve the turn only if every sibling tool call is already
      // valid and requires no redaction or normalization. Otherwise drop the
      // whole assistant turn rather than mutating provider-owned content.
      const replaySafeToolCalls = extractToolCallsFromAssistant(msg);
      if (
        isReplaySafeThinkingAssistantTurn(msg.content, allowedToolNames) &&
        replaySafeToolCalls.every((toolCall) => !claimedReplaySafeToolCallIds.has(toolCall.id))
      ) {
        for (const toolCall of replaySafeToolCalls) {
          claimedReplaySafeToolCallIds.add(toolCall.id);
        }
        out.push(msg);
      } else {
        droppedToolCalls += countRawToolCallBlocks(msg.content);
        droppedAssistantMessages += 1;
        changed = true;
      }
      continue;
    }

    const nextContent: typeof msg.content = [];
    let droppedInMessage = 0;
    let messageChanged = false;

    for (const block of msg.content) {
      if (
        isRawToolCallBlock(block) &&
        (!hasToolCallInput(block) ||
          !hasToolCallId(block) ||
          !isAllowedToolCallName((block as RawToolCallBlock).name, allowedToolNames))
      ) {
        droppedToolCalls += 1;
        droppedInMessage += 1;
        changed = true;
        messageChanged = true;
        continue;
      }
      if (isRawToolCallBlock(block)) {
        if (
          (block as { type?: unknown }).type === "toolCall" ||
          (block as { type?: unknown }).type === "toolUse" ||
          (block as { type?: unknown }).type === "functionCall"
        ) {
          // Only sanitize (redact) sessions_spawn blocks; all others are passed through
          // unchanged to preserve provider-specific shapes (e.g. toolUse.input for Anthropic).
          const blockName =
            typeof (block as { name?: unknown }).name === "string"
              ? (block as { name: string }).name.trim()
              : undefined;
          if (normalizeLowercaseStringOrEmpty(blockName) === "sessions_spawn") {
            const sanitized = sanitizeToolCallBlock(block);
            if (sanitized !== block) {
              changed = true;
              messageChanged = true;
            }
            nextContent.push(sanitized as typeof block);
          } else {
            if (typeof (block as { name?: unknown }).name === "string") {
              const rawName = (block as { name: string }).name;
              const trimmedName = rawName.trim();
              if (rawName !== trimmedName && trimmedName) {
                const renamed = { ...(block as object), name: trimmedName } as typeof block;
                nextContent.push(renamed);
                changed = true;
                messageChanged = true;
              } else {
                nextContent.push(block);
              }
            } else {
              nextContent.push(block);
            }
          }
          continue;
        }
      } else {
        nextContent.push(block);
      }
    }

    if (droppedInMessage > 0) {
      if (nextContent.length === 0) {
        droppedAssistantMessages += 1;
        changed = true;
        continue;
      }
      out.push({ ...msg, content: nextContent });
      continue;
    }

    if (messageChanged) {
      out.push({ ...msg, content: nextContent });
      continue;
    }

    out.push(msg);
  }

  return {
    messages: changed ? out : messages,
    droppedToolCalls,
    droppedAssistantMessages,
  };
}

export function sanitizeToolCallInputs(
  messages: AgentMessage[],
  options?: ToolCallInputRepairOptions,
): AgentMessage[] {
  return repairToolCallInputs(messages, options).messages;
}

export function sanitizeToolUseResultPairing(
  messages: AgentMessage[],
  options?: ToolUseResultPairingOptions,
): AgentMessage[] {
  return repairToolUseResultPairing(messages, options).messages;
}

export type ToolUseRepairReport = {
  messages: AgentMessage[];
  added: Array<Extract<AgentMessage, { role: "toolResult" }>>;
  droppedDuplicateCount: number;
  droppedOrphanCount: number;
  moved: boolean;
};

function shouldDropErroredAssistantResults(options?: ToolUseResultPairingOptions): boolean {
  return options?.erroredAssistantResultPolicy === "drop";
}

export function repairToolUseResultPairing(
  messages: AgentMessage[],
  options?: ToolUseResultPairingOptions,
): ToolUseRepairReport {
  // Anthropic (and Cloud Code Assist) reject transcripts where assistant tool calls are not
  // immediately followed by matching tool results. Session files can end up with results
  // displaced (e.g. after user turns) or duplicated. Repair by:
  // - moving matching toolResult messages directly after their assistant toolCall turn
  // - inserting synthetic error toolResults for missing ids
  // - dropping duplicate toolResults for the same id (anywhere in the transcript)
  const out: AgentMessage[] = [];
  const added: Array<Extract<AgentMessage, { role: "toolResult" }>> = [];
  const seenToolResultIds = new Set<string>();
  let droppedDuplicateCount = 0;
  let droppedOrphanCount = 0;
  let moved = false;
  let changed = false;

  const pushToolResult = (msg: Extract<AgentMessage, { role: "toolResult" }>) => {
    const id = extractToolResultId(msg);
    if (id && seenToolResultIds.has(id)) {
      droppedDuplicateCount += 1;
      changed = true;
      return;
    }
    if (id) {
      seenToolResultIds.add(id);
    }
    out.push(msg);
  };

  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") {
      out.push(msg);
      continue;
    }

    const role = (msg as { role?: unknown }).role;
    if (role !== "assistant") {
      // Tool results must only appear directly after the matching assistant tool call turn.
      // Any "free-floating" toolResult entries in session history can make strict providers
      // (Anthropic-compatible APIs, MiniMax, Cloud Code Assist) reject the entire request.
      if (role !== "toolResult") {
        out.push(msg);
      } else {
        droppedOrphanCount += 1;
        changed = true;
      }
      continue;
    }

    const assistant = msg as Extract<AgentMessage, { role: "assistant" }>;

    const toolCalls = extractToolCallsFromAssistant(assistant);
    if (toolCalls.length === 0) {
      out.push(msg);
      continue;
    }

    const toolCallIds = new Set(toolCalls.map((t) => t.id));
    const toolCallNamesById = new Map(toolCalls.map((t) => [t.id, t.name] as const));

    const spanResultsById = new Map<string, Extract<AgentMessage, { role: "toolResult" }>>();
    const remainder: AgentMessage[] = [];

    let j = i + 1;
    for (; j < messages.length; j += 1) {
      const next = messages[j];
      if (!next || typeof next !== "object") {
        remainder.push(next);
        continue;
      }

      const nextRole = (next as { role?: unknown }).role;
      if (nextRole === "assistant") {
        break;
      }

      if (nextRole === "toolResult") {
        const toolResult = next as Extract<AgentMessage, { role: "toolResult" }>;
        const id = extractToolResultId(toolResult);
        if (id && toolCallIds.has(id)) {
          if (seenToolResultIds.has(id)) {
            droppedDuplicateCount += 1;
            changed = true;
            continue;
          }
          const normalizedToolResult = normalizeToolResultName(
            toolResult,
            toolCallNamesById.get(id),
          );
          if (normalizedToolResult !== toolResult) {
            changed = true;
          }
          if (!spanResultsById.has(id)) {
            spanResultsById.set(id, normalizedToolResult);
          }
          continue;
        }
      }

      // Drop tool results that don't match the current assistant tool calls.
      if (nextRole !== "toolResult") {
        remainder.push(next);
      } else {
        droppedOrphanCount += 1;
        changed = true;
      }
    }

    // Aborted/errored assistant turns should never synthesize missing tool results, but
    // the replay sanitizer can still legitimately retain real tool results for surviving
    // tool calls in the same turn after malformed siblings are dropped.
    const stopReason = (assistant as { stopReason?: string }).stopReason;
    if (stopReason === "error" || stopReason === "aborted") {
      if (!shouldDropErroredAssistantResults(options)) {
        out.push(msg);
        for (const toolCall of toolCalls) {
          const result = spanResultsById.get(toolCall.id);
          if (!result) {
            continue;
          }
          pushToolResult(result);
        }
      } else if (spanResultsById.size > 0) {
        changed = true;
      } else {
        changed = true;
      }
      for (const rem of remainder) {
        out.push(rem);
      }
      i = j - 1;
      continue;
    }

    out.push(msg);

    if (spanResultsById.size > 0 && remainder.length > 0) {
      // Preserve real late-arriving results before synthesizing missing siblings;
      // otherwise parallel tool replay can replace useful output with repair noise.
      moved = true;
      changed = true;
    }

    for (const call of toolCalls) {
      const existing = spanResultsById.get(call.id);
      if (existing) {
        pushToolResult(existing);
      } else {
        const missing = makeMissingToolResult({
          toolCallId: call.id,
          toolName: call.name,
          text: options?.missingToolResultText,
        });
        added.push(missing);
        changed = true;
        pushToolResult(missing);
      }
    }

    for (const rem of remainder) {
      if (!rem || typeof rem !== "object") {
        out.push(rem);
        continue;
      }
      out.push(rem);
    }
    i = j - 1;
  }

  const changedOrMoved = changed || moved;
  return {
    messages: changedOrMoved ? out : messages,
    added,
    droppedDuplicateCount,
    droppedOrphanCount,
    moved: changedOrMoved,
  };
}
