import { createServer } from "node:http";
import { afterAll, describe, expect, it, vi } from "vitest";
import { streamWithIdleTimeout } from "../../../../src/agents/embedded-agent-runner/run/llm-idle-timeout.js";
import {
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticRunProgress,
  resetDiagnosticRunActivityForTest,
} from "../../../../src/logging/diagnostic-run-activity.js";
import { streamOpenAICompletions } from "../providers/openai-completions.js";
import { registerBuiltInApiProviders } from "../providers/register-builtins.js";
import { createLlmRuntime } from "../stream.js";
import { shouldEmitOpenAICompletionsReasoning } from "./openai-completions-stream.js";
import { createOpenAICompletionsTransportStreamFn } from "./openai-completions-transport.js";
import { makeCompletionsChunk, makeCompletionsModel } from "./openai-completions.test-support.js";

describe("openai completions stream", () => {
  afterAll(() => {
    resetDiagnosticRunActivityForTest();
  });

  describe.each([
    { name: "direct", createStream: streamOpenAICompletions },
    { name: "managed", createStream: createOpenAICompletionsTransportStreamFn() },
  ])("$name cache-creation usage", ({ createStream }) => {
    it.each([
      ["top-level fallback", {}, 300, 0.001075, undefined],
      ["nested writes", { cache_write_tokens: 100 }, 100, 0.001025, undefined],
      ["nested creation", { cache_creation_input_tokens: 100 }, 100, 0.001025, undefined],
      ["nested write zero", { cache_write_tokens: 0 }, 0, 0.001, undefined],
      ["nested creation zero", { cache_creation_input_tokens: 0 }, 0, 0.001, undefined],
      ["provider-billed zero", {}, 300, 0, 0],
    ] as const)("preserves %s over HTTP", async (_name, details, cacheWrite, cost, billedCost) => {
      let capturedPayload: Record<string, unknown> | undefined;
      let capturedRoute: string | undefined;
      const server = createServer((req, res) => {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk: string) => {
          body += chunk;
        });
        req.on("end", () => {
          capturedRoute = `${req.method} ${req.url}`;
          capturedPayload = JSON.parse(body) as Record<string, unknown>;
          res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
          // TrueFoundry documents inclusive prompt tokens with a top-level write bucket:
          // https://www.truefoundry.com/docs/ai-gateway/chat-completions-advanced
          const usage = {
            prompt_tokens: 1500,
            completion_tokens: 200,
            total_tokens: 1700,
            prompt_tokens_details: { cached_tokens: 1200, ...details },
            cache_read_input_tokens: 1200,
            cache_creation_input_tokens: 300,
            ...(billedCost === undefined ? {} : { cost: billedCost }),
          };
          for (const chunk of [
            makeCompletionsChunk({ role: "assistant", content: "Usage preserved." }),
            makeCompletionsChunk({}, "stop"),
            makeCompletionsChunk({}, null, { choices: [], usage }),
          ]) {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
          res.end("data: [DONE]\n\n");
        });
      });

      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      try {
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Missing loopback server address");
        }
        const model = makeCompletionsModel({
          provider: "compatible-proxy",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          reasoning: false,
          cost: { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 1.25 },
        });
        const stream = await createStream(
          model,
          { messages: [{ role: "user", content: "Explain the usage.", timestamp: 1 }] },
          { apiKey: "synthetic-test-key" },
        );
        const result = await stream.result();

        expect(capturedRoute).toBe("POST /v1/chat/completions");
        expect(capturedPayload).toMatchObject({ model: model.id, stream: true });
        expect(result.stopReason).toBe("stop");
        expect(result.content).toEqual([expect.objectContaining({ text: "Usage preserved." })]);
        expect(result.usage).toMatchObject({
          input: 300 - cacheWrite,
          output: 200,
          cacheRead: 1200,
          cacheWrite,
          totalTokens: 1700,
        });
        expect(result.usage.cost.cacheWrite).toBeCloseTo((cacheWrite * 1.25) / 1_000_000, 10);
        expect(result.usage.cost.total).toBeCloseTo(cost, 10);
        if (billedCost !== undefined) {
          expect(result.usage.cost.totalOrigin).toBe("provider-billed");
        }
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    });
  });

  it("emits Qwen thinking streams when enabled without reasoning_effort support", async () => {
    let capturedPayload: Record<string, unknown> | undefined;
    const server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        capturedPayload = JSON.parse(body) as Record<string, unknown>;
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
        });
        res.end(
          JSON.stringify({
            id: "chatcmpl-qwen-thinking",
            object: "chat.completion",
            model: "qwen3.5-32b",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  reasoning_content: "Need a Qwen answer.",
                  content: "qwen-ok",
                },
                finish_reason: "stop",
              },
            ],
          }),
        );
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing loopback server address");
      }
      const model = makeCompletionsModel({
        id: "qwen3.5-32b",
        name: "Qwen 3.5 32B",
        provider: "qwen",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        contextWindow: 131072,
        compat: {
          thinkingFormat: "qwen",
          supportsReasoningEffort: false,
        },
      });
      const stream = createOpenAICompletionsTransportStreamFn()(
        model,
        {
          systemPrompt: "system",
          messages: [{ role: "user", content: "Reply qwen-ok", timestamp: Date.now() }],
          tools: [],
        } as never,
        { apiKey: "test-key", reasoning: "medium" } as never,
      );

      let thinking = "";
      let text = "";
      for await (const event of stream as AsyncIterable<{ type: string; delta?: string }>) {
        if (event.type === "thinking_delta") {
          thinking += event.delta ?? "";
        }
        if (event.type === "text_delta") {
          text += event.delta ?? "";
        }
      }

      expect(capturedPayload?.enable_thinking).toBe(true);
      expect(capturedPayload).not.toHaveProperty("reasoning_effort");
      expect(thinking).toBe("Need a Qwen answer.");
      expect(text).toBe("qwen-ok");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("does not emit thinking streams when reasoning is disabled", () => {
    const model = makeCompletionsModel({
      id: "grok-4.20-0309-reasoning",
      name: "Grok 4.20 0309 (Reasoning)",
      provider: "xai",
      baseUrl: "https://api.x.ai/v1",
      contextWindow: 1_000_000,
      maxTokens: 30_000,
    });

    expect(
      shouldEmitOpenAICompletionsReasoning(model, {
        apiKey: "test-key",
        reasoning: "off",
      } as never),
    ).toBe(false);
  });

  it("emits Z.ai thinking streams when enabled without reasoning_effort support", () => {
    const model = makeCompletionsModel({
      id: "glm-4.7",
      name: "GLM 4.7",
      provider: "zai",
      baseUrl: "",
      contextWindow: 128_000,
    });

    expect(
      shouldEmitOpenAICompletionsReasoning(model, {
        apiKey: "test-key",
        reasoning: "medium",
      } as never),
    ).toBe(true);
  });

  it.each([
    { finishReason: "tool_call", emitsTool: true, stopReason: "toolUse" },
    { finishReason: "tool_call", emitsTool: false, stopReason: "stop" },
    { finishReason: "tool_calls", emitsTool: true, stopReason: "toolUse" },
    { finishReason: "function_call", emitsTool: true, stopReason: "toolUse" },
    { finishReason: "unknown", emitsTool: true, stopReason: "error" },
  ])(
    "handles $finishReason with emitsTool=$emitsTool through the public LLM runtime",
    async ({ finishReason, emitsTool, stopReason }) => {
      const server = createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
          const delta = emitsTool
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_lookup",
                    type: "function",
                    function: { name: "lookup", arguments: '{"query":"local"}' },
                  },
                ],
              }
            : { role: "assistant", content: "No tool required." };
          for (const chunk of [
            makeCompletionsChunk(delta),
            makeCompletionsChunk({}, finishReason),
          ]) {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
          res.end("data: [DONE]\n\n");
        });
      });

      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      try {
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Missing loopback server address");
        }
        const model = makeCompletionsModel({
          id: "minimax-m2.5-8bit",
          provider: "mlx-lm",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          reasoning: false,
        });
        const runtime = createLlmRuntime();
        registerBuiltInApiProviders(runtime.registry);
        const stream = runtime.streamSimple(
          model,
          { messages: [{ role: "user", content: "Look it up.", timestamp: 1 }] },
          { apiKey: "synthetic-test-key" },
        );
        const result = await stream.result();

        expect(result.stopReason).toBe(stopReason);
        const toolCalls = result.content.filter((block) => block.type === "toolCall");
        if (stopReason === "toolUse") {
          expect(toolCalls).toEqual([
            expect.objectContaining({
              id: "call_lookup",
              name: "lookup",
              arguments: { query: "local" },
            }),
          ]);
        } else {
          expect(toolCalls).toEqual([]);
        }
        if (finishReason === "unknown") {
          expect(result.errorMessage).toBe("Provider finish_reason: unknown");
        }
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );

  it.concurrent.each(["reasoning_content", "reasoning"] as const)(
    "keeps hidden local %s streams alive beyond the model idle timeout",
    async (reasoningField) => {
      // The regression under guard is "hidden reasoning stops resetting the idle
      // watchdog", so the hidden phase has to outlast idleTimeoutMs or a broken
      // build would pass. Pace chunks far below that budget instead of near it:
      // a loaded runner stretches every inter-chunk gap, and one gap wider than
      // the timeout inverts the ratio into a false idle timeout.
      const idleTimeoutMs = 1_000;
      const sessionProgressStaleMs = 750;
      const reasoningChunkDelayMs = 5;
      const hiddenReasoningDurationMs = idleTimeoutMs + 200;
      const runId = `hidden-${reasoningField}-run`;
      let hiddenReasoningElapsedMs = 0;
      let crossedSessionProgressThreshold = false;
      let resolveSessionProgressThreshold!: () => void;
      const sessionProgressThresholdReached = new Promise<void>((resolve) => {
        resolveSessionProgressThreshold = resolve;
      });
      const server = createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });

          const hiddenReasoningStartedAt = Date.now();
          const writeNextChunk = () => {
            if (res.destroyed) {
              return;
            }
            hiddenReasoningElapsedMs = Date.now() - hiddenReasoningStartedAt;
            if (
              !crossedSessionProgressThreshold &&
              hiddenReasoningElapsedMs > sessionProgressStaleMs + 100
            ) {
              crossedSessionProgressThreshold = true;
              resolveSessionProgressThreshold();
            }
            if (hiddenReasoningElapsedMs < hiddenReasoningDurationMs) {
              const reasoningChunk = {
                id: "chatcmpl-local-reasoning",
                object: "chat.completion.chunk",
                created: 1,
                model: "nemotron-local",
                choices: [
                  {
                    index: 0,
                    delta: { [reasoningField]: "private reasoning" },
                    finish_reason: null,
                  },
                ],
              };
              res.write(`data: ${JSON.stringify(reasoningChunk)}\n\n`);
              setTimeout(writeNextChunk, reasoningChunkDelayMs);
              return;
            }

            res.write(
              `data: ${JSON.stringify(makeCompletionsChunk({ role: "assistant", content: "OK" }))}\n\n`,
            );
            res.write(`data: ${JSON.stringify(makeCompletionsChunk({}, "stop"))}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
          };

          writeNextChunk();
        });
      });

      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      try {
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Missing loopback server address");
        }
        const model = makeCompletionsModel({
          id: "nemotron-local",
          name: "Local Nemotron",
          provider: "inference",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          reasoning: false,
        });
        const onIdleTimeout = vi.fn();
        markDiagnosticRunProgress({
          runId,
          sessionId: runId,
          reason: "model_call:started",
        });
        const streamFn = streamWithIdleTimeout(
          createOpenAICompletionsTransportStreamFn(),
          idleTimeoutMs,
          onIdleTimeout,
          { runId },
        );
        const stream = streamFn(
          model,
          {
            systemPrompt: "system",
            messages: [{ role: "user", content: "Reply OK", timestamp: Date.now() }],
            tools: [],
          } as never,
          { apiKey: "test-key" } as never,
        );

        let text = "";
        let thinking = "";
        const collectStream = (async () => {
          for await (const event of stream as AsyncIterable<{ type: string; delta?: string }>) {
            if (event.type === "text_delta") {
              text += event.delta ?? "";
            }
            if (event.type === "thinking_delta") {
              thinking += event.delta ?? "";
            }
          }
        })();

        await sessionProgressThresholdReached;
        const activity = getDiagnosticSessionActivitySnapshot({ sessionId: runId });
        expect(activity.lastProgressAgeMs).toBeLessThan(sessionProgressStaleMs);
        expect(activity.lastProgressReason).toBe("model_call:stream_progress");

        await collectStream;

        expect(text).toBe("OK");
        expect(thinking).toBe("");
        expect(onIdleTimeout).not.toHaveBeenCalled();
        // Without this the assertions above could pass on a run whose hidden
        // phase never reached the watchdog deadline, i.e. proving nothing.
        expect(hiddenReasoningElapsedMs).toBeGreaterThan(idleTimeoutMs);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );
});
