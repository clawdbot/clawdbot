// Covers suspension RPC validation and coordinator response mapping.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { suspendHandlers } from "./suspend.js";

const coordinator = vi.hoisted(() => ({
  prepare: vi.fn(),
  status: vi.fn(),
  resume: vi.fn(),
}));

vi.mock("../../infra/gateway-suspend-coordinator.js", () => ({
  prepareGatewaySuspend: coordinator.prepare,
  getGatewaySuspendStatus: coordinator.status,
  resumeGatewaySuspend: coordinator.resume,
}));

vi.mock("../server-active-work.js", () => ({
  createGatewayServerActiveWorkInspectors: vi.fn(() => ({ getChatRuns: vi.fn(() => 0) })),
}));

function invoke(method: keyof typeof suspendHandlers, params: unknown) {
  const respond = vi.fn();
  const pauseScheduling = vi.fn();
  const resumeScheduling = vi.fn();
  const warn = vi.fn();
  const handler = suspendHandlers[method];
  return Promise.resolve(
    handler({
      params,
      respond,
      context: {
        cron: { pauseScheduling, resumeScheduling },
        logGateway: { warn },
        chatAbortControllers: new Map(),
        chatQueuedTurns: new Map(),
      },
    } as unknown as Parameters<typeof handler>[0]),
  ).then(() => ({ respond, pauseScheduling, resumeScheduling }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("gateway suspend handlers", () => {
  it("validates the closed prepare params shape", async () => {
    const { respond } = await invoke("gateway.suspend.prepare", {
      requestId: "request-1",
      extra: true,
    });

    expect(coordinator.prepare).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "INVALID_REQUEST",
      message: "invalid gateway.suspend.prepare params",
    });
  });

  it("wires prepare to scheduler pause/resume and returns busy or ready", async () => {
    coordinator.prepare.mockReturnValueOnce({
      status: "busy",
      reason: "active-work",
      activeCount: 1,
      blockers: [{ kind: "queue", count: 1, message: "busy" }],
    });
    const { respond, pauseScheduling, resumeScheduling } = await invoke("gateway.suspend.prepare", {
      requestId: "request-1",
    });

    expect(coordinator.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "request-1",
        pauseScheduling: expect.any(Function),
        resumeScheduling: expect.any(Function),
      }),
    );
    const options = coordinator.prepare.mock.calls[0]?.[0];
    options.pauseScheduling();
    options.resumeScheduling();
    expect(pauseScheduling).toHaveBeenCalledOnce();
    expect(resumeScheduling).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "busy", reason: "active-work" }),
    );
  });

  it("maps a competing prepared lease to retryable unavailable", async () => {
    coordinator.prepare.mockReturnValueOnce({ status: "conflict", expiresAtMs: Date.now() + 5000 });
    const { respond } = await invoke("gateway.suspend.prepare", { requestId: "request-2" });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        details: expect.objectContaining({ reason: "gateway-suspension-conflict" }),
        retryable: true,
      }),
    );
  });

  it("maps prepare and status recovery to the same retryable unavailable error", async () => {
    const recovering = {
      status: "recovering",
      reason: "scheduler-resume-failed",
      retryAfterMs: 1_000,
    };
    coordinator.prepare.mockReturnValueOnce(recovering);
    coordinator.status.mockReturnValueOnce(recovering);

    const prepared = await invoke("gateway.suspend.prepare", { requestId: "request-recovery" });
    const status = await invoke("gateway.suspend.status", { suspensionId: "stale-id" });

    for (const respond of [prepared.respond, status.respond]) {
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "UNAVAILABLE",
          message: "gateway scheduler recovery is pending",
          retryable: true,
          retryAfterMs: 1_000,
          details: { reason: "scheduler-resume-failed" },
        }),
      );
    }
  });

  it("keeps resume idempotent and rejects a mismatched active lease", async () => {
    coordinator.resume.mockReturnValueOnce({ ok: false, reason: "suspension-mismatch" });
    const mismatch = await invoke("gateway.suspend.resume", {
      suspensionId: "suspension-wrong",
    });
    expect(mismatch.respond).toHaveBeenCalledWith(false, undefined, {
      code: "INVALID_REQUEST",
      message: "gateway suspension id does not match",
    });

    coordinator.resume.mockReturnValueOnce({
      ok: true,
      status: "running",
      resumed: false,
    });
    const resumed = await invoke("gateway.suspend.resume", { suspensionId: "suspension-1" });
    expect(resumed.respond).toHaveBeenCalledWith(true, {
      ok: true,
      status: "running",
      resumed: false,
    });
  });

  it("returns retryable unavailable when scheduler resume needs retry", async () => {
    coordinator.resume.mockReturnValueOnce({
      ok: false,
      reason: "scheduler-resume-failed",
      retryAfterMs: 1_000,
    });

    const { respond } = await invoke("gateway.suspend.resume", {
      suspensionId: "suspension-1",
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: "gateway scheduler recovery is pending",
        retryable: true,
        retryAfterMs: 1_000,
        details: { reason: "scheduler-resume-failed" },
      }),
    );
  });
});
