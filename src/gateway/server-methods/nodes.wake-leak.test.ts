import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadApnsRegistration: vi.fn(),
  resolveApnsAuthConfigFromEnv: vi.fn(),
  resolveApnsRelayConfigFromEnv: vi.fn(),
  sendApnsBackgroundWake: vi.fn(),
  sendApnsAlert: vi.fn(),
  clearApnsRegistrationIfCurrent: vi.fn(),
  shouldClearStoredApnsRegistration: vi.fn(() => false),
}));

vi.mock("../../infra/push-apns.js", () => mocks);

import {
  getNodeWakeStateSnapshot,
  resetNodeWakeStateForTest,
} from "../node-wake-state.test-support.js";
import { maybeWakeNodeWithApns } from "./nodes.js";

describe("maybeWakeNodeWithApns no-registration cleanup", () => {
  beforeEach(() => {
    resetNodeWakeStateForTest();
    vi.clearAllMocks();
    mocks.loadApnsRegistration.mockResolvedValue(null);
  });

  afterEach(() => {
    resetNodeWakeStateForTest();
  });

  it("does not retain state for unregistered node ids", async () => {
    for (let index = 0; index < 50; index += 1) {
      await expect(maybeWakeNodeWithApns(`unregistered-node-${index}`)).resolves.toMatchObject({
        available: false,
        throttled: false,
        path: "no-registration",
      });
    }

    for (let index = 0; index < 50; index += 1) {
      expect(getNodeWakeStateSnapshot(`unregistered-node-${index}`)).toBeUndefined();
    }
  });

  it("cleans up after a single no-registration result", async () => {
    await maybeWakeNodeWithApns("stale-node-id");
    expect(getNodeWakeStateSnapshot("stale-node-id")).toBeUndefined();
  });
});
