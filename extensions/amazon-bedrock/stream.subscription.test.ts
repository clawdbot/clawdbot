import {
  BedrockRuntimeClient,
  ConversationRole,
  StopReason,
} from "@aws-sdk/client-bedrock-runtime";
import type { Message, Model } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import bedrockPlugin from "./index.js";
import { createSubscribedSessionHarness } from "../../src/agents/embedded-agent-subscribe.e2e-harness.js";
import { runAgentLoop } from "../../src/agents/runtime/index.js";
import { onAgentEvent } from "../../src/infra/agent-events.js";
import { registerSingleProviderPlugin } from "../../src/test-utils/plugin-registration.js";
import { createDeferred } from "../../test/helpers/promise.js";

const model = {
  id: "amazon.nova-micro-v1:0",
  name: "Reasoning subscription fixture",
  api: "bedrock-converse-stream",
  provider: "amazon-bedrock",
  baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
} satisfies Model;

afterEach(() => vi.restoreAllMocks());

describe("native provider reasoning subscription", () => {
  it("uses Bedrock's authoritative replacement after redaction and a later same-index delta", async () => {
    const firstDeltaConsumed = createDeferred<void>();
    async function* responses() {
      yield { messageStart: { role: ConversationRole.ASSISTANT } };
      yield {
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { reasoningContent: { text: "before" } },
        },
      };
      await firstDeltaConsumed.promise;
      yield {
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { reasoningContent: { redactedContent: new Uint8Array([1, 2, 3]) } },
        },
      };
      yield {
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { reasoningContent: { text: " after" } },
        },
      };
      yield { contentBlockStop: { contentBlockIndex: 0 } };
      yield { messageStop: { stopReason: StopReason.END_TURN } };
    }
    vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
      $metadata: { httpStatusCode: 200 },
      stream: responses(),
    } as never);
    const provider = await registerSingleProviderPlugin(bedrockPlugin);
    const streamFn = provider.createStreamFn?.({
      provider: model.provider,
      modelId: model.id,
      model,
    });
    expect(streamFn).toBeTypeOf("function");
    if (!streamFn) {
      throw new Error("Bedrock stream registration missing");
    }
    const runId = "bedrock-native-reasoning-replacement";
    const { emit, subscription } = createSubscribedSessionHarness({ runId });
    const thinking: Array<{ text: unknown; delta: unknown }> = [];
    const unsubscribe = onAgentEvent((event) => {
      if (event.runId === runId && event.stream === "thinking") {
        thinking.push({ text: event.data.text, delta: event.data.delta });
      }
    });
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
          emit(event);
          await subscription.waitForPendingEvents();
          if (
            event.type === "message_update" &&
            event.assistantMessageEvent.type === "thinking_delta"
          ) {
            firstDeltaConsumed.resolve();
          }
        },
        undefined,
        streamFn,
      );
      expect(thinking).toEqual([
        { text: "before", delta: "before" },
        { text: "[Reasoning redacted] after", delta: "[Reasoning redacted] after" },
      ]);
    } finally {
      firstDeltaConsumed.resolve();
      unsubscribe();
      subscription.unsubscribe();
    }
  });
});
