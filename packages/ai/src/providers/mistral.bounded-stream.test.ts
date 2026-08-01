// Mistral provider tests cover bounded-stream-read helper (`createBoundedMistralFetcher`).
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { Context, Model } from "../types.js";
import { createBoundedMistralFetcher, streamMistral } from "./mistral.js";

const MAX = 16 * 1024 * 1024;
const TOTAL = 18 * 1024 * 1024;

async function readAllChunks(body: ReadableStream<Uint8Array> | null): Promise<{ total: number }> {
  if (!body) {
    return { total: 0 };
  }
  const reader = body.getReader();
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      total += value.byteLength;
    }
  }
  return { total };
}

describe("Mistral bounded-stream-read real wire proof (loopback http.createServer)", () => {
  it("caps an oversized body streamed chunked over real wire", async () => {
    const fetcher = createBoundedMistralFetcher(MAX);
    const CHUNK = 1024 * 1024;
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      let sent = 0;
      const tick = setInterval(() => {
        if (sent < 18) {
          res.write(Buffer.alloc(CHUNK));
          sent++;
        } else {
          clearInterval(tick);
          res.end();
        }
      }, 1);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });
    const port = (server.address() as AddressInfo).port;

    let captured: Error | undefined;
    let totalGot = 0;
    try {
      const response = await fetcher(`http://127.0.0.1:${port}/`);
      // Wire framing merges TCP packets, so the reported size at throw time
      // is between MAX (cap) and TOTAL (cap + last merged packet). Both
      // bounds prove (a) cap fired (got > MAX) and (b) we did not buffer
      // beyond the server's full 18 MiB (got < TOTAL).
      try {
        const result = await readAllChunks(response.body);
        totalGot = result.total;
      } catch (err) {
        captured = err as Error;
      }
      expect(captured).toBeInstanceOf(Error);
      const match = (captured as Error).message.match(
        /mistral: stream body exceeds \d+ bytes \(got (\d+)\)/,
      );
      expect(match).not.toBeNull();
      const got = Number(match?.[1]);
      expect(got).toBeGreaterThan(MAX);
      expect(got).toBeLessThan(TOTAL);
      // Print to vitest stdout for PR-body real behavior proof capture.
      console.log(
        `[mistral bounded-stream proof] oversized path: cap=${MAX} reported=${got} server_total=${TOTAL}`,
      );
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      if (totalGot > 0) {
        // Use the value to satisfy strict unused rules without affecting asserts.
        expect(totalGot).toBeGreaterThan(0);
      }
    }
  });

  it("returns a Response with exact bytes for normal-size responses on real wire", async () => {
    const fetcher = createBoundedMistralFetcher(MAX);
    const bodyText = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n';
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(bodyText);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });
    const port = (server.address() as AddressInfo).port;

    try {
      const response = await fetcher(`http://127.0.0.1:${port}/`);
      expect(response.status).toBe(200);
      const { total } = await readAllChunks(response.body);
      expect(total).toBe(Buffer.byteLength(bodyText, "utf8"));
      console.log(
        `[mistral bounded-stream proof] normal path: cap=${MAX} returned=${total} body=${JSON.stringify(bodyText)}`,
      );
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });
});

// Drive the bounded fetcher directly against a synthetic ReadableStream that
// exceeds the cap. Bypasses any HTTP layer; proves the cap fires against an
// unbounded chunked source, mirroring what the Mistral SDK's internal SSE
// parser (`EventStream`) would see when a streaming body exceeds 16 MiB.
describe("Mistral bounded-stream-read direct (synthetic ReadableStream)", () => {
  it("caps an oversized synthetic ReadableStream at 16 MiB", async () => {
    const CHUNK = 1024 * 1024;
    let sent = 0;
    const synthetic = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent < 18) {
          controller.enqueue(new Uint8Array(CHUNK));
          sent++;
        } else {
          controller.close();
        }
      },
    });
    // Build the same shape `fetcher` expects from a real fetch(): a
    // `Response` whose `body` is a ReadableStream.
    const syntheticResponse = new Response(synthetic, {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    });
    const fetcher = createBoundedMistralFetcher(MAX, async () => syntheticResponse);

    let captured: Error | undefined;
    const wrapped = await fetcher("http://unused.invalid/");
    try {
      await readAllChunks(wrapped.body);
    } catch (err) {
      captured = err as Error;
    }
    expect(captured).toBeInstanceOf(Error);
    const match = (captured as Error).message.match(
      /mistral: stream body exceeds \d+ bytes \(got (\d+)\)/,
    );
    expect(match).not.toBeNull();
    const got = Number(match?.[1]);
    // Synthetic stream chunks are exactly 1 MiB aligned, so cap+1 reads
    // give exactly cap + 1 MiB = 16 MiB + 1 MiB = 17 825 792 bytes.
    expect(got).toBe(16777216 + CHUNK);
  });
});

type MistralTerminalFixture = {
  finishReason: "stop" | "length" | "error" | "tool_calls" | null;
  done: boolean;
  abort?: boolean;
  toolArguments?: string[];
  text?: string;
};

async function streamMistralTerminalFixture(fixture: MistralTerminalFixture) {
  const server = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    const toolCalls = fixture.toolArguments?.map((args, index) => ({
      index,
      id: `call_${index}`,
      type: "function",
      function: { name: `tool_${index}`, arguments: args },
    }));
    response.write(
      `data: ${JSON.stringify({
        id: "mistral-terminal-owner-proof",
        object: "chat.completion.chunk",
        created: 1,
        model: "mistral-large-latest",
        choices: [
          {
            index: 0,
            delta: {
              content: fixture.text ?? null,
              ...(toolCalls ? { tool_calls: toolCalls } : {}),
            },
            finish_reason: fixture.finishReason,
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      })}\n\n`,
    );
    if (fixture.abort) {
      request.once("close", () => response.end());
      return;
    }
    response.end(fixture.done ? "data: [DONE]\n\n" : "");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  const model = {
    id: "mistral-large-latest",
    name: "Mistral terminal owner",
    api: "mistral-conversations",
    provider: "mistral",
    baseUrl: `http://127.0.0.1:${port}`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  } satisfies Model<"mistral-conversations">;
  const context = {
    messages: [{ role: "user", content: "Inspect only", timestamp: 1 }],
  } satisfies Context;
  try {
    const abort = new AbortController();
    const stream = streamMistral(model, context, {
      apiKey: "redacted-fixture-token",
      ...(fixture.abort ? { signal: abort.signal } : {}),
    });
    const events: string[] = [];
    for await (const event of stream) {
      events.push(event.type);
      if (fixture.abort && event.type === "toolcall_delta") {
        abort.abort(new Error("Operator canceled the incomplete tool"));
      }
    }
    return { result: await stream.result(), events };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("Mistral terminal ownership through the installed SDK and real HTTP/SSE", () => {
  it("discards unfinished tool arguments when the operator cancels generation", async () => {
    const { result, events } = await streamMistralTerminalFixture({
      finishReason: null,
      done: false,
      abort: true,
      toolArguments: ['{"action":"delete_all"'],
    });
    expect(result.stopReason).toBe("aborted");
    expect(events).not.toContain("toolcall_end");
    expect(result.content).not.toContainEqual(expect.objectContaining({ type: "toolCall" }));
  });

  it.each([
    { name: "EOF without a provider terminal", finishReason: null, done: false },
    { name: "DONE without a provider terminal", finishReason: null, done: true },
    { name: "a provider error terminal", finishReason: "error", done: true },
    { name: "malformed arguments on a tool terminal", finishReason: "tool_calls", done: true },
  ] as const)("rejects $name without executable calls", async (fixture) => {
    const { result, events } = await streamMistralTerminalFixture({
      ...fixture,
      toolArguments: ['{"action":"delete_all"'],
      text: "Safe partial answer",
    });
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBeTruthy();
    expect(events).not.toContain("toolcall_end");
    expect(result.content).not.toContainEqual(expect.objectContaining({ type: "toolCall" }));
    expect(result.content).toContainEqual({ type: "text", text: "Safe partial answer" });
  });

  it.each(["length", "stop"] as const)(
    "preserves a %s terminal and visible text without finalizing partial tools",
    async (finishReason) => {
      const { result, events } = await streamMistralTerminalFixture({
        finishReason,
        done: true,
        toolArguments: ['{"action":"delete_all"'],
        text: "Safe partial answer",
      });
      expect(result.stopReason).toBe(finishReason);
      expect(result.content).toEqual([{ type: "text", text: "Safe partial answer" }]);
      expect(events).not.toContain("toolcall_end");
      expect(events).toContain("done");
    },
  );

  it("drops every pending parallel tool when a later call is truncated", async () => {
    const { result, events } = await streamMistralTerminalFixture({
      finishReason: "length",
      done: true,
      toolArguments: ['{"action":"inspect"}', '{"action":"delete_all"'],
    });
    expect(result.stopReason).toBe("length");
    expect(result.content).toEqual([]);
    expect(events).not.toContain("toolcall_end");
  });

  it("keeps a complete provider-confirmed tool executable", async () => {
    const { result, events } = await streamMistralTerminalFixture({
      finishReason: "tool_calls",
      done: true,
      toolArguments: ['{"action":"inspect"}'],
    });
    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toContainEqual(
      expect.objectContaining({ type: "toolCall", arguments: { action: "inspect" } }),
    );
    expect(events).toContain("toolcall_end");
  });

  it.each(["null", "[]", "42", '"dangerous"'] as const)(
    "rejects a provider-confirmed non-object JSON argument: %s",
    async (argumentsJson) => {
      const { result, events } = await streamMistralTerminalFixture({
        finishReason: "tool_calls",
        done: true,
        toolArguments: [argumentsJson],
      });
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("invalid JSON arguments");
      expect(events).not.toContain("toolcall_end");
      expect(result.content).not.toContainEqual(expect.objectContaining({ type: "toolCall" }));
    },
  );

  it("preserves a legitimate empty tool-argument object", async () => {
    const { result, events } = await streamMistralTerminalFixture({
      finishReason: "tool_calls",
      done: true,
      toolArguments: ["{}"],
    });
    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toContainEqual(expect.objectContaining({ arguments: {} }));
    expect(events).toContain("toolcall_end");
  });

  it("keeps a completed stop response without tools unchanged", async () => {
    const { result, events } = await streamMistralTerminalFixture({
      finishReason: "stop",
      done: true,
      text: "Visible answer",
    });
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ type: "text", text: "Visible answer" }]);
    expect(events).toContain("done");
  });
});
