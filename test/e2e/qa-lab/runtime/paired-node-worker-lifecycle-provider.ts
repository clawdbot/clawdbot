import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";

type Deferred = { promise: Promise<void>; resolve: () => void };

function createDeferred(): Deferred {
  let resolve = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function readBody(request: AsyncIterable<unknown>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function responseText(raw: string): string {
  const matches = [...raw.matchAll(/Reply exactly:\s*([A-Z0-9_-]+)/gu)];
  return matches.at(-1)?.[1] ?? "WIRE-OK";
}

function writeEvent(response: ServerResponse, event: unknown): void {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function writeReply(response: ServerResponse, text: string): void {
  if (!response.headersSent) {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
  }
  const id = `msg_${randomUUID()}`;
  const item = {
    type: "message",
    id,
    role: "assistant",
    phase: "final_answer",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  writeEvent(response, {
    type: "response.output_item.added",
    output_index: 0,
    item: { ...item, status: "in_progress", content: [] },
  });
  writeEvent(response, {
    type: "response.output_text.delta",
    item_id: id,
    output_index: 0,
    content_index: 0,
    delta: text,
  });
  writeEvent(response, {
    type: "response.output_text.done",
    item_id: id,
    output_index: 0,
    content_index: 0,
    text,
  });
  writeEvent(response, { type: "response.output_item.done", output_index: 0, item });
  writeEvent(response, {
    type: "response.completed",
    response: {
      id: `resp_${id}`,
      status: "completed",
      output: [item],
      usage: { input_tokens: 32, output_tokens: 8, total_tokens: 40 },
    },
  });
  response.end("data: [DONE]\n\n");
}

export async function startPairedNodeWorkerLifecycleProvider(holdMarkers: readonly string[]) {
  const holdSet = new Set(holdMarkers);
  const releases = new Map(holdMarkers.map((marker) => [marker, createDeferred()] as const));
  const held = new Set<string>();
  const pendingResponses = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "gpt-5.6-luna", object: "model" }] }));
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const raw = await readBody(request);
      const text = responseText(raw);
      if (holdSet.has(text)) {
        held.add(text);
        pendingResponses.add(response);
        response.once("close", () => pendingResponses.delete(response));
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        response.flushHeaders();
        await releases.get(text)!.promise;
        if (!response.destroyed) {
          writeReply(response, text);
        }
        pendingResponses.delete(response);
        return;
      }
      writeReply(response, text);
    })().catch((error: unknown) => {
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("paired node lifecycle provider did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    hasHeld(marker: string): boolean {
      return held.has(marker);
    },
    release(marker: string): void {
      releases.get(marker)?.resolve();
    },
    releaseAll(): void {
      for (const release of releases.values()) {
        release.resolve();
      }
    },
    async stop(): Promise<void> {
      for (const release of releases.values()) {
        release.resolve();
      }
      for (const response of pendingResponses) {
        response.destroy();
      }
      pendingResponses.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
