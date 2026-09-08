import {
  AssistantMessageEventStream,
  type AssistantMessage,
  type Message,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { processCompletionsStream } from "../../packages/ai/src/transports/openai-completions-stream.js";
import { onAgentEventForRun } from "../infra/agent-events.js";
import { runAgentLoop, type AgentEvent } from "../plugin-sdk/agent-core.js";
import { createDeferredCore } from "../shared/deferred.js";
import { subscribeEmbeddedAgentSession } from "./embedded-agent-subscribe.js";
import { makeZeroUsageSnapshot } from "./usage.js";

export const NATIVE_REASONING_BENCH_PREFIX = "REASONING_BENCH:";

export async function measureNativeReasoningSubscription(
  options: {
    signal?: AbortSignal;
    chunks?: string[];
    runId?: string;
  } = {},
) {
  const chunks =
    options.chunks ??
    Array.from({ length: 4096 }, (_, index) =>
      index === 0
        ? NATIVE_REASONING_BENCH_PREFIX + "x".repeat(64 - NATIVE_REASONING_BENCH_PREFIX.length)
        : "x".repeat(64),
    );
  const model = {
    id: "reasoning-fixture",
    name: "Reasoning fixture",
    api: "openai-completions",
    provider: "synthetic",
    baseUrl: "https://example.test/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 128_000,
  } satisfies Model;
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: makeZeroUsageSnapshot(),
    stopReason: "stop",
    timestamp: 1,
  };
  const acknowledgments = chunks.map(() => createDeferredCore());
  const releaseAcknowledgments = () => {
    acknowledgments.forEach((acknowledgment) => acknowledgment.resolve());
  };
  options.signal?.addEventListener("abort", releaseAcknowledgments, { once: true });
  if (options.signal?.aborted) {
    releaseAcknowledgments();
  }
  async function* wire() {
    for (const [index, text] of chunks.entries()) {
      yield {
        id: "reasoning-fixture",
        object: "chat.completion.chunk" as const,
        created: 1,
        model: model.id,
        choices: [
          {
            index: 0,
            delta: { role: "assistant" as const, reasoning_content: text },
            finish_reason: null,
          },
        ],
      };
      await acknowledgments[index]!.promise;
    }
    yield {
      id: "reasoning-fixture",
      object: "chat.completion.chunk" as const,
      created: 1,
      model: model.id,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" as const }],
    };
  }
  let handler: ((event: AgentEvent) => void) | undefined;
  const session = {
    subscribe(callback: (event: AgentEvent) => void) {
      handler = callback;
      return () => {
        handler = undefined;
      };
    },
  } as unknown as Parameters<typeof subscribeEmbeddedAgentSession>[0]["session"];
  const runId = options.runId ?? "native-reasoning-work-fixture";
  const subscription = subscribeEmbeddedAgentSession({ session, runId });
  let lastText = "";
  let joinedDelta = "";
  let events = 0;
  const unsubscribe = onAgentEventForRun(runId, (event) => {
    if (event.stream === "thinking") {
      lastText = String(event.data.text);
      joinedDelta += String(event.data.delta);
      events++;
    }
  });
  const stream = new AssistantMessageEventStream();
  stream.push({ type: "start", partial: output });
  const started = performance.now();
  const rssBefore = process.memoryUsage().rss;
  let producing: Promise<void> | undefined;
  let consumed = 0;
  try {
    await runAgentLoop(
      [{ role: "user", content: "Explain the fixture.", timestamp: 0 }],
      { systemPrompt: "", messages: [] },
      {
        model,
        convertToLlm: (messages) =>
          messages.filter(
            (message): message is Message =>
              message.role === "user" ||
              message.role === "assistant" ||
              message.role === "toolResult",
          ),
      },
      async (event) => {
        handler?.(event);
        await subscription.waitForPendingEvents();
        if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "thinking_delta"
        ) {
          acknowledgments[consumed]?.resolve();
          consumed += 1;
        }
      },
      options.signal,
      (_model, _context, streamOptions) => {
        producing = processCompletionsStream(wire(), output, model, stream, {
          signal: streamOptions?.signal,
        }).then(
          () => {
            stream.push({ type: "done", reason: "stop", message: output });
            stream.end();
          },
          (error: unknown) => {
            stream.end({ ...output, stopReason: "error", errorMessage: String(error) });
            throw error;
          },
        );
        void producing.catch(() => {});
        return stream;
      },
    );
    await producing;
    return {
      chunks: chunks.length,
      chars: chunks.join("").length,
      events,
      elapsedMs: performance.now() - started,
      rssBefore,
      rssAfter: process.memoryUsage().rss,
      maxRssKiB: process.resourceUsage().maxRSS,
      textMatches: lastText === chunks.join("").trim(),
      deltaMatches: joinedDelta === chunks.join("").trim(),
    };
  } finally {
    options.signal?.removeEventListener("abort", releaseAcknowledgments);
    releaseAcknowledgments();
    unsubscribe();
    subscription.unsubscribe();
    await producing?.catch(() => {});
  }
}
