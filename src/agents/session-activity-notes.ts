import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { HEARTBEAT_TRANSCRIPT_PROMPT } from "../auto-reply/heartbeat.js";
import { HEARTBEAT_TOKEN } from "../auto-reply/tokens.js";
import { normalizeAgentPlanSteps } from "../channels/streaming.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { redactToolPayloadText } from "../logging/redact.js";
import { buildAgentRunTerminalOutcome } from "./agent-run-terminal-outcome.js";
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
  lastAssistantNote?: string;
  planProgress?: { completed: number; total: number };
};

const MAX_NOTES = 40;
const MAX_NOTE_BYTES = 8 * 1024;
const DEFAULT_NOTE_MAX_CHARS = 360;
const ASSISTANT_NOTE_MAX_CHARS = 240;
const ASSISTANT_BUFFER_MAX_CHARS = 4096;
const MAX_ITEM_STATUSES = 160;

export function createSessionActivityNoteState(): SessionActivityNoteState {
  return { noteSequence: 0, notes: [], noteBytes: 0, itemStatuses: new Map(), assistantBuffer: "" };
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
  while (state.itemStatuses.size > limit) {
    const oldest = state.itemStatuses.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    state.itemStatuses.delete(oldest);
  }
  return true;
}

export function flushSessionActivityAssistantNote(
  state: SessionActivityNoteState,
  noteMaxChars: number = DEFAULT_NOTE_MAX_CHARS,
): void {
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
        const error = readString(data.error);
        addActivityNote(state, error ? `Run ${health}: ${error}` : `Run ${health}`, noteMaxChars);
      }
      return;
    }
    case "tool": {
      // Tool results are intentionally ignored: their details field is private
      // runtime context and must never enter an observer-model prompt.
      if (data.phase !== "start") {
        return;
      }
      const name = readString(data.name) ?? "tool";
      const args = summarizeToolArgs(data.args);
      addActivityNote(state, args ? `Tool ${name}: ${args}` : `Tool ${name}`, noteMaxChars);
      return;
    }
    case "command_output": {
      if (data.phase !== "end") {
        return;
      }
      const title = readString(data.title) ?? readString(data.name) ?? "command";
      const exitCode = readFiniteNumber(data.exitCode);
      const status = readString(data.status) ?? (exitCode === 0 ? "completed" : "failed");
      addActivityNote(
        state,
        `${title}: ${status}${exitCode === undefined ? "" : ` (exit ${exitCode})`}`,
        noteMaxChars,
      );
      return;
    }
    case "item": {
      const status = readString(data.status);
      const title = readString(data.title);
      const itemId = readString(data.itemId) ?? title;
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
      const full = readString(data.text);
      const delta = readString(data.delta);
      if (full) {
        state.assistantBuffer = assembleAssistantBuffer(full, ASSISTANT_BUFFER_MAX_CHARS);
      } else if (delta) {
        state.assistantBuffer = assembleAssistantBuffer(
          state.assistantBuffer + delta,
          ASSISTANT_BUFFER_MAX_CHARS,
        );
      }
      return;
    }
    case "approval": {
      if (data.status !== "pending" && data.phase !== "requested") {
        return;
      }
      addActivityNote(
        state,
        `Waiting for approval: ${readString(data.title) ?? "user action"}`,
        noteMaxChars,
      );
      break;
    }
    default:
      break;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function terminalHealthFor(event: AgentEventPayload): "done" | "failed" {
  const phase = event.data.phase;
  const outcome = buildAgentRunTerminalOutcome({
    status: phase === "end" ? "ok" : "error",
    error: event.data.error,
    stopReason: event.data.stopReason,
    livenessState: event.data.livenessState,
    timeoutPhase: event.data.timeoutPhase,
    providerStarted: event.data.providerStarted,
    startedAt: event.data.startedAt,
    endedAt: event.data.endedAt,
  });
  return outcome.reason === "completed" ? "done" : "failed";
}
