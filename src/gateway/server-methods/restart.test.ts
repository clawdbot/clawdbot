// Restart method tests cover the read-only compatibility preview plus safe
// restart scheduling, deferral flags, and request response payloads.

import { expectDefined } from "@openclaw/normalization-core";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getGatewaySuspendAdmissionPhase,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../process/gateway-work-admission.js";
import { handleGatewayRequest } from "../server-methods.js";
import { restartHandlers } from "./restart.js";

const scheduleSafeGatewayRestart = vi.hoisted(() => vi.fn());
const createSafeGatewayRestartPreflight = vi.hoisted(() => vi.fn());
const requestGatewayRestartWithSignalAdmission = vi.hoisted(() => vi.fn());
const readActiveGatewayLockIdentity = vi.hoisted(() => vi.fn());

vi.mock("../../infra/restart-coordinator.js", () => ({
  createSafeGatewayRestartPreflight: () => createSafeGatewayRestartPreflight(),
  scheduleSafeGatewayRestart: (opts: unknown) => scheduleSafeGatewayRestart(opts),
}));

vi.mock("../../infra/restart.js", () => ({
  requestGatewayRestartWithSignalAdmission: (reason: unknown, intent: unknown) =>
    requestGatewayRestartWithSignalAdmission(reason, intent),
}));

vi.mock("../../infra/gateway-lock.js", () => ({
  readActiveGatewayLockIdentity: () => readActiveGatewayLockIdentity(),
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

function invokeRestartPreflight() {
  const respond = vi.fn();
  const handler = expectDefined(
    restartHandlers["gateway.restart.preflight"],
    'restartHandlers["gateway.restart.preflight"] test invariant',
  );
  return Promise.resolve(
    handler({
      respond,
      params: {},
    } as unknown as Parameters<typeof handler>[0]),
  ).then(() => respond);
}

async function invokeRestartRequestThroughGateway(params: unknown) {
  const respond = vi.fn();
  const handler = expectDefined(
    restartHandlers["gateway.restart.request"],
    'restartHandlers["gateway.restart.request"] test invariant',
  );
  await handleGatewayRequest({
    req: {
      type: "req",
      id: `request-${crypto.randomUUID()}`,
      method: "gateway.restart.request",
      params,
    },
    respond,
    client: {
      connId: `conn-${crypto.randomUUID()}`,
      clientIp: "127.0.0.1",
      connect: {
        role: "operator",
        scopes: ["operator.admin"],
        client: { id: "cli", version: "test", platform: "linux", mode: "cli" },
        minProtocol: 1,
        maxProtocol: 1,
      },
    },
    isWebchatConnect: () => false,
    context: { logGateway: { warn: vi.fn() } } as unknown as Parameters<
      typeof handleGatewayRequest
    >[0]["context"],
    extraHandlers: { "gateway.restart.request": handler },
  });
  return respond;
}

function mockScheduledRestart(preflight: { safe: boolean; summary: string }) {
  scheduleSafeGatewayRestart.mockReturnValueOnce({
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
  expect(scheduleSafeGatewayRestart).toHaveBeenCalledWith({
    reason: "operator",
    delayMs: 0,
    skipDeferral,
  });
}

describe("gateway restart handlers", () => {
  beforeEach(() => {
    resetGatewayWorkAdmission();
    scheduleSafeGatewayRestart.mockClear();
    createSafeGatewayRestartPreflight.mockReset();
    requestGatewayRestartWithSignalAdmission.mockReset();
    requestGatewayRestartWithSignalAdmission.mockReturnValue({ status: "emitted" });
    readActiveGatewayLockIdentity.mockReset();
    readActiveGatewayLockIdentity.mockResolvedValue({
      pid: process.pid,
      ownerId: "gateway-owner",
      createdAt: "2026-07-16T12:00:00.000Z",
      port: 18_789,
    });
  });

  afterEach(() => {
    resetGatewayWorkAdmission();
  });

  it("keeps the deprecated read-only preflight response shape", async () => {
    const preflight = {
      safe: false,
      counts: {
        queueSize: 1,
        pendingReplies: 2,
        embeddedRuns: 3,
        cronRuns: 4,
        backgroundExecSessions: 5,
        rootRequests: 6,
        activeTasks: 7,
        totalActive: 28,
      },
      blockers: [{ kind: "queue", count: 1, message: "1 queued or active operation(s)" }],
      summary: "restart deferred: 1 queued or active operation(s)",
    };
    createSafeGatewayRestartPreflight.mockReturnValueOnce(preflight);

    const respond = await invokeRestartPreflight();

    expect(respond).toHaveBeenCalledWith(true, preflight);
    expect(scheduleSafeGatewayRestart).not.toHaveBeenCalled();
    expect(requestGatewayRestartWithSignalAdmission).not.toHaveBeenCalled();
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

  it("delivers a targeted restart only to the matching lock owner", async () => {
    const respond = await invokeRestartRequest({
      reason: "operator",
      target: {
        pid: process.pid,
        ownerId: "gateway-owner",
        port: 18_789,
      },
      restartIntent: { waitMs: 30_000 },
    });

    expect(scheduleSafeGatewayRestart).not.toHaveBeenCalled();
    expect(requestGatewayRestartWithSignalAdmission).toHaveBeenCalledWith("operator", {
      reason: "operator",
      waitMs: 30_000,
    });
    expect(respond).toHaveBeenCalledWith(true, {
      ok: true,
      status: "emitted",
      pid: process.pid,
    });
  });

  it("schedules a safe restart only after matching the target lock owner", async () => {
    mockScheduledRestart({ safe: false, summary: "restart deferred" });

    const respond = await invokeRestartRequest({
      reason: "operator",
      safe: true,
      skipDeferral: true,
      target: {
        pid: process.pid,
        ownerId: "gateway-owner",
        port: 18_789,
      },
    });

    expectRestartRequest(true);
    expect(requestGatewayRestartWithSignalAdmission).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ ok: true, status: "scheduled" }),
    );
  });

  it("rejects an invalid targeted safe mode without restarting", async () => {
    const respond = await invokeRestartRequest({
      safe: "true",
      target: {
        pid: process.pid,
        ownerId: "gateway-owner",
        port: 18_789,
      },
    });

    expect(scheduleSafeGatewayRestart).not.toHaveBeenCalled();
    expect(requestGatewayRestartWithSignalAdmission).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "INVALID_REQUEST",
      message: "invalid safe targeted restart mode",
    });
  });

  it("rejects a targeted restart after lock ownership changes", async () => {
    readActiveGatewayLockIdentity.mockResolvedValue({
      pid: process.pid,
      ownerId: "replacement-owner",
      createdAt: "2026-07-16T12:00:01.000Z",
      port: 18_789,
    });

    const respond = await invokeRestartRequest({
      reason: "operator",
      target: {
        pid: process.pid,
        ownerId: "gateway-owner",
        port: 18_789,
      },
    });

    expect(requestGatewayRestartWithSignalAdmission).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "INVALID_REQUEST",
      message: "target gateway no longer owns the active lock",
    });
  });

  it("retains prepared suspension when the exact restart target is stale", async () => {
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);
    readActiveGatewayLockIdentity.mockResolvedValue({
      pid: process.pid,
      ownerId: "replacement-owner",
      createdAt: "2026-07-16T12:00:01.000Z",
      port: 18_789,
    });

    const respond = await invokeRestartRequestThroughGateway({
      reason: "operator",
      target: {
        pid: process.pid,
        ownerId: "gateway-owner",
        port: 18_789,
      },
    });

    expect(readActiveGatewayLockIdentity).toHaveBeenCalledOnce();
    expect(requestGatewayRestartWithSignalAdmission).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "INVALID_REQUEST",
      message: "target gateway no longer owns the active lock",
    });
    expect(getGatewaySuspendAdmissionPhase()).toBe("prepared");
    expect(suspension?.release()).toBe(true);
  });

  it("retains prepared suspension when exact restart delivery fails", async () => {
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);
    requestGatewayRestartWithSignalAdmission.mockReturnValueOnce({ status: "failed" });

    const respond = await invokeRestartRequestThroughGateway({
      reason: "operator",
      target: {
        pid: process.pid,
        ownerId: "gateway-owner",
        port: 18_789,
      },
    });

    expect(readActiveGatewayLockIdentity).toHaveBeenCalledOnce();
    expect(requestGatewayRestartWithSignalAdmission).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "UNAVAILABLE",
      message: "target gateway restart delivery failed",
    });
    expect(getGatewaySuspendAdmissionPhase()).toBe("prepared");
    expect(suspension?.release()).toBe(true);
  });

  it("finishes an admitted exact restart after suspension resumes", async () => {
    let resolveLock: (value: unknown) => void = () => {};
    readActiveGatewayLockIdentity.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLock = resolve;
      }),
    );
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);

    const request = invokeRestartRequestThroughGateway({
      reason: "operator",
      target: {
        pid: process.pid,
        ownerId: "gateway-owner",
        port: 18_789,
      },
    });
    await vi.waitFor(() => expect(readActiveGatewayLockIdentity).toHaveBeenCalledOnce());
    expect(suspension?.release()).toBe(true);
    resolveLock({
      pid: process.pid,
      ownerId: "gateway-owner",
      createdAt: "2026-07-16T12:00:00.000Z",
      port: 18_789,
    });

    const respond = await request;
    expect(requestGatewayRestartWithSignalAdmission).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(true, {
      ok: true,
      status: "emitted",
      pid: process.pid,
    });
  });

  it("rejects conflicting targeted restart force and wait options", async () => {
    const respond = await invokeRestartRequest({
      reason: "operator",
      target: {
        pid: process.pid,
        ownerId: "gateway-owner",
        port: 18_789,
      },
      restartIntent: { force: true, waitMs: 30_000 },
    });

    expect(requestGatewayRestartWithSignalAdmission).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "INVALID_REQUEST",
      message: "invalid targeted gateway restart intent",
    });
  });

  it.each([0.5, -1, MAX_TIMER_TIMEOUT_MS + 1, Number.MAX_SAFE_INTEGER])(
    "rejects an invalid targeted restart wait of %s ms",
    async (waitMs) => {
      const respond = await invokeRestartRequest({
        reason: "operator",
        target: {
          pid: process.pid,
          ownerId: "gateway-owner",
          port: 18_789,
        },
        restartIntent: { waitMs },
      });

      expect(requestGatewayRestartWithSignalAdmission).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(false, undefined, {
        code: "INVALID_REQUEST",
        message: "invalid targeted gateway restart intent",
      });
    },
  );

  it("accepts the maximum timer-safe targeted restart wait", async () => {
    const respond = await invokeRestartRequest({
      reason: "operator",
      target: {
        pid: process.pid,
        ownerId: "gateway-owner",
        port: 18_789,
      },
      restartIntent: { waitMs: MAX_TIMER_TIMEOUT_MS },
    });

    expect(requestGatewayRestartWithSignalAdmission).toHaveBeenCalledWith("operator", {
      reason: "operator",
      waitMs: MAX_TIMER_TIMEOUT_MS,
    });
    expect(respond).toHaveBeenCalledWith(true, {
      ok: true,
      status: "emitted",
      pid: process.pid,
    });
  });

  it("backs off before an emoji that crosses the reason limit", async () => {
    mockScheduledRestart({ safe: true, summary: "safe to restart now" });

    await invokeRestartRequest({ reason: "x".repeat(199) + "🧠tail" });

    expect(scheduleSafeGatewayRestart).toHaveBeenCalledWith({
      reason: "x".repeat(199),
      delayMs: 0,
      skipDeferral: false,
    });
  });

  it("rejects non-object params without scheduling a restart", async () => {
    const respond = await invokeRestartRequest("operator");

    expect(scheduleSafeGatewayRestart).not.toHaveBeenCalled();
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

    expect(scheduleSafeGatewayRestart).not.toHaveBeenCalled();
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
