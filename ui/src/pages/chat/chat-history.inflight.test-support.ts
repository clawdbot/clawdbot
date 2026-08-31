import { vi } from "vitest";
import type { ChatHistoryResult, ChatState } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import type { handleAgentEvent, ToolStreamEntry } from "./tool-stream.ts";

export type TestState = ChatState & Parameters<typeof handleAgentEvent>[0];
type TestSessions = NonNullable<ChatState["sessions"]> &
  Parameters<typeof handleAgentEvent>[0]["sessions"];

export function createState(result: ChatHistoryResult): TestState {
  const host = makeChatHost({
    requestHandlers: { "chat.history": result },
    sessionKey: "main",
  });
  const sessions: TestSessions = {
    refreshReplacement: vi.fn(async () => undefined),
    reconcileRunTerminal: vi.fn(),
  };
  return {
    ...host,
    chatToolMessages: host.chatToolMessages ?? [],
    chatStreamSegments: host.chatStreamSegments ?? [],
    connectionEpoch: 1,
    chatThinkingLevel: null,
    chatVerboseLevel: null,
    chatStreamStartedAt: null,
    sessions,
    toolStreamById: host.toolStreamById ?? new Map<string, ToolStreamEntry>(),
    toolStreamOrder: host.toolStreamOrder ?? [],
    toolStreamSyncTimer: host.toolStreamSyncTimer ?? null,
    requestUpdate: vi.fn(),
  };
}

export function activeHistory(runId: string): ChatHistoryResult {
  return {
    messages: [],
    sessionInfo: {
      key: "main",
      kind: "direct",
      updatedAt: 1,
      hasActiveRun: true,
      activeRunIds: [runId],
      status: "running",
    },
    inFlightRun: { runId, text: "" },
  };
}
