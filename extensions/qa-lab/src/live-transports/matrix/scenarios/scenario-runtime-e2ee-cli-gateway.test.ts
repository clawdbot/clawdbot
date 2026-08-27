import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createDriver: vi.fn(),
  createRuntime: vi.fn(),
  ensureVerified: vi.fn(),
  register: vi.fn(async () => ({ accessToken: "x", deviceId: "x", userId: "x" })),
}));
vi.mock("../substrate/client.js", () => ({
  createMatrixQaClient: () => ({
    createPrivateRoom: vi.fn(async () => "!room:test"),
    joinRoom: vi.fn(),
  }),
}));
vi.mock("../substrate/e2ee-client.js", () => ({
  createMatrixQaE2eeScenarioClient: mocks.createDriver,
}));
vi.mock("./scenario-runtime-config.js", () => ({
  patchMatrixQaGatewayMatrixAccount: vi.fn(),
  replaceMatrixQaGatewayMatrixAccount: vi.fn(),
}));
vi.mock("./scenario-runtime-e2ee-cli-runtime.js", () => ({
  createMatrixQaCliGatewayRuntime: mocks.createRuntime,
}));
vi.mock("./scenario-runtime-e2ee-cli-shared.js", () => ({
  parseMatrixQaCliJson: () => ({
    accountId: "cli-setup-gateway",
    bootstrap: { success: true },
    success: true,
  }),
  registerMatrixQaCliE2eeAccount: mocks.register,
  writeMatrixQaCliOutputArtifacts: async () => ({ stderrPath: "stderr", stdoutPath: "stdout" }),
}));
vi.mock("./scenario-runtime-e2ee-room.js", () => ({
  buildMatrixE2eeReplyArtifact: () => ({ eventId: "$reply", tokenMatched: true }),
}));
vi.mock("./scenario-runtime-e2ee-shared.js", () => ({
  ensureMatrixQaE2eeOwnDeviceVerified: mocks.ensureVerified,
  requireMatrixQaE2eeOutputDir: () => "/tmp/output",
  requireMatrixQaGatewayConfigPath: () => "/tmp/config.json",
}));

import { runMatrixQaE2eeCliSetupThenGatewayReplyScenario } from "./scenario-runtime-e2ee-cli-gateway.js";

const context = {
  restartGatewayAfterStateMutation: vi.fn(async (mutate) => await mutate()),
  waitGatewayAccountReady: vi.fn(),
} as any;

describe("Matrix CLI setup gateway reply lifecycle", () => {
  it.each(Array.from({ length: 8 }, (_, row) => [!!(row & 4), !!(row & 2), !!(row & 1)]))(
    "settles the full lifecycle %#",
    async (runFails, driverFails, cliFails) => {
      const order: string[] = [];
      const errors = [new Error("run-secret"), new Error("driver-secret"), new Error("cli-secret")];
      const step = (name: string, error?: Error) =>
        vi.fn(async () => {
          order.push(name);
          if (error) throw error;
        });
      mocks.createRuntime.mockResolvedValue({
        dispose: step("cli", cliFails ? errors[2] : undefined),
        rootDir: "/tmp",
        run: vi.fn(),
      });
      mocks.ensureVerified.mockImplementation(step("run", runFails ? errors[0] : undefined));
      mocks.createDriver.mockResolvedValue({
        prime: vi.fn(),
        sendTextMessage: vi.fn(async () => "$driver"),
        stop: step("driver", driverFails ? errors[1] : undefined),
        waitForJoinedMember: vi.fn(),
        waitForRoomEvent: vi.fn(async () => ({ event: {} })),
      });
      const outcome = await runMatrixQaE2eeCliSetupThenGatewayReplyScenario(context).catch(
        (error: unknown) => error,
      );
      const expected = errors.filter((_, index) => [runFails, driverFails, cliFails][index]);

      expect(order).toEqual(["run", "driver", "cli"]);
      if (!expected.length) expect(outcome).toHaveProperty("artifacts.setupSuccess", true);
      else if (expected.length === 1) expect(outcome).toBe(expected[0]);
      else {
        expect(outcome).toMatchObject({
          cause: expected[0],
          errors: expected,
          message: "Matrix CLI setup gateway reply lifecycle failed",
        });
        expect((outcome as Error).message).not.toMatch(/secret/u);
      }
    },
  );
});
