import {
  BedrockRuntimeClient,
  ConversationRole,
  StopReason as BedrockStopReason,
} from "@aws-sdk/client-bedrock-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimpleBedrock } from "./stream.runtime.js";

const model = {
  api: "bedrock-converse-stream",
  provider: "amazon-bedrock",
  id: "amazon.nova-micro-v1:0",
  name: "Nova Micro",
  baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
} as const;

async function* events(items: unknown[]) {
  yield* items;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Bedrock provider-owned stream lifecycle", () => {
  it.each([
    {
      label: "text",
      blocks: [{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "ready" } } }],
      endEvent: "text_end",
      stopReason: BedrockStopReason.END_TURN,
    },
    {
      label: "thinking",
      blocks: [
        {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { reasoningContent: { text: "considered" } },
          },
        },
      ],
      endEvent: "thinking_end",
      stopReason: BedrockStopReason.END_TURN,
    },
    {
      label: "redacted thinking",
      blocks: [
        {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { reasoningContent: { redactedContent: new Uint8Array([1, 2, 3]) } },
          },
        },
      ],
      endEvent: "thinking_end",
      stopReason: BedrockStopReason.END_TURN,
    },
    {
      label: "tool call",
      blocks: [
        {
          contentBlockStart: {
            contentBlockIndex: 0,
            start: { toolUse: { toolUseId: "call_lookup", name: "lookup" } },
          },
        },
        {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { toolUse: { input: '{"query":"ready"}' } },
          },
        },
      ],
      endEvent: "toolcall_end",
      stopReason: BedrockStopReason.TOOL_USE,
    },
  ])("finalizes the active $label block at the provider terminal boundary", async (scenario) => {
    vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
      $metadata: { httpStatusCode: 200 },
      stream: events([
        { messageStart: { role: ConversationRole.ASSISTANT } },
        ...scenario.blocks,
        { messageStop: { stopReason: scenario.stopReason } },
      ]),
    } as never);

    const stream = streamSimpleBedrock(model as never, {
      messages: [{ role: "user", content: "Continue", timestamp: 0 }],
    });
    const observed = [];
    for await (const event of stream) {
      observed.push(event.type);
    }
    const output = await stream.result();

    expect(observed.at(-2)).toBe(scenario.endEvent);
    expect(observed.at(-1)).toBe("done");
    expect(output.content[0]).not.toHaveProperty("index");
    expect(output.content[0]).not.toHaveProperty("partialJson");
    if (scenario.label === "redacted thinking") {
      expect(output.content[0]).toMatchObject({ redacted: true, thinkingSignature: "AQID" });
    }
  });

  it("resolves the full tool-call arguments for a large, multi-chunk streamed argument", async () => {
    // Regression test: re-parsing the whole accumulated buffer on every single
    // delta made large tool-call arguments (e.g. a multi-KB document body)
    // O(n^2) in argument size. The incremental, time-bounded preview (see
    // packages/ai/src/utils/json-parse.ts) fixes the per-delta cost, but
    // `handleContentBlockStop` must still force one final, unthrottled
    // resolution from the complete buffer - not a stale/partial preview and
    // not an empty `{}`.
    const longContent = "lorem ipsum dolor sit amet ".repeat(2000); // ~54KB of content
    const expectedArguments = { filename: "report.docx", content: longContent };
    const fullArgsJson = JSON.stringify(expectedArguments);

    // Split into many small deltas, matching real provider streaming.
    const chunkSize = 40;
    const deltaEvents = [];
    for (let i = 0; i < fullArgsJson.length; i += chunkSize) {
      deltaEvents.push({
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { toolUse: { input: fullArgsJson.slice(i, i + chunkSize) } },
        },
      });
    }

    vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
      $metadata: { httpStatusCode: 200 },
      stream: events([
        { messageStart: { role: ConversationRole.ASSISTANT } },
        {
          contentBlockStart: {
            contentBlockIndex: 0,
            start: { toolUse: { toolUseId: "call_write", name: "write_file" } },
          },
        },
        ...deltaEvents,
        { messageStop: { stopReason: BedrockStopReason.TOOL_USE } },
      ]),
    } as never);

    const stream = streamSimpleBedrock(model as never, {
      messages: [{ role: "user", content: "Write the report", timestamp: 0 }],
    });
    const drainedEventTypes: string[] = [];
    for await (const event of stream) {
      drainedEventTypes.push(event.type);
    }
    const output = await stream.result();

    expect(output.content[0]).toMatchObject({
      type: "toolCall",
      arguments: expectedArguments,
    });
    expect(output.content[0]).not.toHaveProperty("partialJson");
    expect(output.content[0]).not.toHaveProperty("jsonPreview");
  });
});
