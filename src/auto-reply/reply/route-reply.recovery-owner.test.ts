import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import { drainMatrixReconnect } from "../../infra/outbound/deliver.queue-integration.test-support.js";
import {
  installDeliveryQueueTmpDirHooks,
  loadPendingDeliveries,
} from "../../infra/outbound/delivery-queue.test-helpers.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { buildCaptionedFinalTextFallback } from "../../tts/captioned-final.js";
import { dispatchInboundMessageWithRoutedChannelDispatcher } from "../dispatch.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import { createReplyTurnLedger } from "./dispatch-from-config.turn-ledger.js";
import { attachReplyDispatchUndeliveredFallback } from "./reply-dispatcher.js";
import { routeReply } from "./route-reply.js";

describe("caption fallback recovery ownership", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", fixtures.tmpDir());
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it.each(
    [false, true].flatMap((withCustody) =>
      (["none", "before", "after"] as const).map((callerFailure) => ({
        withCustody,
        callerFailure,
      })),
    ),
  )(
    "keeps retained no-send as the only retry owner, custody=$withCustody caller=$callerFailure",
    async ({ withCustody, callerFailure }) => {
      const custody = {
        storePath: path.join(fixtures.tmpDir(), "sessions.json"),
        sessionKey: "agent:main:recovery-owner",
        sessionId: "owner-session",
        intentId: "owner-intent",
        deliveryId: "owner-delivery",
      };
      if (withCustody) {
        await replaceSessionEntry(custody, {
          sessionId: custody.sessionId,
          updatedAt: Date.now(),
          pendingFinalDelivery: {
            kind: "replayable",
            text: "The completed answer",
            createdAt: Date.now(),
            intentId: custody.intentId,
            deliveries: [{ id: custody.deliveryId, state: "prepared" }],
          },
        });
      }
      let ledger: ReturnType<typeof createReplyTurnLedger> | undefined;
      let settled = false;
      const visible: string[] = [];
      let mediaAttempts = 0;
      const outbound: ChannelOutboundAdapter = {
        deliveryMode: "direct",
        sendText: async ({ onPlatformSendDispatch }) => {
          await onPlatformSendDispatch?.();
          visible.push("caption");
          return { channel: "matrix", messageId: "caption-sent" };
        },
        sendMedia: async ({ onPlatformSendDispatch }) => {
          await onPlatformSendDispatch?.();
          if (mediaAttempts++ === 0) {
            throw new PlatformMessageNotDispatchedError("media was not dispatched", {
              cause: new Error("connection unavailable"),
            });
          }
          visible.push("media");
          return { channel: "matrix", messageId: "media-recovered" };
        },
      };
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "matrix",
            source: "test",
            plugin: createOutboundTestPlugin({ id: "matrix", outbound }),
          },
        ]),
      );
      await dispatchInboundMessageWithRoutedChannelDispatcher({
        cfg: {},
        ctx: {
          Body: "Continue",
          AgentId: "main",
          SessionKey: custody.sessionKey,
          Provider: "matrix",
          Surface: "matrix",
          OriginatingChannel: "matrix",
          OriginatingTo: "!room:example",
        },
        dispatcherOptions: {
          propagateRetryableNoSendFailure: true,
          beforeDeliver: (payload) => {
            if (payload.text === "preflight") {
              throw new PlatformMessageNotDispatchedError("preflight did not dispatch", {
                cause: new Error("offline"),
              });
            }
            return payload;
          },
          deliver: async (payload, info) => {
            const sent = await routeReply({
              cfg: {},
              payload,
              channel: "matrix",
              to: "!room:example",
              agentId: "main",
              sessionKey: custody.sessionKey,
              replyKind: info.kind,
              mirror: false,
            });
            if (!sent.ok) {
              throw new Error(sent.error, { cause: sent.cause });
            }
            return {
              visibleReplySent: sent.delivered,
              ...(sent.ambiguous ? { ambiguous: true } : {}),
              ...(sent.suppressed ? { suppression: { reason: sent.reason } } : {}),
            };
          },
        },
        dispatchReplyFromConfig: async ({ dispatcher }) => {
          const payload = {
            text: "The completed answer",
            mediaUrl: "https://example.com/answer.ogg",
            audioAsVoice: true,
          };
          if (withCustody) {
            setReplyPayloadMetadata(payload, { pendingFinalDeliveryCompletion: custody });
          }
          attachReplyDispatchUndeliveredFallback(payload, buildCaptionedFinalTextFallback(payload));
          ledger = createReplyTurnLedger(dispatcher);
          if (callerFailure === "before") {
            ledger.sendQueued("tool", { text: "preflight" });
          }
          ledger.sendQueued("final", payload);
          if (callerFailure === "after") {
            ledger.sendQueued("tool", { text: "preflight" });
          }
          await ledger.settleQueued();
          settled = true;
          return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
        },
      });
      const beforeRecovery = [...visible];
      expect(settled).toBe(true);
      expect(ledger?.mayHaveDelivered()).toBe(false);
      expect(ledger?.hasObservedDelivery()).toBe(false);
      expect(ledger?.canAttemptFallback()).toBe(false);
      if (withCustody) {
        expect(
          (loadSessionEntry(custody) as InternalSessionEntry)?.pendingFinalDelivery?.deliveries,
        ).toEqual([{ id: custody.deliveryId, state: "queued" }]);
      }
      expect(await loadPendingDeliveries(fixtures.tmpDir())).toHaveLength(1);

      await drainMatrixReconnect({ deliver: deliverOutboundPayloads, stateDir: fixtures.tmpDir() });

      expect({ beforeRecovery, afterRecovery: visible }).toEqual({
        beforeRecovery: [],
        afterRecovery: ["media"],
      });
      expect(await loadPendingDeliveries(fixtures.tmpDir())).toHaveLength(0);
      if (withCustody) {
        expect(
          (loadSessionEntry(custody) as InternalSessionEntry)?.pendingFinalDelivery?.deliveries,
        ).toEqual([{ id: custody.deliveryId, state: "delivered" }]);
      }
    },
  );
});
