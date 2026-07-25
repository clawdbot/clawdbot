import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  SessionApprovalEventSchema,
  SessionApprovalReplaySchema,
  validateSessionsMessagesSubscribeParams,
} from "./index.js";

const approval = {
  id: "approval:01JZ4K6M2X8YQW9N7R3T5V1C0B",
  urlPath: "/approve/approval%3A01JZ4K6M2X8YQW9N7R3T5V1C0B",
  presentation: {
    kind: "exec",
    commandText: "git status --short",
    commandPreview: "git status",
    warningText: null,
    host: "gateway",
    nodeId: null,
    agentId: "main",
    allowedDecisions: ["allow-once", "allow-always", "deny"],
  },
  createdAtMs: 1_780_000_000_000,
  expiresAtMs: 1_780_001_800_000,
} as const;

const pending = { ...approval, status: "pending" } as const;
const terminal = {
  ...approval,
  status: "denied",
  decision: "deny",
  resolvedAtMs: approval.createdAtMs + 1_000,
  reason: "user",
} as const;

describe("session approval protocol validators", () => {
  it("keeps approval subscription opt-in additive and literal", () => {
    expect(validateSessionsMessagesSubscribeParams({ key: "agent:main:main" })).toBe(true);
    expect(
      validateSessionsMessagesSubscribeParams({
        key: "agent:main:main",
        includeApprovals: true,
      }),
    ).toBe(true);
    expect(
      validateSessionsMessagesSubscribeParams({
        key: "agent:main:main",
        includeApprovals: false,
      }),
    ).toBe(false);
  });

  it("requires event phase to match the approval snapshot state", () => {
    const common = {
      sessionKey: "agent:main:main",
      sourceSessionKey: "agent:worker:subagent:child",
      updatedAtMs: terminal.resolvedAtMs,
    } as const;

    expect(
      Value.Check(SessionApprovalEventSchema, {
        ...common,
        phase: "pending",
        approval: pending,
      }),
    ).toBe(true);
    expect(
      Value.Check(SessionApprovalEventSchema, {
        ...common,
        phase: "terminal",
        approval: terminal,
      }),
    ).toBe(true);
    expect(
      Value.Check(SessionApprovalEventSchema, {
        ...common,
        phase: "pending",
        approval: terminal,
      }),
    ).toBe(false);
    expect(
      Value.Check(SessionApprovalEventSchema, {
        ...common,
        phase: "terminal",
        approval: pending,
      }),
    ).toBe(false);
  });

  it("rejects terminal reasons that contradict the terminal status", () => {
    const common = {
      sessionKey: "agent:main:main",
      phase: "terminal",
      updatedAtMs: terminal.resolvedAtMs,
    } as const;
    const terminalCommon = {
      ...approval,
      resolvedAtMs: terminal.resolvedAtMs,
    } as const;

    expect(
      Value.Check(SessionApprovalEventSchema, {
        ...common,
        approval: { ...terminal, reason: "timeout" },
      }),
    ).toBe(false);
    expect(
      Value.Check(SessionApprovalEventSchema, {
        ...common,
        approval: {
          ...terminalCommon,
          status: "allowed",
          decision: "allow-once",
          reason: "timeout",
        },
      }),
    ).toBe(false);
    expect(
      Value.Check(SessionApprovalEventSchema, {
        ...common,
        approval: { ...terminalCommon, status: "expired", reason: "user" },
      }),
    ).toBe(false);
    expect(
      Value.Check(SessionApprovalEventSchema, {
        ...common,
        approval: { ...terminalCommon, status: "cancelled", reason: "timeout" },
      }),
    ).toBe(false);
  });

  it("replays only authoritative pending approval snapshots", () => {
    const replay = {
      sessionKey: "agent:main:main",
      updatedAtMs: approval.createdAtMs,
      approvals: [pending],
      truncated: false,
    } as const;

    expect(Value.Check(SessionApprovalReplaySchema, replay)).toBe(true);
    expect(
      Value.Check(SessionApprovalReplaySchema, {
        ...replay,
        approvals: [terminal],
      }),
    ).toBe(false);
  });
});
