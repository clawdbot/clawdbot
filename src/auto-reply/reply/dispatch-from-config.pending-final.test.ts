import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import {
  deliverInboundReplyWithMessageSendContext,
  isDurableInboundReplyDeliveryHandled,
  throwIfDurableInboundReplyDeliveryFailed,
} from "../../channels/turn/durable-delivery.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { setReplyPayloadMetadata, type ReplyPayload } from "../reply-payload.js";
import {
  capturePendingFinalDeliveryIdentity,
  clearPendingFinalDeliveryAfterSuccess,
  reconcilePendingFinalDeliveryAfterSettlement,
} from "./dispatch-from-config.pending-final.js";
import { captureReplyDispatchDeliveryOutcome, createReplyDispatcher } from "./reply-dispatcher.js";
import type { ReplyDispatchRuntimeInfo } from "./reply-dispatcher.types.js";
import { retireTerminalRestartRecoverySourceClaim } from "./restart-recovery-claim.js";

const durablePluginId = "matrix";

// Minimal finalized-msg context satisfying the durable-delivery producer for a
// direct outbound text reply. Only the platform adapter is a fixture; the
// durable-send producer (sendDurableMessageBatch -> deliverCore) is real.
function durableCtxPayload() {
  return {
    CommandAuthorized: true,
    CommandTurn: { kind: "normal", source: "message", authorized: false },
  } as Parameters<typeof deliverInboundReplyWithMessageSendContext>[0]["ctxPayload"];
}

describe("pending final delivery restart proof", () => {
  let tmpDir: string;
  let storePath: string;
  const sessionKey = "agent:main:discord:direct:123";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pending-final-"));
    storePath = path.join(tmpDir, "sessions.json");
  });

  afterEach(async () => {
    setActivePluginRegistry(createTestRegistry([]));
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writePendingFinal(
    beforeAgentReplyState: "continue" | "handled-reply",
  ): Promise<void> {
    const entry: SessionEntry = {
      sessionId: "session",
      status: "running",
      startedAt: 10,
      lifecycleRunId: "active-run",
      updatedAt: Date.now(),
      pendingFinalDelivery: {
        kind: "replayable",
        text: "hook reply",
        createdAt: 1,
        intentId: "intent-1",
      },
      restartRecoveryBeforeAgentReplyState: beforeAgentReplyState,
      restartRecoveryForceSafeTools: beforeAgentReplyState === "handled-reply" ? true : undefined,
      restartRecoverySourceIngress: "channel",
    };
    await replaceSessionEntry({ storePath, sessionKey }, entry);
  }

  it.each(["continue", "handled-reply"] as const)(
    "clears %s provenance only after the exact pending intent succeeds",
    async (beforeAgentReplyState) => {
      await writePendingFinal(beforeAgentReplyState);
      const identity = capturePendingFinalDeliveryIdentity({
        intentId: "intent-1",
        sessionKey,
        storePath,
      });

      await clearPendingFinalDeliveryAfterSuccess({ identity, sessionKey, storePath });

      const entry = loadSessionEntry({ sessionKey, storePath }) as SessionEntry | undefined;
      expect(entry?.pendingFinalDelivery).toBeUndefined();
      expect(entry?.restartRecoveryBeforeAgentReplyState).toBeUndefined();
      expect(entry?.restartRecoveryForceSafeTools).toBeUndefined();
      expect(entry?.restartRecoverySourceIngress).toBeUndefined();
      expect(entry?.status).toBe(beforeAgentReplyState === "handled-reply" ? "done" : "running");
      expect(entry?.lifecycleRunId).toBe(
        beforeAgentReplyState === "handled-reply" ? undefined : "active-run",
      );
      if (beforeAgentReplyState === "handled-reply") {
        expect(entry?.endedAt).toBeTypeOf("number");
        expect(entry?.runtimeMs).toBeGreaterThanOrEqual(0);
      }
    },
  );

  it("finalizes a media-only hook turn after its exact transport intent succeeds", async () => {
    const entry: SessionEntry = {
      sessionId: "session",
      status: "running",
      startedAt: 10,
      lifecycleRunId: "media-run",
      updatedAt: Date.now(),
      pendingFinalDelivery: {
        kind: "transport-only",
        createdAt: Date.now(),
        intentId: "intent-media",
      },
      restartRecoveryBeforeAgentReplyState: "handled-unrecoverable",
      restartRecoverySourceIngress: "channel",
    };
    await replaceSessionEntry({ storePath, sessionKey }, entry);
    const identity = capturePendingFinalDeliveryIdentity({
      intentId: "intent-media",
      sessionKey,
      storePath,
    });

    await clearPendingFinalDeliveryAfterSuccess({ identity, sessionKey, storePath });

    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      status: "done",
      abortedLastRun: false,
    });
    expect(
      (loadSessionEntry({ sessionKey, storePath }) as SessionEntry | undefined)?.lifecycleRunId,
    ).toBeUndefined();
  });

  it("keeps normal-turn provenance when transport fails before delivery", async () => {
    await writePendingFinal("continue");
    const identity = capturePendingFinalDeliveryIdentity({
      intentId: "intent-1",
      sessionKey,
      storePath,
    });
    const payload: ReplyPayload = { text: "hook reply" };

    await reconcilePendingFinalDeliveryAfterSettlement({
      deliveries: [{ outcome: "failed-before-deliver", payload }],
      identity,
      replies: [payload],
      sessionKey,
      storePath,
    });

    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      pendingFinalDelivery: {
        kind: "replayable",
        text: "hook reply",
        intentId: "intent-1",
      },
      restartRecoveryBeforeAgentReplyState: "continue",
      restartRecoverySourceIngress: "channel",
    });
  });

  it("does not retire a source while its terminal provider outcome is unknown", async () => {
    await replaceSessionEntry(
      { storePath, sessionKey },
      {
        sessionId: "session",
        status: "done",
        updatedAt: Date.now(),
        restartRecoveryDeliveryReceiptState: "terminal-pending",
        restartRecoveryDeliveryToolCallId: "message-call-1",
        restartRecoveryDeliveryRunId: "recovery-1",
        restartRecoveryDeliverySourceRunId: "source-1",
      },
    );

    await expect(
      retireTerminalRestartRecoverySourceClaim({
        sessionId: "session",
        sessionKey,
        sourceTurnId: "source-1",
        storePath,
      }),
    ).resolves.toBeUndefined();

    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      restartRecoveryDeliveryReceiptState: "terminal-pending",
      restartRecoveryDeliveryToolCallId: "message-call-1",
      restartRecoveryDeliveryRunId: "recovery-1",
      restartRecoveryDeliverySourceRunId: "source-1",
    });
    expect(
      loadSessionEntry({ sessionKey, storePath })?.restartRecoveryTerminalRunIds,
    ).toBeUndefined();
  });

  it("retains the pending final when some payloads failed before delivery and others were block-deduped", async () => {
    // Three intent payloads are pending; A delivered, B failed before deliver
    // (proven not sent), C was block-deduped (no delivery entry). The marker
    // must be retained with B's text — not cleared, or B is permanently lost.
    const payloadA = setReplyPayloadMetadata(
      { text: "reply A" },
      { pendingFinalDeliveryIntentId: "intent-1", pendingFinalDeliveryRetryText: "retry A" },
    );
    const payloadB = setReplyPayloadMetadata(
      { text: "reply B" },
      { pendingFinalDeliveryIntentId: "intent-1", pendingFinalDeliveryRetryText: "retry B" },
    );
    const payloadC = setReplyPayloadMetadata(
      { text: "reply C" },
      { pendingFinalDeliveryIntentId: "intent-1", pendingFinalDeliveryRetryText: "retry C" },
    );
    await replaceSessionEntry(
      { storePath, sessionKey },
      {
        sessionId: "session",
        status: "running",
        startedAt: 10,
        updatedAt: Date.now(),
        pendingFinalDelivery: {
          kind: "replayable",
          text: "retry A\n\nretry B\n\nretry C",
          createdAt: 1,
          intentId: "intent-1",
        },
      },
    );
    const identity = capturePendingFinalDeliveryIdentity({
      intentId: "intent-1",
      sessionKey,
      storePath,
    });

    await reconcilePendingFinalDeliveryAfterSettlement({
      deliveries: [
        { outcome: "delivered", payload: payloadA },
        { outcome: "failed-before-deliver", payload: payloadB },
      ],
      identity,
      replies: [payloadA, payloadB, payloadC],
      sessionKey,
      storePath,
    });

    const entry = loadSessionEntry({ sessionKey, storePath });
    expect(entry?.pendingFinalDelivery?.kind).toBe("replayable");
    expect(
      entry?.pendingFinalDelivery?.kind === "replayable"
        ? entry.pendingFinalDelivery.text
        : undefined,
    ).toContain("retry B");
  });

  it("does not replay a block-deduped payload when only a failed-before-deliver payload is present (#119162)", async () => {
    // The all-failed shortcut must not retain the block-deduped payload C in the
    // marker — it was already visible, so recovery must not resend it.
    const payloadB = setReplyPayloadMetadata(
      { text: "reply B" },
      { pendingFinalDeliveryIntentId: "intent-1", pendingFinalDeliveryRetryText: "retry B" },
    );
    const payloadC = setReplyPayloadMetadata(
      { text: "reply C" },
      { pendingFinalDeliveryIntentId: "intent-1", pendingFinalDeliveryRetryText: "retry C" },
    );
    await replaceSessionEntry(
      { storePath, sessionKey },
      {
        sessionId: "session",
        status: "running",
        startedAt: 10,
        updatedAt: Date.now(),
        pendingFinalDelivery: {
          kind: "replayable",
          text: "retry B\n\nretry C",
          createdAt: 1,
          intentId: "intent-1",
        },
      },
    );
    const identity = capturePendingFinalDeliveryIdentity({
      intentId: "intent-1",
      sessionKey,
      storePath,
    });

    await reconcilePendingFinalDeliveryAfterSettlement({
      deliveries: [{ outcome: "failed-before-deliver", payload: payloadB }],
      identity,
      replies: [payloadB, payloadC],
      sessionKey,
      storePath,
    });

    const entry = loadSessionEntry({ sessionKey, storePath });
    expect(entry?.pendingFinalDelivery?.kind).toBe("replayable");
    const retryText =
      entry?.pendingFinalDelivery?.kind === "replayable"
        ? entry.pendingFinalDelivery.text
        : undefined;
    expect(retryText).toBe("retry B");
    expect(retryText).not.toContain("retry C");
  });

  it("retains the pending final narrowed to the real transport-failed payload across mixed settlement (#119161)", async () => {
    // Real transport client proof: the failed-before-deliver outcome for payload B
    // is produced by a REAL channel adapter (sendText throws
    // PlatformMessageNotDispatchedError) driven through the REAL durable-delivery
    // producer (sendDurableMessageBatch -> deliverCore) and the REAL reply-dispatcher
    // classification (deliverOnce + isRetryableNoSendFailure) — not injected. Payload
    // A succeeds through the same real adapter; payload C is block-deduped (no
    // delivery entry, as finalization omits block-deduped payloads before settlement).
    // Settlement must retain the marker narrowed to B's retry text — not cleared, or
    // B is permanently lost; not widened to C, or C is replayed as a duplicate.
    const failingText = "reply B";
    const adapter: ChannelOutboundAdapter = {
      deliveryMode: "direct",
      sendTextOnlyErrorPayloads: true,
      deliveryCapabilities: {
        durableFinal: { text: true, payload: true, messageSendingHooks: true },
      },
      // Real adapter boundary: throw a proven-not-sent error for payload B; succeed
      // for payload A. C never reaches the adapter (block-deduped before delivery).
      sendText: async (ctx) => {
        if (ctx.text === failingText) {
          throw new PlatformMessageNotDispatchedError("platform rejected before dispatch", {
            cause: new Error("pre-connect refused"),
            retryable: true,
          });
        }
        return { channel: durablePluginId, messageId: `msg-${ctx.text}` };
      },
      sendPayload: async (ctx) => ({
        channel: durablePluginId,
        messageId: `msg-${ctx.payload.text ?? ""}`,
      }),
    };
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: durablePluginId,
          source: "test",
          plugin: createOutboundTestPlugin({ id: durablePluginId, outbound: adapter }),
        },
      ]),
    );

    const payloadA = setReplyPayloadMetadata(
      { text: "reply A" },
      { pendingFinalDeliveryIntentId: "intent-1", pendingFinalDeliveryRetryText: "retry A" },
    );
    const payloadB = setReplyPayloadMetadata(
      { text: failingText },
      { pendingFinalDeliveryIntentId: "intent-1", pendingFinalDeliveryRetryText: "retry B" },
    );
    const payloadC = setReplyPayloadMetadata(
      { text: "reply C" },
      { pendingFinalDeliveryIntentId: "intent-1", pendingFinalDeliveryRetryText: "retry C" },
    );

    // Real lifecycle deliver callback (lifecycle.ts:501-522): drive the real durable
    // producer, rethrow failed deliveries, and return the settled delivery otherwise.
    const deliver = async (payload: ReplyPayload, info: ReplyDispatchRuntimeInfo) => {
      const durable = await deliverInboundReplyWithMessageSendContext({
        cfg: {},
        channel: durablePluginId,
        to: "!room:example",
        agentId: "main",
        info,
        payload,
        ctxPayload: durableCtxPayload(),
      });
      throwIfDurableInboundReplyDeliveryFailed(durable);
      if (isDurableInboundReplyDeliveryHandled(durable)) {
        return durable.delivery;
      }
      return undefined;
    };

    // Drive A through the real transport client -> real "delivered" outcome.
    const outcomeA = captureReplyDispatchDeliveryOutcome(payloadA);
    const dispatcherA = createReplyDispatcher({ deliver });
    dispatcherA.sendFinalReply(payloadA);
    dispatcherA.markComplete();
    await dispatcherA.waitForIdle();
    const realOutcomeA = await outcomeA.promise;

    // Drive B through the real transport client (adapter throws) -> real
    // "failed-before-deliver" outcome, classified by the real dispatcher.
    const outcomeB = captureReplyDispatchDeliveryOutcome(payloadB);
    const dispatcherB = createReplyDispatcher({ deliver });
    dispatcherB.sendFinalReply(payloadB);
    dispatcherB.markComplete();
    await dispatcherB.waitForIdle();
    const realOutcomeB = await outcomeB.promise;

    // Real classification: A delivered, B proven-not-sent before deliver.
    expect(realOutcomeA).toBe("delivered");
    expect(realOutcomeB).toBe("failed-before-deliver");

    await replaceSessionEntry(
      { storePath, sessionKey },
      {
        sessionId: "session",
        status: "running",
        startedAt: 10,
        updatedAt: Date.now(),
        pendingFinalDelivery: {
          kind: "replayable",
          text: "retry A\n\nretry B\n\nretry C",
          createdAt: 1,
          intentId: "intent-1",
        },
      },
    );
    const identity = capturePendingFinalDeliveryIdentity({
      intentId: "intent-1",
      sessionKey,
      storePath,
    });

    // Feed the REAL outcomes (not injected) to settlement. C is omitted from
    // deliveries — block-deduped payloads have no delivery record at settlement,
    // matching the finalization caller contract (dispatch-from-config.finalize.ts).
    await reconcilePendingFinalDeliveryAfterSettlement({
      deliveries: [
        { outcome: realOutcomeA, payload: payloadA },
        { outcome: realOutcomeB, payload: payloadB },
      ],
      identity,
      replies: [payloadA, payloadB, payloadC],
      sessionKey,
      storePath,
    });

    const entry = loadSessionEntry({ sessionKey, storePath });
    expect(entry?.pendingFinalDelivery?.kind).toBe("replayable");
    const retryText =
      entry?.pendingFinalDelivery?.kind === "replayable"
        ? entry.pendingFinalDelivery.text
        : undefined;
    // Retained narrowed to B (the real transport-failed payload), not cleared and
    // not widened to the block-deduped C.
    expect(retryText).toContain("retry B");
    expect(retryText).not.toContain("retry A");
    expect(retryText).not.toContain("retry C");
  });
});
