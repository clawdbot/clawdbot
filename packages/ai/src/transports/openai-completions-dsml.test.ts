import { createServer } from "node:http";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
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

describe("openai completions DSML", () => {
  it("surfaces aggregated chat-completions message.refusal as visible assistant text", async () => {
    const model = makeCompletionsModel({
      id: "gpt-5.5",
      name: "GPT-5.5",
      reasoning: false,
      contextWindow: 128_000,
      maxTokens: 4096,
    });
    const output = createAssistantOutput(model);

    await processCompletionsStream(
      streamChunks([
        makeCompletionsChunk({}, null, {
          choices: [
            {
              index: 0,
              // Some OpenAI-compatible endpoints deliver a full message instead of delta.
              message: {
                role: "assistant",
                content: null,
                refusal: "Requests like this are not allowed.",
              },
              logprobs: null,
              finish_reason: "stop",
            } as unknown as ChatCompletionChunk["choices"][number],
          ],
        }),
      ]),
      output,
      model,
      { push() {} },
    );

    expect(output.content).toStrictEqual([
      { type: "text", text: "Requests like this are not allowed." },
    ]);
    expect(output.stopReason).toBe("stop");
  });

  it("filters DeepSeek DSML content without disturbing native tool calls", async () => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);
    const events: CapturedStreamEvent[] = [];

    await processCompletionsStream(
      streamChunks([
        makeCompletionsChunk({
          content: "before <｜DSML｜tool_use_error>body</｜DSML｜tool_use_error> after",
        }),
        makeCompletionsChunk(
          {
            content: "<|DSML|tool_calls>shadow</|DSML|tool_calls>",
            tool_calls: [
              {
                index: 0,
                id: "call_native_1",
                type: "function",
                function: { name: "read", arguments: '{"path":"/tmp/native.md"}' },
              },
            ],
          },
          "tool_calls",
        ),
      ]),
      output,
      model,
      { push: (event) => events.push(event as CapturedStreamEvent) },
    );

    expect(output.content).toEqual([
      {
        type: "text",
        text: "before  after",
        textSignature: expect.stringMatching(
          /^\{"v":1,"id":"commentary-0-[0-9a-f]{24}","phase":"commentary"\}$/u,
        ),
      },
      {
        type: "toolCall",
        id: "call_native_1",
        name: "read",
        arguments: { path: "/tmp/native.md" },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("DSML");
  });

  it("preserves DeepSeek visible content before same-chunk native tool calls", async () => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);

    await processCompletionsStream(
      streamChunks([
        makeCompletionsChunk(
          {
            content: "I'll check",
            tool_calls: [
              {
                index: 0,
                id: "call_native_1",
                type: "function",
                function: { name: "read", arguments: '{"path":"/tmp/native.md"}' },
              },
            ],
          },
          "tool_calls",
        ),
      ]),
      output,
      model,
      { push() {} },
    );

    expect(output.content).toEqual([
      {
        type: "text",
        text: "I'll check",
        textSignature: expect.stringMatching(
          /^\{"v":1,"id":"commentary-0-[0-9a-f]{24}","phase":"commentary"\}$/u,
        ),
      },
      {
        type: "toolCall",
        id: "call_native_1",
        name: "read",
        arguments: { path: "/tmp/native.md" },
      },
    ]);
  });

  it("filters DeepSeek DSML text queued after native tool calls", async () => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);
    const events: CapturedStreamEvent[] = [];

    await processCompletionsStream(
      streamChunks([
        makeCompletionsChunk(
          {
            tool_calls: [
              {
                index: 0,
                id: "call_native_1",
                type: "function",
                function: { name: "read", arguments: '{"path":"/tmp/native.md"}' },
              },
            ],
          },
          "tool_calls",
        ),
        makeCompletionsChunk({
          content: "<|DSML|tool_calls>shadow</|DSML|tool_calls> visible",
        }),
      ]),
      output,
      model,
      { push: (event) => events.push(event as CapturedStreamEvent) },
    );

    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: "call_native_1",
        name: "read",
        arguments: { path: "/tmp/native.md" },
      },
      {
        type: "text",
        text: " visible",
        textSignature: expect.stringMatching(
          /^\{"v":1,"id":"commentary-0-[0-9a-f]{24}","phase":"commentary"\}$/u,
        ),
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("DSML");
  });

  it("keeps DeepSeek DSML state across native tool-call chunks", async () => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);
    const events: CapturedStreamEvent[] = [];

    await processCompletionsStream(
      streamChunks([
        makeCompletionsChunk(
          {
            content: "before <|DSML|tool",
            tool_calls: [
              {
                index: 0,
                id: "call_native_1",
                type: "function",
                function: { name: "read", arguments: '{"path":"/tmp/native.md"}' },
              },
            ],
          },
          "tool_calls",
        ),
        makeCompletionsChunk({
          content: "_calls>shadow</|DSML|tool_calls> after",
        }),
      ]),
      output,
      model,
      { push: (event) => events.push(event as CapturedStreamEvent) },
    );

    expect(output.content).toEqual([
      {
        type: "text",
        text: "before ",
        textSignature: expect.stringMatching(
          /^\{"v":1,"id":"commentary-0-[0-9a-f]{24}","phase":"commentary"\}$/u,
        ),
      },
      {
        type: "toolCall",
        id: "call_native_1",
        name: "read",
        arguments: { path: "/tmp/native.md" },
      },
      {
        type: "text",
        text: " after",
        textSignature: expect.stringMatching(
          /^\{"v":1,"id":"commentary-1-[0-9a-f]{24}","phase":"commentary"\}$/u,
        ),
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("DSML");
  });

  it.each(["|", "｜", "｜｜"])("recovers streamed %s DSML parameter tool calls", async (bar) => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);
    const events: CapturedStreamEvent[] = [];

    const content = `<${bar}DSML${bar}tool_calls><${bar}DSML${bar}invoke name="session_status"><${bar}DSML${bar}parameter name="sessionKey" string="true">current</${bar}DSML${bar}parameter></${bar}DSML${bar}invoke></${bar}DSML${bar}tool_calls>`;
    await processCompletionsStream(
      streamChunks([
        ...Array.from(content, (char) => makeCompletionsChunk({ content: char })),
        makeCompletionsChunk({}, "stop"),
      ]),
      output,
      model,
      { push: (event) => events.push(event as CapturedStreamEvent) },
    );

    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: expect.stringMatching(/^call_[0-9a-f]{24}$/),
        name: "session_status",
        arguments: { sessionKey: "current" },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("DSML");
  });

  it("rejects an oversized DeepSeek DSML block when the crossing chunk contains its close", async () => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);
    const events: CapturedStreamEvent[] = [];

    const prefix = '<|DSML|tool_calls><|DSML|invoke name="read">{"path":"';
    const suffix = '"}</|DSML|invoke></|DSML|tool_calls>';
    const padding = "x".repeat(256_001 - Buffer.byteLength(prefix + suffix, "utf8"));
    const content = prefix + padding + suffix + " after";
    expect(Buffer.byteLength(prefix + padding + suffix, "utf8")).toBe(256_001);
    const chunks = Array.from({ length: Math.ceil(content.length / 4096) }, (_, index) =>
      content.slice(index * 4096, (index + 1) * 4096),
    );

    await expect(
      processCompletionsStream(
        streamChunks(
          chunks.map((contentChunk, index) =>
            makeCompletionsChunk(
              { content: contentChunk },
              index === chunks.length - 1 ? "stop" : null,
            ),
          ),
        ),
        output,
        model,
        { push: (event) => events.push(event as CapturedStreamEvent) },
      ),
    ).rejects.toThrow("Exceeded DeepSeek DSML recovery buffer limit");
    expect(events.filter((event) => event.type?.startsWith("toolcall_"))).toEqual([]);
  });

  it("rejects an oversized DeepSeek DSML recovery buffer using UTF-8 bytes", async () => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);

    // 200k "é": .length under 256k string units, UTF-8 bytes over 256k.
    const multibyteBody =
      '<｜DSML｜invoke name="session_status"><｜DSML｜parameter name="key" string="true">' +
      "\u00E9".repeat(200_000) +
      "</｜DSML｜parameter></｜DSML｜invoke>";

    await expect(
      processCompletionsStream(
        streamChunks([
          makeCompletionsChunk(
            {
              content: "<｜DSML｜tool_calls>" + multibyteBody,
            },
            "stop",
          ),
        ]),
        output,
        model,
        { push() {} },
      ),
    ).rejects.toThrow("Exceeded DeepSeek DSML recovery buffer limit");
  });

  it("counts split surrogate pairs exactly at the DeepSeek DSML recovery cap", async () => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);
    const prefix = '<|DSML|tool_calls><|DSML|invoke name="read">{"path":"';
    const suffix = '"}</|DSML|invoke>';
    const outerClose = "</|DSML|tool_calls>";
    const emoji = "\u{1f600}";
    const padding = "x".repeat(
      256_000 - Buffer.byteLength(prefix + emoji + suffix + outerClose, "utf8"),
    );
    const beforeSplit = prefix + padding + "\uD83D";
    const afterSplit = "\uDE00" + suffix;
    expect(Buffer.byteLength(beforeSplit + afterSplit + outerClose, "utf8")).toBe(256_000);

    await processCompletionsStream(
      streamChunks([
        makeCompletionsChunk({ content: beforeSplit }),
        makeCompletionsChunk({ content: afterSplit }),
        makeCompletionsChunk({ content: outerClose }, "stop"),
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
        arguments: { path: padding + emoji },
      },
    ]);
  });

  it("surfaces an oversized DeepSeek DSML recovery buffer as a transport error", async () => {
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        for (const chunk of [
          makeCompletionsChunk({
            content: "<|DSML|tool_calls>" + "x".repeat(300_000),
          }),
          makeCompletionsChunk({}, "stop"),
        ]) {
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
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

      const events: Array<{
        type: string;
        reason?: string;
        error?: { errorMessage?: string; content?: unknown[] };
      }> = [];
      for await (const event of stream as AsyncIterable<(typeof events)[number]>) {
        events.push(event);
      }

      expect(events).toContainEqual(
        expect.objectContaining({
          type: "error",
          reason: "error",
          error: expect.objectContaining({
            errorMessage: "Exceeded DeepSeek DSML recovery buffer limit",
            content: [],
          }),
        }),
      );
      expect(events.filter((event) => event.type === "toolcall_start")).toEqual([]);
      expect(events.filter((event) => event.type === "toolcall_delta")).toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
