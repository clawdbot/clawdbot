// QA Lab tests cover Matrix E2EE client behavior.
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  MATRIX_QA_E2EE_SYNC_FILTER,
  createMatrixQaE2eeObservedEventRecorder,
  prepareMatrixQaE2eeStorage,
  runMatrixQaE2eeClientOperation,
} from "./e2ee-client-internals.js";
import { findMatrixQaObservedEventMatch, type MatrixQaObservedEvent } from "./events.js";

const testing = {
  MATRIX_QA_E2EE_SYNC_FILTER,
  createMatrixQaE2eeObservedEventRecorder,
  findMatrixQaObservedEventMatch,
  prepareMatrixQaE2eeStorage,
  runMatrixQaE2eeClientOperation,
};

describe("matrix qa e2ee client storage", () => {
  it("stops a disposable client when an E2EE operation exceeds its scenario timeout", async () => {
    vi.useFakeTimers();
    try {
      const stop = vi.fn();
      const operation = testing.runMatrixQaE2eeClientOperation({
        label: "Matrix E2EE text send",
        run: () =>
          new Promise<string>(() => {
            // Intentionally pending so the timeout owns settlement.
          }),
        stop,
        timeoutMs: 150_000,
      });
      const rejection = expect(operation).rejects.toThrow(
        "Matrix E2EE text send timed out after 150000ms",
      );

      await vi.advanceTimersByTimeAsync(150_000);

      await rejection;
      expect(stop).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

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

  it("uses plugin state without creating a legacy IndexedDB snapshot", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "matrix-qa-e2ee-storage-"));
    try {
      const storage = await testing.prepareMatrixQaE2eeStorage({
        actorId: "driver",
        outputDir,
        scenarioId: "matrix-e2ee-basic-reply",
      });

      expect((await stat(storage.accountDir)).mode & 0o777).toBe(0o700);
      await expect(access(storage.idbSnapshotPath)).rejects.toMatchObject({ code: "ENOENT" });
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
    const observed: MatrixQaObservedEvent[] = [];
    const recorder = testing.createMatrixQaE2eeObservedEventRecorder({
      append: (event) => observed.push(event),
    });
    const decrypted = {
      ...previous,
      body: "MATRIX_QA_E2EE_CLI_GATEWAY_OK",
      msgtype: "m.text",
    };

    recorder.record(previous);
    recorder.record(decrypted);
    recorder.record(decrypted);

    expect(observed).toEqual([previous, decrypted]);
  });

  it("rehydrates a replacement when its threaded target decrypts later", () => {
    const observed: MatrixQaObservedEvent[] = [];
    const recorder = testing.createMatrixQaE2eeObservedEventRecorder({
      append: (event) => observed.push(event),
    });
    const replacement = {
      eventId: "$final",
      kind: "message" as const,
      roomId: "!room:matrix-qa.test",
      sender: "@bot:matrix-qa.test",
      type: "m.room.message",
      body: "final",
      msgtype: "m.text",
      replacesEventId: "$preview",
    };
    const relation = {
      eventId: "$root",
      inReplyToId: "$driver",
      isFallingBack: true,
      relType: "m.thread",
    };

    recorder.record(replacement);
    recorder.record({
      eventId: "$preview",
      kind: "notice",
      roomId: "!room:matrix-qa.test",
      sender: "@bot:matrix-qa.test",
      type: "m.room.message",
      body: "preview",
      msgtype: "m.notice",
      relatesTo: relation,
    });

    expect(observed).toEqual([
      replacement,
      expect.objectContaining({ eventId: "$preview", relatesTo: relation }),
      { ...replacement, relatesTo: relation },
    ]);
  });
});
