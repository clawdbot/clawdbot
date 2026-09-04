import http from "node:http";
import type {
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
} from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { streamAnthropic } from "../../../packages/ai/src/providers/anthropic.js";
import {
  appendHistory,
  createAssistant,
  createAutoCompactionSettings,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import {
  createCompactionHandlers,
  createResourceLoader,
} from "./agent-session-loop-resource-loader.test-support.js";
import type { AgentSessionEvent } from "./agent-session-types.js";
import { SessionManager } from "./session-manager.js";

registerAgentSessionLoopTestLifecycle();

describe("AgentSession refusal compaction", () => {
  it.each([
    {
      name: "refusal explanation resembles overflow",
      overflow: false,
      overlap: true,
      threshold: false,
      queued: false,
      later: false,
      expectedRequests: 1,
    },
    {
      name: "threshold maintenance after refusal",
      overflow: false,
      overlap: false,
      threshold: true,
      queued: false,
      later: false,
      expectedRequests: 1,
    },
    {
      name: "threshold maintenance preserves explicit queued user",
      overflow: false,
      overlap: false,
      threshold: true,
      queued: true,
      later: false,
      expectedRequests: 2,
    },
    {
      name: "actual overflow still retries",
      overflow: true,
      overlap: false,
      threshold: false,
      queued: false,
      later: false,
      expectedRequests: 2,
    },
    {
      name: "explicit later user turn after refusal",
      overflow: false,
      overlap: false,
      threshold: false,
      queued: false,
      later: true,
      expectedRequests: 1,
    },
  ])("$name", async ({ overflow, overlap, threshold, queued, later, expectedRequests }) => {
    const requests: Array<{ url: string | undefined; body: unknown }> = [];
    const explanation = overlap
      ? "This request is refused; prompt is too long."
      : "This request is not allowed.";
    const server = http.createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push({ url: request.url, body: JSON.parse(body) });
        if (requests.length === 1 && overflow) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              type: "error",
              error: {
                type: "invalid_request_error",
                message: "prompt is too long: 1200 tokens > 1000 maximum",
              },
            }),
          );
          return;
        }
        const refused = requests.length === 1;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          [
            {
              type: "message_start",
              message: { id: `msg_${requests.length}`, usage: { input_tokens: 2 } },
            },
            ...(refused
              ? []
              : [
                  {
                    type: "content_block_start",
                    index: 0,
                    content_block: { type: "text", text: "" },
                  },
                  {
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "text_delta", text: "Explicit next turn completed." },
                  },
                  { type: "content_block_stop", index: 0 },
                ]),
            {
              type: "message_delta",
              delta: refused
                ? {
                    stop_reason: "refusal",
                    stop_details: {
                      type: "refusal",
                      category: "reasoning_extraction",
                      explanation,
                    },
                  }
                : { stop_reason: "end_turn" },
              usage: { input_tokens: 2, output_tokens: refused ? 0 : 1 },
            },
            { type: "message_stop" },
          ]
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(""),
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected loopback TCP server");
      }
      const model = {
        ...testModel,
        id: "claude-opus-5",
        name: "Claude Opus 5 SDK compaction proof",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: `http://127.0.0.1:${address.port}`,
        contextWindow: threshold ? 100 : 1000,
        maxTokens: 16,
      } satisfies Model<"anthropic-messages">;
      const sessionManager = SessionManager.inMemory();
      appendHistory(
        sessionManager,
        createAssistant(
          model,
          [{ type: "text", text: "Earlier answer." }],
          "stop",
          threshold ? 85 : 10,
        ),
      );
      streamMocks.streamSimple.mockImplementation(
        (_activeModel: Model, context: Context, options?: SimpleStreamOptions) =>
          streamAnthropic(model, context, { ...options, apiKey: "redacted-fixture-token" }),
      );
      const handlers = createCompactionHandlers();
      const handler = handlers.get("session_before_compact")?.[0];
      if (!handler) {
        throw new Error("Expected compaction fixture handler");
      }
      let queuedUser = false;
      handlers.set("session_before_compact", [
        async (...args: unknown[]) => {
          if (queued && !queuedUser) {
            queuedUser = true;
            await session.followUp("explicit queued user turn");
          }
          return handler(...args);
        },
      ]);
      const { session } = await createTestSession({
        model,
        sessionManager,
        settingsManager: createAutoCompactionSettings(),
        resourceLoader: createResourceLoader(handlers),
      });
      const compactions: Array<Extract<AgentSessionEvent, { type: "compaction_end" }>> = [];
      const assistants: AssistantMessage[] = [];
      session.subscribe((event) => {
        if (event.type === "compaction_end") {
          compactions.push(event);
        }
        if (event.type === "message_end" && event.message.role === "assistant") {
          assistants.push(event.message);
        }
      });
      await session.prompt(threshold ? "current user request ".repeat(12) : "current user request");
      const firstTurnRequests = requests.length;
      expect(assistants[0]?.stopReason).toBe("error");
      if (!overflow) {
        expect(assistants[0]?.diagnostics).toContainEqual(
          expect.objectContaining({ type: "provider_refusal" }),
        );
      }
      if (later) {
        await session.prompt("explicit later user turn");
      }
      expect(firstTurnRequests).toBe(expectedRequests);
      expect(requests.every(({ url }) => url === "/v1/messages")).toBe(true);
      if (threshold) {
        expect(compactions).toContainEqual(
          expect.objectContaining({
            reason: "threshold",
            outcome: expect.objectContaining({ status: "completed", willRetry: false }),
          }),
        );
      }
      if (overflow) {
        expect(compactions).toContainEqual(
          expect.objectContaining({
            reason: "overflow",
            outcome: expect.objectContaining({ status: "completed", willRetry: true }),
          }),
        );
      } else {
        expect(
          compactions.some(({ outcome }) => outcome.status === "completed" && outcome.willRetry),
        ).toBe(false);
      }
      if (queued || later) {
        expect(JSON.stringify(requests[1]?.body)).toContain(
          later ? "explicit later user turn" : "explicit queued user turn",
        );
      }
      if (later) {
        expect(requests).toHaveLength(2);
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
