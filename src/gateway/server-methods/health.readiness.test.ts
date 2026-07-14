import { describe, expect, it, vi } from "vitest";

const getStatusSummaryMock = vi.hoisted(() => vi.fn());

vi.mock("../../commands/status.js", () => ({
  getStatusSummary: getStatusSummaryMock,
}));

import { healthHandlers } from "./health.js";

describe("healthHandlers.ready", () => {
  const readyHandler = healthHandlers.ready;
  if (!readyHandler) {
    throw new Error("healthHandlers.ready must be registered");
  }

  it("returns the live canonical Gateway readiness result", async () => {
    const readiness = {
      ready: true,
      conditions: [],
      failures: [],
      advisories: [],
    };
    const respond = vi.fn();

    await readyHandler({
      req: {} as never,
      params: {},
      respond,
      context: { getReadiness: async () => readiness } as never,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(true, readiness, undefined);
  });

  it("fails closed when live readiness is unavailable", async () => {
    const respond = vi.fn();

    await readyHandler({
      req: {} as never,
      params: {},
      respond,
      context: {} as never,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "readiness unavailable" }),
    );
  });

  it("overlays the live result on Gateway health responses", async () => {
    const readiness = {
      ready: true,
      conditions: [],
      failures: [],
      advisories: [],
    };
    const health = {
      ok: true,
      ts: 1,
      durationMs: 1,
      channels: {},
      channelOrder: [],
      channelLabels: {},
      heartbeatSeconds: 0,
      defaultAgentId: "main",
      agents: [],
      sessions: { path: "/tmp/sessions.json", count: 0, recent: [] },
    };
    const respond = vi.fn();
    const healthHandler = healthHandlers.health;
    if (!healthHandler) {
      throw new Error("healthHandlers.health must be registered");
    }

    await healthHandler({
      req: {} as never,
      params: { probe: false },
      respond,
      context: {
        getHealthCache: () => null,
        refreshHealthSnapshot: async () => health,
        getReadiness: async () => readiness,
        getRuntimeSnapshot: () => ({ channels: {}, channelAccounts: {} }),
        logHealth: { error: vi.fn() },
      } as never,
      client: { connect: { scopes: ["operator.read"] } } as never,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(true, { ...health, readiness }, undefined);
  });

  it("overlays the live result on Gateway status responses", async () => {
    const fallbackReadiness = {
      ready: false,
      conditions: [],
      failures: [],
      advisories: [],
    };
    const readiness = { ...fallbackReadiness, ready: true };
    const status = { readiness: fallbackReadiness };
    const respond = vi.fn();
    getStatusSummaryMock.mockResolvedValueOnce(status);
    const statusHandler = healthHandlers.status;
    if (!statusHandler) {
      throw new Error("healthHandlers.status must be registered");
    }

    await statusHandler({
      req: {} as never,
      params: { includeChannelSummary: true },
      respond,
      context: { getReadiness: async () => readiness } as never,
      client: { connect: { scopes: ["operator.read"] } } as never,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(true, { ...status, readiness }, undefined);
  });
});
