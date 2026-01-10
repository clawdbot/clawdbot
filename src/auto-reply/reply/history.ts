import { CURRENT_MESSAGE_MARKER } from "./mentions.js";

export const HISTORY_CONTEXT_MARKER =
  "[Chat messages since your last reply - for context]";
export const DEFAULT_GROUP_HISTORY_LIMIT = 50;

export type HistoryEntry = {
  sender: string;
  body: string;
  timestamp?: number;
  messageId?: string;
};

export function buildHistoryContext(params: {
  historyText: string;
  currentMessage: string;
  lineBreak?: string;
}): string {
  const { historyText, currentMessage } = params;
  const lineBreak = params.lineBreak ?? "\n";
  if (!historyText.trim()) return currentMessage;
  return [
    HISTORY_CONTEXT_MARKER,
    historyText,
    "",
    CURRENT_MESSAGE_MARKER,
    currentMessage,
  ].join(lineBreak);
}

export function appendHistoryEntry(params: {
  historyMap: Map<string, HistoryEntry[]>;
  historyKey: string;
  entry: HistoryEntry;
  limit: number;
}): HistoryEntry[] {
  const { historyMap, historyKey, entry } = params;
  if (params.limit <= 0) return [];
  const history = historyMap.get(historyKey) ?? [];
  history.push(entry);
  while (history.length > params.limit) history.shift();
  historyMap.set(historyKey, history);
  return history;
}

export function buildHistoryContextFromMap(params: {
  historyMap: Map<string, HistoryEntry[]>;
  historyKey: string;
  limit: number;
  entry?: HistoryEntry;
  currentMessage: string;
  formatEntry: (entry: HistoryEntry) => string;
  lineBreak?: string;
  excludeLast?: boolean;
}): string {
  if (params.limit <= 0) return params.currentMessage;
  const entries = params.entry
    ? appendHistoryEntry({
        historyMap: params.historyMap,
        historyKey: params.historyKey,
        entry: params.entry,
        limit: params.limit,
      })
    : (params.historyMap.get(params.historyKey) ?? []);
  return buildHistoryContextFromEntries({
    entries,
    currentMessage: params.currentMessage,
    formatEntry: params.formatEntry,
    lineBreak: params.lineBreak,
    excludeLast: params.excludeLast,
  });
}

export function clearHistoryEntries(params: {
  historyMap: Map<string, HistoryEntry[]>;
  historyKey: string;
}): void {
  params.historyMap.set(params.historyKey, []);
}

export function buildHistoryContextFromEntries(params: {
  entries: HistoryEntry[];
  currentMessage: string;
  formatEntry: (entry: HistoryEntry) => string;
  lineBreak?: string;
  excludeLast?: boolean;
}): string {
  const lineBreak = params.lineBreak ?? "\n";
  const entries =
    params.excludeLast === false ? params.entries : params.entries.slice(0, -1);
  if (entries.length === 0) return params.currentMessage;
  const historyText = entries.map(params.formatEntry).join(lineBreak);
  return buildHistoryContext({
    historyText,
    currentMessage: params.currentMessage,
    lineBreak,
  });
}
