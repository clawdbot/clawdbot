import { vi } from "vitest";
import { extractText } from "../../lib/chat/message-extract.ts";
import type { ChatHistoryResult, ChatState } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import type { reconcileChatRunLifecycle } from "./run-lifecycle.ts";
import type { handleAgentEvent, ToolStreamEntry } from "./tool-stream.ts";

export type TestState = ChatState &
  Parameters<typeof handleAgentEvent>[0] &
  Parameters<typeof reconcileChatRunLifecycle>[0];
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

export function renderedText(state: TestState) {
  return buildChatItems({
    paneId: "steer-regression",
    sessionKey: state.sessionKey,
    runId: state.chatRunId,
    messages: state.chatMessages,
    toolMessages: state.chatToolMessages,
    streamSegments: state.chatStreamSegments,
    stream: state.chatStream,
    streamStartedAt: state.chatStreamStartedAt,
    showToolCalls: true,
  }).flatMap((item) =>
    item.kind === "group"
      ? item.messages.map(({ message }) => extractText(message)?.trim())
      : item.kind === "stream"
        ? [item.text.trim()]
        : [],
  );
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
