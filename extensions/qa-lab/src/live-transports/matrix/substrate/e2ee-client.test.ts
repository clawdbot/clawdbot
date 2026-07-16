// QA Lab tests cover Matrix E2EE client behavior.
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MATRIX_QA_E2EE_SYNC_FILTER,
  prepareMatrixQaE2eeStorage,
  shouldRecordMatrixQaObservedEventUpdate,
} from "./e2ee-client-internals.js";
import { findMatrixQaObservedEventMatch } from "./events.js";

const testing = {
  MATRIX_QA_E2EE_SYNC_FILTER,
  findMatrixQaObservedEventMatch,
  prepareMatrixQaE2eeStorage,
  shouldRecordMatrixQaObservedEventUpdate,
};

describe("matrix qa e2ee client storage", () => {
  it("filters receipt noise without suppressing room state or timeline events", () => {
    expect(testing.MATRIX_QA_E2EE_SYNC_FILTER).toEqual({
      room: {
        ephemeral: { not_types: ["m.receipt"] },
      },
    });
  });

  it("shares persisted crypto and sync state by actor account", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "matrix-qa-e2ee-account-"));
    try {
      const first = await testing.prepareMatrixQaE2eeStorage({
        actorId: "driver",
        outputDir,
        scenarioId: "matrix-e2ee-basic-reply",
      });
      const second = await testing.prepareMatrixQaE2eeStorage({
        actorId: "driver",
        outputDir,
        scenarioId: "matrix-e2ee-qr-verification",
      });

      expect(first.accountDir).toBe(
        path.join(outputDir, "matrix-e2ee", "accounts", "driver", "account"),
      );
      expect(first.cryptoDatabasePrefix).toBe(second.cryptoDatabasePrefix);
      expect(first.recoveryKeyPath).toBe(path.join(first.accountDir, "recovery-key.json"));
      expect(first.storagePath).toBe(path.join(first.accountDir, "sync-store.json"));
      expect(second.storagePath).toBe(first.storagePath);
    } finally {
      await rm(outputDir, { force: true, recursive: true });
    }
  });

  it("keeps persisted crypto state private", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "matrix-qa-e2ee-storage-"));
    try {
      const storage = await testing.prepareMatrixQaE2eeStorage({
        actorId: "driver",
        outputDir,
        scenarioId: "matrix-e2ee-basic-reply",
      });

      expect((await stat(storage.accountDir)).mode & 0o777).toBe(0o700);
      expect((await stat(storage.idbSnapshotPath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(outputDir, { force: true, recursive: true });
    }
  });

  it("records late-decrypted payload updates for an existing event id", () => {
    const previous = {
      eventId: "$reply",
      kind: "message" as const,
      roomId: "!room:matrix-qa.test",
      sender: "@bot:matrix-qa.test",
      type: "m.room.message",
    };

    expect(
      testing.shouldRecordMatrixQaObservedEventUpdate({
        previous,
        next: {
          ...previous,
          body: "MATRIX_QA_E2EE_CLI_GATEWAY_OK",
          msgtype: "m.text",
        },
      }),
    ).toBe(true);
    expect(
      testing.shouldRecordMatrixQaObservedEventUpdate({
        previous: {
          ...previous,
          body: "MATRIX_QA_E2EE_CLI_GATEWAY_OK",
          msgtype: "m.text",
        },
        next: {
          ...previous,
          body: "MATRIX_QA_E2EE_CLI_GATEWAY_OK",
          msgtype: "m.text",
        },
      }),
    ).toBe(false);
  });
});
