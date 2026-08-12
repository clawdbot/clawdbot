import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { processCompletionsStream } from "./openai-completions-stream.js";
import { createOpenAICompletionsTransportStreamFn } from "./openai-completions-transport.js";
import {
  type CapturedStreamEvent,
  createAssistantOutput,
  createDeepSeekCompletionsModel,
  makeCompletionsChunk,
  makeCompletionsModel,
  streamChunks,
} from "./openai-completions.test-support.js";
import { getCompat } from "./openai-transport-params.js";

describe("openai completions DSML", () => {
  it("fails before a later DSML call after overflow can be authorized", async () => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);
    const laterCall =
      '<|DSML|tool_calls><|DSML|invoke name="read">{"path":"/tmp/repro.md"}</|DSML|invoke></|DSML|tool_calls>';

    await expect(
      processCompletionsStream(
        streamChunks([
          makeCompletionsChunk({
            content: "<|DSML|tool_calls>" + "x".repeat(256_001),
          }),
          makeCompletionsChunk({
            content: "</|DSML|function_calls> after " + laterCall,
          }),
          makeCompletionsChunk({}, "tool_calls"),
        ]),
        output,
        model,
        { push() {} },
      ),
    ).rejects.toThrow("Exceeded DeepSeek DSML recovery buffer limit");
  });

  it("does not carry surrogate accounting across emitted visible text", async () => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);

    await expect(
      processCompletionsStream(
        streamChunks([
          makeCompletionsChunk({ content: "\ud83d" }),
          makeCompletionsChunk({ content: "\ude00" }),
          makeCompletionsChunk({
            content: "<|DSML|tool_calls>" + "x".repeat(256_001),
          }),
          makeCompletionsChunk({}, "stop"),
        ]),
        output,
        model,
        { push() {} },
      ),
    ).rejects.toThrow("Exceeded DeepSeek DSML recovery buffer limit");
  });

  it("rejects a nested DSML wrapper before the original outer close", async () => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);
    const events: CapturedStreamEvent[] = [];

    await expect(
      processCompletionsStream(
        streamChunks([
          makeCompletionsChunk({ content: "<|DSML|tool_calls><|DSML|tool_" }),
          makeCompletionsChunk({
            content:
              'calls><|DSML|invoke name="read">{"path":"/tmp/nested.md"}</|DSML|invoke></|DSML|tool_calls>',
          }),
          makeCompletionsChunk({ content: "</|DSML|tool_calls>" }, "stop"),
        ]),
        output,
        model,
        {
          push(event) {
            events.push(event as CapturedStreamEvent);
          },
        },
      ),
    ).rejects.toThrow("Nested DeepSeek DSML recovery wrappers are not supported");
    expect(events.filter((event) => event.type?.startsWith("toolcall_") === true)).toEqual([]);
    expect(output.content.some((part) => part.type === "toolCall")).toBe(false);
  });

  it("does not accept a different DSML wrapper kind as the outer close", async () => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);

    await processCompletionsStream(
      streamChunks([
        makeCompletionsChunk({
          content:
            '<|DSML|tool_calls><|DSML|invoke name="read">{"path":"/tmp/mismatch.md"}</|DSML|invoke></|DSML|function_calls>',
        }),
        makeCompletionsChunk({}, "stop"),
      ]),
      output,
      model,
      { push() {} },
    );

    expect(output.stopReason).toBe("stop");
    expect(output.content.some((part) => part.type === "toolCall")).toBe(false);
  });

  it("does not rewind across the outer opener after a short first body chunk", async () => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);

    await processCompletionsStream(
      streamChunks([
        makeCompletionsChunk({ content: "<|DSML|tool_calls>\n" }),
        makeCompletionsChunk({
          content:
            '<|DSML|invoke name="read">{"path":"/tmp/fragmented.md"}</|DSML|invoke></|DSML|tool_calls>',
        }),
        makeCompletionsChunk({}, "stop"),
      ]),
      output,
      model,
      { push() {} },
    );

    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: expect.stringMatching(/^call_[0-9a-f]{24}$/),
        name: "read",
        arguments: { path: "/tmp/fragmented.md" },
      },
    ]);
  });

  it("treats DSML-looking text inside a parameter value as payload", async () => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);
    const content =
      '<｜DSML｜tool_calls><｜DSML｜invoke name="message">' +
      '<｜DSML｜parameter name="text" string="true">' +
      "literal <｜DSML｜tool_calls> marker" +
      "</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>";

    const chunks = Array.from(content, (char) => makeCompletionsChunk({ content: char }));
    chunks.push(makeCompletionsChunk({}, "stop"));
    await processCompletionsStream(streamChunks(chunks), output, model, {
      push() {},
    });

    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: expect.stringMatching(/^call_[0-9a-f]{24}$/),
        name: "message",
        arguments: { text: "literal <｜DSML｜tool_calls> marker" },
      },
    ]);
  });

  it("ignores an incomplete invoke-like prefix before a valid invoke", async () => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);
    const content =
      "<|DSML|tool_calls>literal <|DSML|invoke marker " +
      '<|DSML|invoke name="read">{"path":"/tmp/valid.md"}</|DSML|invoke>' +
      "</|DSML|tool_calls>";

    await processCompletionsStream(
      streamChunks(
        Array.from(content, (char) => makeCompletionsChunk({ content: char })).concat([
          makeCompletionsChunk({}, "stop"),
        ]),
      ),
      output,
      model,
      { push() {} },
    );

    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: expect.stringMatching(/^call_[0-9a-f]{24}$/),
        name: "read",
        arguments: { path: "/tmp/valid.md" },
      },
    ]);
  });

  it("does not recover a nested call hidden inside a nameless invoke", async () => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);
    const events: CapturedStreamEvent[] = [];
    const content =
      "<|DSML|tool_calls><|DSML|invoke><|DSML|tool_calls>" +
      '<|DSML|invoke name="read">{"path":"/tmp/bypass"}</|DSML|invoke>' +
      "</|DSML|tool_calls>";

    await processCompletionsStream(
      streamChunks([makeCompletionsChunk({ content }), makeCompletionsChunk({}, "stop")]),
      output,
      model,
      {
        push(event) {
          events.push(event as CapturedStreamEvent);
        },
      },
    );

    expect(output.stopReason).toBe("stop");
    expect(events.filter((event) => event.type?.startsWith("toolcall_") === true)).toEqual([]);
    expect(output.content.some((part) => part.type === "toolCall")).toBe(false);
  });

  it("treats DSML-looking text inside JSON arguments as payload", async () => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);
    const content =
      '<|DSML|tool_calls><|DSML|invoke name="message">' +
      '{"text":"literal <|DSML|tool_calls> marker"}' +
      "</|DSML|invoke></|DSML|tool_calls>";

    await processCompletionsStream(
      streamChunks([makeCompletionsChunk({ content }, "stop")]),
      output,
      model,
      { push() {} },
    );

    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: expect.stringMatching(/^call_[0-9a-f]{24}$/),
        name: "message",
        arguments: { text: "literal <|DSML|tool_calls> marker" },
      },
    ]);
  });

  it.each([
    { finishReason: "length", stopReason: "length" },
    { finishReason: "content_filter", stopReason: "error" },
  ])(
    "does not authorize recovered DeepSeek DSML calls after $finishReason",
    async ({ finishReason, stopReason }) => {
      const model = createDeepSeekCompletionsModel();
      const output = createAssistantOutput(model);
      expect(getCompat(model).thinkingFormat).toBe("deepseek");

      await processCompletionsStream(
        streamChunks([
          makeCompletionsChunk(
            {
              content:
                '<|DSML|tool_calls><|DSML|invoke name="read">{"path":"/tmp/partial.md"}</|DSML|invoke></|DSML|tool_calls>',
            },
            finishReason,
          ),
        ]),
        output,
        model,
        { push() {} },
      );

      expect(output.stopReason).toBe(stopReason);
      expect(output.content).toEqual([]);
    },
  );

  it("does not authorize recovered DeepSeek DSML calls when the stream omits a terminal", async () => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);

    await processCompletionsStream(
      streamChunks([
        makeCompletionsChunk({
          content:
            '<|DSML|tool_calls><|DSML|invoke name="read">{"path":"/tmp/partial.md"}</|DSML|invoke></|DSML|tool_calls>',
        }),
      ]),
      output,
      model,
      { push() {} },
    );

    expect(output.stopReason).toBe("stop");
    expect(output.content).toEqual([]);
  });

  it("emits recovered DeepSeek content-filter terminals as errors", async () => {
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(
          `data: ${JSON.stringify(
            makeCompletionsChunk(
              {
                content:
                  '<|DSML|tool_calls><|DSML|invoke name="read">{"path":"/tmp/partial.md"}</|DSML|invoke></|DSML|tool_calls>',
              },
              "content_filter",
            ),
          )}\n\n`,
        );
        res.end("data: [DONE]\n\n");
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing loopback server address");
      }
      const model = makeCompletionsModel({
        ...createDeepSeekCompletionsModel(),
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      });
      const stream = createOpenAICompletionsTransportStreamFn()(
        model,
        {
          systemPrompt: "system",
          messages: [{ role: "user", content: "Read the file", timestamp: Date.now() }],
          tools: [],
        } as never,
        { apiKey: "test-key" } as never,
      );

      const terminalEvents: Array<{
        type: string;
        reason?: string;
        error?: Record<string, unknown>;
      }> = [];
      for await (const event of stream as AsyncIterable<{
        type: string;
        reason?: string;
        error?: Record<string, unknown>;
      }>) {
        if (event.type === "done" || event.type === "error") {
          terminalEvents.push(event);
        }
      }

      expect(terminalEvents).toEqual([
        expect.objectContaining({
          type: "error",
          reason: "error",
          error: expect.objectContaining({
            stopReason: "error",
            errorMessage: "Provider finish_reason: content_filter",
            content: [],
          }),
        }),
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("parses repeated DeepSeek DSML calls with response-unique ids", async () => {
    // Guards the cached attribute matchers: repeated parses must stay identical
    // apart from invocation identity (no stale RegExp lastIndex).
    const model = createDeepSeekCompletionsModel();
    const content =
      '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="session_status">\n<｜DSML｜parameter name="sessionKey" string="true">current</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>';

    const runOnce = async () => {
      const output = createAssistantOutput(model);
      await processCompletionsStream(
        streamChunks([makeCompletionsChunk({ content }, "stop")]),
        output,
        model,
        { push() {} },
      );
      return output.content;
    };

    const first = await runOnce();
    const second = await runOnce();
    for (const resultContent of [first, second]) {
      expect(resultContent).toEqual([
        {
          type: "toolCall",
          id: expect.stringMatching(/^call_[0-9a-f]{24}$/),
          name: "session_status",
          arguments: { sessionKey: "current" },
        },
      ]);
    }
    expect((second[0] as { id?: string }).id).not.toBe((first[0] as { id?: string }).id);
  });

  it("recovers split DeepSeek DSML JSON tool calls emitted as text", async () => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);

    await processCompletionsStream(
      streamChunks([
        makeCompletionsChunk({ content: '<|DSML|tool_calls><|DSML|invoke name="read">' }),
        makeCompletionsChunk({ content: '{"path":"/tmp/native.md"}</|DSML|invoke>' }),
        makeCompletionsChunk({ content: "</|DSML|tool_calls>" }, "stop"),
      ]),
      output,
      model,
      { push() {} },
    );

    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: expect.stringMatching(/^call_[0-9a-f]{24}$/),
        name: "read",
        arguments: { path: "/tmp/native.md" },
      },
    ]);
  });

  it("does not recover malformed DeepSeek DSML tool calls", async () => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);

    await processCompletionsStream(
      streamChunks([
        makeCompletionsChunk(
          {
            content:
              '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="session_status">\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>',
          },
          "stop",
        ),
      ]),
      output,
      model,
      { push() {} },
    );

    expect(output.stopReason).toBe("stop");
    expect(output.content).toEqual([]);
  });
});
