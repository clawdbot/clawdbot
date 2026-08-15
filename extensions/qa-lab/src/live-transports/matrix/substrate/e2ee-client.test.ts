// QA Lab tests cover Matrix E2EE client behavior.
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  MATRIX_QA_E2EE_SYNC_FILTER,
  createMatrixQaE2eeClientLifecycle,
  createMatrixQaE2eeObservedEventRecorder,
  prepareMatrixQaE2eeStorage,
} from "./e2ee-client-internals.js";
import { findMatrixQaObservedEventMatch, type MatrixQaObservedEvent } from "./events.js";

const testing = {
  MATRIX_QA_E2EE_SYNC_FILTER,
  createMatrixQaE2eeClientLifecycle,
  createMatrixQaE2eeObservedEventRecorder,
  findMatrixQaObservedEventMatch,
  prepareMatrixQaE2eeStorage,
};

describe("matrix qa e2ee client storage", () => {
  function createLifecycleFixture(options?: {
    drain?: () => Promise<void>;
    shutdownTimeoutMs?: number;
  }) {
    const calls: string[] = [];
    const lifecycle = testing.createMatrixQaE2eeClientLifecycle({
      detachListeners: vi.fn(() => calls.push("detach")),
      drainPendingDecryptions: vi.fn(async () => {
        calls.push("drain");
        await options?.drain?.();
      }),
      shutdownTimeoutMs: options?.shutdownTimeoutMs ?? 500,
      stopAndPersist: vi.fn(async () => {
        calls.push("stop-and-persist");
      }),
      stopWithoutPersist: vi.fn(() => calls.push("stop-and-discard")),
    });
    return { calls, lifecycle };
  }

  it("drains decryptions before stopping the SDK and persisting", async () => {
    const { calls, lifecycle } = createLifecycleFixture();

    await lifecycle.stop();

    expect(calls).toEqual(["detach", "drain", "stop-and-persist"]);
  });

  it("shares one stop promise across concurrent and repeated shutdown requests", async () => {
    const { calls, lifecycle } = createLifecycleFixture();

    const first = lifecycle.stop();
    const second = lifecycle.stop();
    await Promise.all([first, second]);
    const third = lifecycle.stop();
    const run = vi.fn(async () => "sent");

    expect(second).toBe(first);
    expect(third).toBe(first);
    await expect(
      lifecycle.runOperation({
        label: "Matrix E2EE text send",
        run,
        timeoutMs: 100,
      }),
    ).rejects.toThrow("shutdown has started");
    expect(run).not.toHaveBeenCalled();
    expect(calls).toEqual(["detach", "drain", "stop-and-persist"]);
  });

  it("gives an active operation a bounded grace period before draining and stopping", async () => {
    vi.useFakeTimers();
    try {
      const { calls, lifecycle } = createLifecycleFixture();
      let finishOperation: ((value: string) => void) | undefined;
      const operation = lifecycle.runOperation({
        label: "Matrix E2EE text send",
        run: () =>
          new Promise<string>((resolve) => {
            calls.push("operation");
            finishOperation = resolve;
          }),
        timeoutMs: 1_000,
      });

      const stop = lifecycle.stop();
      expect(calls).toEqual(["operation", "detach"]);
      finishOperation?.("sent");
      await operation;
      await stop;

      expect(calls).toEqual(["operation", "detach", "drain", "stop-and-persist"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards without persisting when active operation grace expires", async () => {
    vi.useFakeTimers();
    try {
      const { calls, lifecycle } = createLifecycleFixture({
        shutdownTimeoutMs: 100,
      });
      void lifecycle.runOperation({
        label: "Matrix E2EE text send",
        run: () =>
          new Promise<string>(() => {
            calls.push("operation");
          }),
        timeoutMs: 1_000,
      });
      const stop = lifecycle.stop();
      const rejection = expect(stop).rejects.toThrow(
        "shutdown failed while waiting for active Matrix SDK operations",
      );

      await vi.advanceTimersByTimeAsync(100);

      await rejection;
      expect(calls).toEqual(["operation", "detach", "stop-and-discard"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards without persisting when pending decryptions exceed the shutdown deadline", async () => {
    vi.useFakeTimers();
    try {
      const { calls, lifecycle } = createLifecycleFixture({
        drain: () =>
          new Promise<void>(() => {
            // Intentionally pending so the shutdown deadline owns settlement.
          }),
        shutdownTimeoutMs: 100,
      });
      const stop = lifecycle.stop();
      const rejection = expect(stop).rejects.toThrow(
        "shutdown failed while draining pending Matrix decryptions",
      );

      await vi.advanceTimersByTimeAsync(100);

      await rejection;
      expect(calls).toEqual(["detach", "drain", "stop-and-discard"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("requests lifecycle shutdown on operation timeout instead of directly discarding", async () => {
    vi.useFakeTimers();
    try {
      const { calls, lifecycle } = createLifecycleFixture({
        shutdownTimeoutMs: 100,
      });
      const operation = lifecycle.runOperation({
        label: "Matrix E2EE text send",
        run: () =>
          new Promise<string>(() => {
            calls.push("operation");
          }),
        timeoutMs: 50,
      });
      const rejection = expect(operation).rejects.toThrow(
        "Matrix E2EE text send timed out after 50ms",
      );

      await vi.advanceTimersByTimeAsync(50);

      await rejection;
      expect(calls).toEqual(["operation", "detach"]);
      await vi.advanceTimersByTimeAsync(100);
      expect(calls).toEqual(["operation", "detach", "stop-and-discard"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("observes a tracked operation that rejects after shutdown has discarded state", async () => {
    vi.useFakeTimers();
    try {
      const { lifecycle } = createLifecycleFixture({
        shutdownTimeoutMs: 50,
      });
      let rejectOperation: ((error: Error) => void) | undefined;
      const operation = lifecycle.runOperation({
        label: "Matrix E2EE text send",
        run: () =>
          new Promise<string>((_resolve, reject) => {
            rejectOperation = reject;
          }),
        timeoutMs: 1_000,
      });
      const operationRejection = expect(operation).rejects.toThrow("late send failure");
      const stop = lifecycle.stop();
      const stopRejection = expect(stop).rejects.toThrow(
        "shutdown failed while waiting for active Matrix SDK operations",
      );

      await vi.advanceTimersByTimeAsync(50);
      await stopRejection;
      rejectOperation?.(new Error("late send failure"));
      await operationRejection;
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
