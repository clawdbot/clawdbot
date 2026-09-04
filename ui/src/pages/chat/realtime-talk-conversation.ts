// Control UI chat module implements realtime talk conversation behavior.
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { RealtimeTalkTranscript } from "./realtime-talk-shared.ts";

type RealtimeTalkConversationRole = "user" | "assistant";

export type RealtimeTalkConversationEntry = {
  id: string;
  role: RealtimeTalkConversationRole;
  text: string;
  isStreaming: boolean;
  order?: number;
};

export type RealtimeTalkConversationState = {
  entries: RealtimeTalkConversationEntry[];
  nextEntryId: number;
  userEntryId: string | null;
  userEntryAwaitingFinal: boolean;
  userEntryAwaitingFinalStartedAtMs: number | null;
  assistantEntryId: string | null;
};

type RealtimeTalkTranscriptUpdate = RealtimeTalkTranscript & {
  nowMs?: number;
};

const MAX_CONVERSATION_ENTRIES = 60;
const MAX_CONVERSATION_ENTRY_CHARS = 8_000;
const CONVERSATION_ENTRY_PREFIX_CHARS = 256;
const CONVERSATION_ENTRY_TRUNCATION_MARKER = "\n…\n";
const USER_FINAL_REWRITE_GRACE_MS = 1_500;

export function createRealtimeTalkConversationState(): RealtimeTalkConversationState {
  return {
    entries: [],
    nextEntryId: 1,
    userEntryId: null,
    userEntryAwaitingFinal: false,
    userEntryAwaitingFinalStartedAtMs: null,
    assistantEntryId: null,
  };
}

export function updateRealtimeTalkConversation(
  state: RealtimeTalkConversationState,
  update: RealtimeTalkTranscriptUpdate,
): RealtimeTalkConversationState {
  const text = update.text;
  if (update.final ? text.trim() === "" : text === "") {
    return state;
  }
  if (update.itemId !== undefined) {
    const id = `item-${update.itemId}`;
    const previous = state.entries.find((entry) => entry.id === id);
    const entry = {
      id,
      role: update.role,
      order: update.order,
      text: boundRealtimeConversationText(update.final ? text : (previous?.text ?? "") + text),
      isStreaming: !update.final,
    };
    // Provider identities survive delayed ASR and overlapping responses. Text and
    // wall-clock proximity cannot identify which utterance a final replaces.
    return orderRealtimeTalkConversation({
      ...state,
      entries: [...state.entries.filter((candidate) => candidate.id !== id), entry],
    });
  }
  const nowMs = update.nowMs ?? Date.now();
  if (update.role === "assistant") {
    const preparedState = finishRealtimeConversationEntry(state, "user", nowMs);
    return upsertRealtimeConversationEntry(
      preparedState,
      update.role,
      preparedState.assistantEntryId,
      text,
      update.final,
      nowMs,
    );
  }
  const entryId = state.userEntryId;
  const shouldStartNewUserEntry =
    entryId !== null && shouldStartNewRealtimeUserEntry(state, entryId, text, update.final, nowMs);
  const assistantClosedState =
    entryId === null || shouldStartNewUserEntry
      ? finishRealtimeConversationEntry(state, "assistant", nowMs)
      : state;
  const nextState =
    shouldStartNewUserEntry && entryId !== null
      ? {
          ...finishRealtimeConversationEntry(assistantClosedState, "user", nowMs),
          userEntryId: null,
          userEntryAwaitingFinal: false,
          userEntryAwaitingFinalStartedAtMs: null,
        }
      : assistantClosedState;
  return upsertRealtimeConversationEntry(
    nextState,
    update.role,
    shouldStartNewUserEntry ? null : entryId,
    text,
    update.final,
    nowMs,
  );
}

export function orderRealtimeTalkConversation(
  state: RealtimeTalkConversationState,
  orders: ReadonlyArray<{ itemId: string; order: number }> = [],
): RealtimeTalkConversationState {
  const byId = new Map(orders.map(({ itemId, order }) => [`item-${itemId}`, order]));
  return {
    ...state,
    entries: state.entries
      .map((entry) => (byId.has(entry.id) ? { ...entry, order: byId.get(entry.id) } : entry))
      .toSorted((left, right) => (left.order ?? Infinity) - (right.order ?? Infinity))
      .slice(-MAX_CONVERSATION_ENTRIES),
  };
}

function upsertRealtimeConversationEntry(
  state: RealtimeTalkConversationState,
  role: RealtimeTalkConversationRole,
  entryId: string | null,
  text: string,
  isFinal: boolean,
  nowMs: number,
): RealtimeTalkConversationState {
  if (entryId === null) {
    const id = `rt-${state.nextEntryId}`;
    const entries = [
      ...state.entries,
      {
        id,
        role,
        text: boundRealtimeConversationText(text.trimStart()),
        isStreaming: !isFinal,
      },
    ].slice(-MAX_CONVERSATION_ENTRIES);
    return rememberRealtimeConversationEntry(
      { ...state, entries, nextEntryId: state.nextEntryId + 1 },
      role,
      id,
      isFinal,
      nowMs,
    );
  }

  const targetIndex = state.entries.findIndex((entry) => entry.id === entryId);
  if (targetIndex === -1) {
    return upsertRealtimeConversationEntry(state, role, null, text, isFinal, nowMs);
  }
  const entry = state.entries[targetIndex];
  if (!entry) {
    return upsertRealtimeConversationEntry(state, role, null, text, isFinal, nowMs);
  }
  const mergedText =
    role === "assistant"
      ? mergeAssistantTranscriptText(entry.text, text, isFinal)
      : mergeRealtimeTranscriptText(entry.text, text, isFinal);
  const updatedText = boundRealtimeConversationText(mergedText);
  const entries =
    entry.text === updatedText && entry.isStreaming === !isFinal
      ? state.entries
      : state.entries.map((candidate, index) =>
          index === targetIndex
            ? { ...candidate, text: updatedText, isStreaming: !isFinal }
            : candidate,
        );
  return rememberRealtimeConversationEntry({ ...state, entries }, role, entryId, isFinal, nowMs);
}

function rememberRealtimeConversationEntry(
  state: RealtimeTalkConversationState,
  role: RealtimeTalkConversationRole,
  entryId: string,
  isFinal: boolean,
  _nowMs: number,
): RealtimeTalkConversationState {
  if (role === "user") {
    return {
      ...state,
      userEntryId: isFinal ? null : entryId,
      userEntryAwaitingFinal: false,
      userEntryAwaitingFinalStartedAtMs: null,
    };
  }
  return { ...state, assistantEntryId: isFinal ? null : entryId };
}

function finishRealtimeConversationEntry(
  state: RealtimeTalkConversationState,
  role: RealtimeTalkConversationRole,
  nowMs: number = Date.now(),
): RealtimeTalkConversationState {
  const entryId = role === "user" ? state.userEntryId : state.assistantEntryId;
  if (entryId === null) {
    return state;
  }
  const entries = state.entries.map((entry) =>
    entry.id === entryId && entry.isStreaming ? { ...entry, isStreaming: false } : entry,
  );
  if (role === "user") {
    return {
      ...state,
      entries,
      userEntryAwaitingFinal: true,
      userEntryAwaitingFinalStartedAtMs: nowMs,
    };
  }
  return { ...state, entries, assistantEntryId: null };
}

function shouldStartNewRealtimeUserEntry(
  state: RealtimeTalkConversationState,
  entryId: string,
  incoming: string,
  isFinal: boolean,
  nowMs: number,
): boolean {
  const entry = state.entries.find((candidate) => candidate.id === entryId);
  if (!entry || entry.isStreaming) {
    return false;
  }
  const existing = entry.text;
  if (existing.trim() === "" || incoming.trim() === "") {
    return false;
  }
  if (incoming[0] && /\s/.test(incoming[0])) {
    return false;
  }
  if (incoming === existing || incoming.startsWith(existing) || existing.endsWith(incoming)) {
    return false;
  }
  if (isFinal && state.userEntryAwaitingFinal) {
    const elapsed =
      state.userEntryAwaitingFinalStartedAtMs === null
        ? Number.POSITIVE_INFINITY
        : nowMs - state.userEntryAwaitingFinalStartedAtMs;
    if (
      elapsed <= USER_FINAL_REWRITE_GRACE_MS &&
      looksLikeTranscriptReplacement(existing, incoming)
    ) {
      return false;
    }
  }
  return true;
}

// Assistant transcripts are verbatim fragment streams: providers concatenate
// deltas into the exact transcript (OpenAI audio-transcript deltas, Google Live
// outputTranscription chunks). Never synthesize characters between fragments —
// the user-side ASR spacing heuristic would mangle "ChatGPT" into "Chat G PT"
// and "Version 1.2" into "Version 1. 2".
function mergeAssistantTranscriptText(
  existing: string,
  incoming: string,
  isFinal: boolean,
): string {
  if (existing.trim() === "") {
    return incoming.trimStart();
  }
  if (!isFinal) {
    return `${existing}${incoming}`;
  }
  // Final shape differs by provider: OpenAI-style finals carry the full
  // transcript (replace), Google Live finals carry only the last fragment
  // (append). Replace only when incoming restates what already streamed.
  if (incoming === existing || incoming.startsWith(existing)) {
    return incoming;
  }
  if (looksLikeTranscriptReplacement(existing, incoming)) {
    return incoming;
  }
  return `${existing}${incoming}`;
}

function mergeRealtimeTranscriptText(existing: string, incoming: string, isFinal: boolean): string {
  if (existing.trim() === "") {
    return incoming.trimStart();
  }
  if (incoming === "") {
    return existing;
  }
  if (incoming === existing || existing.endsWith(incoming)) {
    return existing;
  }
  if (incoming.startsWith(existing)) {
    return incoming;
  }
  if (incoming[0] && /\s/.test(incoming[0])) {
    return `${existing}${incoming}`;
  }
  if (isFinal && looksLikeTranscriptReplacement(existing, incoming)) {
    return incoming;
  }
  const overlap = findTextOverlap(existing, incoming);
  const suffix = overlap > 0 ? incoming.slice(overlap) : incoming;
  if (suffix === "") {
    return existing;
  }
  const separator = overlap > 0 || !shouldInsertTranscriptSpace(existing, suffix) ? "" : " ";
  return `${existing}${separator}${suffix}`;
}

function boundRealtimeConversationText(text: string): string {
  if (text.length <= MAX_CONVERSATION_ENTRY_CHARS) {
    return text;
  }
  // Keep the opening context for late full-final replacement detection and
  // the newest tail for the visible conversation. Reuse the original prefix
  // so repeated streaming deltas do not move the truncation boundary.
  const markerIndex = text.indexOf(CONVERSATION_ENTRY_TRUNCATION_MARKER);
  const hasBoundedPrefix =
    markerIndex >= CONVERSATION_ENTRY_PREFIX_CHARS - 1 &&
    markerIndex <= CONVERSATION_ENTRY_PREFIX_CHARS;
  const prefixEnd = hasBoundedPrefix ? markerIndex : CONVERSATION_ENTRY_PREFIX_CHARS;
  // A natural marker can follow malformed provider text ending in a lone high
  // surrogate. Keep that code unit out of the retained truncation boundary.
  const prefix = sliceUtf16Safe(text, 0, prefixEnd).replace(/[\uD800-\uDBFF]$/, "");
  const tailChars =
    MAX_CONVERSATION_ENTRY_CHARS - prefix.length - CONVERSATION_ENTRY_TRUNCATION_MARKER.length;
  const tail = sliceUtf16Safe(text, -tailChars);
  return `${prefix}${CONVERSATION_ENTRY_TRUNCATION_MARKER}${tail}`;
}

function looksLikeTranscriptReplacement(existing: string, incoming: string): boolean {
  const existingWords = transcriptWords(existing);
  const incomingWords = transcriptWords(incoming);
  if (existingWords.length === 0 || incomingWords.length === 0) {
    return false;
  }
  if (existingWords[0] !== incomingWords[0]) {
    return false;
  }
  if (
    existingWords.length > 1 &&
    incomingWords.length > 1 &&
    existingWords[1] === incomingWords[1]
  ) {
    return true;
  }
  const existingText = normalizeTranscriptText(existing);
  const incomingText = normalizeTranscriptText(incoming);
  const commonPrefix = commonPrefixLength(existingText, incomingText);
  const shortest = Math.min(existingText.length, incomingText.length);
  return commonPrefix >= 6 && commonPrefix / Math.max(1, shortest) >= 0.45;
}

function transcriptWords(value: string): string[] {
  return [...value.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)].map((match) => match[0]);
}

function normalizeTranscriptText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function commonPrefixLength(left: string, right: string): number {
  const max = Math.min(left.length, right.length);
  let index = 0;
  while (index < max && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function findTextOverlap(base: string, next: string): number {
  const normalizedBase = base.toLowerCase();
  const normalizedNext = next.toLowerCase();
  const max = Math.min(normalizedBase.length, normalizedNext.length);
  for (let length = max; length >= 3; length -= 1) {
    if (normalizedBase.endsWith(normalizedNext.slice(0, length))) {
      return length;
    }
  }
  return 0;
}

function shouldInsertTranscriptSpace(base: string, next: string): boolean {
  const last = base.at(-1);
  const first = next[0];
  if (!last || !first || /\s/.test(last) || /\s/.test(first)) {
    return false;
  }
  return /[\p{L}\p{N}.!?,:;)\]}"'’”]/u.test(last) && /[\p{L}\p{N}]/u.test(first);
}
