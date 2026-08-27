import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MatrixQaE2eeScenarioClient } from "../substrate/e2ee-client.js";
import type { MatrixQaScenarioContext } from "./scenario-runtime-shared.js";

const sharedScenarioMocks = vi.hoisted(() => ({
  createMatrixQaE2eeScenarioClient: vi.fn(),
}));

vi.mock("../substrate/e2ee-client.js", () => ({
  createMatrixQaE2eeScenarioClient: sharedScenarioMocks.createMatrixQaE2eeScenarioClient,
  runMatrixQaE2eeBootstrap: vi.fn(),
}));

import {
  createMatrixQaE2eeDriverClient,
  withMatrixQaE2eeDriverAndObserver,
} from "./scenario-runtime-e2ee-shared.js";

function createContext(): MatrixQaScenarioContext {
  return {
    baseUrl: "https://matrix-qa.test",
    driverAccessToken: "driver-token",
    driverDeviceId: "DRIVER",
    driverPassword: "driver-password",
    driverUserId: "@driver:matrix-qa.test",
    observedEvents: [],
    observerAccessToken: "observer-token",
    observerDeviceId: "OBSERVER",
    observerPassword: "observer-password",
    observerUserId: "@observer:matrix-qa.test",
    outputDir: "/tmp/matrix-qa-output",
    sutAccessToken: "sut-token",
    sutUserId: "@sut:matrix-qa.test",
    syncState: {},
    timeoutMs: 30_000,
    topology: { rooms: [] },
  } as unknown as MatrixQaScenarioContext;
}

function createClient(stop = vi.fn(async () => undefined)) {
  return {
    client: { stop } as unknown as MatrixQaE2eeScenarioClient,
    stop,
  };
}

beforeEach(() => {
  sharedScenarioMocks.createMatrixQaE2eeScenarioClient.mockReset();
});

describe("Matrix E2EE scenario readiness scope", () => {
  it("does not require room readiness for a control-plane driver", async () => {
    const { client } = createClient();
    sharedScenarioMocks.createMatrixQaE2eeScenarioClient.mockResolvedValue(client);

    await createMatrixQaE2eeDriverClient(createContext(), "matrix-e2ee-bootstrap-success");

    expect(sharedScenarioMocks.createMatrixQaE2eeScenarioClient).toHaveBeenCalledOnce();
    expect(
      sharedScenarioMocks.createMatrixQaE2eeScenarioClient.mock.calls[0]?.[0],
    ).not.toHaveProperty("readyRoomIds");
  });

  it("preserves the observer construction failure when driver cleanup succeeds", async () => {
    const driver = createClient();
    const startupError = new Error("observer setup failed");
    sharedScenarioMocks.createMatrixQaE2eeScenarioClient
      .mockResolvedValueOnce(driver.client)
      .mockRejectedValueOnce(startupError);
    const run = vi.fn();

    const failure = await withMatrixQaE2eeDriverAndObserver(
      createContext(),
      "matrix-e2ee-basic-reply",
      run,
      {
        readyRoomIds: ["!message:matrix-qa.test"],
      },
    ).catch((error: unknown) => error);

    expect(failure).toBe(startupError);
    expect(run).not.toHaveBeenCalled();
    expect(driver.stop).toHaveBeenCalledTimes(1);
  });

  it("aggregates observer construction and driver cleanup failures without leaking details", async () => {
    const driver = createClient();
    const startupError = new Error("observer setup failed with observer-secret");
    const cleanupError = new Error("driver cleanup failed with driver-secret");
    driver.stop.mockRejectedValueOnce(cleanupError);
    sharedScenarioMocks.createMatrixQaE2eeScenarioClient
      .mockResolvedValueOnce(driver.client)
      .mockRejectedValueOnce(startupError);
    const run = vi.fn();

    const failure = await withMatrixQaE2eeDriverAndObserver(
      createContext(),
      "matrix-e2ee-basic-reply",
      run,
      {
        readyRoomIds: ["!message:matrix-qa.test"],
      },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      cause: startupError,
      errors: [startupError, cleanupError],
      message: "Matrix E2EE observer startup and driver cleanup both failed",
    });
    expect((failure as Error).message).not.toContain("observer-secret");
    expect((failure as Error).message).not.toContain("driver-secret");
    expect(run).not.toHaveBeenCalled();
    expect(driver.stop).toHaveBeenCalledTimes(1);
  });

  it.each(
    Array.from({ length: 8 }, (_, row) => [Boolean(row & 4), Boolean(row & 2), Boolean(row & 1)]),
  )("settles the post-construction lifecycle %#", async (runFails, observerFails, driverFails) => {
    const order: string[] = [];
    const errors = ["run", "observer", "driver"].map((name) => new Error(`${name}-secret`));
    const step = (name: string, error?: Error, value?: string) =>
      vi.fn(async () => {
        order.push(name);
        if (error) throw error;
        return value;
      });
    const driver = createClient(step("driver", driverFails ? errors[2] : undefined));
    const observer = createClient(step("observer", observerFails ? errors[1] : undefined));
    sharedScenarioMocks.createMatrixQaE2eeScenarioClient
      .mockResolvedValueOnce(driver.client)
      .mockResolvedValueOnce(observer.client);
    const outcome = await withMatrixQaE2eeDriverAndObserver(
      createContext(),
      "matrix-e2ee-basic-reply",
      step("run", runFails ? errors[0] : undefined, "ok"),
      { readyRoomIds: ["!message:matrix-qa.test"] },
    ).catch((error: unknown) => error);
    const expected = errors.filter((_, index) => [runFails, observerFails, driverFails][index]);

    expect(order).toEqual(["run", "observer", "driver"]);
    expect(
      sharedScenarioMocks.createMatrixQaE2eeScenarioClient.mock.calls.map(([arg]) => ({
        actorId: arg.actorId,
        readyRoomIds: arg.readyRoomIds,
      })),
    ).toEqual([
      { actorId: "driver", readyRoomIds: ["!message:matrix-qa.test"] },
      { actorId: "observer", readyRoomIds: ["!message:matrix-qa.test"] },
    ]);
    if (!expected.length) expect(outcome).toBe("ok");
    else if (expected.length === 1) expect(outcome).toBe(expected[0]);
    else {
      expect(outcome).toMatchObject({
        cause: expected[0],
        errors: expected,
        message: "Matrix E2EE driver and observer lifecycle failed",
      });
      expect((outcome as Error).message).not.toMatch(/secret/u);
    }
  });
});
