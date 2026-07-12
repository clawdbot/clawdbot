// Restart method tests cover safe restart scheduling, deferral flags, and
// response payloads returned by gateway.restart.request.

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

function invokeRestartRequest(params: unknown) {
  const respond = vi.fn();
  const handler = expectDefined(
    restartHandlers["gateway.restart.request"],
    'restartHandlers["gateway.restart.request"] test invariant',
  );
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
  beforeEach(() => {
    requestSafeGatewayRestart.mockClear();
  });

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

  it("backs off before an emoji that crosses the reason limit", async () => {
    mockScheduledRestart({ safe: true, summary: "safe to restart now" });

    await invokeRestartRequest({ reason: "x".repeat(199) + "🧠tail" });

    expect(requestSafeGatewayRestart).toHaveBeenCalledWith({
      reason: "x".repeat(199),
      delayMs: 0,
      skipDeferral: false,
    });
  });

  it("rejects non-object params without scheduling a restart", async () => {
    const respond = await invokeRestartRequest("operator");

    expect(requestSafeGatewayRestart).not.toHaveBeenCalled();
    expect(respond.mock.calls).toEqual([
      [
        false,
        undefined,
        {
          code: "INVALID_REQUEST",
          message: "invalid gateway.restart.request params",
        },
      ],
    ]);
  });

  it("rejects array params without scheduling a restart", async () => {
    const respond = await invokeRestartRequest([]);

    expect(requestSafeGatewayRestart).not.toHaveBeenCalled();
    expect(respond.mock.calls).toEqual([
      [
        false,
        undefined,
        {
          code: "INVALID_REQUEST",
          message: "invalid gateway.restart.request params",
        },
      ],
    ]);
  });
});
