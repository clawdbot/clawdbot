import type { Message } from "grammy/types";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelegramInboundBuffers } from "./bot-handlers.inbound-buffer.js";
import type { TelegramMessagePipeline } from "./bot-handlers.message-pipeline.js";
import type { TelegramContext } from "./bot/types.js";
import { createTelegramIngressResolver, createTelegramIngressSubject } from "./ingress.js";

describe("Telegram inbound provenance buffering", () => {
  afterEach(() => clearRuntimeConfigSnapshot());

  it.each([false, true])(
    "preserves every authorization resolver through collection (hot reload: %s)",
    async (reload) => {
      const cfg = { messages: { inbound: { debounceMs: reload ? 0 : 50 } } };
      setRuntimeConfigSnapshot(cfg, cfg);
      const processMessageWithReplyChain = vi.fn<
        TelegramMessagePipeline["processMessageWithReplyChain"]
      >(async () => ({ kind: "completed" as const }));
      const message = {
        promptContextBoundaryOptions: () => ({}),
        latestPromptContextMinTimestampMs: () => undefined,
        latestPromptContextAmbientWatermark: () => undefined,
        mergeDispatchDedupeClaims: () => [],
        releaseDispatchDedupeClaims: () => undefined,
        buildFailedProcessingResult: (error: unknown) => ({ kind: "failed-retryable", error }),
        settleSpooledReplayParticipants: () => undefined,
        createSpooledReplayParticipantForBufferedWork: () => undefined,
        spooledReplayOptions: () => ({}),
        buildSyntheticTextMessage: ({ base, text }: { base: Message; text: string }) => ({
          ...base,
          text,
        }),
        buildSyntheticContext: (ctx: TelegramContext, syntheticMessage: Message) => ({
          ...ctx,
          message: syntheticMessage,
        }),
        formatTelegramAmbientTranscriptBody: () => undefined,
        processMessageWithReplyChain,
      } as unknown as TelegramMessagePipeline;
      const { inboundDebouncer } = createTelegramInboundBuffers({
        params: {
          cfg,
          bot: { api: { sendMessage: vi.fn() } } as never,
          runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
          opts: { token: "test-token" },
        },
        message,
      });
      if (reload) {
        const current = { messages: { inbound: { byChannel: { telegram: 50 } } } };
        setRuntimeConfigSnapshot(current, current);
      }
      const resolver = createTelegramIngressResolver({ accountId: "default" });
      const ingress = await Promise.all([
        resolver.message({
          subject: createTelegramIngressSubject("42"),
          conversation: { kind: "direct", id: "42" },
          dmPolicy: "open",
        }),
        resolver.message({
          subject: createTelegramIngressSubject("42"),
          conversation: { kind: "direct", id: "42" },
          dmPolicy: "open",
        }),
      ]);
      const ingressResolvers = ingress.map((result) => async () => await Promise.resolve(result));
      const baseMessage = {
        message_id: 1,
        date: 1,
        chat: { id: 42, type: "private", first_name: "Alice" },
        from: { id: 42, is_bot: false, first_name: "Alice" },
        text: "hello",
      } as Message;
      const ctx = { message: baseMessage } as TelegramContext;

      for (const [index, channelIngressResolver] of ingressResolvers.entries()) {
        await inboundDebouncer.enqueue({
          ctx,
          msg: { ...baseMessage, message_id: index + 1, text: `message ${index + 1}` },
          allMedia: [],
          storeAllowFrom: [],
          receivedAtMs: index + 1,
          debounceKey: "telegram:default:42:42:default",
          debounceLane: "default",
          threadSpec: { scope: "none" },
          dispatchDedupeClaims: [],
          channelIngressResolvers: [channelIngressResolver],
        });
      }
      await inboundDebouncer.drain();

      expect(processMessageWithReplyChain).toHaveBeenCalledTimes(1);
      const carried =
        processMessageWithReplyChain.mock.calls[0]?.[0]?.options?.channelIngressResolvers;
      expect(carried).toEqual(ingressResolvers);
      expect(carried?.[0]).toBe(ingressResolvers[0]);
      expect(carried?.[1]).toBe(ingressResolvers[1]);
    },
  );
});
