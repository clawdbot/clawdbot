import { describe, expect, it } from "vitest";
import { transformMessages } from "./transcript-transform.js";
import type { AssistantMessage, Model } from "./types.js";

const model: Model<"openai-responses"> = {
  id: "test-model",
  name: "Test model",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://proxy.example/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
};

const otherModel: Model<"openai-responses"> = { ...model, id: "other-model" };

const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// Persisted session history can carry assistant blocks outside the declared
// content union: the gateway's managed-media path appends `attachment` /
// `attachment_error` display blocks to the assistant message it stores.
const attachmentBlock = {
  type: "attachment",
  attachment: {
    artifactId: "artifact_managed_media_00000000-0000-4000-8000-000000000001",
    url: "/api/chat/media/outgoing/session/00000000-0000-4000-8000-000000000001/full",
    kind: "document",
    label: "report.pdf",
  },
} as unknown as AssistantMessage["content"][number];

function assistantWith(content: AssistantMessage["content"], modelId = model.id): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: modelId,
    content,
    usage: emptyUsage,
    stopReason: "stop",
    timestamp: 2,
  };
}

describe("transformMessages assistant content outside the declared union", () => {
  it("passes an attachment block through instead of throwing on block.id.trim()", () => {
    const assistant = assistantWith([{ type: "text", text: "Here is the file." }, attachmentBlock]);
    const messages = [{ role: "user" as const, content: "hello", timestamp: 1 }, assistant];

    const result = transformMessages(messages, model);

    expect(result).toHaveLength(2);
    const transformed = result[1] as AssistantMessage;
    expect(transformed.content).toEqual([
      { type: "text", text: "Here is the file." },
      attachmentBlock,
    ]);
  });

  it("keeps passing the block through when replaying for a different model", () => {
    const assistant = assistantWith([{ type: "text", text: "Here is the file." }, attachmentBlock]);
    const messages = [{ role: "user" as const, content: "hello", timestamp: 1 }, assistant];

    const result = transformMessages(messages, otherModel, (id) => `norm-${id}`);

    const transformed = result[1] as AssistantMessage;
    expect(transformed.content).toContainEqual(attachmentBlock);
  });

  it("still trims and pairs real tool call ids around the foreign block", () => {
    const assistant = assistantWith([
      attachmentBlock,
      { type: "toolCall", id: " call_1 ", name: "read", arguments: {} },
    ]);
    const messages = [
      { role: "user" as const, content: "hello", timestamp: 1 },
      assistant,
      {
        role: "toolResult" as const,
        toolCallId: " call_1 ",
        toolName: "read",
        content: [{ type: "text" as const, text: "ok" }],
        isError: false,
        timestamp: 3,
      },
    ];

    const result = transformMessages(messages, model);

    const transformed = result[1] as AssistantMessage;
    expect(transformed.content).toContainEqual({
      type: "toolCall",
      id: "call_1",
      name: "read",
      arguments: {},
    });
    expect(result[2]).toMatchObject({ role: "toolResult", toolCallId: "call_1" });
  });
});
