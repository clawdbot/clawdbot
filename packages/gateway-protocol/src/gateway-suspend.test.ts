import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  GatewaySuspendBlockerSchema,
  GatewaySuspendPrepareResultSchema,
  GatewaySuspendStatusResultSchema,
  validateGatewaySuspendPrepareParams,
  validateGatewaySuspendHandoffParams,
} from "./index.js";

describe("gateway suspension protocol", () => {
  it("requires an exact handoff target and rejects unrelated interruption policy", () => {
    const target = { pid: 1, processInstanceId: "gateway-process" };
    const params = { suspensionId: "held-lease", target };
    expect(validateGatewaySuspendHandoffParams(params)).toBe(true);
    for (const rejected of [
      { ...params, target: undefined },
      { ...params, force: true },
      { ...params, waitMs: 0 },
      { ...params, target: { ...target, processInstanceId: " " } },
      { ...params, target: { ...target, pid: 0 } },
      { ...params, target: { ...target, port: 18789 } },
      { ...params, target: { ...target, successor: "other" } },
    ]) {
      expect(validateGatewaySuspendHandoffParams(rejected)).toBe(false);
    }
  });
  it("keeps prepare params closed and bounded", () => {
    expect(validateGatewaySuspendPrepareParams({ requestId: "host-request" })).toBe(true);
    expect(
      validateGatewaySuspendPrepareParams({
        requestId: "host-request",
        terminalPolicy: "preserve",
      }),
    ).toBe(true);
    expect(
      validateGatewaySuspendPrepareParams({
        requestId: "host-request",
        terminalPolicy: "terminate",
      }),
    ).toBe(true);
    expect(
      validateGatewaySuspendPrepareParams({
        requestId: "host-request",
        terminalPolicy: "preserve",
        drain: true,
      }),
    ).toBe(true);
    expect(validateGatewaySuspendPrepareParams({ requestId: "host-request", drain: false })).toBe(
      true,
    );
    expect(validateGatewaySuspendPrepareParams({ requestId: "host-request", drain: "true" })).toBe(
      false,
    );
    expect(validateGatewaySuspendPrepareParams({ requestId: "   " })).toBe(false);
    expect(
      validateGatewaySuspendPrepareParams({ requestId: "host-request", terminalPolicy: "close" }),
    ).toBe(false);
    expect(validateGatewaySuspendPrepareParams({ requestId: "host-request", extra: true })).toBe(
      false,
    );
  });

  it("keeps the historical terminal-session blocker wire-compatible", () => {
    expect(
      Value.Check(GatewaySuspendBlockerSchema, {
        kind: "terminal-session",
        count: 1,
        message: "1 open terminal session(s)",
      }),
    ).toBe(true);
  });

  it("accepts closed draining prepare results without changing existing result variants", () => {
    const draining = {
      status: "draining",
      suspensionId: "suspension-1",
      expiresAtMs: 2_000,
      retryAfterMs: 250,
      activeCount: 1,
      blockers: [{ kind: "terminal-session", count: 1, message: "1 open terminal session" }],
    };

    expect(Value.Check(GatewaySuspendPrepareResultSchema, draining)).toBe(true);
    expect(Value.Check(GatewaySuspendPrepareResultSchema, { ...draining, unexpected: true })).toBe(
      false,
    );
    expect(
      Value.Check(GatewaySuspendPrepareResultSchema, {
        status: "busy",
        reason: "active-work",
        retryAfterMs: 250,
        activeCount: 1,
        blockers: draining.blockers,
      }),
    ).toBe(true);
    expect(
      Value.Check(GatewaySuspendPrepareResultSchema, {
        status: "ready",
        suspensionId: "suspension-1",
        expiresAtMs: 2_000,
        activeCount: 0,
        blockers: [],
      }),
    ).toBe(true);
  });

  it("accepts closed draining status results without changing existing status variants", () => {
    const draining = {
      status: "draining",
      expiresAtMs: 2_000,
      retryAfterMs: 250,
      activeCount: 1,
      blockers: [{ kind: "terminal-persistence", count: 1, message: "1 pending terminal write" }],
    };

    expect(Value.Check(GatewaySuspendStatusResultSchema, draining)).toBe(true);
    expect(Value.Check(GatewaySuspendStatusResultSchema, { ...draining, suspensionId: "id" })).toBe(
      false,
    );
    expect(Value.Check(GatewaySuspendStatusResultSchema, { status: "running" })).toBe(true);
    expect(
      Value.Check(GatewaySuspendStatusResultSchema, { status: "ready", expiresAtMs: 2_000 }),
    ).toBe(true);
  });
});
