import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveAgentDir } from "../agents/agent-scope.js";
import type { MemoryEmbeddingProviderAdapter } from "../plugins/memory-embedding-providers.js";
import { getFreePort, installGatewayTestHooks } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const WRITE_SCOPE_HEADER = { "x-openclaw-scopes": "operator.write" };

let startGatewayServer: typeof import("./server.js").startGatewayServer;
let createEmbeddingProviderMock: ReturnType<
  typeof vi.fn<
    (options: { provider: string; model: string; agentDir?: string }) => Promise<{
      provider: {
        id: string;
        model: string;
        embedQuery: (text: string) => Promise<number[]>;
        embedBatch: (texts: string[]) => Promise<number[][]>;
      };
    }>
  >
>;
let clearMemoryEmbeddingProviders: typeof import("../plugins/memory-embedding-providers.js").clearMemoryEmbeddingProviders;
let registerMemoryEmbeddingProvider: typeof import("../plugins/memory-embedding-providers.js").registerMemoryEmbeddingProvider;
let enabledServer: Awaited<ReturnType<typeof startServer>>;
let enabledPort: number;

beforeAll(async () => {
  ({ clearMemoryEmbeddingProviders, registerMemoryEmbeddingProvider } =
    await import("../plugins/memory-embedding-providers.js"));
  createEmbeddingProviderMock = vi.fn(
    async (options: { provider: string; model: string; agentDir?: string }) => ({
      provider: {
        id: options.provider,
        model: options.model,
        embedQuery: async () => [0.1, 0.2],
        embedBatch: async (texts: string[]) =>
          texts.map((_text, index) => [index + 0.1, index + 0.2]),
      },
    }),
  );
  clearMemoryEmbeddingProviders();
  const openAiAdapter: MemoryEmbeddingProviderAdapter = {
    id: "openai",
    defaultModel: "text-embedding-3-small",
    transport: "remote",
    autoSelectPriority: 20,
    allowExplicitWhenConfiguredAuto: true,
    create: async (options) => {
      const result = await createEmbeddingProviderMock({
        provider: "openai",
        model: options.model,
        agentDir: options.agentDir,
      });
      return result;
    },
  };
  registerMemoryEmbeddingProvider(openAiAdapter);
  ({ startGatewayServer } = await import("./server.js"));
  enabledPort = await getFreePort();
  enabledServer = await startServer(enabledPort, { openAiChatCompletionsEnabled: true });
});

afterAll(async () => {
  await enabledServer.close({ reason: "embeddings http enabled suite done" });
  clearMemoryEmbeddingProviders();
  vi.resetModules();
});

async function startServer(port: number, opts?: { openAiChatCompletionsEnabled?: boolean }) {
  return await startGatewayServer(port, {
    host: "127.0.0.1",
    auth: { mode: "token", token: "secret" },
    controlUiEnabled: false,
    openAiChatCompletionsEnabled: opts?.openAiChatCompletionsEnabled ?? false,
  });
}

async function postEmbeddings(body: unknown, headers?: Record<string, string>) {
  return await fetch(`http://127.0.0.1:${enabledPort}/v1/embeddings`, {
    method: "POST",
    headers: {
      authorization: "Bearer secret",
      "content-type": "application/json",
      ...WRITE_SCOPE_HEADER,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function latestCreateEmbeddingProviderOptions(): {
  agentDir?: string;
  model?: string;
  provider?: string;
} {
  const calls = createEmbeddingProviderMock.mock.calls;
  const call = calls[calls.length - 1];
  if (!call) {
    throw new Error("expected embedding provider create call");
  }
  return call[0];
}

describe("OpenAI-compatible embeddings HTTP API (e2e)", () => {
  it("embeds string and array inputs", async () => {
    const single = await postEmbeddings({
      model: "openclaw/default",
      input: "hello",
    });
    expect(single.status).toBe(200);
    const singleJson = (await single.json()) as {
      object?: string;
      data?: Array<{ object?: string; embedding?: number[]; index?: number }>;
    };
    expect(singleJson.object).toBe("list");
    expect(singleJson.data?.[0]?.object).toBe("embedding");
    expect(singleJson.data?.[0]?.embedding).toEqual([0.1, 0.2]);

    const batch = await postEmbeddings({
      model: "openclaw/default",
      input: ["a", "b"],
    });
    expect(batch.status).toBe(200);
    const batchJson = (await batch.json()) as {
      data?: Array<{ embedding?: number[]; index?: number }>;
    };
    expect(batchJson.data).toEqual([
      { object: "embedding", index: 0, embedding: [0.1, 0.2] },
      { object: "embedding", index: 1, embedding: [1.1, 1.2] },
    ]);

    const qualified = await postEmbeddings(
      {
        model: "openclaw/default",
        input: "hello again",
      },
      { "x-openclaw-model": "openai/text-embedding-3-small" },
    );
    expect(qualified.status).toBe(200);
    const qualifiedJson = (await qualified.json()) as { model?: string };
    expect(qualifiedJson.model).toBe("openclaw/default");
    const lastCall = latestCreateEmbeddingProviderOptions();
    expect(lastCall.provider).toBe("openai");
    expect(lastCall.model).toBe("text-embedding-3-small");
  });

  it("supports base64 encoding and agent-scoped auth/config resolution", async () => {
    const res = await postEmbeddings(
      {
        model: "openclaw/beta",
        input: "hello",
        encoding_format: "base64",
      },
      { "x-openclaw-agent-id": "beta" },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data?: Array<{ embedding?: string }> };
    expect(typeof json.data?.[0]?.embedding).toBe("string");
    expect(createEmbeddingProviderMock).toHaveBeenCalled();
    const lastCall = latestCreateEmbeddingProviderOptions();
    expect(typeof lastCall.model).toBe("string");
    expect(lastCall.agentDir).toBe(resolveAgentDir({}, "beta"));
  });

  it("rejects invalid input shapes", async () => {
    const res = await postEmbeddings({
      model: "openclaw/default",
      input: [{ nope: true }],
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: { type?: string } };
    expect(json.error?.type).toBe("invalid_request_error");
  });

  it("ignores narrower declared scopes for shared-secret bearer auth", async () => {
    const res = await postEmbeddings(
      {
        model: "openclaw/default",
        input: "hello",
      },
      { "x-openclaw-scopes": "operator.read" },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      object?: string;
      data?: Array<{ object?: string; embedding?: number[] }>;
    };
    expect(json.object).toBe("list");
    expect(json.data?.[0]?.object).toBe("embedding");
    expect(json.data?.[0]?.embedding).toEqual([0.1, 0.2]);
  });

  it("allows requests with an empty declared scopes header", async () => {
    const res = await postEmbeddings(
      {
        model: "openclaw/default",
        input: "hello",
      },
      { "x-openclaw-scopes": "" },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      object?: string;
      data?: Array<{ object?: string; embedding?: number[] }>;
    };
    expect(json.object).toBe("list");
    expect(json.data?.[0]?.object).toBe("embedding");
    expect(json.data?.[0]?.embedding).toEqual([0.1, 0.2]);
  });

  it("allows requests when the operator scopes header is missing", async () => {
    const res = await fetch(`http://127.0.0.1:${enabledPort}/v1/embeddings`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "openclaw/default",
        input: "hello",
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      object?: string;
      data?: Array<{ object?: string; embedding?: number[] }>;
    };
    expect(json.object).toBe("list");
    expect(json.data?.[0]?.object).toBe("embedding");
    expect(json.data?.[0]?.embedding).toEqual([0.1, 0.2]);
  });

  it("rejects invalid agent targets", async () => {
    const res = await postEmbeddings({
      model: "ollama/nomic-embed-text",
      input: "hello",
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: { type?: string; message?: string } };
    expect(json.error).toEqual({
      type: "invalid_request_error",
      message: "Invalid `model`. Use `openclaw` or `openclaw/<agentId>`.",
    });
  });

  it("rejects disallowed x-openclaw-model provider overrides", async () => {
    const res = await postEmbeddings(
      {
        model: "openclaw/default",
        input: "hello",
      },
      { "x-openclaw-model": "ollama/nomic-embed-text" },
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: { type?: string; message?: string } };
    expect(json.error).toEqual({
      type: "invalid_request_error",
      message: "This agent does not allow that embedding provider on `/v1/embeddings`.",
    });
  });

  it("rejects oversized batches", async () => {
    const res = await postEmbeddings({
      model: "openclaw/default",
      input: Array.from({ length: 129 }, () => "x"),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: { type?: string; message?: string } };
    expect(json.error).toEqual({
      type: "invalid_request_error",
      message: "Too many inputs (max 128).",
    });
  });

  it("sanitizes provider failures", async () => {
    createEmbeddingProviderMock.mockRejectedValueOnce(new Error("secret upstream failure"));
    const res = await postEmbeddings({
      model: "openclaw/default",
      input: "hello",
    });
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error?: { type?: string; message?: string } };
    expect(json.error).toEqual({
      type: "api_error",
      message: "internal error",
    });
  });
});
