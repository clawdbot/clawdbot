import { afterEach, expect, test, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { startGatewayServerHarness } from "./server.e2e-ws-harness.js";

const startup = vi.hoisted(() => ({
  port: vi.fn<() => Promise<number>>(),
  server: vi.fn<() => Promise<never>>(),
}));
vi.mock("./test-helpers.js", () => ({
  getGatewayTestPort: startup.port,
  startTestGatewayServer: startup.server,
  connectOk: vi.fn(),
  trackConnectChallengeNonce: vi.fn(),
}));

afterEach(() => {
  vi.resetAllMocks();
});

test.each(["port", "server"] as const)(
  "restores its token snapshot when %s acquisition fails before publishing a close handle",
  async (stage) => {
    const env = captureEnv(["OPENCLAW_GATEWAY_TOKEN"]);
    const failure = new Error(`injected ${stage} acquisition failure`);
    process.env.OPENCLAW_GATEWAY_TOKEN = "fixture-token";
    startup.port.mockResolvedValue(12345);
    startup.server.mockRejectedValue(failure);
    if (stage === "port") {
      startup.port.mockRejectedValue(failure);
    }
    try {
      await expect(startGatewayServerHarness()).rejects.toBe(failure);
      expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("fixture-token");
    } finally {
      env.restore();
    }
  },
);
