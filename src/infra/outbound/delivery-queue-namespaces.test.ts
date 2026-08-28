import fs from "node:fs";
import path from "node:path";
import { constants } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  commitStagedDeliveryQueueEntryOnceAcrossNamespaces,
  movePendingDeliveryQueueEntryNamespace,
  upsertDeliveryQueueEntryOnceAcrossNamespaces,
} from "../delivery-queue-sqlite-namespace.js";
import {
  deleteDeliveryQueueEntry,
  getDeliveryQueueEntryStatus,
  upsertDeliveryQueueEntry,
} from "../delivery-queue-sqlite.js";
import type { DeliveryQueueCompletionRetention } from "../delivery-queue-sqlite.types.js";
import { moveDeliveryQueueEntryToFailedForTest } from "../delivery-queue-test-support.js";
import { resolvePreferredOpenClawTmpDir } from "../tmp-openclaw-dir.js";
import {
  LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
  DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME,
  OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
  OUTBOUND_DELIVERY_QUEUE_NAME,
} from "./delivery-queue-media-staging.js";
import { findDeliveryIntentOwner } from "./delivery-queue-storage.js";

describe("outbound delivery namespace ownership", () => {
  let rootDir: string;
  let stateDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-dq-owner-"));
    stateDir = path.join(rootDir, "state");
  });

  afterEach(() => {
    vi.useRealTimers();
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  function seedFailedOwner(
    id: string,
    completionRetention: DeliveryQueueCompletionRetention,
    terminalAt: number,
  ): void {
    vi.setSystemTime(terminalAt);
    upsertDeliveryQueueEntry({
      queueName: LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
      entry: { id, enqueuedAt: terminalAt - 1, retryCount: 0, completionRetention },
      stateDir,
    });
    moveDeliveryQueueEntryToFailedForTest(LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME, id, stateDir);
  }

  function seedOwnerSet(prefix: string) {
    vi.useFakeTimers();
    const ids = {
      expired: `${prefix}-expired`,
      unexpired: `${prefix}-unexpired`,
      permanent: `${prefix}-permanent`,
    };
    seedFailedOwner(ids.expired, { idPrefix: ids.expired, maxAgeMs: 100, maxEntries: 2 }, 1_000);
    seedFailedOwner(
      ids.unexpired,
      { idPrefix: ids.unexpired, maxAgeMs: 100, maxEntries: 2 },
      2_000,
    );
    seedFailedOwner(ids.permanent, "permanent", 2_000);
    vi.setSystemTime(2_050);
    return ids;
  }

  it("resolves canonical ownership from one exact-ID namespace snapshot", () => {
    const id = "shared-delivery-intent";
    for (const queueName of [LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME, OUTBOUND_DELIVERY_QUEUE_NAME]) {
      upsertDeliveryQueueEntry({
        queueName,
        entry: { id, enqueuedAt: 1, retryCount: 0 },
        stateDir,
      });
    }
    const database = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    if (typeof database.db.setAuthorizer !== "function") {
      return;
    }
    const originalPrepare = database.db.prepare.bind(database.db);
    let ownerQueries = 0;
    database.db.prepare = (sql, options) => {
      if (sql.includes('from "delivery_queue_entries"')) {
        ownerQueries++;
      }
      return originalPrepare(sql, options);
    };
    const readOwner = () => {
      const before = ownerQueries;
      database.db.setAuthorizer(() => constants.SQLITE_OK);
      try {
        const owner = findDeliveryIntentOwner(id, stateDir);
        expect(ownerQueries - before).toBe(1);
        return owner;
      } finally {
        database.db.setAuthorizer(null);
      }
    };

    expect(readOwner()).toEqual({
      queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
      namespace: "prepared",
      retired: false,
      status: "pending",
    });
    deleteDeliveryQueueEntry(OUTBOUND_DELIVERY_QUEUE_NAME, id, stateDir);
    expect(readOwner()).toEqual({
      queueName: LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
      namespace: "legacy",
      retired: true,
      status: "pending",
    });
  });

  it("observes ownership before and after an atomic namespace move", () => {
    const id = "moving-delivery-intent";
    const source = { id, enqueuedAt: 1, retryCount: 0 };
    const destination = { ...source, enqueuedAt: 2 };
    upsertDeliveryQueueEntry({
      queueName: OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
      entry: source,
      stateDir,
    });
    expect(findDeliveryIntentOwner(id, stateDir)).toMatchObject({
      queueName: OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
      namespace: "preparing",
      status: "pending",
    });

    expect(
      movePendingDeliveryQueueEntryNamespace({
        sourceQueueName: OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
        destinationQueueName: OUTBOUND_DELIVERY_QUEUE_NAME,
        expectedSourceEntry: source,
        destinationEntry: destination,
        stateDir,
      }),
    ).toBe("moved");
    expect(findDeliveryIntentOwner(id, stateDir)).toMatchObject({
      queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
      namespace: "prepared",
      status: "pending",
    });
  });

  it("expires bounded failed ownership inside insert-once admission", () => {
    const ids = seedOwnerSet("insert-once");
    for (const [id, created] of [
      [ids.expired, true],
      [ids.unexpired, false],
      [ids.permanent, false],
    ] as const) {
      expect(
        upsertDeliveryQueueEntryOnceAcrossNamespaces({
          queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
          conflictQueueNames: [LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME],
          entry: { id, enqueuedAt: 2_050, retryCount: 0 },
          stateDir,
        }),
      ).toBe(created);
    }
    expect(
      getDeliveryQueueEntryStatus(LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME, ids.expired, stateDir),
    ).toBeUndefined();
  });

  it("expires bounded failed ownership inside staged publication", () => {
    const ids = seedOwnerSet("staged");
    for (const [id, expected] of [
      [ids.expired, "created"],
      [ids.unexpired, "existing"],
      [ids.permanent, "existing"],
    ] as const) {
      const stagingId = `stage-${id}`;
      upsertDeliveryQueueEntry({
        queueName: DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME,
        entry: { id: stagingId, enqueuedAt: 2_050, retryCount: 0 },
        stateDir,
      });
      expect(
        commitStagedDeliveryQueueEntryOnceAcrossNamespaces({
          queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
          conflictQueueNames: [LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME],
          entry: { id, enqueuedAt: 2_050, retryCount: 0 },
          stagingId,
          stagingQueueName: DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME,
          stateDir,
        }),
      ).toBe(expected);
    }
  });

  it("expires bounded failed ownership inside an atomic namespace move", () => {
    const ids = seedOwnerSet("move");
    for (const [id, expected] of [
      [ids.expired, "moved"],
      [ids.unexpired, "destination-exists"],
      [ids.permanent, "destination-exists"],
    ] as const) {
      const source = { id, enqueuedAt: 2_050, retryCount: 0 };
      upsertDeliveryQueueEntry({
        queueName: OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
        entry: source,
        stateDir,
      });
      expect(
        movePendingDeliveryQueueEntryNamespace({
          sourceQueueName: OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
          destinationQueueName: OUTBOUND_DELIVERY_QUEUE_NAME,
          conflictQueueNames: [LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME],
          expectedSourceEntry: source,
          destinationEntry: { ...source, enqueuedAt: 2_051 },
          stateDir,
        }),
      ).toBe(expected);
    }
  });
});
