import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { normalizeCommandBody } from "../commands-registry-normalize.js";
import type { CommandNormalizeOptions } from "../commands-registry.types.js";

const ABORT_TRIGGERS = new Set([
  "stop",
  "esc",
  "abort",
  "wait",
  "exit",
  "interrupt",
  "detente",
  "deten",
  "detén",
  "arrete",
  "arrête",
  "停止",
  "やめて",
  "止めて",
  "रुको",
  "توقف",
  "стоп",
  "остановись",
  "останови",
  "остановить",
  "прекрати",
  "halt",
  "anhalten",
  "aufhören",
  "hoer auf",
  "stopp",
  "pare",
  "stop openclaw",
  "openclaw stop",
  "stop action",
  "stop current action",
  "stop run",
  "stop current run",
  "stop agent",
  "stop the agent",
  "stop don't do anything",
  "stop dont do anything",
  "stop do not do anything",
  "stop doing anything",
  "do not do that",
  "please stop",
  "stop please",
]);
const ABORT_MEMORY = new Map<string, boolean>();
const ABORT_MEMORY_MAX = 2000;
const TRAILING_ABORT_PUNCTUATION_RE = /[.!?…,，。;；:：'"’”)\]}]+$/u;

function normalizeAbortTriggerText(text: string): string {
  return normalizeLowercaseStringOrEmpty(text)
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, " ")
    .replace(TRAILING_ABORT_PUNCTUATION_RE, "")
    .trim();
}

export function isAbortTrigger(text?: string): boolean {
  if (!text) {
    return false;
  }
  const normalized = normalizeAbortTriggerText(text);
  return ABORT_TRIGGERS.has(normalized);
}

export function isAbortRequestText(text?: string, options?: CommandNormalizeOptions): boolean {
  if (!text) {
    return false;
  }
  const normalized = normalizeCommandBody(text, options).trim();
  if (!normalized) {
    return false;
  }
  const normalizedLower = normalizeLowercaseStringOrEmpty(normalized);
  return (
    normalizedLower === "/stop" ||
    normalizeAbortTriggerText(normalizedLower) === "/stop" ||
    isAbortTrigger(normalizedLower)
  );
}

export function getAbortMemory(key: string): boolean | undefined {
  const normalized = key.trim();
  if (!normalized) {
    return undefined;
  }
  return ABORT_MEMORY.get(normalized);
}

function pruneAbortMemory(): void {
  if (ABORT_MEMORY.size <= ABORT_MEMORY_MAX) {
    return;
  }
  const excess = ABORT_MEMORY.size - ABORT_MEMORY_MAX;
  let removed = 0;
  for (const entryKey of ABORT_MEMORY.keys()) {
    ABORT_MEMORY.delete(entryKey);
    removed += 1;
    if (removed >= excess) {
      break;
    }
  }
}

export function setAbortMemory(key: string, value: boolean): void {
  const normalized = key.trim();
  if (!normalized) {
    return;
  }
  if (!value) {
    ABORT_MEMORY.delete(normalized);
    return;
  }
  if (ABORT_MEMORY.has(normalized)) {
    ABORT_MEMORY.delete(normalized);
  }
  ABORT_MEMORY.set(normalized, true);
  pruneAbortMemory();
}

export function getAbortMemorySizeForTest(): number {
  return ABORT_MEMORY.size;
}

export function resetAbortMemoryForTest(): void {
  ABORT_MEMORY.clear();
}
