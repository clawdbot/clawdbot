import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { streamSimple } from "openclaw/plugin-sdk/llm";
import { isTruthyEnvValue } from "openclaw/plugin-sdk/runtime-env";
import { describe, expect, it } from "vitest";
import {
  buildAnthropicCompactionContextChunk,
  resolveAnthropicCompactionLiveSettings,
} from "./server-compaction-live.test-support.js";
import { wrapAnthropicProviderStream } from "./stream-wrappers.js";

const settings = resolveAnthropicCompactionLiveSettings(
  process.env,
  isTruthyEnvValue(process.env.OPENCLAW_LIVE_TEST),
);
const describeLive = settings.enabled ? describe : describe.skip;

describeLive("Anthropic server compaction live", () => {
  it(
    "captures and replays a compaction summary without losing durable context",
    async () => {
      if (!settings.enabled) {
        return;
      }
      const model = {
        id: settings.modelId,
        name: settings.modelId,
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8_192,
      } satisfies Model<"anthropic-messages">;
      let sawCompactionControls = false;
      let sawCompactionReplay = false;
      let sawCompactionBeta = false;
      const observingBase: StreamFn = (callModel, context, options) => {
        sawCompactionBeta ||=
          options?.headers?.["anthropic-beta"]?.includes("compact-2026-01-12") === true;
        return streamSimple(callModel, context, {
          ...options,
          onPayload: async (payload, payloadModel) => {
            const patchedPayload = (await options?.onPayload?.(payload, payloadModel)) ?? payload;
            if (
              patchedPayload &&
              typeof patchedPayload === "object" &&
              !Array.isArray(patchedPayload)
            ) {
              const record = patchedPayload as Record<string, unknown>;
              sawCompactionControls ||= record.context_management !== undefined;
              const messages = Array.isArray(record.messages) ? record.messages : [];
              sawCompactionReplay ||= messages.some((message) => {
                if (!message || typeof message !== "object" || Array.isArray(message)) {
                  return false;
                }
                const content = (message as Record<string, unknown>).content;
                return (
                  Array.isArray(content) &&
                  content[0] !== null &&
                  typeof content[0] === "object" &&
                  !Array.isArray(content[0]) &&
                  (content[0] as Record<string, unknown>).type === "compaction"
                );
              });
            }
            return patchedPayload;
          },
        });
      };
      const wrapped = wrapAnthropicProviderStream({
        streamFn: observingBase,
        modelId: model.id,
        extraParams: {
          anthropicServerCompaction: true,
          anthropicCompactThreshold: settings.compactThreshold,
        },
      } as never);
      if (!wrapped) {
        throw new Error("Anthropic compaction wrapper was not installed");
      }
      const messages: Context["messages"] = [];
      const marker = `ANTHROPIC-COMPACTION-${Date.now().toString(36).toUpperCase()}`;
      const runTurn = async (content: string) => {
        messages.push({ role: "user", content, timestamp: Date.now() });
        const stream = await Promise.resolve(
          wrapped(model, { messages }, {
            apiKey: settings.apiKey,
            authProfileId: "anthropic:live-compaction",
            sessionId: "anthropic-live-compaction",
            timeoutMs: settings.requestTimeoutMs,
          } as never),
        );
        const assistant = await stream.result();
        if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
          throw new Error(
            `live turn failed (${assistant.stopReason}): ${assistant.errorMessage ?? "unknown"}`,
          );
        }
        messages.push(assistant);
        console.log(
          `[live-turn] stop=${assistant.stopReason} blocks=${assistant.content
            .map((block) => block.type)
            .join(",")} replay=${assistant.providerReplay?.type ?? "none"}`,
        );
        return assistant;
      };

      await runTurn(`Remember durable marker ${marker}. Reply with exactly ${marker}.`);
      const denseChunk = buildAnthropicCompactionContextChunk(settings.denseTurnChars);
      let captured = false;
      for (let turn = 1; turn <= settings.maxDenseTurns && !captured; turn += 1) {
        const assistant = await runTurn(
          `${denseChunk}\n\nReply with exactly ANTHROPIC-CONTEXT-${turn}-OK.`,
        );
        captured = assistant.providerReplay?.type === "anthropic-compaction";
      }

      expect(sawCompactionBeta).toBe(true);
      expect(sawCompactionControls).toBe(true);
      expect(captured).toBe(true);
      const recall = await runTurn(
        "Reply with exactly the durable marker I asked you to remember.",
      );
      expect(
        recall.content.some((block) => block.type === "text" && block.text.trim() === marker),
      ).toBe(true);
      expect(sawCompactionBeta).toBe(true);
      expect(sawCompactionControls).toBe(true);
      expect(sawCompactionReplay).toBe(true);
    },
    settings.enabled ? settings.suiteTimeoutMs : 60_000,
  );
});
