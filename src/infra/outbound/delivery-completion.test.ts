import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commitMainSessionRecovery } from "../../agents/main-session-recovery/main-session-recovery-store.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { rejectDurableDelivery, settlePendingFinalDelivery } from "./delivery-completion.js";

const recoveryMocks = vi.hoisted(() => ({
  scheduleMainSessionRecoveryPendingTarget: vi.fn(),
}));

vi.mock(
  "../../agents/main-session-recovery/main-session-recovery-owner-release.js",
  () => recoveryMocks,
);

describe("pending-final delivery completion", () => {
  let tmpDir: string;
  let storePath: string;
  const sessionKey = "agent:main:main";
  const completion = {
    kind: "pending-final" as const,
    deliveryId: "delivery-1",
    intentId: "intent-1",
    sessionId: "session-1",
    sessionKey,
    storePath: "",
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-delivery-completion-"));
    storePath = path.join(tmpDir, "sessions.json");
    completion.storePath = storePath;
    const entry: InternalSessionEntry = {
      sessionId: completion.sessionId,
      status: "running",
      abortedLastRun: true,
      updatedAt: Date.now(),
      mainRestartRecovery: {
        cycleId: "cycle-1",
        revision: 1,
        chargedAttempts: 1,
      },
      pendingFinalDelivery: {
        kind: "replayable",
        text: "durable final",
        createdAt: Date.now(),
        intentId: completion.intentId,
        deliveries: [{ id: completion.deliveryId, state: "prepared" }],
      },
    };
    await replaceSessionEntry({ sessionKey, storePath }, entry);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("invalidates an earlier recovery decision and wakes the exact session", async () => {
    const observation = { sessionId: completion.sessionId, cycleId: "cycle-1", revision: 1 };

    await expect(settlePendingFinalDelivery(completion, "delivered")).resolves.toEqual({
      state: "delivered",
    });

    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      mainRestartRecovery: { revision: 2 },
      pendingFinalDelivery: {
        deliveries: [{ id: completion.deliveryId, state: "delivered" }],
      },
    });
    expect(recoveryMocks.scheduleMainSessionRecoveryPendingTarget).toHaveBeenCalledWith({
      sessionId: completion.sessionId,
      sessionKey,
      storePath,
    });
    await expect(
      commitMainSessionRecovery({
        command: {
          kind: "tombstone",
          now: Date.now(),
          observation,
          reason: "stale delivery decision",
        },
        requireWriteSuccess: true,
        target: { sessionKey, storePath },
      }),
    ).resolves.toMatchObject({ transition: { kind: "rejected", reason: "stale_revision" } });
  });

  it("records queue custody without waking recovery", async () => {
    await expect(settlePendingFinalDelivery(completion, "queued")).resolves.toEqual({
      state: "queued",
    });

    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      mainRestartRecovery: { revision: 2 },
      pendingFinalDelivery: {
        deliveries: [{ id: completion.deliveryId, state: "queued" }],
      },
    });
    expect(recoveryMocks.scheduleMainSessionRecoveryPendingTarget).not.toHaveBeenCalled();
  });

  const noticeContext = { channel: "telegram", to: "chat-1", accountId: "default" };

  async function installContextOnPendingFinal() {
    const entry = loadSessionEntry({ sessionKey, storePath })!;
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        ...entry,
        pendingFinalDelivery: { ...entry.pendingFinalDelivery!, context: noticeContext },
      },
    );
  }

  it("owes a notice when claimed custody is affirmed unknown", async () => {
    await installContextOnPendingFinal();
    await settlePendingFinalDelivery(completion, "unknown", ["prepared", "queued"]);
    expect(loadSessionEntry({ sessionKey, storePath })?.pendingDeliveryNotice).toBeUndefined();

    await expect(
      settlePendingFinalDelivery(completion, "unknown", ["queued", "unknown"]),
    ).resolves.toEqual({ state: "unknown" });

    expect(loadSessionEntry({ sessionKey, storePath })?.pendingDeliveryNotice).toMatchObject({
      intentId: completion.intentId,
      state: "owed",
      context: noticeContext,
    });
  });

  it("does not owe a notice for the pre-dispatch claim or terminal outcomes", async () => {
    await installContextOnPendingFinal();
    await settlePendingFinalDelivery(completion, "queued", ["prepared"]);
    await settlePendingFinalDelivery(completion, "unknown", ["prepared", "queued"]);
    await settlePendingFinalDelivery(completion, "delivered");

    const entry = loadSessionEntry({ sessionKey, storePath });
    expect(entry?.pendingDeliveryNotice).toBeUndefined();
    expect(entry?.pendingFinalDelivery).toMatchObject({
      deliveries: [{ id: completion.deliveryId, state: "delivered" }],
    });
  });

  it("restores prepared custody for a retryable no-send so recovery can replay", async () => {
    await installContextOnPendingFinal();
    await settlePendingFinalDelivery(completion, "unknown", ["prepared", "queued"]);

    await expect(
      settlePendingFinalDelivery(completion, "prepared", ["queued", "unknown"]),
    ).resolves.toEqual({ state: "prepared" });

    const entry = loadSessionEntry({ sessionKey, storePath });
    expect(entry?.pendingDeliveryNotice).toBeUndefined();
    expect(entry?.pendingFinalDelivery).toMatchObject({
      deliveries: [{ id: completion.deliveryId, state: "prepared" }],
    });
  });

  it("settles a proven pre-dispatch rejection as suppressed without notice debt", async () => {
    await installContextOnPendingFinal();
    await settlePendingFinalDelivery(completion, "unknown", ["prepared", "queued"]);

    await expect(rejectDurableDelivery(completion, "payload rejected")).resolves.toEqual({
      state: "suppressed",
    });

    const entry = loadSessionEntry({ sessionKey, storePath });
    expect(entry?.pendingDeliveryNotice).toBeUndefined();
    expect(entry?.pendingFinalDelivery).toMatchObject({
      deliveries: [{ id: completion.deliveryId, state: "suppressed" }],
    });
  });

  it("carries the custom queue root when a terminal sibling wakes recovery", async () => {
    const entry = loadSessionEntry({ sessionKey, storePath })!;
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        ...entry,
        pendingFinalDelivery: {
          ...entry.pendingFinalDelivery!,
          deliveries: [
            { id: completion.deliveryId, state: "prepared" },
            { id: "delivery-2", state: "queued" },
          ],
        },
      },
    );

    await expect(
      settlePendingFinalDelivery(completion, "delivered", undefined, tmpDir),
    ).resolves.toEqual({ state: "delivered" });

    expect(recoveryMocks.scheduleMainSessionRecoveryPendingTarget).toHaveBeenCalledWith({
      sessionId: completion.sessionId,
      sessionKey,
      stateDir: tmpDir,
      storePath,
    });
  });
});
