import { setTimeout as sleep } from "node:timers/promises";
import type { MatrixVerificationSummary } from "@openclaw/matrix/test-api.js";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMatrixQaE2eeScenarioClient,
  type MatrixQaE2eeScenarioClient,
} from "../substrate/e2ee-client.js";
import {
  waitForMatrixQaVerificationSummary,
  withMatrixQaE2eeDriverAndObserver,
} from "./scenario-runtime-e2ee-shared.js";
import { createMatrixQaE2eeTestContext } from "./scenario-runtime-e2ee.test-helpers.js";

vi.mock("../substrate/e2ee-client.js", () => ({
  createMatrixQaE2eeScenarioClient: vi.fn(),
  runMatrixQaE2eeBootstrap: vi.fn(),
}));

vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:timers/promises")>()),
  setTimeout: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

function summary(overrides: Partial<MatrixVerificationSummary> = {}): MatrixVerificationSummary {
  return {
    id: "private-id",
    transactionId: "private-transaction",
    roomId: "private-room",
    otherUserId: "private-user",
    otherDeviceId: "private-device",
    isSelfVerification: true,
    initiatedByMe: false,
    phase: 1,
    phaseName: "requested",
    pending: true,
    methods: ["private-method"],
    canAccept: true,
    hasSas: true,
    sas: { decimal: [123, 456, 789], emoji: [["secret-emoji", "secret-label"]] },
    hasReciprocateQr: true,
    completed: false,
    error: "private-raw-error",
    createdAt: "private-created",
    updatedAt: "private-updated",
    ...overrides,
  };
}

describe("Matrix E2EE scenario client ownership", () => {
  const context = createMatrixQaE2eeTestContext();
  const scenarioId = "matrix-e2ee-qr-verification";
  const client = (stop: MatrixQaE2eeScenarioClient["stop"]) =>
    ({ stop }) as MatrixQaE2eeScenarioClient;

  it.each([false, true])(
    "stops the driver when observer acquisition fails (cleanup fails: %s)",
    async (cleanupFails) => {
      const acquisitionFailure = new Error("observer startup failed");
      const cleanupFailure = new Error("driver persistence failed");
      const stop = vi.fn(async () => {
        if (cleanupFails) {
          throw cleanupFailure;
        }
      });
      vi.mocked(createMatrixQaE2eeScenarioClient)
        .mockResolvedValueOnce(client(stop))
        .mockRejectedValueOnce(acquisitionFailure);
      const run = vi.fn();
      const failure = await withMatrixQaE2eeDriverAndObserver(context, scenarioId, run).catch(
        (error: unknown) => error,
      );

      expect(stop).toHaveBeenCalledTimes(1);
      expect(run).not.toHaveBeenCalled();
      if (cleanupFails) {
        expect(failure).toMatchObject({
          cause: acquisitionFailure,
          errors: [acquisitionFailure, cleanupFailure],
        });
      } else {
        expect(failure).toBe(acquisitionFailure);
      }
    },
  );

  it.each(["driver", "observer"] as const)(
    "joins both clients and preserves all errors when %s cleanup fails first",
    async (firstFailure) => {
      const scenarioFailure = new Error("verification failed");
      const driverFailure = new Error("driver shutdown failed");
      const observerFailure = new Error("observer shutdown failed");
      const delayedStop = createDeferred<void>();
      const stops = {
        driver: vi.fn(async () => {
          if (firstFailure !== "driver") {
            await delayedStop.promise;
          }
          throw driverFailure;
        }),
        observer: vi.fn(async () => {
          if (firstFailure !== "observer") {
            await delayedStop.promise;
          }
          throw observerFailure;
        }),
      };
      vi.mocked(createMatrixQaE2eeScenarioClient)
        .mockResolvedValueOnce(client(stops.driver))
        .mockResolvedValueOnce(client(stops.observer));
      const settled = vi.fn();
      const completion = withMatrixQaE2eeDriverAndObserver(context, scenarioId, async () => {
        throw scenarioFailure;
      }).then(settled, settled);
      try {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(stops.driver).toHaveBeenCalledTimes(1);
        expect(stops.observer).toHaveBeenCalledTimes(1);
        expect(settled).not.toHaveBeenCalled();
      } finally {
        delayedStop.resolve();
        await completion;
      }
      expect(settled).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          cause: scenarioFailure,
          errors: [scenarioFailure, driverFailure, observerFailure],
        }),
      );
    },
  );

  it("returns the scenario result after stopping both clients", async () => {
    const stopDriver = vi.fn(async () => {});
    const stopObserver = vi.fn(async () => {});
    const driver = client(stopDriver);
    const observer = client(stopObserver);
    vi.mocked(createMatrixQaE2eeScenarioClient)
      .mockResolvedValueOnce(driver)
      .mockResolvedValueOnce(observer);
    const result = { verified: true };
    const run = vi.fn(async () => result);

    await expect(withMatrixQaE2eeDriverAndObserver(context, scenarioId, run)).resolves.toBe(result);
    expect(run).toHaveBeenCalledExactlyOnceWith({ driver, observer });
    expect(stopDriver).toHaveBeenCalledTimes(1);
    expect(stopObserver).toHaveBeenCalledTimes(1);
  });

  it("preserves a cleanup-only rejection after joining the other client", async () => {
    const delayedStop = createDeferred<void>();
    const stopDriver = vi.fn().mockRejectedValue(undefined);
    const stopObserver = vi.fn(() => delayedStop.promise);
    const driver = client(stopDriver);
    const observer = client(stopObserver);
    vi.mocked(createMatrixQaE2eeScenarioClient)
      .mockResolvedValueOnce(driver)
      .mockResolvedValueOnce(observer);
    const resolved = vi.fn();
    const rejected = vi.fn();
    const completion = withMatrixQaE2eeDriverAndObserver(context, scenarioId, async () => ({
      verified: true,
    })).then(resolved, rejected);
    try {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(stopDriver).toHaveBeenCalledTimes(1);
      expect(stopObserver).toHaveBeenCalledTimes(1);
      expect(resolved).not.toHaveBeenCalled();
      expect(rejected).not.toHaveBeenCalled();
    } finally {
      delayedStop.resolve();
      await completion;
    }
    expect(resolved).not.toHaveBeenCalled();
    expect(rejected).toHaveBeenCalledExactlyOnceWith(undefined);
  });
});

describe("Matrix verification wait diagnostics", () => {
  it("reports only four latest phase/boolean states at the unchanged polling deadline", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.mocked(sleep).mockImplementation(async (ms) => {
      now += ms ?? 0;
    });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const latest = Array.from({ length: 6 }, () => summary({ phaseName: "ready" }));
    const listVerifications = vi
      .fn<MatrixQaE2eeScenarioClient["listVerifications"]>()
      .mockResolvedValueOnce([summary()])
      .mockResolvedValue(latest);
    const client: Pick<MatrixQaE2eeScenarioClient, "listVerifications"> = { listVerifications };
    const predicate = vi.fn(() => false);
    const error = await waitForMatrixQaVerificationSummary({
      client: client as MatrixQaE2eeScenarioClient,
      label: "recipient ready",
      predicate,
      timeoutMs: 275,
    }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    const expected = Array.from({ length: 4 }, () => ({
      phase: "ready",
      pending: true,
      completed: false,
      initiatedByMe: false,
      hasReciprocateQr: true,
      hasSas: true,
      hasError: true,
    }));
    expect(message).toBe(
      `timed out waiting for Matrix verification summary: recipient ready; states=${JSON.stringify(expected)}`,
    );
    expect(stderr).toHaveBeenCalledExactlyOnceWith(`[matrix-verification-timeout] ${message}\n`);
    expect(listVerifications).toHaveBeenCalledTimes(2);
    expect(predicate).toHaveBeenCalledTimes(7);
    expect(vi.mocked(sleep).mock.calls.map(([ms]) => ms)).toEqual([250, 25]);
    expect(now).toBe(275);
  });

  it("returns the matching summary unchanged without timeout diagnostics", async () => {
    const expected = summary({ completed: true, phaseName: "done" });
    const listVerifications = vi
      .fn<MatrixQaE2eeScenarioClient["listVerifications"]>()
      .mockResolvedValue([summary(), expected]);
    const client: Pick<MatrixQaE2eeScenarioClient, "listVerifications"> = { listVerifications };
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await expect(
      waitForMatrixQaVerificationSummary({
        client: client as MatrixQaE2eeScenarioClient,
        label: "complete",
        predicate: (entry) => entry.completed,
        timeoutMs: 1_000,
      }),
    ).resolves.toBe(expected);
    expect(sleep).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });
});
