import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
  stripInternalRuntimeContext,
} from "../agents/internal-runtime-context.js";
import { HEARTBEAT_TRANSCRIPT_PROMPT } from "../auto-reply/heartbeat.js";
import { HEARTBEAT_TOKEN } from "../auto-reply/tokens.js";
import { normalizeAgentPlanSteps } from "../channels/streaming.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { redactToolPayloadText } from "../logging/redact.js";
import {
  readFiniteNumber,
  readString,
  terminalHealthFor,
  type SessionObserverState,
} from "./session-observer-model.js";

const MAX_NOTES = 40;
const MAX_NOTE_BYTES = 8 * 1024;
const ASSISTANT_NOTE_MAX_CHARS = 240;
const SESSION_OBSERVER_ASSISTANT_BUFFER_MAX_CHARS = 4096;

/**
 * Assemble streamed assistant prose: strip complete runtime-context blocks,
 * then truncate without ever discarding an unmatched context BEGIN marker so
 * the eventual END still closes and strips the whole block. Accepted tradeoff:
 * a truncation boundary landing inside a split marker while the model echoes
 * >4 KB of context is treated as ordinary prose (flush stays redacted).
 */
function assembleSessionObserverAssistantBuffer(value: string): string {
  // Detect a still-open block on the RAW text: the stripper drops an
  // unterminated marker together with its tail, which would leave the block
  // body arriving in later deltas indistinguishable from ordinary prose.
  const openIndex = value.lastIndexOf(INTERNAL_RUNTIME_CONTEXT_BEGIN);
  const isOpen = openIndex !== -1 && !value.includes(INTERNAL_RUNTIME_CONTEXT_END, openIndex);
  if (!isOpen) {
    return keepUtf16SafeTail(
      stripInternalRuntimeContext(value),
      SESSION_OBSERVER_ASSISTANT_BUFFER_MAX_CHARS,
    );
  }
  const head = keepUtf16SafeTail(
    stripInternalRuntimeContext(value.slice(0, openIndex)),
    SESSION_OBSERVER_ASSISTANT_BUFFER_MAX_CHARS,
  );
  const body = keepUtf16SafeTail(
    value.slice(openIndex + INTERNAL_RUNTIME_CONTEXT_BEGIN.length),
    SESSION_OBSERVER_ASSISTANT_BUFFER_MAX_CHARS,
  );
  return `${head}${INTERNAL_RUNTIME_CONTEXT_BEGIN}${body}`;
}

/** True while the buffer holds a still-streaming runtime-context block. */
function assistantBufferHasOpenContext(value: string): boolean {
  return value.includes(INTERNAL_RUNTIME_CONTEXT_BEGIN);
}

/** Keep the newest chars without starting on the low half of a surrogate pair. */
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

function sanitizeSessionObserverActivityText(value: string, maxChars: number): string {
  const normalized = redactToolPayloadText(stripInternalRuntimeContext(value))
    .replace(/\s+/gu, " ")
    .trim();
  return truncateUtf16Safe(normalized, maxChars);
}

function summarizeSessionObserverToolArgs(args: unknown): string {
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
      return sanitizeSessionObserverActivityText(JSON.stringify(summary), 220);
    }
    return sanitizeSessionObserverActivityText(
      `args: ${Object.keys(record).toSorted().slice(0, 8).join(", ")}`,
      220,
    );
  } catch {
    return "";
  }
}

function addSessionObserverNote(state: SessionObserverState, raw: string): void {
  const text = sanitizeSessionObserverActivityText(raw, 360);
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

export function flushSessionObserverAssistantNote(state: SessionObserverState): void {
  // Assistant prose is redacted only as assembled text: per-fragment sanitizing
  // cannot match secrets split across stream chunks, and raw fragments must not
  // count toward the digest note threshold.
  if (!state.assistantBuffer || assistantBufferHasOpenContext(state.assistantBuffer)) {
    return;
  }
  const sanitized = sanitizeSessionObserverActivityText(
    state.assistantBuffer,
    SESSION_OBSERVER_ASSISTANT_BUFFER_MAX_CHARS,
  );
  const visible = keepUtf16SafeTail(sanitized, ASSISTANT_NOTE_MAX_CHARS).trim();
  if (!visible || visible === HEARTBEAT_TOKEN || visible === HEARTBEAT_TRANSCRIPT_PROMPT) {
    return;
  }
  if (visible === state.lastAssistantNote) {
    return;
  }
  state.lastAssistantNote = visible;
  addSessionObserverNote(state, `Assistant: ${visible}`);
}

export function noteSessionObserverEvent(
  state: SessionObserverState,
  event: AgentEventPayload,
  rememberItemStatus: (state: SessionObserverState, itemId: string, status: string) => boolean,
): void {
  const data = event.data;
  switch (event.stream) {
    case "lifecycle": {
      const phase = data.phase;
      if (phase === "start") {
        addSessionObserverNote(state, "Run started");
      } else if (phase === "finishing") {
        addSessionObserverNote(state, "Run is wrapping up");
      } else if (phase === "end" || phase === "error") {
        const health = terminalHealthFor(event);
        const error = readString(data.error);
        addSessionObserverNote(state, error ? `Run ${health}: ${error}` : `Run ${health}`);
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
      const args = summarizeSessionObserverToolArgs(data.args);
      addSessionObserverNote(state, args ? `Tool ${name}: ${args}` : `Tool ${name}`);
      return;
    }
    case "command_output": {
      if (data.phase !== "end") {
        return;
      }
      const title = readString(data.title) ?? readString(data.name) ?? "command";
      const exitCode = readFiniteNumber(data.exitCode);
      const status = readString(data.status) ?? (exitCode === 0 ? "completed" : "failed");
      addSessionObserverNote(
        state,
        `${title}: ${status}${exitCode === undefined ? "" : ` (exit ${exitCode})`}`,
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
      if (!rememberItemStatus(state, itemId, status)) {
        return;
      }
      addSessionObserverNote(state, `${title}: ${status}`);
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
        if (!rememberItemStatus(state, itemId, step.status)) {
          continue;
        }
        const status = step.status === "in_progress" ? "running" : step.status;
        addSessionObserverNote(state, `Plan: ${step.step}: ${status}`);
      }
      return;
    }
    case "assistant": {
      const full = readString(data.text);
      const delta = readString(data.delta);
      if (full) {
        state.assistantBuffer = assembleSessionObserverAssistantBuffer(full);
      } else if (delta) {
        state.assistantBuffer = assembleSessionObserverAssistantBuffer(
          state.assistantBuffer + delta,
        );
      }
      return;
    }
    case "approval": {
      if (data.status !== "pending" && data.phase !== "requested") {
        return;
      }
      addSessionObserverNote(
        state,
        `Waiting for approval: ${readString(data.title) ?? "user action"}`,
      );
      break;
    }
    default:
      break;
  }
}
