import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../reply-payload.js";
import {
  clearPendingFinalDeliveryAfterSuccess,
  suppressPendingFinalDelivery,
} from "./dispatch-from-config.pending-final.js";
import { retireTerminalRestartRecoverySourceClaim } from "./restart-recovery-claim.js";

describe("pending final delivery restart proof", () => {
  let tmpDir: string;
  let storePath: string;
  const sessionKey = "agent:main:discord:direct:123";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pending-final-"));
    storePath = path.join(tmpDir, "sessions.json");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writePendingFinal(
    beforeAgentReplyState: "handled-reply" | undefined,
    state: "prepared" | "delivered" = "delivered",
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
        deliveries: [{ id: "delivery-1", state }],
      },
      restartRecoveryBeforeAgentReplyState: beforeAgentReplyState,
      restartRecoveryForceSafeTools: beforeAgentReplyState === "handled-reply" ? true : undefined,
      restartRecoverySourceIngress: "channel",
    };
    await replaceSessionEntry({ storePath, sessionKey }, entry);
  }

  function pendingFinalPayload(deliveryId = "delivery-1"): ReplyPayload {
    const payload: ReplyPayload = { text: "hook reply" };
    setReplyPayloadMetadata(payload, {
      pendingFinalDeliveryCompletion: {
        deliveryId,
        intentId: "intent-1",
        sessionId: "session",
        sessionKey,
        storePath,
      },
    });
    return payload;
  }

  it.each([undefined, "handled-reply"] as const)(
    "clears %s provenance only after the exact pending intent succeeds",
    async (beforeAgentReplyState) => {
      await writePendingFinal(beforeAgentReplyState);
      const identity =
        getReplyPayloadMetadata(pendingFinalPayload())?.pendingFinalDeliveryCompletion;

      await clearPendingFinalDeliveryAfterSuccess(identity);

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
        deliveries: [{ id: "delivery-media", state: "delivered" }],
      },
      restartRecoveryBeforeAgentReplyState: "handled-reply",
      restartRecoverySourceIngress: "channel",
    };
    await replaceSessionEntry({ storePath, sessionKey }, entry);
    const payload: ReplyPayload = { mediaUrl: "https://example.test/image.png" };
    setReplyPayloadMetadata(payload, {
      pendingFinalDeliveryCompletion: {
        deliveryId: "delivery-media",
        intentId: "intent-media",
        sessionId: "session",
        sessionKey,
        storePath,
      },
    });
    const identity = getReplyPayloadMetadata(payload)?.pendingFinalDeliveryCompletion;

    await clearPendingFinalDeliveryAfterSuccess(identity);

    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      status: "done",
      abortedLastRun: false,
    });
    expect(
      (loadSessionEntry({ sessionKey, storePath }) as SessionEntry | undefined)?.lifecycleRunId,
    ).toBeUndefined();
  });

  it("clears a skipped turn only after every sendable final is suppressed", async () => {
    await writePendingFinal(undefined, "prepared");
    await replaceSessionEntry(
      { storePath, sessionKey },
      {
        ...(loadSessionEntry({ sessionKey, storePath }) as SessionEntry),
        pendingFinalDelivery: {
          kind: "replayable",
          text: "hook reply",
          createdAt: 1,
          intentId: "intent-1",
          deliveries: [
            { id: "delivery-1", state: "prepared" },
            { id: "delivery-2", state: "prepared" },
          ],
        },
      },
    );

    await suppressPendingFinalDelivery(pendingFinalPayload("delivery-1"));

    expect(
      (loadSessionEntry({ sessionKey, storePath }) as SessionEntry).pendingFinalDelivery
        ?.deliveries,
    ).toEqual([
      { id: "delivery-1", state: "suppressed" },
      { id: "delivery-2", state: "prepared" },
    ]);

    await suppressPendingFinalDelivery(pendingFinalPayload("delivery-2"));

    expect(
      (loadSessionEntry({ sessionKey, storePath }) as SessionEntry).pendingFinalDelivery,
    ).toBeUndefined();
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
});
