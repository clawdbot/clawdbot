import { describe, expect, it, vi } from "vitest";
import type { ChannelManager } from "./server-channels.js";
import {
  AUTH_NONE,
  createRequest,
  createResponse,
  dispatchRequest,
  withGatewayServer,
} from "./server-http.test-harness.js";
import { createReadinessChecker } from "./server/readiness.js";

describe("Gateway readiness probe clock rollback", () => {
  it.each([
    { name: "stopped", lifecycle: "stopped", running: false },
    { name: "starting", lifecycle: "starting", running: true },
    { name: "recovering", lifecycle: "recovering", running: true },
    { name: "unrecorded", lifecycle: undefined, running: true },
  ] as const)("returns 503 for a $name channel after the clock moves backward", async (state) => {
    let now = Date.now();
    const startedAt = now - 300_000;
    const account = {
      accountId: "default",
      running: true,
      connected: true,
      enabled: true,
      configured: true,
      lifecycle: "ready" as "ready" | "stopped" | "starting" | "recovering" | undefined,
      lastStartAt: startedAt,
    };
    const channelManager = {
      getRuntimeSnapshot: vi.fn(() => ({
        channels: { discord: account },
        channelAccounts: { discord: { default: account } },
      })),
      getAutostartSuppression: () => null,
      isAmbientAutostartSuppressed: () => false,
    } as unknown as ChannelManager;
    const getReadiness = createReadinessChecker({ channelManager, startedAt, cacheTtlMs: 1_000 });
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);

    try {
      await withGatewayServer({
        prefix: "probe-clock-rollback-stopped-channel",
        resolvedAuth: AUTH_NONE,
        overrides: { getReadiness },
        run: async (server) => {
          const healthy = createResponse();
          await dispatchRequest(server, createRequest({ path: "/readyz" }), healthy.res);
          expect(healthy.res.statusCode).toBe(200);

          account.running = state.running;
          account.connected = false;
          account.lifecycle = state.lifecycle;
          account.lastStartAt = now;
          now -= 60_000;

          const stopped = createResponse();
          await dispatchRequest(server, createRequest({ path: "/readyz" }), stopped.res);
          expect(stopped.res.statusCode).toBe(503);
          expect(JSON.parse(stopped.getBody())).toMatchObject({
            ready: false,
            failing: ["discord"],
          });
          expect(channelManager.getRuntimeSnapshot).toHaveBeenCalledTimes(2);
        },
      });
    } finally {
      dateNow.mockRestore();
    }
  });
});
