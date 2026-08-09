/** Proves paired-node Ollama work stops at every node-local HTTP phase. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import { createOllamaNodeHostCommands, createOllamaNodeInferenceTool } from "./node-inference.js";
import {
  enrichOllamaCompletionModels,
  enrichOllamaModelsWithContext,
  fetchOllamaModels,
  queryOllamaModelShowInfo,
} from "./provider-models.js";

type AbortTestServer = {
  baseUrl: string;
  requests: string[];
  canceled: string[];
};

async function withAbortTestServer<T>(
  stallPath: string,
  run: (server: AbortTestServer) => Promise<T>,
  options?: { stallCount?: number },
): Promise<T> {
  const requests: string[] = [];
  const canceled: string[] = [];
  let stalls = 0;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    requests.push(requestPath);
    if (requestPath === stallPath && stalls < (options?.stallCount ?? Number.POSITIVE_INFINITY)) {
      stalls += 1;
      response.once("close", () => {
        if (!response.writableFinished) {
          canceled.push(requestPath);
        }
      });
      return;
    }

    response.setHeader("Content-Type", "application/json");
    if (requestPath === "/api/tags") {
      response.end(
        JSON.stringify({
          models: [{ name: "node-local:small", digest: "sha256:node-local-small", size: 512 }],
        }),
      );
      return;
    }
    if (requestPath === "/api/show") {
      response.end(
        JSON.stringify({
          capabilities: ["completion", "tools"],
          model_info: { "test.context_length": 8192 },
        }),
      );
      return;
    }
    if (requestPath === "/api/chat") {
      response.end(
        JSON.stringify({
          model: "node-local:small",
          message: { content: "node-only inference" },
          done_reason: "stop",
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("node-local Ollama fixture did not expose a TCP address");
  }
  try {
    return await run({
      baseUrl: `http://127.0.0.1:${address.port}`,
      requests,
      canceled,
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function requireNodeChatCommand(baseUrl: string) {
  const command = createOllamaNodeHostCommands({ baseUrl }).find(
    (candidate) => candidate.command === "ollama.chat",
  );
  if (!command) {
    throw new Error("Ollama node chat command was not registered");
  }
  return command;
}

describe("node-local Ollama inference cancellation", () => {
  it.each([
    {
      phase: "model tags",
      request: (signal: AbortSignal) => fetchOllamaModels("http://127.0.0.1:1", { signal }),
    },
    {
      phase: "model metadata",
      request: (signal: AbortSignal) =>
        queryOllamaModelShowInfo("http://127.0.0.1:1", "node-local:small", { signal }),
    },
    {
      phase: "model context enrichment",
      request: (signal: AbortSignal) =>
        enrichOllamaModelsWithContext("http://127.0.0.1:1", [{ name: "node-local:small" }], {
          signal,
        }),
    },
    {
      phase: "completion enrichment",
      request: (signal: AbortSignal) =>
        enrichOllamaCompletionModels("http://127.0.0.1:1", [{ name: "node-local:small" }], {
          signal,
        }),
    },
  ])("normalizes a pre-aborted string reason during $phase", async ({ request }) => {
    const result = request(AbortSignal.abort("node inference canceled"));

    await expect(result).rejects.toBeInstanceOf(Error);
    await expect(result).rejects.toMatchObject({ message: "node inference canceled" });
  });

  it.each([
    { phase: "model discovery", path: "/api/tags" },
    { phase: "model capability verification", path: "/api/show" },
    { phase: "model generation", path: "/api/chat" },
  ])("closes the node-local request when $phase is canceled", async ({ path }) => {
    await withAbortTestServer(path, async ({ baseUrl, requests, canceled }) => {
      const controller = new AbortController();
      const inference = requireNodeChatCommand(baseUrl).handle(
        JSON.stringify({ model: "node-local:small", prompt: "answer locally" }),
        undefined,
        { sendNodeEvent: async () => undefined, signal: controller.signal },
      );
      await vi.waitFor(() => expect(requests).toContain(path));

      controller.abort(new Error("node inference canceled"));

      await expect(inference).rejects.toThrow("node inference canceled");
      await vi.waitFor(() => expect(canceled).toContain(path));
    });
  });

  it("forwards an agent-tool cancellation through its paired node runtime", async () => {
    await withAbortTestServer("/api/chat", async ({ baseUrl, requests, canceled }) => {
      const controller = new AbortController();
      const invoke = vi.fn(
        async (params: { command: string; params?: unknown; signal?: AbortSignal }) => ({
          payloadJSON: await requireNodeChatCommand(baseUrl).handle(
            JSON.stringify(params.params),
            undefined,
            { sendNodeEvent: async () => undefined, signal: params.signal },
          ),
        }),
      );
      const api = createTestPluginApi({
        runtime: {
          nodes: {
            list: async () => ({
              nodes: [
                {
                  nodeId: "paired-node",
                  connected: true,
                  commands: ["ollama.models", "ollama.chat"],
                },
              ],
            }),
            invoke,
          },
        } as never,
      });

      const inference = createOllamaNodeInferenceTool(api).execute(
        "paired-node-inference",
        {
          action: "run",
          model: "node-local:small",
          prompt: "answer only from the paired node",
        },
        controller.signal,
      );
      await vi.waitFor(() => expect(requests).toContain("/api/chat"));

      controller.abort(new Error("agent inference canceled"));

      await expect(inference).rejects.toThrow("agent inference canceled");
      expect(invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          nodeId: "paired-node",
          command: "ollama.chat",
          signal: controller.signal,
        }),
      );
      await vi.waitFor(() => expect(canceled).toContain("/api/chat"));
    });
  });

  it("normalizes a pre-aborted agent-tool string reason before listing nodes", async () => {
    const list = vi.fn(async () => ({ nodes: [] }));
    const api = createTestPluginApi({
      runtime: { nodes: { list, invoke: vi.fn() } } as never,
    });

    const inference = createOllamaNodeInferenceTool(api).execute(
      "paired-node-inference",
      { action: "discover" },
      AbortSignal.abort("agent inference canceled"),
    );

    await expect(inference).rejects.toBeInstanceOf(Error);
    await expect(inference).rejects.toMatchObject({ message: "agent inference canceled" });
    expect(list).not.toHaveBeenCalled();
  });

  it("does not poison shared model metadata after a canceled show request", async () => {
    await withAbortTestServer(
      "/api/show",
      async ({ baseUrl, requests, canceled }) => {
        const controller = new AbortController();
        const command = requireNodeChatCommand(baseUrl);
        const params = JSON.stringify({ model: "node-local:small", prompt: "answer locally" });
        const canceledInference = command.handle(params, undefined, {
          sendNodeEvent: async () => undefined,
          signal: controller.signal,
        });
        await vi.waitFor(() => expect(requests).toContain("/api/show"));

        controller.abort(new Error("first inference canceled"));
        await expect(canceledInference).rejects.toThrow("first inference canceled");
        await vi.waitFor(() => expect(canceled).toContain("/api/show"));

        await expect(command.handle(params)).resolves.toContain("node-only inference");
        expect(requests.filter((request) => request === "/api/show")).toHaveLength(2);
      },
      { stallCount: 1 },
    );
  });
});
