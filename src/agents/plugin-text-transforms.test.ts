// Verifies plugin text transforms rewrite prompts and streamed assistant output.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type ToolCall,
} from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import {
  applyPluginTextReplacements,
  mergePluginTextTransforms,
  wrapStreamFnTextTransforms,
} from "./plugin-text-transforms.js";

const model = {
  api: "openai-responses",
  provider: "test",
  id: "test-model",
} as Model<"openai-responses">;

function makeAssistantMessage(text: string): AssistantMessage {
  // Output transform tests need a complete assistant message with visible text.
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    api: "openai-responses",
    provider: "test",
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: 0,
  };
}

function makeAssistantToolMessage(toolCall: ToolCall): AssistantMessage {
  return {
    ...makeAssistantMessage(""),
    content: [toolCall],
    stopReason: "toolUse",
  };
}

describe("plugin text transforms", () => {
  it("merges registered transform groups in order", () => {
    const merged = mergePluginTextTransforms(
      { input: [{ from: /red basket/g, to: "blue basket" }] },
      { output: [{ from: /blue basket/g, to: "red basket" }] },
      { input: [{ from: /paper ticket/g, to: "digital ticket" }] },
    );

    expect(merged).toStrictEqual({
      input: [
        { from: /red basket/g, to: "blue basket" },
        { from: /paper ticket/g, to: "digital ticket" },
      ],
      output: [{ from: /blue basket/g, to: "red basket" }],
    });
    expect(applyPluginTextReplacements("red basket paper ticket", merged?.input)).toBe(
      "blue basket digital ticket",
    );
  });

  it("applies ordered string and regexp replacements", () => {
    expect(
      applyPluginTextReplacements("paper ticket on the left shelf", [
        { from: /paper ticket/g, to: "digital ticket" },
        { from: /left shelf/g, to: "right shelf" },
        { from: "digital ticket", to: "counter receipt" },
      ]),
    ).toBe("counter receipt on the right shelf");
  });

  it("rewrites system prompt and message text content before transport", async () => {
    let capturedContext: Context | undefined;
    const wrapped = wrapStreamFnTextTransforms({
      streamFn: (_model, context) => {
        capturedContext = context;
        const stream = createAssistantMessageEventStream();
        stream.end();
        return stream;
      },
      input: [
        {
          from: /orchid mailbox/g,
          to: "pine mailbox",
        },
        { from: /red basket/g, to: "blue basket" },
      ],
    });
    await Promise.resolve(
      wrapped(
        model,
        {
          systemPrompt: "Use orchid mailbox inside north tower",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Please use the red basket" },
                { type: "image", url: "data:image/png;base64,abc" },
              ],
            },
          ],
        } as Context,
        undefined,
      ),
    );

    const context = capturedContext as unknown as {
      systemPrompt: string;
      messages: Array<{ content: unknown[] }>;
    };

    expect(context.systemPrompt).toBe("Use pine mailbox inside north tower");
    const textContent = context.messages[0]?.content[0] as
      | { type?: string; text?: string }
      | undefined;
    expect(textContent?.type).toBe("text");
    expect(textContent?.text).toBe("Please use the blue basket");
    const imageContent = context.messages[0]?.content[1] as
      | { type?: string; url?: string }
      | undefined;
    expect(imageContent?.type).toBe("image");
    expect(imageContent?.url).toBe("data:image/png;base64,abc");
  });

  it("wraps stream functions with inbound and outbound replacements", async () => {
    // The wrapper mutates text-only blocks while preserving non-text content.
    let capturedContext: Context | undefined;
    const baseStreamFn: StreamFn = (_model, context) => {
      capturedContext = context;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const partial = makeAssistantMessage("blue basket on the right shelf");
        stream.push({
          type: "text_delta",
          contentIndex: 0,
          delta: "blue basket on the right shelf",
          partial,
        });
        stream.push({
          type: "done",
          reason: "stop",
          message: makeAssistantMessage("final blue basket on the right shelf"),
        });
        stream.end();
      });
      return stream;
    };

    const wrapped = wrapStreamFnTextTransforms({
      streamFn: baseStreamFn,
      input: [{ from: /red basket/g, to: "blue basket" }],
      output: [
        { from: /blue basket/g, to: "red basket" },
        { from: /right shelf/g, to: "left shelf" },
      ],
      transformSystemPrompt: false,
    });
    const stream = await Promise.resolve(
      wrapped(
        model,
        {
          systemPrompt: "Keep red basket untouched here",
          messages: [{ role: "user", content: "Use red basket" }],
        } as Context,
        undefined,
      ),
    );
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }
    const result = await stream.result();

    expect(capturedContext?.systemPrompt).toBe("Keep red basket untouched here");
    expect(capturedContext?.messages).toEqual([{ role: "user", content: "Use blue basket" }]);
    const firstEvent = events[0] as { type?: string; delta?: string } | undefined;
    expect(firstEvent?.type).toBe("text_delta");
    expect(firstEvent?.delta).toBe("red basket on the left shelf");
    expect(result.content).toEqual([{ type: "text", text: "final red basket on the left shelf" }]);
  });

  it("applies output replacements to structured tool-call arguments", async () => {
    const partialToolCall: ToolCall = {
      type: "toolCall",
      id: "call-1",
      name: "search",
      arguments: {
        query: "[MASKED]",
        nested: { note: "ask [MASKED] again" },
        entries: ["[MASKED]", 7],
      },
    };
    const finalToolCall: ToolCall = {
      type: "toolCall",
      id: "call-2",
      name: "send_msg",
      arguments: { text: "[MASKED]" },
    };
    const partial = makeAssistantToolMessage(partialToolCall);
    const baseStreamFn: StreamFn = (_model, _context) => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "toolcall_delta",
          contentIndex: 0,
          delta: '{"query":"[MASKED]"}',
          partial,
        });
        stream.push({
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: partialToolCall,
          partial,
        });
        stream.push({
          type: "done",
          reason: "toolUse",
          message: makeAssistantToolMessage(finalToolCall),
        });
        stream.end();
      });
      return stream;
    };

    const wrapped = wrapStreamFnTextTransforms({
      streamFn: baseStreamFn,
      output: [{ from: /\[MASKED\]/g, to: "John" }],
    });
    const stream = await Promise.resolve(wrapped(model, {} as Context, undefined));
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    const deltaEvent = events.find((event) => event.type === "toolcall_delta") as
      | { delta?: string; partial?: AssistantMessage }
      | undefined;
    // Raw JSON fragments are provider bytes and may split a replacement token.
    // Structured arguments are the safe, canonical transform surface.
    expect(deltaEvent?.delta).toBe('{"query":"[MASKED]"}');
    expect(deltaEvent?.partial?.content[0]).toMatchObject({
      name: "search",
      arguments: {
        query: "John",
        nested: { note: "ask John again" },
        entries: ["John", 7],
      },
    });

    const endEvent = events.find((event) => event.type === "toolcall_end") as
      | { toolCall?: { name?: string; arguments?: Record<string, unknown> } }
      | undefined;
    // Tool name is preserved — only arguments are transformed to avoid
    // breaking tool routing by renaming a registered tool identifier.
    expect(endEvent?.toolCall?.name).toBe("search");
    expect(endEvent?.toolCall?.arguments).toEqual({
      query: "John",
      nested: { note: "ask John again" },
      entries: ["John", 7],
    });

    const result = await stream.result();
    expect(result.content[0]).toMatchObject({
      name: "send_msg",
      arguments: { text: "John" },
    });
  });
});
