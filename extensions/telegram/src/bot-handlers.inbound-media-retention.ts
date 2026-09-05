import type { BufferedMediaGroupEntry } from "./bot-handlers.inbound-media.types.js";

export function pauseTelegramMediaGroupRetention(
  entries: readonly BufferedMediaGroupEntry[],
): void {
  for (const entry of entries) {
    if (!entry.timer) {
      continue;
    }
    clearTimeout(entry.timer);
    entry.timer = undefined;
  }
}

export function finalizeTelegramMediaGroupAfterProcessing(
  entry: BufferedMediaGroupEntry,
  finalizeEntry: (entry: BufferedMediaGroupEntry) => void,
): void {
  const finalize = () => finalizeEntry(entry);
  if (entry.processing) {
    void entry.processing.then(finalize, finalize);
  } else {
    finalize();
  }
}

export function resumeTelegramMediaGroupAfterDeniedIgnore(params: {
  entries: readonly BufferedMediaGroupEntry[];
  finalizeEntry: (entry: BufferedMediaGroupEntry) => void;
  requestFlush: (entry: BufferedMediaGroupEntry) => void;
  nowMs?: number;
}): void {
  const nowMs = params.nowMs ?? Date.now();
  for (const entry of params.entries) {
    if (entry.cancelled) {
      continue;
    }
    if (entry.phase === "buffered") {
      if (entry.flushRequested || entry.flushDueAt <= nowMs) {
        params.requestFlush(entry);
      } else {
        entry.timer = setTimeout(() => params.requestFlush(entry), entry.flushDueAt - nowMs);
      }
      continue;
    }
    if (entry.phase !== "in-flight" || entry.dispatchAdmission !== "admitted" || entry.processing) {
      continue;
    }
    const remainingMs = (entry.retentionDueAt ?? nowMs) - nowMs;
    if (remainingMs <= 0) {
      params.finalizeEntry(entry);
    } else {
      entry.timer = setTimeout(() => params.finalizeEntry(entry), remainingMs);
    }
  }
}
