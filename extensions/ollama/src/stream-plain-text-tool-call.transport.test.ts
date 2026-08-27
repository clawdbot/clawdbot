// Real-transport regression proof for the plain-text tool-call compat wrapper (#122513).
// Drives createOllamaStreamFn — the wrapper's canonical consumer — through a real
// loopback NDJSON /api/chat server: real HTTP, real SSRF-guarded fetch, real NDJSON
// parsing, real createPlainTextToolCallCompatWrapper, real Markdown protection.
// Nothing is mocked; only the network endpoint is local. The hand-built delta suites
// in packages/tool-call-repair replicate the delta shape this transport emits
// (per-record text_delta with contentIndex and no cumulative partial); the raw-stream
// assertions here pin that shape so those suites cannot silently drift from it.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createOllamaStreamFn } from "./stream-api.js";

const FENCE = "```";

/**
 * Bracket-dense fenced TOML chunked exactly the way a token stream delivers it: every
 * section heading's `[` ends its own delta, so nearly every line is candidate-shaped
 * for a `read` tool matcher and forces the wrapper's protected-range resolution. The
 * fenced `[read]` block is a complete, promotable call that only fence protection
 * keeps literal; the trailing block is the same call outside the fence.
 */
function buildBracketDenseChunks(sections: number): {
  chunks: string[];
  text: string;
  fencedBody: string;
  trailingCall: string;
} {
  const chunks: string[] = ["Here is the configuration you asked for.\n\n", `${FENCE}toml\n`];
  for (let index = 0; index < sections; index += 1) {
    const id = String(index).padStart(2, "0");
    chunks.push("[", `read.section.${id}]\n`, `name = "section-${id}"\n`);
  }
  const fencedBody = '[read]\n{"path":"fenced.txt"}\n[/read]\n';
  chunks.push("[", fencedBody.slice(1));
  chunks.push(`${FENCE}\n`);
  const trailingCall = '[read]\n{"path":"real.txt"}\n[/read]\n';
  chunks.push("\n", "[", trailingCall.slice(1));
  return { chunks, text: chunks.join(""), fencedBody, trailingCall };
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function startNdjsonChatServer(chunks: readonly string[]): Promise<string> {
  const server = createServer((req, res) => {
    if (!req.url?.endsWith("/api/chat")) {
      res.writeHead(404).end();
      return;
    }
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      for (const content of chunks) {
        res.write(
          `${JSON.stringify({
            model: "proof-model",
            created_at: "2026-01-01T00:00:00Z",
            message: { role: "assistant", content },
            done: false,
          })}\n`,
        );
      }
      res.write(
        `${JSON.stringify({
          model: "proof-model",
          created_at: "2026-01-01T00:00:00Z",
          message: { role: "assistant", content: "" },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 1,
          eval_count: 1,
        })}\n`,
      );
      res.end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

type CollectedRun = {
  deltaText: string;
  doneText: string;
  errors: unknown[];
  eventTypes: Map<string, number>;
  partialCarryingDeltas: number;
  toolCallNames: string[];
};

async function runThroughTransport(
  chunks: readonly string[],
  tools: ReadonlyArray<Record<string, unknown>>,
): Promise<CollectedRun> {
  const baseUrl = await startNdjsonChatServer(chunks);
  const streamFn = createOllamaStreamFn(baseUrl);
  const stream = streamFn(
    { api: "ollama", provider: "ollama", id: "proof-model", contextWindow: 65536 } as never,
    { messages: [{ role: "user", content: "config?" }], tools } as never,
    {},
  );
  const run: CollectedRun = {
    deltaText: "",
    doneText: "",
    errors: [],
    eventTypes: new Map(),
    partialCarryingDeltas: 0,
    toolCallNames: [],
  };
  for await (const event of stream as AsyncIterable<Record<string, unknown>>) {
    const type = typeof event.type === "string" ? event.type : "unknown";
    run.eventTypes.set(type, (run.eventTypes.get(type) ?? 0) + 1);
    if (type === "text_delta") {
      run.deltaText += typeof event.delta === "string" ? event.delta : "";
      if ("partial" in event && event.partial !== undefined) {
        run.partialCarryingDeltas += 1;
      }
    }
    if (type === "error") {
      run.errors.push(event.error);
    }
    if (type === "done") {
      const message = event.message as { content?: unknown[] } | undefined;
      for (const block of message?.content ?? []) {
        const record = block as { type?: unknown; text?: unknown; name?: unknown };
        if (record.type === "text" && typeof record.text === "string") {
          run.doneText += record.text;
        }
        if (record.type === "toolCall" && typeof record.name === "string") {
          run.toolCallNames.push(record.name);
        }
      }
    }
  }
  return run;
}

const readTool = {
  name: "read",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } } },
};

describe("plain-text tool-call compat wrapper over the real Ollama NDJSON transport", () => {
  it("keeps a bracket-dense fenced answer byte-identical while normalizing the unfenced call (#122513)", async () => {
    const payload = buildBracketDenseChunks(40);
    const run = await runThroughTransport(payload.chunks, [readTool]);

    expect(run.errors).toEqual([]);
    // Fence protection must keep every candidate-shaped line — including a complete,
    // otherwise-promotable [read] call — literal, byte for byte. A fast-path bug that
    // misreads fence state would scrub these lines out of the visible text.
    const fencedPortion = payload.text.slice(0, payload.text.indexOf(payload.trailingCall));
    expect(run.doneText.startsWith(fencedPortion)).toBe(true);
    expect(run.doneText).toContain(payload.fencedBody);
    // The identical call outside the fence is the wrapper's job to normalize away
    // (scrubbed or promoted, both remove it from visible text); its literal text
    // surviving would mean the wrapper never engaged.
    expect(run.doneText).not.toContain('"path":"real.txt"');
    // Live deltas and the terminal snapshot must agree exactly.
    expect(run.deltaText).toBe(run.doneText);
  });

  it("passes the identical stream through untouched when no tools are configured (#122513)", async () => {
    const payload = buildBracketDenseChunks(40);
    const run = await runThroughTransport(payload.chunks, []);

    expect(run.errors).toEqual([]);
    // With no tool names the wrapper early-returns the raw provider stream, so the
    // trailing [read] block stays literal and the whole payload survives byte for byte.
    expect(run.doneText).toBe(payload.text);
    expect(run.deltaText).toBe(payload.text);
    expect(run.toolCallNames).toEqual([]);
    // Raw transport delta shape backing the packages/tool-call-repair bounded suites:
    // one text_delta per NDJSON record, with no cumulative `partial` snapshot attached.
    expect(run.eventTypes.get("text_delta")).toBe(payload.chunks.length);
    expect(run.partialCarryingDeltas).toBe(0);
  });
});
