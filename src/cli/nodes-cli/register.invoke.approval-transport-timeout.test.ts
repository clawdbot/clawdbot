import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_EXEC_APPROVAL_TIMEOUT_MS } from "../../infra/exec-approvals.js";
import { parseTimeoutMs } from "../parse-timeout.js";
import { callGatewayCli } from "./rpc.js";

/**
 * Regression test for #12098:
 * `exec.approval.request` times out after 35s when the CLI transport timeout
 * is shorter than the exec approval timeout (120s). The transport timeout
 * must be at least as long as the approval timeout so the gateway has enough
 * time to collect the user's decision.
 *
 * The root cause: callGatewayCli reads opts.timeout for the transport timeout.
 * Before the fix, node exec flows called callGatewayCli("exec.approval.request",
 * opts, ...) without overriding opts.timeout, so the 35s CLI default raced
 * against the 120s approval wait on the gateway side. The CLI always lost.
 *
 * The fix: override the transport timeout for exec.approval.request to be at
 * least approvalTimeoutMs + 10_000.
 */

const { callGatewaySpy } = vi.hoisted(() => ({
  callGatewaySpy: vi.fn<(opts: Record<string, unknown>) => Promise<{ decision: "allow-once" }>>(
    async () => ({ decision: "allow-once" }),
  ),
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: callGatewaySpy,
  randomIdempotencyKey: () => "mock-key",
}));

vi.mock("../progress.js", () => ({
  withProgress: (_opts: unknown, fn: () => unknown) => fn(),
}));

describe("exec approval transport timeout (#12098)", () => {
  const approvalTransportFloorMs = DEFAULT_EXEC_APPROVAL_TIMEOUT_MS + 10_000;

  beforeEach(() => {
    callGatewaySpy.mockClear();
    callGatewaySpy.mockResolvedValue({ decision: "allow-once" });
  });

  it("callGatewayCli forwards opts.timeout as the transport timeoutMs", async () => {
    await callGatewayCli("exec.approval.request", { timeout: "35000" } as never, {
      timeoutMs: 120_000,
    });

    expect(callGatewaySpy).toHaveBeenCalledTimes(1);
    const callOpts = callGatewaySpy.mock.calls.at(0)![0];
    expect(callOpts.method).toBe("exec.approval.request");
    expect(callOpts.timeoutMs).toBe(35_000);
  });

  it("fix: overriding transportTimeoutMs gives the approval enough transport time", async () => {
    const approvalTimeoutMs = DEFAULT_EXEC_APPROVAL_TIMEOUT_MS;
    // Mirror the production code: parseTimeoutMs(opts.timeout) ?? 0
    const transportTimeoutMs = Math.max(parseTimeoutMs("35000") ?? 0, approvalTransportFloorMs);
    expect(transportTimeoutMs).toBe(approvalTransportFloorMs);

    await callGatewayCli(
      "exec.approval.request",
      { timeout: "35000" } as never,
      { timeoutMs: approvalTimeoutMs },
      { transportTimeoutMs },
    );

    expect(callGatewaySpy).toHaveBeenCalledTimes(1);
    const callOpts = callGatewaySpy.mock.calls.at(0)![0];
    expect(callOpts.timeoutMs).toBeGreaterThanOrEqual(approvalTimeoutMs);
    expect(callOpts.timeoutMs).toBe(approvalTransportFloorMs);
  });

  it("fix: user-specified timeout larger than approval is preserved", async () => {
    const approvalTimeoutMs = DEFAULT_EXEC_APPROVAL_TIMEOUT_MS;
    const userTimeout = 200_000;
    // Mirror the production code: parseTimeoutMs preserves valid large values
    const transportTimeoutMs = Math.max(
      parseTimeoutMs(String(userTimeout)) ?? 0,
      approvalTransportFloorMs,
    );
    expect(transportTimeoutMs).toBe(approvalTransportFloorMs);

    await callGatewayCli(
      "exec.approval.request",
      { timeout: String(userTimeout) } as never,
      { timeoutMs: approvalTimeoutMs },
      { transportTimeoutMs },
    );

    const callOpts = callGatewaySpy.mock.calls.at(0)![0];
    expect(callOpts.timeoutMs).toBe(approvalTransportFloorMs);
  });

  it("fix: non-numeric timeout falls back to approval floor", async () => {
    const approvalTimeoutMs = DEFAULT_EXEC_APPROVAL_TIMEOUT_MS;
    // parseTimeoutMs returns undefined for garbage input, ?? 0 ensures
    // Math.max picks the approval floor instead of producing NaN
    const transportTimeoutMs = Math.max(parseTimeoutMs("foo") ?? 0, approvalTransportFloorMs);
    expect(transportTimeoutMs).toBe(approvalTransportFloorMs);

    await callGatewayCli(
      "exec.approval.request",
      { timeout: "foo" } as never,
      { timeoutMs: approvalTimeoutMs },
      { transportTimeoutMs },
    );

    const callOpts = callGatewaySpy.mock.calls.at(0)![0];
    expect(callOpts.timeoutMs).toBe(approvalTransportFloorMs);
  });
});
