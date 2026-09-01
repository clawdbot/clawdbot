import { createServer } from "node:http";
import type { AddressInfo, Server } from "node:net";
import type { AssistantMessage, Context, Model } from "@openclaw/llm-core";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupSessionResources } from "../session-resources.js";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";

// Matches the identically-named symbol in src/agents/provider-request-config.ts
// (and the sibling local copy in openai-completions.test-support.ts) via the
// global symbol registry, without a packages/ai -> src/agents import.
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

// Real loopback HTTP + SSE server standing in for a self-hosted OpenAI-Responses
// proxy (e.g. OmniRoute). Unlike openai-responses-client.continuation.test.ts,
// nothing here mocks the `openai` SDK: requests leave the process over a real
// socket and come back as real "text/event-stream" bytes, so this proves the
// wire behavior rather than an intercepted SDK call.
class ScriptedResponsesServer {
  readonly requests: Array<Record<string, unknown>> = [];
  private readonly script: Array<(request: Record<string, unknown>) => string>;
  private server: Server | undefined;

  constructor(script: Array<(request: Record<string, unknown>) => string>) {
    this.script = script;
  }

  async listen(): Promise<string> {
    this.server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        const index = this.requests.length;
        this.requests.push(parsed);
        const frame = this.script[index];
        if (!frame) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(
            JSON.stringify({ error: { message: `no scripted response for request ${index}` } }),
          );
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(`data: ${frame(parsed)}\n\n`);
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

function completedFrame(responseId: string, content: string): string {
  return JSON.stringify({
    type: "response.completed",
    response: {
      id: responseId,
      status: "completed",
      output: [
        {
          id: `msg_${responseId}`,
          type: "message",
          status: "completed",
          content: [{ type: "output_text", text: content, annotations: [] }],
          role: "assistant",
        },
      ],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    },
  });
}

function userMessage(text: string, timestamp: number) {
  return { role: "user" as const, content: text, timestamp };
}

function customEndpointModel(baseUrl: string): Model<"openai-responses"> {
  const model = {
    id: "scripted-model",
    name: "Scripted Model",
    api: "openai-responses",
    provider: "omniroute",
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
    compat: { supportsResponsesContinuation: true },
  } satisfies Model<"openai-responses">;
  return attachModelProviderRequestTransport(model, { allowPrivateNetwork: true });
}

async function run(
  model: Model<"openai-responses">,
  context: Context,
  sessionId: string,
): Promise<AssistantMessage> {
  const stream = await createOpenAIResponsesTransportStreamFn()(model, context, {
    apiKey: "test-key",
    sessionId,
    transport: "sse",
    reasoningEffort: "low",
    onPayload: (payload: Record<string, unknown>) => ({ ...payload, store: true }),
  } as never);
  return stream.result();
}

describe("real HTTP/SSE OpenAI-Responses continuation (loopback server, no SDK mocking)", () => {
  afterEach(() => {
    cleanupSessionResources();
  });

  it("sends previous_response_id and only the new message on a real two-turn exchange", async () => {
    const server = new ScriptedResponsesServer([
      () => completedFrame("resp_1", "first answer"),
      () => completedFrame("resp_2", "second answer"),
    ]);
    const baseUrl = await server.listen();
    try {
      const model = customEndpointModel(baseUrl);
      const sessionId = "real-sse-basic";
      const firstUser = userMessage("first question", 1);
      const first = await run(model, { messages: [firstUser], tools: [] }, sessionId);
      await run(
        model,
        { messages: [firstUser, first, userMessage("second question", 2)], tools: [] },
        sessionId,
      );

      expect(server.requests).toHaveLength(2);
      expect(server.requests[0]).not.toHaveProperty("previous_response_id");
      expect(server.requests[1]).toMatchObject({ previous_response_id: "resp_1" });
      expect(server.requests[1]?.input).toEqual([
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "second question" }],
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it("advances the continuation baseline across three real chained turns", async () => {
    const server = new ScriptedResponsesServer([
      () => completedFrame("resp_1", "first answer"),
      () => completedFrame("resp_2", "second answer"),
      () => completedFrame("resp_3", "third answer"),
    ]);
    const baseUrl = await server.listen();
    try {
      const model = customEndpointModel(baseUrl);
      const sessionId = "real-sse-chain";
      const firstUser = userMessage("first question", 1);
      const first = await run(model, { messages: [firstUser], tools: [] }, sessionId);
      const secondContext = {
        messages: [firstUser, first, userMessage("second question", 2)],
        tools: [],
      };
      const second = await run(model, secondContext, sessionId);
      await run(
        model,
        {
          messages: [...secondContext.messages, second, userMessage("third question", 3)],
          tools: [],
        },
        sessionId,
      );

      expect(server.requests).toHaveLength(3);
      expect(server.requests[1]).toMatchObject({ previous_response_id: "resp_1" });
      expect(server.requests[1]?.input).toHaveLength(1);
      expect(server.requests[2]).toMatchObject({ previous_response_id: "resp_2" });
      expect(server.requests[2]?.input).toEqual([
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "third question" }],
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it("never sends previous_response_id for an unopted-in custom endpoint over a real connection", async () => {
    const server = new ScriptedResponsesServer([
      () => completedFrame("resp_1", "first answer"),
      () => completedFrame("resp_2", "second answer"),
    ]);
    const baseUrl = await server.listen();
    try {
      const model: Model<"openai-responses"> = {
        ...customEndpointModel(baseUrl),
        compat: undefined,
      };
      const sessionId = "real-sse-unopted";
      const firstUser = userMessage("first question", 1);
      const first = await run(model, { messages: [firstUser], tools: [] }, sessionId);
      await run(
        model,
        { messages: [firstUser, first, userMessage("second question", 2)], tools: [] },
        sessionId,
      );

      expect(server.requests[1]).not.toHaveProperty("previous_response_id");
      expect((server.requests[1]?.input as unknown[] | undefined)?.length).toBe(3);
    } finally {
      await server.close();
    }
  });
});
