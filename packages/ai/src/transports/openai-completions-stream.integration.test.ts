import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { streamWithIdleTimeout } from "../../../../src/agents/embedded-agent-runner/run/llm-idle-timeout.js";
import { shouldEmitOpenAICompletionsReasoning } from "./openai-completions-stream.js";
import { createOpenAICompletionsTransportStreamFn } from "./openai-completions-transport.js";
import { makeCompletionsChunk, makeCompletionsModel } from "./openai-completions.test-support.js";

describe("openai completions stream", () => {
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

  it.each(["reasoning_content", "reasoning"] as const)(
    "keeps hidden local %s streams alive beyond the model idle timeout",
    async (reasoningField) => {
      // The regression under guard is "hidden reasoning stops resetting the idle
      // watchdog", so the hidden phase has to outlast idleTimeoutMs or a broken
      // build would pass. Pace chunks far below that budget instead of near it:
      // a loaded runner stretches every inter-chunk gap, and one gap wider than
      // the timeout inverts the ratio into a false idle timeout.
      const idleTimeoutMs = 1_000;
      const reasoningChunkDelayMs = 5;
      const hiddenReasoningDurationMs = idleTimeoutMs + 200;
      let hiddenReasoningElapsedMs = 0;
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
        const streamFn = streamWithIdleTimeout(
          createOpenAICompletionsTransportStreamFn(),
          idleTimeoutMs,
          onIdleTimeout,
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
        for await (const event of stream as AsyncIterable<{ type: string; delta?: string }>) {
          if (event.type === "text_delta") {
            text += event.delta ?? "";
          }
          if (event.type === "thinking_delta") {
            thinking += event.delta ?? "";
          }
        }

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
