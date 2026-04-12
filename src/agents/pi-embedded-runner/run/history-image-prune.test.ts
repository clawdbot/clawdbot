import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { castAgentMessage } from "../../test-helpers/agent-message-fixtures.js";
import { PRUNED_HISTORY_IMAGE_MARKER, pruneProcessedHistoryImages } from "./history-image-prune.js";

function expectArrayMessageContent(
  message: AgentMessage | undefined,
  errorMessage: string,
): Array<{ type: string; text?: string; data?: string }> {
  if (!message || !("content" in message) || !Array.isArray(message.content)) {
    throw new Error(errorMessage);
  }
  return message.content as Array<{ type: string; text?: string; data?: string }>;
}

function expectPrunedImageMessage(
  messages: AgentMessage[],
  errorMessage: string,
): Array<{ type: string; text?: string; data?: string }> {
  const didMutate = pruneProcessedHistoryImages(messages);
  expect(didMutate).toBe(true);
  const content = expectArrayMessageContent(messages[0], errorMessage);
  expect(content).toHaveLength(2);
  expect(content[1]).toMatchObject({ type: "text", text: PRUNED_HISTORY_IMAGE_MARKER });
  return content;
}

function expectImageMessagePreserved(messages: AgentMessage[], errorMessage: string) {
  const didMutate = pruneProcessedHistoryImages(messages);

  expect(didMutate).toBe(false);
  const content = expectArrayMessageContent(messages[0], errorMessage);
  expect(content[1]).toMatchObject({ type: "image", data: "abc" });
}

describe("pruneProcessedHistoryImages", () => {
  const image: ImageContent = { type: "image", data: "abc", mimeType: "image/png" };
  const assistantTurn = () => castAgentMessage({ role: "assistant", content: "ack" });
  const userText = () => castAgentMessage({ role: "user", content: "more" });

  it("prunes image blocks from user messages older than 3 assistant turns", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "user",
        content: [{ type: "text", text: "See /tmp/photo.png" }, { ...image }],
      }),
      assistantTurn(),
      userText(),
      assistantTurn(),
      userText(),
      assistantTurn(),
      userText(),
      assistantTurn(),
    ];

    const content = expectPrunedImageMessage(messages, "expected user array content");
    expect(content[0]?.type).toBe("text");
  });

  it("keeps image blocks that belong to the third-most-recent assistant turn", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "user",
        content: [{ type: "text", text: "See /tmp/photo.png" }, { ...image }],
      }),
      assistantTurn(),
      userText(),
      assistantTurn(),
      userText(),
      assistantTurn(),
    ];

    expectImageMessagePreserved(messages, "expected user array content");
  });

  it("does not count multiple assistant messages from one tool loop as separate turns", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "user",
        content: [{ type: "text", text: "See /tmp/photo.png" }, { ...image }],
      }),
      castAgentMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      } as AgentMessage),
      castAgentMessage({
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "bytes" }],
      }),
      assistantTurn(),
      userText(),
      assistantTurn(),
      userText(),
      assistantTurn(),
    ];

    expectImageMessagePreserved(messages, "expected user array content");
  });

  it("does not prune latest user message when no assistant response exists yet", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "user",
        content: [{ type: "text", text: "See /tmp/photo.png" }, { ...image }],
      }),
    ];

    const didMutate = pruneProcessedHistoryImages(messages);

    expect(didMutate).toBe(false);
    const content = expectArrayMessageContent(messages[0], "expected user array content");
    expect(content).toHaveLength(2);
    expect(content[1]).toMatchObject({ type: "image", data: "abc" });
  });

  it("prunes image blocks from toolResult messages older than 3 assistant turns", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "toolResult",
        toolName: "read",
        content: [{ type: "text", text: "screenshot bytes" }, { ...image }],
      }),
      assistantTurn(),
      userText(),
      assistantTurn(),
      userText(),
      assistantTurn(),
      userText(),
      assistantTurn(),
    ];

    expectPrunedImageMessage(messages, "expected toolResult array content");
  });

  it("prunes only old images while preserving recent ones", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "user",
        content: [{ type: "text", text: "old" }, { ...image }],
      }),
      assistantTurn(),
      userText(),
      assistantTurn(),
      userText(),
      assistantTurn(),
      castAgentMessage({
        role: "user",
        content: [{ type: "text", text: "recent" }, { ...image }],
      }),
      assistantTurn(),
    ];

    const didMutate = pruneProcessedHistoryImages(messages);
    expect(didMutate).toBe(true);

    const oldContent = expectArrayMessageContent(messages[0], "expected old user content");
    expect(oldContent[1]).toMatchObject({ type: "text", text: PRUNED_HISTORY_IMAGE_MARKER });

    const recentContent = expectArrayMessageContent(messages[6], "expected recent user content");
    expect(recentContent[1]).toMatchObject({ type: "image", data: "abc" });
  });

  it("does not change messages when no assistant turn exists", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "user",
        content: "noop",
      }),
    ];

    const didMutate = pruneProcessedHistoryImages(messages);

    expect(didMutate).toBe(false);
    const firstUser = messages[0] as Extract<AgentMessage, { role: "user" }> | undefined;
    expect(firstUser?.content).toBe("noop");
  });
});
