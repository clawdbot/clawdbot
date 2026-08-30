import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOllamaNodeHostCommands } from "./node-inference.js";
import { fetchOllamaModels } from "./provider-models.js";

const CHAT_MODEL = "deadline-model:latest";
const CHAT_COMMAND = "ollama.chat";

async function withDelayedOllamaServer<T>(
  delays: Partial<Record<"/api/tags" | "/api/show" | "/api/chat", number>>,
  run: (baseUrl: string, requestedPaths: string[]) => Promise<T>,
): Promise<T> {
  const requestedPaths: string[] = [];
  const sockets = new Set<Socket>();
  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    const requestPath = request.url;
    if (requestPath !== "/api/tags" && requestPath !== "/api/show" && requestPath !== "/api/chat") {
      response.writeHead(404).end();
      return;
    }
    requestedPaths.push(requestPath);
    const bodyChunks: Buffer[] = [];
    for await (const chunk of request) {
      bodyChunks.push(Buffer.from(chunk));
    }
    if (requestPath !== "/api/tags" && Buffer.concat(bodyChunks).length === 0) {
      throw new Error("Ollama deadline test received an empty POST body");
    }
    const delayMs = delays[requestPath];
    if (delayMs !== undefined) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }
    if (response.destroyed) {
      return;
    }
    response.setHeader("Content-Type", "application/json");
    if (requestPath === "/api/tags") {
      response.end(JSON.stringify({ models: [{ name: CHAT_MODEL }] }));
      return;
    }
    if (requestPath === "/api/show") {
      response.end(
        JSON.stringify({
          capabilities: ["completion", "tools"],
          model_info: { "test.context_length": 32_768 },
        }),
      );
      return;
    }
    response.end(
      JSON.stringify({
        model: CHAT_MODEL,
        message: { content: "within the requested deadline" },
        done_reason: "stop",
      }),
    );
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Ollama deadline test server did not expose a TCP address");
  }
  try {
    return await run(`http://127.0.0.1:${address.port}`, requestedPaths);
  } finally {
    const closed = new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    for (const socket of sockets) {
      socket.destroy();
    }
    await closed;
  }
}

function runNodeChat(baseUrl: string, timeoutMs: number): Promise<string> {
  const chatCommand = createOllamaNodeHostCommands({ baseUrl }).find(
    (entry) => entry.command === CHAT_COMMAND,
  );
  if (!chatCommand) {
    throw new Error("Ollama node host did not expose its chat command");
  }
  return chatCommand.handle(
    JSON.stringify({ model: CHAT_MODEL, prompt: "answer within the deadline", timeoutMs }),
  );
}

describe("Ollama node inference deadline", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["/api/tags", ["/api/tags"]],
    ["/api/show", ["/api/tags", "/api/show"]],
    ["/api/chat", ["/api/tags", "/api/show", "/api/chat"]],
  ] as const)("bounds a stalled %s request by the inference deadline", async (slowPath, paths) => {
    await withDelayedOllamaServer({ [slowPath]: 900 }, async (baseUrl, requestedPaths) => {
      const startedAtMs = performance.now();

      await expect(runNodeChat(baseUrl, 250)).rejects.toThrow(/timed out|unavailable/);

      expect(performance.now() - startedAtMs).toBeLessThan(2_000);
      expect(requestedPaths).toEqual(paths);
    });
  });

  it("shares one deadline across successful catalog and model preflight", async () => {
    await withDelayedOllamaServer(
      { "/api/tags": 160, "/api/show": 160, "/api/chat": 160 },
      async (baseUrl, requestedPaths) => {
        const startedAtMs = performance.now();

        await expect(runNodeChat(baseUrl, 400)).rejects.toThrow(/timed out|unavailable/);

        expect(performance.now() - startedAtMs).toBeLessThan(2_000);
        expect(requestedPaths.slice(0, 2)).toEqual(["/api/tags", "/api/show"]);
      },
    );
  });

  it("applies the requested catalog timeout to guarded DNS preflight", async () => {
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "0");
    const stalledLookup = vi.fn(() => new Promise<never>(() => {})) as unknown as LookupFn;
    const fetchSpy = vi.fn(async () => new Response("DNS should not complete"));
    const startedAtMs = performance.now();

    await expect(
      fetchOllamaModels(
        "https://ollama.example.com",
        { timeoutMs: 150 },
        {
          lookupFn: stalledLookup,
          fetchImpl: fetchSpy,
        },
      ),
    ).resolves.toEqual({ reachable: false, models: [] });

    expect(performance.now() - startedAtMs).toBeLessThan(2_000);
    expect(stalledLookup).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 10_000);
});
