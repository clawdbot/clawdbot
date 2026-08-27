import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMatrixQaTransportAdapter, waitForMatrixQaObserverEvent } from "./adapter.runtime.js";
import type { MatrixQaRoomObserver } from "./substrate/sync.js";

const adapterMocks = vi.hoisted(() => ({
  createMatrixQaClient: vi.fn(),
  createMatrixQaRoomObserver: vi.fn(),
  harness: {
    baseUrl: "http://127.0.0.1:18008",
    registrationToken: "registration-token",
    stop: vi.fn(async () => undefined),
  },
  provisionMatrixQaRoom: vi.fn(),
  startMatrixQaHarness: vi.fn(),
}));

vi.mock("./substrate/client.js", () => ({
  createMatrixQaClient: adapterMocks.createMatrixQaClient,
  provisionMatrixQaRoom: adapterMocks.provisionMatrixQaRoom,
}));

vi.mock("./substrate/harness.runtime.js", () => ({
  startMatrixQaHarness: adapterMocks.startMatrixQaHarness,
}));

vi.mock("./substrate/sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./substrate/sync.js")>();
  return {
    ...actual,
    createMatrixQaRoomObserver: adapterMocks.createMatrixQaRoomObserver,
  };
});

function makeObserver(
  waitForOptionalRoomEvent: MatrixQaRoomObserver["waitForOptionalRoomEvent"],
): MatrixQaRoomObserver {
  return {
    prime: vi.fn(async () => "s0"),
    waitForOptionalRoomEvent,
    waitForRoomEvent: vi.fn(),
  };
}

function makePrimeFailureObserver(error: Error): MatrixQaRoomObserver {
  const observer = makeObserver(vi.fn());
  vi.mocked(observer.prime).mockRejectedValueOnce(error);
  return observer;
}

const provisioning = {
  driver: {
    accessToken: "driver-token",
    deviceId: "DRIVER",
    userId: "@driver:matrix.test",
  },
  observer: {
    accessToken: "observer-token",
    deviceId: "OBSERVER",
    userId: "@observer:matrix.test",
  },
  roomId: "!main:matrix.test",
  sut: {
    accessToken: "sut-token",
    deviceId: "SUT",
    userId: "@sut:matrix.test",
  },
  topology: {
    defaultRoomId: "!main:matrix.test",
    defaultRoomKey: "main",
    rooms: [
      {
        key: "main",
        kind: "group",
        memberRoles: ["driver", "observer", "sut"],
        memberUserIds: ["@driver:matrix.test", "@observer:matrix.test", "@sut:matrix.test"],
        name: "Matrix QA",
        requireMention: true,
        roomId: "!main:matrix.test",
      },
    ],
  },
};

beforeEach(() => {
  adapterMocks.harness.stop.mockReset().mockResolvedValue(undefined);
  adapterMocks.startMatrixQaHarness.mockReset().mockResolvedValue(adapterMocks.harness);
  adapterMocks.provisionMatrixQaRoom.mockReset();
  adapterMocks.createMatrixQaRoomObserver.mockReset();
  adapterMocks.createMatrixQaClient.mockReset();
});

describe("Matrix QA adapter startup cleanup", () => {
  it.each(["provisioning", "observer priming"] as const)(
    "preserves the %s failure when cleanup succeeds",
    async (phase) => {
      const startupError = new Error(`${phase} failed`);
      if (phase === "provisioning") {
        adapterMocks.provisionMatrixQaRoom.mockRejectedValueOnce(startupError);
      } else {
        adapterMocks.provisionMatrixQaRoom.mockResolvedValueOnce(provisioning);
        adapterMocks.createMatrixQaRoomObserver.mockReturnValueOnce(
          makePrimeFailureObserver(startupError),
        );
      }

      const failure = await createMatrixQaTransportAdapter({
        adapterOptions: {},
        messages: {},
      } as never).catch((error: unknown) => error);

      expect(failure).toBe(startupError);
      expect(adapterMocks.harness.stop).toHaveBeenCalledOnce();
    },
  );

  it.each(["provisioning", "observer priming"] as const)(
    "aggregates the %s failure with cleanup failure",
    async (phase) => {
      const startupError = new Error(`${phase} failed`);
      const cleanupError = new Error("secret runtime directory cleanup failed");
      adapterMocks.harness.stop.mockRejectedValueOnce(cleanupError);
      if (phase === "provisioning") {
        adapterMocks.provisionMatrixQaRoom.mockRejectedValueOnce(startupError);
      } else {
        adapterMocks.provisionMatrixQaRoom.mockResolvedValueOnce(provisioning);
        adapterMocks.createMatrixQaRoomObserver.mockReturnValueOnce(
          makePrimeFailureObserver(startupError),
        );
      }

      const failure = await createMatrixQaTransportAdapter({
        adapterOptions: {},
        messages: {},
      } as never).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure).toMatchObject({
        cause: startupError,
        errors: [startupError, cleanupError],
        message: "Matrix QA adapter startup and cleanup both failed",
      });
      expect(adapterMocks.harness.stop).toHaveBeenCalledOnce();
    },
  );
});

describe("Matrix QA adapter observer recovery", () => {
  it("retries a sync failure only during the explicit transport interruption window", async () => {
    let interrupted = true;
    const waitForOptionalRoomEvent = vi
      .fn<MatrixQaRoomObserver["waitForOptionalRoomEvent"]>()
      .mockRejectedValueOnce(new Error("homeserver unavailable"))
      .mockResolvedValueOnce({ matched: false, since: "s1" });
    const sleepImpl = vi.fn(async () => {
      interrupted = false;
    });

    await expect(
      waitForMatrixQaObserverEvent({
        isExpectedInterruption: () => interrupted,
        observer: makeObserver(waitForOptionalRoomEvent),
        predicate: () => true,
        readInterruptionGeneration: () => 1,
        roomId: "!room:matrix.test",
        sleepImpl,
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({ matched: false, since: "s1" });
    expect(waitForOptionalRoomEvent).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledOnce();
  });

  it("preserves terminal observer failures outside the interruption window", async () => {
    const failure = new Error("sync failed");
    const waitForOptionalRoomEvent = vi
      .fn<MatrixQaRoomObserver["waitForOptionalRoomEvent"]>()
      .mockRejectedValue(failure);
    const sleepImpl = vi.fn(async () => undefined);

    await expect(
      waitForMatrixQaObserverEvent({
        isExpectedInterruption: () => false,
        observer: makeObserver(waitForOptionalRoomEvent),
        predicate: () => true,
        readInterruptionGeneration: () => 0,
        roomId: "!room:matrix.test",
        sleepImpl,
        timeoutMs: 1_000,
      }),
    ).rejects.toBe(failure);
    expect(waitForOptionalRoomEvent).toHaveBeenCalledOnce();
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it("retries a poll that started during interruption after readiness closes the window", async () => {
    let interrupted = true;
    const waitForOptionalRoomEvent = vi
      .fn<MatrixQaRoomObserver["waitForOptionalRoomEvent"]>()
      .mockImplementationOnce(async () => {
        interrupted = false;
        throw new Error("stale outage response");
      })
      .mockResolvedValueOnce({ matched: false, since: "s2" });

    await expect(
      waitForMatrixQaObserverEvent({
        isExpectedInterruption: () => interrupted,
        observer: makeObserver(waitForOptionalRoomEvent),
        predicate: () => true,
        readInterruptionGeneration: () => 1,
        roomId: "!room:matrix.test",
        sleepImpl: vi.fn(async () => undefined),
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({ matched: false, since: "s2" });
    expect(waitForOptionalRoomEvent).toHaveBeenCalledTimes(2);
  });

  it("retries a poll that spans the complete interruption window", async () => {
    let interruptionGeneration = 0;
    const waitForOptionalRoomEvent = vi
      .fn<MatrixQaRoomObserver["waitForOptionalRoomEvent"]>()
      .mockImplementationOnce(async () => {
        // The poll began before restart and rejected only after begin/end both ran.
        interruptionGeneration = 2;
        throw new Error("pre-restart poll rejected after recovery");
      })
      .mockResolvedValueOnce({ matched: false, since: "s3" });

    await expect(
      waitForMatrixQaObserverEvent({
        isExpectedInterruption: () => false,
        observer: makeObserver(waitForOptionalRoomEvent),
        predicate: () => true,
        readInterruptionGeneration: () => interruptionGeneration,
        roomId: "!room:matrix.test",
        sleepImpl: vi.fn(async () => undefined),
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({ matched: false, since: "s3" });
    expect(waitForOptionalRoomEvent).toHaveBeenCalledTimes(2);
  });
});
