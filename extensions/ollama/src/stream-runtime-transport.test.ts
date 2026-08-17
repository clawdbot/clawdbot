// Ollama production stream UTF-8 rejection over a real loopback HTTP boundary.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createOllamaStreamFn } from "./stream.runtime.js";

const model = {
  api: "ollama",
  provider: "ollama",
  id: "qwen3:32b",
  contextWindow: 131072,
} as never;

const context = {
  messages: [{ role: "user", content: "hello" }],
} as never;

const TERMINAL_NDJSON = [
  '{"model":"m","created_at":"t","message":{"role":"assistant","content":"ok"},"done":false}',
  '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true}',
].join("\n");

async function withOllamaServer(
  chunks: Uint8Array[],
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    for (const chunk of chunks) {
      response.write(chunk);
    }
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

async function withTricklingWhitespaceServer(
  tailChunk: Uint8Array,
  intervalMs: number,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.write(new TextEncoder().encode(`${TERMINAL_NDJSON}\n`));
    // Keep the body open and trickle valid whitespace past the terminal
    // record; completion must not wait for connection close.
    const writer = setInterval(() => {
      if (response.destroyed) {
        clearInterval(writer);
        return;
      }
      response.write(tailChunk);
    }, intervalMs);
    response.on("close", () => clearInterval(writer));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

async function withOpenBodyServer(
  initialBody: Uint8Array,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.write(initialBody);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

async function collectStreamEvents(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function typeOf(event: unknown): string | undefined {
  return (event as { type?: string } | null | undefined)?.type;
}

describe("ollama production stream UTF-8 rejection over real HTTP", () => {
  it("rejects a partial UTF-8 byte in a later body chunk instead of completing", async () => {
    const terminalChunk = new TextEncoder().encode(`${TERMINAL_NDJSON}\n`);
    await withOllamaServer([terminalChunk, new Uint8Array([0xc3])], async (baseUrl) => {
      const stream = createOllamaStreamFn(baseUrl)(model, context, {});
      const events = await collectStreamEvents(await Promise.resolve(stream));
      expect(events.some((event) => typeOf(event) === "done")).toBe(false);
      const errorEvent = events.find((event) => typeOf(event) === "error");
      expect(errorEvent).toBeDefined();
      expect(JSON.stringify(errorEvent)).toMatch(/utf-8/i);
    });
  });

  it("completes successfully for a valid terminal stream", async () => {
    const bytes = new TextEncoder().encode(`${TERMINAL_NDJSON}\n`);
    await withOllamaServer([bytes], async (baseUrl) => {
      const stream = createOllamaStreamFn(baseUrl)(model, context, {});
      const events = await collectStreamEvents(await Promise.resolve(stream));
      expect(events.some((event) => typeOf(event) === "done")).toBe(true);
      expect(events.some((event) => typeOf(event) === "error")).toBe(false);
    });
  });

  it("completes within the terminal-tail bound when the peer keeps sending whitespace", async () => {
    await withTricklingWhitespaceServer(
      new TextEncoder().encode("\n".repeat(8192)),
      1,
      async (baseUrl) => {
        const stream = createOllamaStreamFn(baseUrl)(model, context, {});
        const events = await collectStreamEvents(await Promise.resolve(stream));
        expect(events.some((event) => typeOf(event) === "done")).toBe(true);
        expect(events.some((event) => typeOf(event) === "error")).toBe(false);
      },
    );
  });

  it("bounds a large valid tail delivered with the terminal record", async () => {
    const terminalChunk = new TextEncoder().encode(`${TERMINAL_NDJSON}\n`);
    const tail = new Uint8Array(16 * 1024 * 1024 + 1).fill(0x20);
    const initialBody = new Uint8Array(terminalChunk.byteLength + tail.byteLength);
    initialBody.set(terminalChunk);
    initialBody.set(tail, terminalChunk.byteLength);

    await withOpenBodyServer(initialBody, async (baseUrl) => {
      const started = Date.now();
      const stream = createOllamaStreamFn(baseUrl)(model, context, {});
      const events = await collectStreamEvents(await Promise.resolve(stream));
      expect(events.some((event) => typeOf(event) === "done")).toBe(true);
      expect(events.some((event) => typeOf(event) === "error")).toBe(false);
      expect(Date.now() - started).toBeLessThan(1_500);
    });
  });

  it("completes when the terminal-tail byte cap cuts off an incomplete UTF-8 suffix", async () => {
    const terminalChunk = new TextEncoder().encode(`${TERMINAL_NDJSON}\n`);
    const tail = new Uint8Array(256 * 1024 + 1).fill(0x20);
    tail[tail.length - 1] = 0xc3;
    const initialBody = new Uint8Array(terminalChunk.byteLength + tail.byteLength);
    initialBody.set(terminalChunk);
    initialBody.set(tail, terminalChunk.byteLength);

    await withOpenBodyServer(initialBody, async (baseUrl) => {
      const stream = createOllamaStreamFn(baseUrl)(model, context, {});
      const events = await collectStreamEvents(await Promise.resolve(stream));
      expect(events.some((event) => typeOf(event) === "done")).toBe(true);
      expect(events.some((event) => typeOf(event) === "error")).toBe(false);
    });
  });

  it("completes within the terminal-tail deadline for a slow periodic tail", async () => {
    await withTricklingWhitespaceServer(new TextEncoder().encode("\n"), 150, async (baseUrl) => {
      const started = Date.now();
      const stream = createOllamaStreamFn(baseUrl)(model, context, {});
      const events = await collectStreamEvents(await Promise.resolve(stream));
      expect(events.some((event) => typeOf(event) === "done")).toBe(true);
      expect(events.some((event) => typeOf(event) === "error")).toBe(false);
      // The fixed deadline bounds completion even while the peer keeps the
      // body open with a trickle far below the byte bound.
      expect(Date.now() - started).toBeLessThan(5_000);
    });
  });
});
