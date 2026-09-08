import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createSessionMaintenanceOwner } from "../../agents/session-maintenance/coordinator.js";
import { SessionWorkStartChangedError } from "../../config/sessions/lifecycle.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import * as registry from "./reply-run-registry.js";
import { testing } from "./reply-run-registry.test-support.js";
import { admitReplyTurn } from "./reply-turn-admission.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sessionKey = "global";
const sessionId = "copied-session-id";
const successorId = "compacted-session-id";

afterEach(() => {
  testing.resetReplyRunRegistry();
  closeOpenClawAgentDatabasesForTest();
  vi.restoreAllMocks();
});

function seed(storePath: string, id = sessionId) {
  replaceSessionEntrySync({ storePath, sessionKey }, { sessionId: id, updatedAt: 1 });
}

async function admitOwner(storePath?: string, id = sessionId) {
  const result = await admitReplyTurn({
    sessionKey,
    sessionId: id,
    storePath,
    kind: "visible",
    resetTriggered: false,
  });
  if (result.status !== "owned") {
    throw new Error("fixture requires a genuinely admitted parent operation");
  }
  return result.operation;
}

it.each(
  (["active", "successor", "followup"] as const).flatMap((barrier) =>
    [true, false].map((sameStore) => ({ barrier, sameStore })),
  ),
)(
  "follows $barrier rotation only in its physical store, sameStore=$sameStore",
  async ({ barrier, sameStore }) => {
    const ownerStore = path.join(tempDirs.make("reply-owner-"), "sessions.json");
    const targetStore = sameStore
      ? ownerStore
      : path.join(tempDirs.make("reply-target-"), "sessions.json");
    seed(ownerStore);
    if (!sameStore) {
      seed(targetStore);
    }
    const owner = await admitOwner(ownerStore);
    const released = createDeferred();
    const waited =
      barrier === "active"
        ? vi.spyOn(registry.replyRunRegistry, "waitForIdle")
        : vi.spyOn(
            registry,
            barrier === "successor"
              ? "waitForReplyRunSuccessorAdmission"
              : "waitForReplyRunFollowupAdmission",
          );
    const rotate = (operation: registry.ReplyOperation) => {
      operation.updateSessionId(successorId);
      seed(ownerStore, successorId);
    };
    if (barrier === "successor") {
      registry.registerReplyOperationSuccessorBarrier({
        operation: owner,
        sessionId,
        sessionKeys: [sessionKey],
        start: () => released.promise,
      });
      rotate(owner);
      owner.complete();
    } else if (barrier === "followup") {
      owner.completeWithAfterClearBarrier(released.promise);
    }
    const pending = admitReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath: targetStore,
      kind: "queued_followup",
      resetTriggered: false,
    });
    try {
      await vi.waitFor(() => expect(waited).toHaveBeenCalled());
      if (barrier === "active") {
        rotate(owner);
        owner.complete();
      } else if (barrier === "followup") {
        // A later visible turn may advance this same-store delivery barrier.
        const visible = await admitOwner(ownerStore);
        rotate(visible);
        visible.complete();
      }
      released.resolve();
      const result = await pending;
      expect(result.status).toBe("owned");
      if (result.status === "owned") {
        expect(result.operation.sessionId).toBe(sameStore ? successorId : sessionId);
        result.operation.complete();
      }
    } finally {
      owner.complete();
      released.resolve();
      const result = await pending;
      if (result.status === "owned") {
        result.operation.complete();
      }
    }
  },
);

it.each([true, false])(
  "follows a rotation completed during foreground maintenance only in its physical store, sameStore=%s",
  async (sameStore) => {
    const ownerStore = path.join(tempDirs.make("reply-maintenance-owner-"), "sessions.json");
    const targetStore = sameStore
      ? ownerStore
      : path.join(tempDirs.make("reply-maintenance-foreign-"), "sessions.json");
    seed(ownerStore);
    if (!sameStore) {
      seed(targetStore);
    }
    const admitted = await admitReplyTurn({
      sessionKey,
      sessionId,
      agentId: "main",
      storePath: ownerStore,
      kind: "visible",
      resetTriggered: false,
    });
    if (admitted.status !== "owned" || !admitted.databaseClaim) {
      throw new Error("fixture requires a reply owner with its physical database claim");
    }
    const { operation: owner, databaseClaim } = admitted;
    const maintenanceStarted = createDeferred();
    const releaseMaintenance = createDeferred();
    const maintenance = createSessionMaintenanceOwner({ sessionKey });
    const work = maintenance.track(
      maintenance.run(async () => {
        maintenanceStarted.resolve();
        await releaseMaintenance.promise;
      }),
    );
    await maintenanceStarted.promise;
    const controller = new AbortController();
    let settled = false;
    const pending = admitReplyTurn({
      sessionKey,
      sessionId,
      agentId: "main",
      expectedSessionId: sessionId,
      storePath: targetStore,
      kind: "visible",
      resetTriggered: false,
      upstreamAbortSignal: controller.signal,
    }).finally(() => {
      settled = true;
    });
    void pending.catch(() => {});
    try {
      owner.updateSessionId(successorId);
      seed(ownerStore, successorId);
      if (!sameStore) {
        // Matching UUIDs in another physical database do not establish rotation lineage.
        seed(targetStore, successorId);
      }
      owner.complete();
      await Promise.resolve();
      expect(registry.replyRunRegistry.get(sessionKey)).toBeUndefined();
      expect(settled).toBe(false);

      releaseMaintenance.resolve();
      await work;
      if (sameStore) {
        const result = await pending;
        expect(result.status).toBe("owned");
        if (result.status === "owned") {
          expect(result.operation.sessionId).toBe(successorId);
          expect(result.operation.agentId).toBe("main");
          expect(result.databaseClaim?.database.db).toBe(databaseClaim.database.db);
          result.operation.complete();
        }
      } else {
        await expect(pending).rejects.toThrow(SessionWorkStartChangedError);
      }
    } finally {
      owner.complete();
      releaseMaintenance.resolve();
      controller.abort();
      await work;
      const result = await pending.catch(() => undefined);
      if (result?.status === "owned") {
        result.operation.complete();
      }
    }
  },
);

it.each(["before", "after"] as const)(
  "keeps same-store rotation when a foreign barrier is installed %s the rotation",
  async (foreignOrder) => {
    const ownerStore = path.join(tempDirs.make("reply-rotation-owner-"), "sessions.json");
    const foreignStore = path.join(tempDirs.make("reply-rotation-foreign-"), "sessions.json");
    seed(ownerStore);
    seed(foreignStore);
    const owner = await admitOwner(ownerStore);
    const ownerDelivery = createDeferred();
    const foreignDelivery = createDeferred();
    owner.completeWithAfterClearBarrier(ownerDelivery.promise);
    const waited = vi.spyOn(registry, "waitForReplyRunFollowupAdmission");
    const pending = admitReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath: ownerStore,
      kind: "queued_followup",
      resetTriggered: false,
    });
    const installForeignBarrier = async () => {
      const foreign = await admitOwner(foreignStore);
      foreign.completeWithAfterClearBarrier(foreignDelivery.promise);
    };
    try {
      await vi.waitFor(() => expect(waited).toHaveBeenCalled());
      if (foreignOrder === "before") {
        await installForeignBarrier();
      }
      const visible = await admitOwner(ownerStore);
      seed(ownerStore, successorId);
      visible.updateSessionId(successorId);
      visible.complete();
      if (foreignOrder === "after") {
        await installForeignBarrier();
      }
      ownerDelivery.resolve();
      foreignDelivery.resolve();
      const result = await pending;
      expect(result.status).toBe("owned");
      if (result.status === "owned") {
        expect(result.operation.sessionId).toBe(successorId);
        result.operation.complete();
      }
    } finally {
      owner.complete();
      ownerDelivery.resolve();
      foreignDelivery.resolve();
      const result = await pending;
      if (result.status === "owned") {
        result.operation.complete();
      }
    }
  },
);

it.each(
  [false, true].flatMap((replacementBarrier) =>
    [false, true].map((storeless) => ({ replacementBarrier, storeless })),
  ),
)(
  "rejects unrelated replacement, replacementBarrier=$replacementBarrier storeless=$storeless",
  async ({ replacementBarrier, storeless }) => {
    const storePath = storeless
      ? undefined
      : path.join(tempDirs.make("reply-replaced-owner-"), "sessions.json");
    if (storePath) {
      seed(storePath);
    }
    const owner = await admitOwner(storePath);
    const delivery = createDeferred();
    const replacementDelivery = createDeferred();
    owner.completeWithAfterClearBarrier(delivery.promise);
    const waited = vi.spyOn(registry, "waitForReplyRunFollowupAdmission");
    const pending = admitReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath,
      kind: "queued_followup",
      resetTriggered: false,
    });
    try {
      await vi.waitFor(() => expect(waited).toHaveBeenCalled());
      if (storePath) {
        seed(storePath, "unrelated-replacement");
      }
      const replacement = await admitOwner(storePath, "unrelated-replacement");
      expect(replacement.sessionId).toBe("unrelated-replacement");
      expect(replacement.hasOwnedSessionId(sessionId)).toBe(false);
      if (replacementBarrier) {
        replacement.completeWithAfterClearBarrier(replacementDelivery.promise);
      } else {
        replacement.complete();
      }
      delivery.resolve();
      replacementDelivery.resolve();
      await expect(pending).resolves.toMatchObject({
        status: "skipped",
        reason: "lifecycle-invalidated",
      });
    } finally {
      owner.complete();
      delivery.resolve();
      replacementDelivery.resolve();
      const result = await pending;
      if (result.status === "owned") {
        result.operation.complete();
      }
    }
  },
);

it("follows connected compactions by distinct owners from either predecessor", async () => {
  const storePath = path.join(tempDirs.make("reply-lineage-owner-"), "sessions.json");
  seed(storePath);
  const owner = await admitOwner(storePath);
  const delivery = createDeferred();
  owner.completeWithAfterClearBarrier(delivery.promise);
  const waited = vi.spyOn(registry, "waitForReplyRunFollowupAdmission");
  const controller = new AbortController();
  const pending: Promise<{ status: string; sessionId?: string }>[] = [];
  const enqueue = (expectedSessionId: string) => {
    pending.push(
      admitReplyTurn({
        sessionKey,
        sessionId: expectedSessionId,
        expectedSessionId,
        storePath,
        kind: "queued_followup",
        resetTriggered: false,
        upstreamAbortSignal: controller.signal,
      }).then((result) => {
        if (result.status !== "owned") {
          return { status: result.status };
        }
        const admittedId = result.operation.sessionId;
        result.operation.complete();
        return { status: result.status, sessionId: admittedId };
      }),
    );
  };
  try {
    enqueue(sessionId);
    await vi.waitFor(() => expect(waited).toHaveBeenCalledTimes(1));
    for (const nextId of [successorId, "second-compaction"]) {
      const visible = await admitOwner(storePath);
      seed(storePath, nextId);
      visible.updateSessionId(nextId);
      visible.complete();
      if (nextId === successorId) {
        enqueue(successorId);
        await vi.waitFor(() => expect(waited).toHaveBeenCalledTimes(2));
      }
    }
    delivery.resolve();
    await expect(Promise.all(pending)).resolves.toEqual([
      { status: "owned", sessionId: "second-compaction" },
      { status: "owned", sessionId: "second-compaction" },
    ]);
  } finally {
    owner.complete();
    delivery.resolve();
    controller.abort();
    await Promise.allSettled(pending);
  }
});

it("keeps rekeyed source lineage separate from the adopted target", async () => {
  const storePath = path.join(tempDirs.make("reply-rekeyed-lineage-"), "sessions.json");
  seed(storePath);
  const owner = await admitOwner(storePath);
  const release = createDeferred();
  registry.registerReplyOperationSuccessorBarrier({
    operation: owner,
    sessionId,
    sessionKeys: [sessionKey],
    start: () => release.promise,
  });
  seed(storePath, successorId);
  owner.updateSessionId(successorId);
  const targetKey = "agent:main:adopted-target";
  const targetId = "adopted-session";
  replaceSessionEntrySync(
    { storePath, sessionKey: targetKey },
    { sessionId: targetId, updatedAt: 1 },
  );
  const adopted = await admitReplyTurn({
    sessionKey: targetKey,
    sessionId: successorId,
    expectedSessionId: targetId,
    storePath,
    kind: "visible",
    resetTriggered: false,
    adoptOperation: owner,
  });
  expect(adopted.status).toBe("owned");
  owner.updateSessionId(targetId);
  expect(owner.hasOwnedSessionId(targetId)).toBe(true);
  const waited = vi.spyOn(registry, "waitForReplyRunSuccessorAdmission");
  const controller = new AbortController();
  const pending = [sessionId, targetId].map(async (expectedSessionId) => {
    const result = await admitReplyTurn({
      sessionKey,
      sessionId: expectedSessionId,
      expectedSessionId,
      storePath,
      kind: "queued_followup",
      resetTriggered: false,
      upstreamAbortSignal: controller.signal,
    });
    if (result.status !== "owned") {
      return { status: result.status, reason: result.reason };
    }
    const admittedId = result.operation.sessionId;
    result.operation.complete();
    return { status: result.status, sessionId: admittedId };
  });
  try {
    await vi.waitFor(() => expect(waited).toHaveBeenCalledTimes(2));
    owner.complete();
    release.resolve();
    await expect(Promise.all(pending)).resolves.toEqual([
      { status: "owned", sessionId: successorId },
      { status: "skipped", reason: "lifecycle-invalidated" },
    ]);
  } finally {
    owner.complete();
    release.resolve();
    controller.abort();
    await Promise.allSettled(pending);
  }
});

it.each(
  (["followup", "successor"] as const).flatMap((nextBarrier) =>
    (["connected", "replacement", "foreign-store"] as const).map((lineage) => ({
      nextBarrier,
      lineage,
    })),
  ),
)(
  "preserves settled delivery lineage across a new $nextBarrier barrier: $lineage",
  async ({ nextBarrier, lineage }) => {
    const storePath = path.join(tempDirs.make("reply-settled-lineage-"), "sessions.json");
    seed(storePath);
    const first = await admitOwner(storePath);
    const firstDelivery = createDeferred();
    const secondDelivery = createDeferred();
    first.completeWithAfterClearBarrier(firstDelivery.promise);
    const waited = vi.spyOn(registry, "waitForReplyRunFollowupAdmission");
    const controller = new AbortController();
    const pending = admitReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath,
      kind: "queued_followup",
      resetTriggered: false,
      upstreamAbortSignal: controller.signal,
    });
    let second: registry.ReplyOperation | undefined;
    try {
      await vi.waitFor(() => expect(waited).toHaveBeenCalledTimes(1));
      const rotating = await admitOwner(storePath);
      rotating.updateSessionId(successorId);
      seed(storePath, successorId);
      rotating.complete();
      const secondStore =
        lineage === "foreign-store"
          ? path.join(tempDirs.make("reply-settled-foreign-"), "sessions.json")
          : storePath;
      if (lineage !== "connected") {
        seed(secondStore, lineage === "replacement" ? "unrelated-session" : successorId);
      }
      second = await admitOwner(secondStore);
      const next = second;
      // Delivery completion installs the next fence after the first registry
      // entry was removed, before the queued waiter resumes from settlement.
      registry.runAfterReplyOperationClear(first, () => {
        next.updateSessionId("second-compaction");
        seed(secondStore, "second-compaction");
        if (lineage === "foreign-store") {
          seed(storePath, "second-compaction");
        }
        if (nextBarrier === "successor") {
          registry.registerReplyOperationSuccessorBarrier({
            operation: next,
            sessionId: next.sessionId,
            sessionKeys: [sessionKey],
            start: () => secondDelivery.promise,
          });
          next.complete();
        } else {
          next.completeWithAfterClearBarrier(secondDelivery.promise);
        }
      });
      firstDelivery.resolve();
      // Let the waiter observe the second fence before its delivery settles.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      secondDelivery.resolve();
      const result = await pending;
      if (lineage === "connected") {
        expect(result.status).toBe("owned");
        if (result.status === "owned") {
          expect(result.operation.sessionId).toBe("second-compaction");
          result.operation.complete();
        }
      } else {
        expect(result).toMatchObject({ status: "skipped", reason: "lifecycle-invalidated" });
      }
    } finally {
      first.complete();
      second?.complete();
      firstDelivery.resolve();
      secondDelivery.resolve();
      controller.abort();
      const result = await pending;
      if (result.status === "owned") {
        result.operation.complete();
      }
    }
  },
);

it.each(
  (["active-successor", "followup-active"] as const).flatMap((handoff) =>
    (["connected", "replacement", "foreign-store"] as const).map((lineage) => ({
      handoff,
      lineage,
    })),
  ),
)("preserves waited lineage through $handoff: $lineage", async ({ handoff, lineage }) => {
  const storePath = path.join(tempDirs.make("reply-waited-lineage-"), "sessions.json");
  seed(storePath);
  const first = await admitOwner(storePath);
  const delivery = createDeferred();
  if (handoff === "followup-active") {
    first.completeWithAfterClearBarrier(delivery.promise);
  }
  const activeWait = vi.spyOn(registry.replyRunRegistry, "waitForIdle");
  const deliveryWait = vi.spyOn(registry, "waitForReplyRunFollowupAdmission");
  const controller = new AbortController();
  let finished = false;
  const pending = admitReplyTurn({
    sessionKey,
    sessionId,
    expectedSessionId: sessionId,
    storePath,
    kind: "queued_followup",
    resetTriggered: false,
    upstreamAbortSignal: controller.signal,
  }).then((result) => {
    finished = true;
    return result;
  });
  let second: registry.ReplyOperation | undefined;
  try {
    await vi.waitFor(() =>
      expect(handoff === "active-successor" ? activeWait : deliveryWait).toHaveBeenCalledTimes(1),
    );
    if (handoff === "active-successor") {
      first.updateSessionId(successorId);
      seed(storePath, successorId);
    } else {
      const rotating = await admitOwner(storePath);
      rotating.updateSessionId(successorId);
      seed(storePath, successorId);
      rotating.complete();
    }
    const secondStore =
      lineage === "foreign-store"
        ? path.join(tempDirs.make("reply-waited-foreign-"), "sessions.json")
        : storePath;
    const secondKey = handoff === "active-successor" ? "agent:main:command-source" : sessionKey;
    const secondId = lineage === "replacement" ? "unrelated-session" : successorId;
    replaceSessionEntrySync(
      { storePath: secondStore, sessionKey: secondKey },
      { sessionId: secondId, updatedAt: 1 },
    );
    const admitted = await admitReplyTurn({
      sessionKey: secondKey,
      sessionId: secondId,
      storePath: secondStore,
      kind: "visible",
      resetTriggered: false,
    });
    expect(admitted.status).toBe("owned");
    if (admitted.status !== "owned") {
      throw new Error("fixture requires a genuinely admitted successor");
    }
    second = admitted.operation;
    const next = second;
    registry.runAfterReplyOperationClear(first, () => {
      next.updateSessionKey(sessionKey);
      next.updateSessionId("second-compaction");
      seed(secondStore, "second-compaction");
      if (lineage === "foreign-store") {
        seed(storePath, "second-compaction");
      }
      if (handoff === "active-successor") {
        registry.registerReplyOperationSuccessorBarrier({
          operation: next,
          sessionId: next.sessionId,
          sessionKeys: [sessionKey],
          start: () => delivery.promise,
        });
        next.complete();
        delivery.resolve();
      }
    });
    if (handoff === "active-successor") {
      first.complete();
    } else {
      delivery.resolve();
      await vi.waitFor(() => expect(finished || activeWait.mock.calls.length > 0).toBe(true));
      second.complete();
    }
    const result = await pending;
    if (lineage === "connected") {
      expect(result.status).toBe("owned");
      if (result.status === "owned") {
        expect(result.operation.sessionId).toBe("second-compaction");
        result.operation.complete();
      }
    } else {
      expect(result).toMatchObject({ status: "skipped", reason: "lifecycle-invalidated" });
    }
  } finally {
    first.complete();
    second?.complete();
    delivery.resolve();
    controller.abort();
    const result = await pending;
    if (result.status === "owned") {
      result.operation.complete();
    }
  }
});

it.each(["completed", "user-aborted", "restart-aborted"] as const)(
  "preserves predecessor invalidation in a pending chain: %s",
  async (terminal) => {
    const storePath = path.join(tempDirs.make("reply-restart-lineage-"), "sessions.json");
    seed(storePath);
    const initial = await admitOwner(storePath);
    const delivery = createDeferred();
    initial.completeWithAfterClearBarrier(delivery.promise);
    const waited = vi.spyOn(registry, "waitForReplyRunFollowupAdmission");
    const controller = new AbortController();
    const pending = admitReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath,
      kind: "queued_followup",
      resetTriggered: false,
      upstreamAbortSignal: controller.signal,
    });
    const operations: registry.ReplyOperation[] = [initial];
    try {
      await vi.waitFor(() => expect(waited).toHaveBeenCalledTimes(1));
      const predecessor = await admitOwner(storePath);
      operations.push(predecessor);
      predecessor.updateSessionId(successorId);
      seed(storePath, successorId);
      if (terminal === "restart-aborted") {
        expect(predecessor.abortForRestart()).toBe(true);
      } else if (terminal === "user-aborted") {
        expect(predecessor.abortByUser()).toBe(true);
      }
      predecessor.completeWithAfterClearBarrier(delivery.promise);
      const successor = await admitOwner(storePath);
      operations.push(successor);
      successor.updateSessionId("second-compaction");
      seed(storePath, "second-compaction");
      successor.complete();
      delivery.resolve();
      const result = await pending;
      if (terminal === "restart-aborted") {
        expect(result).toMatchObject({ status: "skipped", reason: "lifecycle-invalidated" });
      } else {
        expect(result.status).toBe("owned");
        if (result.status === "owned") {
          expect(result.operation.sessionId).toBe("second-compaction");
          result.operation.complete();
        }
      }
    } finally {
      for (const operation of operations) {
        operation.complete();
      }
      delivery.resolve();
      controller.abort();
      const result = await pending;
      if (result.status === "owned") {
        result.operation.complete();
      }
    }
  },
);
