import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import type { normalizeSessionDeliveryState } from "openclaw/plugin-sdk/session-store-runtime";

export type TestSessionEntry = {
  sessionId: string;
  updatedAt: number;
  sessionFile: string;
  chatType?: "direct" | "group" | "channel";
  delivery?: ReturnType<typeof normalizeSessionDeliveryState>;
  origin?: { chatType?: "direct" | "group" | "channel" };
};

export function sessionEntry(
  sessionId: string,
  updatedAt: number,
  sessionFile: string,
  metadata?: Pick<TestSessionEntry, "chatType" | "delivery" | "origin">,
): TestSessionEntry {
  return { sessionId, updatedAt, sessionFile, ...metadata };
}

export function searchHit(
  path: string,
  source: MemorySearchResult["source"],
  snippet: string,
  details?: Partial<Pick<MemorySearchResult, "score" | "startLine" | "endLine">>,
): MemorySearchResult {
  return { path, source, score: 1, snippet, startLine: 1, endLine: 2, ...details };
}
