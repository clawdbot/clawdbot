import { createServer } from "node:http";
import type { AddressInfo, Server } from "node:net";
import type { Context, Model } from "@openclaw/llm-core";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupSessionResources } from "../session-resources.js";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";

// Matches the identically-named symbol in src/agents/provider-request-config.ts
// via the global symbol registry, without a packages/ai -> src/agents import.
const MODEL_PROVIDER_REQUEST_TRANSPORT_SYMBOL = Symbol.for(
  "openclaw.modelProviderRequestTransport",
);

function attachModelProviderRequestTransport<TModel extends object>(
  model: TModel,
  request: { allowPrivateNetwork?: boolean },
): TModel {
  return {
    ...model,
    [MODEL_PROVIDER_REQUEST_TRANSPORT_SYMBOL]: request,
  };
}

// Real loopback HTTP + SSE server standing in for an arbitrary
// Responses-API-shaped proxy. Nothing here mocks the `openai` SDK: the
// request leaves the process over a real socket and the response comes back
// as real "text/event-stream" bytes, so this proves the literal wire shape
// rather than an intercepted SDK call -- see
// packages/ai/src/transports/openai-responses-client.continuation.integration.test.ts
// for the established pattern this mirrors.
class ScriptedResponsesServer {
  readonly requests: Array<Record<string, unknown>> = [];
  private server: Server | undefined;

  async listen(): Promise<string> {
    this.server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        this.requests.push(parsed);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(
          `data: ${JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_1",
              status: "completed",
              output: [
                {
                  id: "msg_resp_1",
                  type: "message",
                  status: "completed",
                  content: [{ type: "output_text", text: "answer", annotations: [] }],
                  role: "assistant",
                },
              ],
              usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
            },
          })}\n\n`,
        );
        res.end();
      });
    });
    await new Promise<void>((resolve) => {
      this.server?.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server?.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}/v1`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function proxyModel(baseUrl: string, compat?: Record<string, boolean>): Model<"openai-responses"> {
  const model = {
    id: "scripted-model",
    name: "Scripted Model",
    api: "openai-responses",
    provider: "custom-provider",
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
    ...(compat ? { compat } : {}),
  } satisfies Model<"openai-responses">;
  return attachModelProviderRequestTransport(model, { allowPrivateNetwork: true });
}

const context: Context = {
  systemPrompt: "You are a helpful assistant.",
  messages: [{ role: "user", content: "hi", timestamp: 1 }],
  tools: [],
};

async function runOnce(model: Model<"openai-responses">, sessionId: string) {
  const stream = await createOpenAIResponsesTransportStreamFn()(model, context, {
    apiKey: "test-key",
    sessionId,
    transport: "sse",
    reasoningEffort: "low",
    onPayload: (payload: Record<string, unknown>) => ({ ...payload, store: true }),
  } as never);
  await stream.result();
}

describe("real HTTP/SSE OpenAI-Responses instructions-field default (loopback server, no SDK mocking)", () => {
  afterEach(() => {
    cleanupSessionResources();
  });

  it("embeds the system prompt in input, not instructions, for an unverified custom proxy over a real connection", async () => {
    const server = new ScriptedResponsesServer();
    const baseUrl = await server.listen();
    try {
      await runOnce(proxyModel(baseUrl), "real-instructions-default-off");

      expect(server.requests).toHaveLength(1);
      const wireRequest = server.requests[0];
      expect(wireRequest).not.toHaveProperty("instructions");
      // reasoning:true with no compat.supportsDeveloperRole gets the
      // "developer" role, not "system" -- see openai-responses-params-internal.ts.
      expect((wireRequest?.input as Array<{ role?: string }> | undefined)?.[0]?.role).toBe(
        "developer",
      );
    } finally {
      await server.close();
    }
  });

  it("carries the system prompt via top-level instructions once the route is explicitly opted in, over a real connection", async () => {
    const server = new ScriptedResponsesServer();
    const baseUrl = await server.listen();
    try {
      await runOnce(
        proxyModel(baseUrl, { supportsInstructions: true }),
        "real-instructions-explicit-opt-in",
      );

      expect(server.requests).toHaveLength(1);
      const wireRequest = server.requests[0];
      expect(wireRequest?.instructions).toBe("You are a helpful assistant.");
      const input = wireRequest?.input as Array<{ role?: string }> | undefined;
      expect(input?.every((item) => item.role !== "system")).toBe(true);
    } finally {
      await server.close();
    }
  });
});
