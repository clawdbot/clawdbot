import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { HEARTBEAT_TRANSCRIPT_PROMPT } from "../auto-reply/heartbeat.js";
import { HEARTBEAT_TOKEN } from "../auto-reply/tokens.js";
import { normalizeAgentPlanSteps } from "../channels/streaming.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { redactToolPayloadText } from "../logging/redact.js";
import {
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
  classifyAgentRunTerminalOutcome,
} from "./agent-run-terminal-outcome.js";
import {
  normalizeAgentRunTerminalReplySnapshot,
  type AgentRunTerminalReplySnapshot,
} from "./agent-run-terminal-reply.js";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
  stripInternalRuntimeContext,
} from "./internal-runtime-context.js";

export type SessionActivityNoteState = {
  noteSequence: number;
  notes: Array<{ sequence: number; text: string; bytes: number }>;
  noteBytes: number;
  itemStatuses: Map<string, string>;
  assistantBuffer: string;
  assistantRawBuffer: string;
  assistantBufferDirty: boolean;
  lastAssistantBufferAt: number;
  lastAssistantNote?: string;
  planProgress?: { completed: number; total: number };
  terminalReply?: AgentRunTerminalReplySnapshot;
};

const MAX_NOTES = 40;
const MAX_NOTE_BYTES = 8 * 1024;
const DEFAULT_NOTE_MAX_CHARS = 360;
const ASSISTANT_NOTE_MAX_CHARS = 240;
const ASSISTANT_BUFFER_MAX_CHARS = 4096;
const ASSISTANT_BUFFER_THROTTLE_MS = 150;
const MAX_ITEM_STATUSES = 160;

export function createSessionActivityNoteState(): SessionActivityNoteState {
  return {
    noteSequence: 0,
    notes: [],
    noteBytes: 0,
    itemStatuses: new Map(),
    assistantBuffer: "",
    assistantRawBuffer: "",
    assistantBufferDirty: false,
    lastAssistantBufferAt: 0,
  };
}

// Preserve an unmatched BEGIN while truncating so a later END can still strip the private block.
function assembleAssistantBuffer(value: string, maxChars: number): string {
  // Detect on raw text: stripping an open block would make later body deltas
  // indistinguishable from ordinary prose.
  const openIndex = value.lastIndexOf(INTERNAL_RUNTIME_CONTEXT_BEGIN);
  const isOpen = openIndex !== -1 && !value.includes(INTERNAL_RUNTIME_CONTEXT_END, openIndex);
  if (!isOpen) {
    return keepUtf16SafeTail(stripInternalRuntimeContext(value), maxChars);
  }
  const head = keepUtf16SafeTail(stripInternalRuntimeContext(value.slice(0, openIndex)), maxChars);
  const body = keepUtf16SafeTail(
    value.slice(openIndex + INTERNAL_RUNTIME_CONTEXT_BEGIN.length),
    maxChars,
  );
  return `${head}${INTERNAL_RUNTIME_CONTEXT_BEGIN}${body}`;
}

function syncAssistantBuffer(state: SessionActivityNoteState, at = Date.now()): void {
  if (!state.assistantBufferDirty) {
    return;
  }
  state.assistantBuffer = assembleAssistantBuffer(
    state.assistantRawBuffer,
    ASSISTANT_BUFFER_MAX_CHARS,
  );
  state.assistantBufferDirty = false;
  state.lastAssistantBufferAt = at;
}

function keepUtf16SafeTail(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  let start = value.length - maxChars;
  const lead = value.charCodeAt(start);
  if (lead >= 0xdc00 && lead <= 0xdfff) {
    start += 1;
  }
  return value.slice(start);
}

function sanitizeActivityText(value: string, maxChars: number): string {
  const normalized = redactToolPayloadText(stripInternalRuntimeContext(value))
    .replace(/\s+/gu, " ")
    .trim();
  return truncateUtf16Safe(normalized, maxChars);
}

function summarizeToolArgs(args: unknown): string {
  if (!args || typeof args !== "object") {
    return "";
  }
  const record = args as Record<string, unknown>;
  const summary: Record<string, string | number | boolean> = {};
  for (const key of [
    "action",
    "cmd",
    "command",
    "cwd",
    "file",
    "filePath",
    "host",
    "package",
    "path",
    "pattern",
    "query",
    "target",
    "url",
  ]) {
    const value = record[key];
    if (typeof value === "string") {
      summary[key] = redactToolPayloadText(value);
    } else if (typeof value === "number" || typeof value === "boolean") {
      summary[key] = value;
    }
  }
  try {
    if (Object.keys(summary).length > 0) {
      return sanitizeActivityText(JSON.stringify(summary), 220);
    }
    return sanitizeActivityText(
      `args: ${Object.keys(record).toSorted().slice(0, 8).join(", ")}`,
      220,
    );
  } catch {
    return "";
  }
}

function addActivityNote(state: SessionActivityNoteState, raw: string, maxChars: number): void {
  const text = sanitizeActivityText(raw, maxChars);
  if (!text) {
    return;
  }
  state.noteSequence += 1;
  const note = {
    sequence: state.noteSequence,
    text,
    bytes: Buffer.byteLength(text, "utf8"),
  };
  state.notes.push(note);
  state.noteBytes += note.bytes;
  while (state.notes.length > MAX_NOTES || state.noteBytes > MAX_NOTE_BYTES) {
    const removed = state.notes.shift();
    state.noteBytes -= removed?.bytes ?? 0;
  }
}

function rememberItemStatus(
  state: SessionActivityNoteState,
  itemId: string,
  status: string,
  limit: number,
): boolean {
  if (state.itemStatuses.get(itemId) === status) {
    return false;
  }
  state.itemStatuses.delete(itemId);
  state.itemStatuses.set(itemId, status);
  pruneMapToMaxSize(state.itemStatuses, limit);
  return true;
}

export function flushSessionActivityAssistantNote(
  state: SessionActivityNoteState,
  noteMaxChars: number = DEFAULT_NOTE_MAX_CHARS,
): void {
  // Consumers force the latest cumulative snapshot; periodic assembly only keeps live state warm.
  syncAssistantBuffer(state);
  // Redact assembled prose so split secrets match and raw fragments do not count as notes.
  if (!state.assistantBuffer || state.assistantBuffer.includes(INTERNAL_RUNTIME_CONTEXT_BEGIN)) {
    return;
  }
  const sanitized = sanitizeActivityText(state.assistantBuffer, ASSISTANT_BUFFER_MAX_CHARS);
  const visible = keepUtf16SafeTail(sanitized, ASSISTANT_NOTE_MAX_CHARS).trim();
  if (!visible || visible === HEARTBEAT_TOKEN || visible === HEARTBEAT_TRANSCRIPT_PROMPT) {
    return;
  }
  if (visible === state.lastAssistantNote) {
    return;
  }
  state.lastAssistantNote = visible;
  addActivityNote(state, `Assistant: ${visible}`, noteMaxChars);
}

export function noteSessionActivityEvent(
  state: SessionActivityNoteState,
  event: AgentEventPayload,
  noteMaxChars: number = DEFAULT_NOTE_MAX_CHARS,
): void {
  const data = event.data;
  switch (event.stream) {
    case "lifecycle": {
      const phase = data.phase;
      if (phase === "start") {
        addActivityNote(state, "Run started", noteMaxChars);
      } else if (phase === "finishing") {
        addActivityNote(state, "Run is wrapping up", noteMaxChars);
      } else if (phase === "end" || phase === "error") {
        const health = terminalHealthFor(event);
        const error = readNonBlankString(data.error);
        addActivityNote(state, error ? `Run ${health}: ${error}` : `Run ${health}`, noteMaxChars);
        const terminalReply = normalizeAgentRunTerminalReplySnapshot(data.terminalReply);
        state.terminalReply = terminalReply;
        if (terminalReply?.disposition === "visible") {
          addActivityNote(state, `Assistant: ${terminalReply.text}`, noteMaxChars);
        }
      }
      return;
    }
    case "tool": {
      // Tool results are intentionally ignored: their details field is private
      // runtime context and must never enter an observer-model prompt.
      if (data.phase !== "start") {
        return;
      }
      const name = readNonBlankString(data.name) ?? "tool";
      const args = summarizeToolArgs(data.args);
      addActivityNote(state, args ? `Tool ${name}: ${args}` : `Tool ${name}`, noteMaxChars);
      return;
    }
    case "command_output": {
      if (data.phase !== "end") {
        return;
      }
      const title = readNonBlankString(data.title) ?? readNonBlankString(data.name) ?? "command";
      const exitCode = asFiniteNumber(data.exitCode);
      const status = readNonBlankString(data.status) ?? (exitCode === 0 ? "completed" : "failed");
      addActivityNote(
        state,
        `${title}: ${status}${exitCode === undefined ? "" : ` (exit ${exitCode})`}`,
        noteMaxChars,
      );
      return;
    }
    case "item": {
      const status = readNonBlankString(data.status);
      const title = readNonBlankString(data.title);
      const itemId = readNonBlankString(data.itemId) ?? title;
      if (!status || !title || !itemId) {
        return;
      }
      if (!["running", "completed", "failed", "blocked"].includes(status)) {
        return;
      }
      if (!rememberItemStatus(state, itemId, status, MAX_ITEM_STATUSES)) {
        return;
      }
      addActivityNote(state, `${title}: ${status}`, noteMaxChars);
      return;
    }
    case "plan": {
      const steps = normalizeAgentPlanSteps(data.steps);
      if (!steps) {
        return;
      }
      state.planProgress = {
        completed: steps.filter((step) => step.status === "completed").length,
        total: steps.length,
      };
      for (const [index, step] of steps.entries()) {
        const itemId = `plan:${index}:${step.step}`;
        if (!rememberItemStatus(state, itemId, step.status, MAX_ITEM_STATUSES)) {
          continue;
        }
        const status = step.status === "in_progress" ? "running" : step.status;
        addActivityNote(state, `Plan: ${step.step}: ${status}`, noteMaxChars);
      }
      return;
    }
    case "assistant": {
      const full = readNonBlankString(data.text);
      const delta = readNonBlankString(data.delta);
      if (full) {
        state.assistantRawBuffer = full;
      } else if (delta) {
        // Delta-only producers never expose an unbounded cumulative string. Keep their historical
        // bounded assembly path; its scan cost is capped independently of turn length.
        syncAssistantBuffer(state, event.ts);
        state.assistantBuffer = assembleAssistantBuffer(
          state.assistantBuffer + delta,
          ASSISTANT_BUFFER_MAX_CHARS,
        );
        state.assistantRawBuffer = state.assistantBuffer;
        state.lastAssistantBufferAt = event.ts;
        return;
      } else {
        return;
      }
      // Runtime-context markers can straddle the retained tail, so only the full raw snapshot can
      // be normalized safely. Bound that scan while preserving exact output at every consumer.
      state.assistantBufferDirty = true;
      if (event.ts - state.lastAssistantBufferAt >= ASSISTANT_BUFFER_THROTTLE_MS) {
        syncAssistantBuffer(state, event.ts);
      }
      return;
    }
    case "approval": {
      if (data.status !== "pending" && data.phase !== "requested") {
        return;
      }
      addActivityNote(
        state,
        `Waiting for approval: ${readNonBlankString(data.title) ?? "user action"}`,
        noteMaxChars,
      );
      break;
    }
    default:
      break;
  }
}

export function terminalHealthFor(event: AgentEventPayload): "done" | "failed" {
  const phase = event.data.phase;
  const outcome = buildAgentRunTerminalOutcomeFromLifecycleEvent({
    phase: phase === "end" ? "end" : "error",
    data: event.data,
  });
  return classifyAgentRunTerminalOutcome(outcome) === "success" ? "done" : "failed";
}
