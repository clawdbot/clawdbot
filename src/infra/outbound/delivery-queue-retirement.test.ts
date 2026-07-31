import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDeliveryQueueMediaDir } from "../../config/paths.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { getDeliveryQueueEntryStatus, upsertDeliveryQueueEntry } from "../delivery-queue-sqlite.js";
import { requireNodeSqlite } from "../node-sqlite.js";
import { pruneOrphanedDeliveryQueueMedia } from "./delivery-queue-media-spool.js";
import { LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import { retireLegacyPendingOutboundDeliveries } from "./delivery-queue-retirement.js";
import { enqueueDeliveryOnce } from "./delivery-queue-storage.js";
import {
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
} from "./delivery-queue.test-helpers.js";

const mediaMocks = vi.hoisted(() => ({
  deferCleanup: false,
  releaseSpoolArtifacts: vi.fn(),
}));

vi.mock("./delivery-queue-media-spool.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./delivery-queue-media-spool.js")>();
  mediaMocks.releaseSpoolArtifacts.mockImplementation(
    async (...args: Parameters<typeof original.releaseSpoolArtifacts>) => {
      if (mediaMocks.deferCleanup) {
        throw new Error("simulated cleanup interruption");
      }
      await original.releaseSpoolArtifacts(...args);
    },
  );
  return { ...original, releaseSpoolArtifacts: mediaMocks.releaseSpoolArtifacts };
});

function legacyEntry(id: string, text = "private pre-policy content") {
  return {
    id,
    enqueuedAt: 100,
    retryCount: 3,
    attemptCount: 2,
    availableAt: Date.now() + 60_000,
    channel: "matrix",
    to: "!room:example",
    queuePolicy: "required",
    payloads: [{ text }],
    replyPayloadSendingHook: {
      kind: "final",
      context: { channelId: "matrix", recipientId: "!room:example" },
    },
  };
}

function readEntryJson(queueName: string, id: string, stateDir: string): string | undefined {
  const { db } = openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
  return (
    db
      .prepare("SELECT entry_json FROM delivery_queue_entries WHERE queue_name = ? AND id = ?")
      .get(queueName, id) as { entry_json?: string } | undefined
  )?.entry_json;
}

describe("pre-D4 outbound retirement", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();

  beforeEach(() => {
    mediaMocks.deferCleanup = false;
    mediaMocks.releaseSpoolArtifacts.mockClear();
  });

  afterEach(() => {
    mediaMocks.deferCleanup = false;
  });

  it("retires pending rows without replay and scrubs payload and attempt state", async () => {
    const id = "legacy-retry-backoff";
    const completionOwnerPath = resolveOpenClawAgentSqlitePath({
      agentId: "main",
      env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir() },
    });
    const entry = {
      ...legacyEntry(id),
      platformSendAttemptId: "provider-attempt-private",
      platformSendStartedAt: 123,
      recoveryState: "unknown_after_send",
      deliveryCompletion: {
        kind: "conversation" as const,
        agentId: "main",
        operationId: "operation-private",
        storePath: completionOwnerPath,
      },
    };
    upsertDeliveryQueueEntry({
      queueName: LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
      entry,
      stateDir: tmpDir(),
    });
    const log = createRecoveryLog();

    await expect(
      retireLegacyPendingOutboundDeliveries({ log, stateDir: tmpDir() }),
    ).resolves.toEqual({
      retired: 1,
      skipped: 0,
      completionUnknownFailed: 0,
      mediaCleanupDeferred: 0,
    });

    await expect(fs.stat(completionOwnerPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(getDeliveryQueueEntryStatus(LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME, id, tmpDir())).toBe(
      "failed",
    );
    const raw = readEntryJson(LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME, id, tmpDir()) ?? "";
    expect(raw).not.toContain("private pre-policy content");
    expect(raw).not.toContain("replyPayloadSendingHook");
    expect(raw).not.toContain("provider-attempt-private");
    expect(raw).toContain("retired_pre_d4_pending");
    expect(log.info).toHaveBeenCalledWith(
      "Retired legacy outbound deliveries retired=1 skipped=0 completion_unknown_failed=0 media_cleanup_deferred=0",
    );
  });

  it("is idempotent under overlapping startup scans and keeps the stable id owned", async () => {
    const id = "stable-legacy-intent";
    upsertDeliveryQueueEntry({
      queueName: LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
      entry: { ...legacyEntry(id), completionRetention: "permanent" },
      stateDir: tmpDir(),
    });
    const firstLog = createRecoveryLog();
    const secondLog = createRecoveryLog();
    const results = await Promise.all([
      retireLegacyPendingOutboundDeliveries({ log: firstLog, stateDir: tmpDir() }),
      retireLegacyPendingOutboundDeliveries({ log: secondLog, stateDir: tmpDir() }),
    ]);
    expect(results.reduce((count, result) => count + result.retired, 0)).toBe(1);
    expect(readEntryJson(LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME, id, tmpDir())).toContain(
      '"completionRetention":"permanent"',
    );
    await expect(
      enqueueDeliveryOnce(
        {
          channel: "matrix",
          to: "!room:example",
          payloads: [{ text: "must not regenerate" }],
        },
        id,
        tmpDir(),
      ),
    ).resolves.toEqual({ id, created: false });
    await expect(
      retireLegacyPendingOutboundDeliveries({ log: createRecoveryLog(), stateDir: tmpDir() }),
    ).resolves.toEqual({
      retired: 0,
      skipped: 0,
      completionUnknownFailed: 0,
      mediaCleanupDeferred: 0,
    });
  });

  it("retries completion settlement errors, then retires a confirmed missing owner", async () => {
    const id = "legacy-completion-retry";
    const completionAgentId = "completion-retry";
    const completionOwnerPath = resolveOpenClawAgentSqlitePath({
      agentId: completionAgentId,
      env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir() },
    });
    await fs.mkdir(path.dirname(completionOwnerPath), { recursive: true });
    const database = new (requireNodeSqlite().DatabaseSync)(completionOwnerPath);
    database.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + 1};`);
    database.close();
    const entry = {
      ...legacyEntry(id),
      deliveryCompletion: {
        kind: "conversation" as const,
        agentId: completionAgentId,
        operationId: "operation-retry",
        storePath: completionOwnerPath,
      },
    };
    upsertDeliveryQueueEntry({
      queueName: LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
      entry,
      stateDir: tmpDir(),
    });
    await expect(
      retireLegacyPendingOutboundDeliveries({ log: createRecoveryLog(), stateDir: tmpDir() }),
    ).resolves.toEqual({
      retired: 0,
      skipped: 1,
      completionUnknownFailed: 1,
      mediaCleanupDeferred: 0,
    });
    expect(getDeliveryQueueEntryStatus(LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME, id, tmpDir())).toBe(
      "pending",
    );
    expect(readEntryJson(LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME, id, tmpDir())).toContain(
      "operation-retry",
    );
    await fs.rm(completionOwnerPath, { force: true });

    await expect(
      retireLegacyPendingOutboundDeliveries({ log: createRecoveryLog(), stateDir: tmpDir() }),
    ).resolves.toEqual({
      retired: 1,
      skipped: 0,
      completionUnknownFailed: 0,
      mediaCleanupDeferred: 0,
    });
    expect(getDeliveryQueueEntryStatus(LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME, id, tmpDir())).toBe(
      "failed",
    );
    expect(readEntryJson(LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME, id, tmpDir())).not.toContain(
      "operation-retry",
    );
    await expect(fs.stat(completionOwnerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves completed and failed legacy records untouched", async () => {
    const completed = legacyEntry("legacy-completed", "completed payload");
    const failed = legacyEntry("legacy-failed", "failed payload");
    upsertDeliveryQueueEntry({
      queueName: LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
      entry: completed,
      status: "completed",
      stateDir: tmpDir(),
    });
    upsertDeliveryQueueEntry({
      queueName: LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
      entry: failed,
      status: "failed",
      stateDir: tmpDir(),
    });
    const beforeCompleted = readEntryJson(
      LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
      completed.id,
      tmpDir(),
    );
    const beforeFailed = readEntryJson(LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME, failed.id, tmpDir());

    await retireLegacyPendingOutboundDeliveries({ log: createRecoveryLog(), stateDir: tmpDir() });

    expect(readEntryJson(LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME, completed.id, tmpDir())).toBe(
      beforeCompleted,
    );
    expect(readEntryJson(LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME, failed.id, tmpDir())).toBe(
      beforeFailed,
    );
    expect(
      getDeliveryQueueEntryStatus(LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME, completed.id, tmpDir()),
    ).toBe("completed");
    expect(
      getDeliveryQueueEntryStatus(LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME, failed.id, tmpDir()),
    ).toBe("failed");
  });

  it("releases queue-owned media only after terminal retirement", async () => {
    const spoolDir = resolveDeliveryQueueMediaDir(tmpDir());
    const mediaPath = path.join(spoolDir, "11111111-1111-4111-8111-111111111111.png");
    await fs.mkdir(spoolDir, { recursive: true });
    await fs.writeFile(mediaPath, "queued media");
    const entry = { ...legacyEntry("legacy-media"), payloads: [{ mediaUrl: mediaPath }] };
    upsertDeliveryQueueEntry({
      queueName: LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
      entry,
      stateDir: tmpDir(),
    });

    await retireLegacyPendingOutboundDeliveries({ log: createRecoveryLog(), stateDir: tmpDir() });

    expect(
      getDeliveryQueueEntryStatus(LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME, entry.id, tmpDir()),
    ).toBe("failed");
    await expect(fs.stat(mediaPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("lets orphan GC finish media cleanup interrupted after the terminal transition", async () => {
    const spoolDir = resolveDeliveryQueueMediaDir(tmpDir());
    const mediaPath = path.join(spoolDir, "22222222-2222-4222-8222-222222222222.png");
    await fs.mkdir(spoolDir, { recursive: true });
    await fs.writeFile(mediaPath, "orphaned media");
    const entry = {
      ...legacyEntry("legacy-media-interrupted"),
      payloads: [{ mediaUrl: mediaPath }],
    };
    upsertDeliveryQueueEntry({
      queueName: LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
      entry,
      stateDir: tmpDir(),
    });
    mediaMocks.deferCleanup = true;

    const result = await retireLegacyPendingOutboundDeliveries({
      log: createRecoveryLog(),
      stateDir: tmpDir(),
    });
    expect(result.mediaCleanupDeferred).toBe(1);
    expect(
      getDeliveryQueueEntryStatus(LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME, entry.id, tmpDir()),
    ).toBe("failed");
    await expect(fs.stat(mediaPath)).resolves.toBeDefined();

    mediaMocks.deferCleanup = false;
    const old = new Date(Date.now() - 25 * 60 * 60_000);
    await fs.utimes(mediaPath, old, old);
    await pruneOrphanedDeliveryQueueMedia({ stateDir: tmpDir(), nowMs: Date.now() });
    await expect(fs.stat(mediaPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
