// Restart method tests cover safe restart scheduling, deferral flags, and
// response payloads returned by gateway.restart.request.
import { describe, expect, it, vi } from "vitest";
import { restartHandlers } from "./restart.js";

const requestSafeGatewayRestart = vi.hoisted(() => vi.fn());

vi.mock("../../infra/restart-coordinator.js", () => ({
  createSafeGatewayRestartPreflight: vi.fn(() => ({
    safe: true,
    counts: {
      queueSize: 0,
      pendingReplies: 0,
      embeddedRuns: 0,
      activeTasks: 0,
      totalActive: 0,
    },
    blockers: [],
    summary: "safe to restart now",
  })),
  requestSafeGatewayRestart: (opts: unknown) => requestSafeGatewayRestart(opts),
}));

function invokeRestartRequest(params: Record<string, unknown>) {
  const respond = vi.fn();
  const handler = restartHandlers["gateway.restart.request"];
  return Promise.resolve(
    handler({
      respond,
      params,
      // The handler only reads `params` and `respond`; remaining fields are unused.
    } as unknown as Parameters<typeof handler>[0]),
  ).then(() => respond);
}

function mockScheduledRestart(preflight: { safe: boolean; summary: string }) {
  requestSafeGatewayRestart.mockReturnValueOnce({
    ok: true,
    status: "scheduled",
    preflight: { ...preflight, counts: {}, blockers: [] },
    restart: {
      ok: true,
      pid: 0,
      signal: "SIGUSR1",
      delayMs: 0,
      mode: "emit",
      coalesced: false,
      cooldownMsApplied: 0,
    },
  });
}

function expectRestartRequest(skipDeferral: boolean) {
  expect(requestSafeGatewayRestart).toHaveBeenCalledWith({
    reason: "operator",
    delayMs: 0,
    skipDeferral,
  });
}

describe("gateway.restart.request handler", () => {
  it("defaults to skipDeferral: false when the param is absent", async () => {
    mockScheduledRestart({ safe: true, summary: "safe to restart now" });

    await invokeRestartRequest({ reason: "operator" });

    expectRestartRequest(false);
  });

  it("forwards skipDeferral: true only when params.skipDeferral === true", async () => {
    mockScheduledRestart({ safe: false, summary: "" });

    await invokeRestartRequest({ reason: "operator", skipDeferral: true });

    expectRestartRequest(true);
  });

  it("normalizes truthy non-boolean skipDeferral values to false", async () => {
    mockScheduledRestart({ safe: true, summary: "safe to restart now" });

    await invokeRestartRequest({ reason: "operator", skipDeferral: "true" });

    expectRestartRequest(false);
  });

  it("forwards skipDeferral: false explicitly when the param is sent as false", async () => {
    mockScheduledRestart({ safe: true, summary: "safe to restart now" });

    await invokeRestartRequest({ reason: "operator", skipDeferral: false });

    expectRestartRequest(false);
  });
});
