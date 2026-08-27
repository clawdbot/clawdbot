import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bootstrap: vi.fn(),
  createDriver: vi.fn(),
  createScenarioClient: vi.fn(),
  matrixClient: { createPrivateRoom: vi.fn(), joinRoom: vi.fn() },
  patchAccount: vi.fn(),
  readAccount: vi.fn(),
  register: vi.fn(),
  startProxy: vi.fn(),
}));
vi.mock("../substrate/client.js", () => ({ createMatrixQaClient: () => mocks.matrixClient }));
vi.mock("../substrate/e2ee-client.js", () => ({
  createMatrixQaE2eeScenarioClient: mocks.createScenarioClient,
  runMatrixQaE2eeBootstrap: mocks.bootstrap,
}));
vi.mock("../substrate/fault-proxy.js", () => ({ startMatrixQaFaultProxy: mocks.startProxy }));
vi.mock("./scenario-runtime-config.js", async (importOriginal) => ({
  ...(await importOriginal()),
  patchMatrixQaGatewayMatrixAccount: mocks.patchAccount,
  readMatrixQaGatewayMatrixAccount: mocks.readAccount,
}));
vi.mock("./scenario-runtime-e2ee-shared.js", async (importOriginal) => ({
  ...(await importOriginal()),
  createMatrixQaE2eeDriverClient: mocks.createDriver,
  registerMatrixQaE2eeScenarioAccount: mocks.register,
  requireMatrixQaE2eeOutputDir: () => "/tmp/output",
  requireMatrixQaGatewayConfigPath: () => "/tmp/config.json",
}));

import {
  runMatrixQaFaultedE2eeBootstrap,
  runMatrixQaFaultedRecoveryOwnerVerification,
  withMatrixQaE2eeDriver,
  withMatrixQaIsolatedE2eeDriverRoom,
} from "./scenario-runtime-e2ee-room.js";

const context = { baseUrl: "matrix", outputDir: "/tmp/output", timeoutMs: 1_000 } as any;
const recovery = { context } as any;
const scenarioId = "matrix-e2ee-basic-reply";
const capture = async (run: Promise<unknown>) => await run.catch((error: unknown) => error);
const reject = (error: Error) => vi.fn(() => Promise.reject(error));
const action = (order: string[], name: string, error?: Error) =>
  vi.fn(async () => {
    order.push(name);
    if (error) throw error;
  });
const proxy = (stop = vi.fn(async () => undefined)) => ({ baseUrl: "proxy", hits: () => [], stop });
const expectAggregate = (actual: unknown, errors: Error[], message: string) =>
  expect(actual).toMatchObject({ cause: errors[0], errors, message });

describe("Matrix E2EE room lifecycles", () => {
  it("preserves exact and aggregates driver lifecycle failures", async () => {
    const errors = [new Error("run"), new Error("stop")];
    mocks.createDriver.mockResolvedValueOnce({ stop: vi.fn(async () => undefined) });
    expect(await capture(withMatrixQaE2eeDriver(context, scenarioId, reject(errors[0])))).toBe(
      errors[0],
    );
    mocks.createDriver.mockResolvedValueOnce({ stop: reject(errors[1]) });
    expectAggregate(
      await capture(withMatrixQaE2eeDriver(context, scenarioId, reject(errors[0]))),
      errors,
      "Matrix E2EE driver lifecycle failed",
    );
  });

  it("preserves exact and aggregates faulted bootstrap lifecycle failures", async () => {
    const errors = [new Error("bootstrap"), new Error("proxy")];
    mocks.bootstrap.mockRejectedValueOnce(errors[0]);
    mocks.startProxy.mockResolvedValueOnce(proxy());
    expect(await capture(runMatrixQaFaultedE2eeBootstrap(context))).toBe(errors[0]);
    mocks.bootstrap.mockRejectedValueOnce(errors[0]);
    mocks.startProxy.mockResolvedValueOnce(proxy(reject(errors[1])));
    expectAggregate(
      await capture(runMatrixQaFaultedE2eeBootstrap(context)),
      errors,
      "Matrix E2EE faulted bootstrap lifecycle failed",
    );
  });

  it("stops after recovery construction failure and orders aggregate cleanup", async () => {
    const construction = new Error("construction");
    const stop = vi.fn(async () => undefined);
    mocks.createScenarioClient.mockRejectedValueOnce(construction);
    mocks.startProxy.mockResolvedValueOnce(proxy(stop));
    expect(await capture(runMatrixQaFaultedRecoveryOwnerVerification(recovery))).toBe(construction);
    expect(stop).toHaveBeenCalledOnce();
    const order: string[] = [];
    const errors = [new Error("verify"), new Error("client"), new Error("proxy")];
    mocks.createScenarioClient.mockResolvedValueOnce({
      stop: action(order, "client", errors[1]),
      verifyWithRecoveryKey: action(order, "verify", errors[0]),
    });
    mocks.startProxy.mockResolvedValueOnce(proxy(action(order, "proxy", errors[2])));
    const outcome = await capture(runMatrixQaFaultedRecoveryOwnerVerification(recovery));
    expect(order).toEqual(["verify", "client", "proxy"]);
    expectAggregate(outcome, errors, "Matrix E2EE recovery owner verification lifecycle failed");
  });

  it("attempts isolated client stop then gateway restore and retains every error", async () => {
    const order: string[] = [];
    const errors = [new Error("run"), new Error("client"), new Error("restore")];
    const original = { groupAllowFrom: ["@original:test"], groupPolicy: "open" };
    mocks.readAccount.mockResolvedValueOnce(original);
    mocks.register.mockResolvedValueOnce({ accessToken: "x", deviceId: "x", userId: "x" });
    mocks.matrixClient.createPrivateRoom.mockResolvedValueOnce("!room:test");
    mocks.createScenarioClient.mockResolvedValueOnce({
      stop: action(order, "client", errors[1]),
      waitForJoinedMember: vi.fn(),
    });
    mocks.patchAccount
      .mockImplementationOnce(action(order, "patch"))
      .mockImplementationOnce(action(order, "restore", errors[2]));
    const isolated = {
      ...context,
      restartGatewayAfterStateMutation: vi.fn(async (mutate) => await mutate()),
    };
    const outcome = await capture(
      withMatrixQaIsolatedE2eeDriverRoom(isolated, scenarioId, action(order, "run", errors[0])),
    );
    expectAggregate(outcome, errors, "Matrix E2EE isolated driver room lifecycle failed");
    expect(order).toEqual(["patch", "run", "client", "restore"]);
  });

  it("restores an isolated gateway mutation when restart fails after the write", async () => {
    const order: string[] = [];
    const restartError = new Error("restart-secret");
    const restorationError = new Error("restoration-secret");
    mocks.readAccount.mockResolvedValueOnce({
      groupAllowFrom: ["@original:test"],
      groupPolicy: "open",
    });
    mocks.register.mockResolvedValueOnce({ accessToken: "x", deviceId: "x", userId: "x" });
    mocks.matrixClient.createPrivateRoom.mockResolvedValueOnce("!room:test");
    mocks.patchAccount
      .mockImplementationOnce(action(order, "patch"))
      .mockImplementationOnce(action(order, "restoration", restorationError));
    const restartGatewayAfterStateMutation = vi.fn(
      async (mutate: () => Promise<void>) => await mutate(),
    );
    restartGatewayAfterStateMutation.mockImplementationOnce(async (mutate) => {
      await mutate();
      order.push("restart");
      throw restartError;
    });

    const outcome = await capture(
      withMatrixQaIsolatedE2eeDriverRoom(
        { ...context, restartGatewayAfterStateMutation },
        scenarioId,
        vi.fn(),
      ),
    );

    expect(order).toEqual(["patch", "restart", "restoration"]);
    expect(restartGatewayAfterStateMutation).toHaveBeenCalledTimes(2);
    expectAggregate(
      outcome,
      [restartError, restorationError],
      "Matrix E2EE isolated driver room lifecycle failed",
    );
    expect((outcome as Error).message).not.toMatch(/secret/u);
  });
});
