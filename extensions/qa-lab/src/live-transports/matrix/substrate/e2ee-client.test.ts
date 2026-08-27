// QA Lab tests cover Matrix E2EE client behavior.
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MATRIX_QA_E2EE_SYNC_FILTER,
  createMatrixQaE2eeClientLifecycle,
  createMatrixQaE2eeObservedEventRecorder,
  prepareMatrixQaE2eeStorage,
} from "./e2ee-client-internals.js";
import { createMatrixQaE2eeScenarioClient, runMatrixQaE2eeBootstrap } from "./e2ee-client.js";
import { findMatrixQaObservedEventMatch, type MatrixQaObservedEvent } from "./events.js";

const scenarioClientMocks = vi.hoisted(() => {
  const client = {
    bootstrapOwnDeviceVerification: vi.fn(async () => ({ success: true })),
    drainPendingDecryptions: vi.fn(async () => undefined),
    off: vi.fn((_eventName: string, _listener: (...args: unknown[]) => void) => undefined),
    on: vi.fn((_eventName: string, _listener: (...args: unknown[]) => void) => undefined),
    start: vi.fn(
      async (_opts?: { abortSignal?: AbortSignal; readyTimeoutMs?: number }) => undefined,
    ),
    stopAndPersist: vi.fn(async () => undefined),
    stopWithoutPersist: vi.fn(),
    waitForEncryptedRoomReady: vi.fn(
      async (_roomId: string, _opts?: { abortSignal?: AbortSignal; timeoutMs?: number }) =>
        undefined,
    ),
  };
  return {
    client,
    setMatrixRuntime: vi.fn(),
  };
});

vi.mock("openclaw/plugin-sdk/qa-runner-runtime", () => ({
  loadQaRunnerBundledPluginTestApi: async () => ({
    MatrixClient: function MatrixClient() {
      return scenarioClientMocks.client;
    },
    setMatrixRuntime: scenarioClientMocks.setMatrixRuntime,
  }),
}));

const testing = {
  MATRIX_QA_E2EE_SYNC_FILTER,
  createMatrixQaE2eeClientLifecycle,
  createMatrixQaE2eeObservedEventRecorder,
  findMatrixQaObservedEventMatch,
  prepareMatrixQaE2eeStorage,
};

beforeEach(() => {
  scenarioClientMocks.client.bootstrapOwnDeviceVerification.mockReset().mockResolvedValue({
    success: true,
  });
  scenarioClientMocks.setMatrixRuntime.mockReset();
  scenarioClientMocks.client.drainPendingDecryptions.mockReset().mockResolvedValue(undefined);
  scenarioClientMocks.client.off.mockReset();
  scenarioClientMocks.client.on.mockReset();
  scenarioClientMocks.client.start.mockReset().mockResolvedValue(undefined);
  scenarioClientMocks.client.stopAndPersist.mockReset().mockResolvedValue(undefined);
  scenarioClientMocks.client.stopWithoutPersist.mockReset();
  scenarioClientMocks.client.waitForEncryptedRoomReady.mockReset().mockResolvedValue(undefined);
});

describe("matrix qa e2ee client storage", () => {
  function createLifecycleFixture(options?: {
    discard?: () => Promise<void>;
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
      stopWithoutPersist: vi.fn(async () => {
        calls.push("stop-and-discard");
        await options?.discard?.();
      }),
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
      await Promise.resolve();

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
      let finishDiscard: (() => void) | undefined;
      const { calls, lifecycle } = createLifecycleFixture({
        discard: () =>
          new Promise<void>((resolve) => {
            finishDiscard = resolve;
          }),
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
      await Promise.resolve();
      const stop = lifecycle.stop();
      const rejection = expect(stop).rejects.toThrow(
        "shutdown failed while waiting for active Matrix SDK operations",
      );

      await vi.advanceTimersByTimeAsync(100);

      let rejected = false;
      void stop.catch(() => {
        rejected = true;
      });
      await Promise.resolve();
      expect(rejected).toBe(false);
      expect(calls).toEqual(["operation", "detach", "stop-and-discard"]);

      finishDiscard?.();
      await rejection;
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
      await Promise.resolve();
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

  it("keeps the scenario client unavailable until required-room readiness completes", async () => {
    let releaseEncryption: (() => void) | undefined;
    const encryptionReady = new Promise<void>((resolve) => {
      releaseEncryption = resolve;
    });
    let readinessSignal: AbortSignal | undefined;
    scenarioClientMocks.client.waitForEncryptedRoomReady.mockImplementationOnce(
      async (_roomId, opts) => {
        readinessSignal = opts?.abortSignal;
        await encryptionReady;
      },
    );
    let created = false;
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "matrix-qa-e2ee-readiness-"));

    try {
      const pendingClient = createMatrixQaE2eeScenarioClient({
        accessToken: "driver-token",
        actorId: "driver",
        baseUrl: "https://matrix-qa.test",
        observedEvents: [],
        outputDir,
        readyRoomIds: ["!target:matrix-qa.test"],
        scenarioId: "matrix-e2ee-basic-reply",
        timeoutMs: 1_000,
        userId: "@driver:matrix-qa.test",
      }).then((client) => {
        created = true;
        return client;
      });
      await vi.waitFor(() =>
        expect(scenarioClientMocks.client.waitForEncryptedRoomReady).toHaveBeenCalledWith(
          "!target:matrix-qa.test",
          {
            abortSignal: expect.any(AbortSignal),
            timeoutMs: 1_000,
          },
        ),
      );

      expect(created).toBe(false);
      expect(readinessSignal).toBe(
        scenarioClientMocks.client.start.mock.calls[0]?.[0]?.abortSignal,
      );
      releaseEncryption?.();
      const client = await pendingClient;
      expect(created).toBe(true);
      await client.stop();
    } finally {
      releaseEncryption?.();
      await rm(outputDir, { force: true, recursive: true });
    }
  });

  it.each(Array.from({ length: 4 }, (_, row) => [Boolean(row & 2), Boolean(row & 1)]))(
    "settles bootstrap lifecycle %#",
    async (runFails, stopFails) => {
      const runError = new Error("bootstrap-secret");
      const stopError = new Error("persist-secret");
      if (runFails) {
        scenarioClientMocks.client.bootstrapOwnDeviceVerification.mockRejectedValueOnce(runError);
      }
      if (stopFails) {
        scenarioClientMocks.client.stopAndPersist.mockRejectedValueOnce(stopError);
      }

      const outcome = await runMatrixQaE2eeBootstrap({
        accessToken: "driver-token",
        actorId: "driver",
        baseUrl: "https://matrix-qa.test",
        outputDir: os.tmpdir(),
        scenarioId: "matrix-e2ee-bootstrap-success",
        timeoutMs: 1_000,
        userId: "@driver:matrix-qa.test",
      }).catch((error: unknown) => error);
      const expected = [...(runFails ? [runError] : []), ...(stopFails ? [stopError] : [])];

      if (expected.length === 0) {
        expect(outcome).toEqual({ success: true });
      } else if (expected.length === 1) {
        expect(outcome).toBe(expected[0]);
      } else {
        expect(outcome).toMatchObject({
          cause: runError,
          errors: expected,
          message: "Matrix E2EE bootstrap lifecycle failed",
        });
        expect((outcome as Error).message).not.toMatch(/secret/u);
      }
      expect(scenarioClientMocks.client.stopAndPersist).toHaveBeenCalledOnce();
      expect(scenarioClientMocks.client.waitForEncryptedRoomReady).not.toHaveBeenCalled();
    },
  );

  it("aborts timed-out readiness and cleans up the partially constructed client", async () => {
    vi.useFakeTimers();
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "matrix-qa-e2ee-timeout-"));
    let authorityRequestActive = false;
    let releaseAuthorityAbort: (() => void) | undefined;
    let readinessSignal: AbortSignal | undefined;
    let markReadinessStarted: (() => void) | undefined;
    const readinessStarted = new Promise<void>((resolve) => {
      markReadinessStarted = resolve;
    });
    scenarioClientMocks.client.stopAndPersist.mockImplementationOnce(async () => {
      expect(authorityRequestActive).toBe(false);
    });
    scenarioClientMocks.client.waitForEncryptedRoomReady.mockImplementationOnce(
      async (_roomId, opts) =>
        await new Promise<never>((_resolve, reject) => {
          readinessSignal = opts?.abortSignal;
          authorityRequestActive = true;
          markReadinessStarted?.();
          const noteAbort = () => {
            releaseAuthorityAbort = () => {
              authorityRequestActive = false;
              const error = new Error("readiness aborted");
              error.name = "AbortError";
              reject(error);
            };
          };
          if (readinessSignal?.aborted) {
            noteAbort();
            return;
          }
          readinessSignal?.addEventListener("abort", noteAbort, { once: true });
        }),
    );

    try {
      const pendingClient = createMatrixQaE2eeScenarioClient({
        accessToken: "driver-token",
        actorId: "driver",
        baseUrl: "https://matrix-qa.test",
        observedEvents: [],
        outputDir,
        readyRoomIds: ["!target:matrix-qa.test"],
        scenarioId: "matrix-e2ee-basic-reply",
        timeoutMs: 50,
        userId: "@driver:matrix-qa.test",
      });
      let clientSettled = false;
      void pendingClient
        .finally(() => {
          clientSettled = true;
        })
        .catch(() => undefined);
      const rejection = pendingClient.catch((error: unknown) => error);
      await readinessStarted;
      await vi.advanceTimersByTimeAsync(50);

      expect(readinessSignal?.aborted).toBe(true);
      expect(authorityRequestActive).toBe(true);
      expect(clientSettled).toBe(false);
      expect(scenarioClientMocks.client.stopAndPersist).not.toHaveBeenCalled();

      releaseAuthorityAbort?.();
      const error = await rejection;

      expect(error).toMatchObject({
        message: "Matrix E2EE client startup timed out after 50ms",
      });
      expect(authorityRequestActive).toBe(false);
      expect(scenarioClientMocks.client.off).toHaveBeenCalledWith(
        "room.message",
        expect.any(Function),
      );
      expect(scenarioClientMocks.client.off).toHaveBeenCalledWith(
        "verification.summary",
        expect.any(Function),
      );
      expect(scenarioClientMocks.client.stopAndPersist).toHaveBeenCalledTimes(1);
      expect(scenarioClientMocks.client.stopWithoutPersist).not.toHaveBeenCalled();
    } finally {
      releaseAuthorityAbort?.();
      vi.useRealTimers();
      await rm(outputDir, { force: true, recursive: true });
    }
  });

  it("cleans up when listener setup fails before startup", async () => {
    const constructionError = new Error("listener setup failed");
    scenarioClientMocks.client.on
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw constructionError;
      });
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "matrix-qa-e2ee-listener-"));

    try {
      const failure = await createMatrixQaE2eeScenarioClient({
        accessToken: "driver-token",
        actorId: "driver",
        baseUrl: "https://matrix-qa.test",
        observedEvents: [],
        outputDir,
        scenarioId: "matrix-e2ee-bootstrap-success",
        timeoutMs: 1_000,
        userId: "@driver:matrix-qa.test",
      }).catch((error: unknown) => error);

      expect(failure).toBe(constructionError);
      expect(scenarioClientMocks.client.stopAndPersist).toHaveBeenCalledTimes(1);
      expect(scenarioClientMocks.client.off).toHaveBeenCalledTimes(2);
    } finally {
      await rm(outputDir, { force: true, recursive: true });
    }
  });

  it("preserves construction and cleanup failures when both fail", async () => {
    const constructionError = new Error("listener setup failed");
    const cleanupError = new Error("crypto persistence cleanup failed");
    scenarioClientMocks.client.on
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw constructionError;
      });
    scenarioClientMocks.client.stopAndPersist.mockRejectedValueOnce(cleanupError);
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "matrix-qa-e2ee-dual-failure-"));

    try {
      const failure = await createMatrixQaE2eeScenarioClient({
        accessToken: "driver-token",
        actorId: "driver",
        baseUrl: "https://matrix-qa.test",
        observedEvents: [],
        outputDir,
        scenarioId: "matrix-e2ee-bootstrap-success",
        timeoutMs: 1_000,
        userId: "@driver:matrix-qa.test",
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure).toMatchObject({
        cause: constructionError,
        errors: [constructionError, cleanupError],
        message: "Matrix E2EE client construction and cleanup both failed",
      });
      expect(scenarioClientMocks.client.stopAndPersist).toHaveBeenCalledTimes(1);
      expect(scenarioClientMocks.client.off).toHaveBeenCalledTimes(2);
    } finally {
      await rm(outputDir, { force: true, recursive: true });
    }
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
