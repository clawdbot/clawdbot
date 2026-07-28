import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { ReplyPayload } from "../reply-payload.js";
import {
  capturePendingFinalDeliveryIdentity,
  clearPendingFinalDeliveryAfterSuccess,
  reconcilePendingFinalDeliveryAfterSettlement,
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
    beforeAgentReplyState: "continue" | "handled-reply",
  ): Promise<void> {
    await replaceSessionEntry({ storePath, sessionKey }, {
      sessionId: "session",
      status: "running",
      startedAt: 10,
      updatedAt: Date.now(),
      pendingFinalDelivery: true,
      pendingFinalDeliveryText: "hook reply",
      pendingFinalDeliveryCreatedAt: 1,
      pendingFinalDeliveryIntentId: "intent-1",
      restartRecoveryBeforeAgentReplyState: beforeAgentReplyState,
      restartRecoveryForceSafeTools: beforeAgentReplyState === "handled-reply" ? true : undefined,
      restartRecoverySourceIngress: "channel",
    } satisfies SessionEntry);
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

      const entry = loadSessionEntry({ sessionKey, storePath });
      expect(entry?.pendingFinalDelivery).toBeUndefined();
      expect(entry?.pendingFinalDeliveryText).toBeUndefined();
      expect(entry?.pendingFinalDeliveryIntentId).toBeUndefined();
      expect(entry?.restartRecoveryBeforeAgentReplyState).toBeUndefined();
      expect(entry?.restartRecoveryForceSafeTools).toBeUndefined();
      expect(entry?.restartRecoverySourceIngress).toBeUndefined();
      expect(entry?.status).toBe(beforeAgentReplyState === "handled-reply" ? "done" : "running");
      if (beforeAgentReplyState === "handled-reply") {
        expect(entry?.endedAt).toBeTypeOf("number");
        expect(entry?.runtimeMs).toBeGreaterThanOrEqual(0);
      }
    },
  );

  it("finalizes a media-only hook turn after its exact transport intent succeeds", async () => {
    await replaceSessionEntry(
      { storePath, sessionKey },
      {
        sessionId: "session",
        status: "running",
        startedAt: 10,
        updatedAt: Date.now(),
        pendingFinalDelivery: true,
        pendingFinalDeliveryIntentId: "intent-media",
        restartRecoveryBeforeAgentReplyState: "handled-unrecoverable",
        restartRecoverySourceIngress: "channel",
      },
    );
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
      pendingFinalDelivery: true,
      pendingFinalDeliveryText: "hook reply",
      pendingFinalDeliveryIntentId: "intent-1",
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
});
