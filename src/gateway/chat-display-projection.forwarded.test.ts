import { describe, expect, it } from "vitest";
import { annotateInterSessionPromptText } from "../sessions/input-provenance.js";
import { projectChatDisplayMessages } from "./chat-display-projection.js";
import {
  CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
  replaceOversizedChatHistoryMessages,
} from "./server-methods/chat-history-budget.js";
import { buildSessionHistorySnapshot } from "./session-history-state.js";

function projectHistoryTransports(message: Record<string, unknown>) {
  const websocket = replaceOversizedChatHistoryMessages({
    messages: projectChatDisplayMessages([message]),
    maxSingleMessageBytes: CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
  }).messages;
  const sse = buildSessionHistorySnapshot({ rawMessages: [message], limit: 5 }).history.messages;
  return [websocket, sse];
}

describe("forwarded session attribution", () => {
  it.each([
    {
      name: "structured provenance before prompt metadata",
      sourceSessionKey: "agent:main:main",
      promptSessionKey: "agent:other:main",
      senderSession: { sessionKey: "agent:main:main", agentId: "main" },
      senderLabel: "Forwarded from main",
    },
    {
      name: "prompt metadata when provenance lacks the source key",
      sourceSessionKey: undefined,
      promptSessionKey: "agent:helper:dashboard:source",
      senderSession: { sessionKey: "agent:helper:dashboard:source", agentId: "helper" },
      senderLabel: "Forwarded from helper",
    },
    {
      name: "a session key without a parseable agent",
      sourceSessionKey: "legacy-session",
      promptSessionKey: undefined,
      senderSession: { sessionKey: "legacy-session" },
      senderLabel: "Forwarded agent message",
    },
    {
      name: "no source metadata",
      sourceSessionKey: undefined,
      promptSessionKey: undefined,
      senderSession: undefined,
      senderLabel: "Forwarded agent message",
    },
  ])("preserves $name across history transports", (testCase) => {
    const provenance = {
      kind: "inter_session" as const,
      sourceTool: "sessions_send",
      ...(testCase.sourceSessionKey ? { sourceSessionKey: testCase.sourceSessionKey } : {}),
    };
    const message = {
      role: "user",
      provenance,
      content: annotateInterSessionPromptText("Forwarded status update", {
        kind: "inter_session",
        sourceTool: "sessions_send",
        sourceSessionKey: testCase.promptSessionKey,
      }),
    };

    for (const messages of projectHistoryTransports(message)) {
      expect(messages).toStrictEqual([
        {
          role: "assistant",
          provenance,
          content: "Forwarded status update",
          senderLabel: testCase.senderLabel,
          ...(testCase.senderSession ? { senderSession: testCase.senderSession } : {}),
        },
      ]);
    }
  });
});
