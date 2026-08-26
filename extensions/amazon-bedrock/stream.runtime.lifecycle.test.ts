import {
  BedrockRuntimeClient,
  ConversationRole,
  StopReason as BedrockStopReason,
} from "@aws-sdk/client-bedrock-runtime";
import { withProviderAcceptanceObserver } from "openclaw/plugin-sdk/provider-transport-runtime";
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

function streamBedrockForTest(options: Parameters<typeof streamSimpleBedrock>[2] = {}) {
  return streamSimpleBedrock(
    model as never,
    { messages: [{ role: "user", content: "Hello", timestamp: 0 }] } as never,
    options,
  );
}

function expectDestroyedClient(
  send: ReturnType<typeof vi.spyOn>,
  destroy: ReturnType<typeof vi.spyOn>,
) {
  expect(send).toHaveBeenCalledOnce();
  expect(destroy).toHaveBeenCalledOnce();
  expect(destroy.mock.contexts[0]).toBe(send.mock.contexts[0]);
  expect(destroy.mock.invocationCallOrder[0]).toBeGreaterThan(
    send.mock.invocationCallOrder[0] ?? 0,
  );
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
        { contentBlockStop: { contentBlockIndex: 0 } },
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
});

describe("Bedrock stream client lifecycle", () => {
  it("destroys the client after a successful stream", async () => {
    let markStreamBlocked!: () => void;
    const streamBlocked = new Promise<void>((resolve) => {
      markStreamBlocked = resolve;
    });
    let releaseStream!: () => void;
    const streamReleased = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    async function* successfulStream() {
      yield { messageStart: { role: ConversationRole.ASSISTANT } };
      markStreamBlocked();
      await streamReleased;
      yield { messageStop: { stopReason: BedrockStopReason.END_TURN } };
    }
    const send = vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
      $metadata: { httpStatusCode: 200, requestId: "bedrock-request-1" },
      stream: successfulStream(),
    } as never);
    const destroy = vi.spyOn(BedrockRuntimeClient.prototype, "destroy");
    const acceptanceObserver = vi.fn();
    const onResponse = vi.fn();
    const options = withProviderAcceptanceObserver({ onResponse }, acceptanceObserver);

    const resultPromise = streamBedrockForTest(options).result();
    await streamBlocked;
    expect(destroy).not.toHaveBeenCalled();

    releaseStream();
    const result = await resultPromise;

    expect(result.stopReason).toBe("stop");
    expect(acceptanceObserver).toHaveBeenCalledWith({
      kind: "http_response",
      status: 200,
      headers: { "x-amzn-requestid": "bedrock-request-1" },
    });
    expect(onResponse).toHaveBeenCalledWith(
      { status: 200, headers: { "x-amzn-requestid": "bedrock-request-1" } },
      expect.objectContaining({ provider: "amazon-bedrock" }),
    );
    expectDestroyedClient(send, destroy);
  });

  it("cancels an unread stream when provider acceptance fails", async () => {
    const close = vi.fn(async () => ({ done: true as const, value: undefined }));
    const responseIterator = {
      next: vi.fn(() => new Promise<IteratorResult<never>>(() => {})),
      return: close,
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    const send = vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
      $metadata: { httpStatusCode: 200 },
      stream: responseIterator,
    } as never);
    const destroy = vi.spyOn(BedrockRuntimeClient.prototype, "destroy");
    const hookError = new Error("acceptance observer failed");
    const options = withProviderAcceptanceObserver({}, () => {
      throw hookError;
    });

    const result = await streamBedrockForTest(options).result();

    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "acceptance observer failed",
    });
    expect(close).toHaveBeenCalledOnce();
    expectDestroyedClient(send, destroy);
  });

  it("destroys the client after a provider error", async () => {
    const send = vi
      .spyOn(BedrockRuntimeClient.prototype, "send")
      .mockRejectedValue(new Error("synthetic provider failure"));
    const destroy = vi.spyOn(BedrockRuntimeClient.prototype, "destroy");

    const result = await streamBedrockForTest().result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("synthetic provider failure");
    expectDestroyedClient(send, destroy);
  });

  it("destroys the client when response stream iteration fails", async () => {
    async function* failingStream() {
      yield { messageStart: { role: ConversationRole.ASSISTANT } };
      throw new Error("synthetic iterator failure");
    }
    const send = vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
      $metadata: { httpStatusCode: 200 },
      stream: failingStream(),
    } as never);
    const destroy = vi.spyOn(BedrockRuntimeClient.prototype, "destroy");

    const result = await streamBedrockForTest().result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("synthetic iterator failure");
    expectDestroyedClient(send, destroy);
  });

  it("destroys the client after an aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    const send = vi
      .spyOn(BedrockRuntimeClient.prototype, "send")
      .mockRejectedValue(new Error("synthetic abort"));
    const destroy = vi.spyOn(BedrockRuntimeClient.prototype, "destroy");

    const result = await streamBedrockForTest({ signal: controller.signal }).result();

    expect(result.stopReason).toBe("aborted");
    expect(result.errorMessage).toBe("synthetic abort");
    expectDestroyedClient(send, destroy);
  });
});
