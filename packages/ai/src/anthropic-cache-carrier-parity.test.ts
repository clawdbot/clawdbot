import type { Context, UserMessage } from "@openclaw/llm-core";
import { describe, expect, it, vi } from "vitest";
import {
  anthropicModel,
  context,
  captureAnthropicRequest,
  registerParityHostLifecycle,
} from "./provider-transport-parity.test-support.js";
import { createZeroUsage } from "./usage.test-support.js";

describe("Anthropic transient carrier cache parity", () => {
  registerParityHostLifecycle();

  it.each([
    { content: "Runtime context", longRetention: false },
    { content: [{ type: "text", text: "Runtime context" }], longRetention: false },
    { content: "Runtime context", longRetention: true },
    { content: [{ type: "text", text: "Runtime context" }], longRetention: true },
  ] satisfies { content: UserMessage["content"]; longRetention: boolean }[])(
    "advances the stable prefix across tools and a subsequent turn (%j)",
    async ({ content, longRetention }) => {
      vi.stubEnv("OPENCLAW_CACHE_RETENTION", longRetention ? "long" : "short");
      const cacheControl = { type: "ephemeral", ...(longRetention ? { ttl: "1h" } : {}) };
      const carrier: UserMessage = {
        role: "user",
        content,
        timestamp: 1,
        runtimeContextCarrier: true,
      };
      for (const implementation of ["provider", "transport"] as const) {
        const messages: Context["messages"] = [
          { role: "user", content: "", timestamp: 0 },
          { role: "user", content: "Question", timestamp: 1 },
        ];
        let previousPrefix: unknown[] = [];
        for (let round = 0; round < 3; round++) {
          if (round > 0) {
            const ids = [`call_${round}_a`, `call_${round}_b`];
            messages.push({
              role: "assistant",
              api: anthropicModel.api,
              provider: anthropicModel.provider,
              model: anthropicModel.id,
              timestamp: round * 2,
              stopReason: "toolUse",
              usage: createZeroUsage(),
              content: ids.map((id) => ({
                type: "toolCall",
                id,
                name: "lookup",
                arguments: { query: id },
              })),
            });
            messages.push(
              ...ids.map((id) => ({
                role: "toolResult" as const,
                toolCallId: id,
                toolName: "lookup",
                timestamp: round * 2 + 1,
                isError: false,
                content: [{ type: "text" as const, text: `Answer ${id}` }],
              })),
            );
          }
          const { payload } = await captureAnthropicRequest(implementation, {
            context: {
              ...context,
              messages: [...messages, carrier],
            },
          });
          const wire = payload.messages as Array<{ role: string; content: unknown }>;
          const carrierMessage = wire.at(-1);
          expect(carrierMessage).toEqual({ role: "user", content });
          const stable = wire.slice(0, -1);
          const deepest = stable.at(-1);
          expect(deepest?.content).toEqual(
            round === 0
              ? [{ type: "text", text: "Question", cache_control: cacheControl }]
              : [
                  expect.objectContaining({ type: "tool_result", tool_use_id: `call_${round}_a` }),
                  expect.objectContaining({
                    type: "tool_result",
                    tool_use_id: `call_${round}_b`,
                    cache_control: cacheControl,
                  }),
                ],
          );
          // Breakpoints intentionally advance; provider-visible prefix content must not change.
          const prefix = JSON.parse(
            JSON.stringify(stable, (key, value) => (key === "cache_control" ? undefined : value)),
          );
          expect(prefix.slice(0, previousPrefix.length)).toEqual(previousPrefix);
          previousPrefix = prefix;
          const markers = JSON.stringify(payload).match(/"cache_control":/g) ?? [];
          expect(markers.length).toBeLessThanOrEqual(4);
        }

        const { payload } = await captureAnthropicRequest(implementation, {
          context: {
            ...context,
            messages: [
              ...messages,
              {
                role: "assistant",
                api: anthropicModel.api,
                provider: anthropicModel.provider,
                model: anthropicModel.id,
                timestamp: 8,
                stopReason: "stop",
                usage: createZeroUsage(),
                content: [{ type: "text", text: "Done" }],
              },
              { role: "user", content: "Next question", timestamp: 9 },
              { ...carrier, timestamp: 10 },
            ],
          },
        });
        const next = payload.messages as Array<{ content: unknown }>;
        expect(next.at(-1)?.content).toEqual(content);
        expect(next.at(-2)?.content).toEqual([
          { type: "text", text: "Next question", cache_control: cacheControl },
        ]);
      }
    },
  );
});
