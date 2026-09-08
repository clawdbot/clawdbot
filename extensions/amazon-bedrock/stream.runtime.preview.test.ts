import { createServer } from "node:http";
import { crc32 } from "node:zlib";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { AssistantMessageEvent, Model } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { streamSimpleBedrock } from "./stream.runtime.js";

function bedrockEvent(type: string, payload: unknown): Buffer {
  // Amazon event-stream frames carry string headers and CRCs over the prelude
  // and full message. Exercise the SDK decoder instead of mocking its output.
  const headers = Buffer.concat(
    Object.entries({
      ":message-type": "event",
      ":event-type": type,
      ":content-type": "application/json",
    }).map(([name, value]) => {
      const bytes = Buffer.alloc(1 + name.length + 3 + value.length);
      bytes.writeUInt8(name.length, 0);
      bytes.write(name, 1);
      bytes.writeUInt8(7, 1 + name.length);
      bytes.writeUInt16BE(value.length, 2 + name.length);
      bytes.write(value, 4 + name.length);
      return bytes;
    }),
  );
  const body = Buffer.from(JSON.stringify(payload));
  const frame = Buffer.alloc(16 + headers.length + body.length);
  frame.writeUInt32BE(frame.length, 0);
  frame.writeUInt32BE(headers.length, 4);
  frame.writeUInt32BE(crc32(frame.subarray(0, 8)), 8);
  headers.copy(frame, 12);
  body.copy(frame, 12 + headers.length);
  frame.writeUInt32BE(crc32(frame.subarray(0, -4)), frame.length - 4);
  return frame;
}

type Frame = readonly [type: string, payload: unknown];
const startMessage: Frame = ["messageStart", { role: "assistant" }];
const stopMessage: Frame = ["messageStop", { stopReason: "tool_use" }];
const startTool = (index: number): Frame => [
  "contentBlockStart",
  {
    contentBlockIndex: index,
    start: { toolUse: { toolUseId: `call-${index}`, name: "write_document" } },
  },
];
const toolDelta = (index: number, input: string): Frame => [
  "contentBlockDelta",
  {
    contentBlockIndex: index,
    delta: { toolUse: { input } },
  },
];
const stopTool = (index: number): Frame => ["contentBlockStop", { contentBlockIndex: index }];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function readBedrockFrames(options: {
  frames: AsyncIterable<Frame>;
  signal: AbortSignal;
  observe: (event: AssistantMessageEvent) => void;
  queued?: boolean;
  release?: () => void;
}) {
  vi.stubEnv("AWS_BEDROCK_SKIP_AUTH", "1");
  vi.stubEnv("AWS_BEDROCK_FORCE_HTTP1", "1");
  const abort = new AbortController();
  const signal = AbortSignal.any([options.signal, abort.signal]);
  const release = () => options.release?.();
  signal.addEventListener("abort", release, { once: true });
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    request.resume();
    response.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
    void (async () => {
      for await (const [type, payload] of options.frames) {
        response.write(bedrockEvent(type, payload));
      }
      response.end();
    })().catch((error: unknown) =>
      response.destroy(error instanceof Error ? error : new Error(String(error))),
    );
  });
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing loopback address");
    }
    const model = {
      id: "amazon.nova-micro-v1:0",
      name: "Bedrock preview fixture",
      provider: "amazon-bedrock",
      api: "bedrock-converse-stream",
      baseUrl: `http://127.0.0.1:${address.port}`,
      reasoning: false,
      input: ["text"],
      contextWindow: 128_000,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    } satisfies Model<"bedrock-converse-stream">;
    const stream = streamSimpleBedrock(
      model,
      {
        messages: [{ role: "user", content: "Write the fixture.", timestamp: 0 }],
        tools: [
          {
            name: "write_document",
            description: "Write a synthetic document",
            parameters: Type.Object({ body: Type.String() }, { additionalProperties: true }),
          },
        ],
      },
      { signal },
    );
    if (options.queued) {
      await stream.result();
    }
    for await (const event of stream) {
      options.observe(event);
    }
    const result = await stream.result();
    expect(requests).toBe(1);
    return result;
  } finally {
    abort.abort();
    release();
    signal.removeEventListener("abort", release);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

it("bounds full-buffer preview work without losing raw deltas, progress, or terminal arguments", async ({
  signal,
}) => {
  const marker = "BEDROCK_PREVIEW_WORK:";
  const body = marker + "x".repeat(65_536);
  const expected = { body, tail: ["雪\n\\path", { ready: true }] };
  const raw = JSON.stringify(expected);
  const chunks: string[] = [];
  for (let offset = 0; offset < raw.length; offset += 256) {
    chunks.push(raw.slice(offset, offset + 256));
  }
  const acknowledgments = chunks.map(() => createDeferred<void>());
  async function* frames(): AsyncGenerator<Frame> {
    yield startMessage;
    yield startTool(0);
    for (const [index, chunk] of chunks.entries()) {
      yield toolDelta(0, chunk);
      // Observe the current preview before another delta mutates the same block.
      await acknowledgments[index]!.promise;
    }
    yield stopTool(0);
    yield stopMessage;
  }
  const probe = vi.spyOn(JSON, "parse");
  let parsedChars = 0;
  let fullParses = 0;
  const collectWork = () => {
    for (const [text] of probe.mock.calls) {
      if (typeof text === "string" && text.startsWith(`{"body":"${marker}`)) {
        parsedChars += text.length;
        fullParses += 1;
      }
    }
    // The probe must not retain all historical argument prefixes itself.
    probe.mockClear();
  };
  const received: string[] = [];
  const previewLengths: number[] = [];
  const terminal: unknown[] = [];
  const started = performance.now();
  const rssBefore = process.memoryUsage().rss;
  const result = await readBedrockFrames({
    frames: frames(),
    signal,
    release: () => acknowledgments.forEach((ack) => ack.resolve()),
    observe: (event) => {
      if (event.type === "toolcall_delta") {
        received.push(event.delta);
        const block = event.partial.content[event.contentIndex];
        previewLengths.push(
          block?.type === "toolCall" && typeof block.arguments.body === "string"
            ? block.arguments.body.length
            : 0,
        );
        collectWork();
        acknowledgments[received.length - 1]?.resolve();
      } else if (event.type === "toolcall_end") {
        terminal.push(event.toolCall.arguments);
      }
    },
  });
  collectWork();
  console.log(
    "bedrock-preview-work",
    JSON.stringify({
      chars: raw.length,
      chunks: chunks.length,
      received: received.length,
      fullParses,
      parsedChars,
      elapsedMs: performance.now() - started,
      rssBefore,
      rssAfter: process.memoryUsage().rss,
    }),
  );
  expect(received).toEqual(chunks);
  expect(Math.max(...previewLengths)).toBeGreaterThan(body.length / 2);
  expect(terminal).toEqual([expected]);
  expect(result.stopReason).toBe("toolUse");
  expect(parsedChars).toBeLessThan(raw.length * 4);
});

it.for([false, true])(
  "keeps interleaved calls independent with queued consumption=%s",
  async (queued, { signal }) => {
    const first = { body: "first:" + "a".repeat(1100), tail: { escaped: '"\n雪' } };
    const second = { body: "second:" + "b".repeat(550), id: "9007199254740993" };
    const firstRaw = JSON.stringify(first);
    const secondRaw = `{"body":${JSON.stringify(second.body)},"id":9007199254740993}`;
    const deltas = [
      { index: 3, input: firstRaw.slice(0, 1050) },
      { index: 8, input: secondRaw.slice(0, 530) },
      { index: 3, input: firstRaw.slice(1050) },
      { index: 8, input: secondRaw.slice(530) },
    ];
    const gates = deltas.map(() => createDeferred<void>());
    async function* frames(): AsyncGenerator<Frame> {
      yield startMessage;
      yield startTool(3);
      yield startTool(8);
      for (const [index, delta] of deltas.entries()) {
        yield toolDelta(delta.index, delta.input);
        if (!queued) {
          await gates[index]!.promise;
        }
      }
      yield stopTool(8);
      yield stopTool(3);
      yield stopMessage;
    }
    const received: Array<{ index: number; input: string }> = [];
    const observedPreviews: number[] = [];
    const terminal: Array<{ id: string; arguments: unknown }> = [];
    const result = await readBedrockFrames({
      frames: frames(),
      signal,
      queued,
      release: () => gates.forEach((gate) => gate.resolve()),
      observe: (event) => {
        if (event.type === "toolcall_delta") {
          const block = event.partial.content[event.contentIndex];
          expect(block?.type).toBe("toolCall");
          if (block?.type !== "toolCall") {
            throw new Error("Missing active tool call");
          }
          received.push({ index: Number(block.id.slice(5)), input: event.delta });
          observedPreviews.push(
            typeof block.arguments.body === "string" ? block.arguments.body.length : 0,
          );
          gates[received.length - 1]?.resolve();
        } else if (event.type === "toolcall_end") {
          expect(event.toolCall).not.toHaveProperty("partialJson");
          expect(event.toolCall).not.toHaveProperty("index");
          terminal.push({ id: event.toolCall.id, arguments: event.toolCall.arguments });
        }
      },
    });
    expect(received).toEqual(deltas);
    expect(observedPreviews[0]).toBeGreaterThan(1000);
    expect(observedPreviews[1]).toBeGreaterThan(500);
    expect(terminal).toEqual([
      { id: "call-8", arguments: second },
      { id: "call-3", arguments: first },
    ]);
    expect(result.stopReason).toBe("toolUse");
  },
);
