import { describe, expect, it } from "vitest";
import {
  validateApprovalAllowDecision,
  validateApprovalGetParams,
  validateApprovalGetResult,
  validateApprovalHistoryParams,
  validateApprovalHistoryResult,
  validateApprovalDecision,
  validateApprovalKind,
  validateApprovalPresentation,
  validateApprovalResolveParams,
  validateApprovalResolveResult,
  validateApprovalSnapshot,
  validateApprovalTerminalReason,
  validateExecApprovalPresentation,
  validatePluginApprovalPresentation,
  validatePluginApprovalSeverity,
  validateTerminalApprovalSnapshot,
} from "./index.js";

const execPresentation = {
  kind: "exec",
  commandText: "git status --short",
  commandPreview: "git status",
  warningText: null,
  host: "gateway",
  nodeId: null,
  agentId: "main",
  allowedDecisions: ["allow-once", "allow-always", "deny"],
} as const;

const pluginPresentation = {
  kind: "plugin",
  title: "Publish release",
  description: "Publish version 1.2.3 to the package registry.",
  severity: "critical",
  pluginId: "publisher",
  toolName: "publish",
  agentId: "release",
  allowedDecisions: ["allow-once", "deny"],
} as const;

const systemAgentPresentation = {
  kind: "system-agent",
  title: "OpenClaw change",
  description: "Set gateway.port to 19001",
  proposalHash: "a".repeat(64),
  agentId: "main",
  allowedDecisions: ["allow-once", "deny"],
} as const;

const execRecord = {
  id: "approval:01JZ4K6M2X8YQW9N7R3T5V1C0B",
  urlPath: "/approve/approval%3A01JZ4K6M2X8YQW9N7R3T5V1C0B",
  presentation: execPresentation,
  createdAtMs: 1_780_000_000_000,
  expiresAtMs: 1_780_001_800_000,
} as const;

const pluginRecord = {
  id: "plugin:01JZ4K6M2X8YQW9N7R3T5V1C0B",
  urlPath: "/approve/plugin%3A01JZ4K6M2X8YQW9N7R3T5V1C0B",
  presentation: pluginPresentation,
  createdAtMs: 1_780_000_000_000,
  expiresAtMs: 1_780_000_120_000,
} as const;

describe("unified approval protocol validators", () => {
  it("keeps approval kinds and decisions closed", () => {
    expect(validateApprovalKind("exec")).toBe(true);
    expect(validateApprovalKind("plugin")).toBe(true);
    expect(validateApprovalKind("system-agent")).toBe(true);
    expect(validateApprovalKind("tool")).toBe(false);
    expect(validateApprovalDecision("deny")).toBe(true);
    expect(validateApprovalDecision("accept")).toBe(false);
    expect(validateApprovalAllowDecision("allow-once")).toBe(true);
    expect(validateApprovalAllowDecision("deny")).toBe(false);
    for (const reason of [
      "user",
      "timeout",
      "malformed-verdict",
      "no-route",
      "run-aborted",
      "gateway-restart",
      "storage-corrupt",
    ] as const) {
      expect(validateApprovalTerminalReason(reason)).toBe(true);
    }
    expect(validateApprovalTerminalReason("reviewer-decision")).toBe(false);
    expect(validatePluginApprovalSeverity("critical")).toBe(true);
    expect(validatePluginApprovalSeverity("blocker")).toBe(false);
  });

  it("accepts only reviewer-safe approval presentations", () => {
    expect(validateExecApprovalPresentation(execPresentation)).toBe(true);
    expect(validatePluginApprovalPresentation(pluginPresentation)).toBe(true);
    expect(validateApprovalPresentation(execPresentation)).toBe(true);
    expect(validateApprovalPresentation(pluginPresentation)).toBe(true);
    expect(validateApprovalPresentation(systemAgentPresentation)).toBe(true);

    for (const forbiddenField of ["cwd", "env", "systemRunBinding", "systemRunPlan"] as const) {
      expect(
        validateExecApprovalPresentation({
          ...execPresentation,
          [forbiddenField]: forbiddenField === "env" ? { TOKEN: "secret" } : "private",
        }),
      ).toBe(false);
    }
  });

  it("keeps deny available on every presentation and resolve request", () => {
    expect(
      validateExecApprovalPresentation({
        ...execPresentation,
        allowedDecisions: ["allow-once"],
      }),
    ).toBe(false);
    expect(
      validatePluginApprovalPresentation({
        ...pluginPresentation,
        allowedDecisions: ["allow-always"],
      }),
    ).toBe(false);
    expect(
      validateApprovalResolveParams({ id: execRecord.id, kind: "exec", decision: "deny" }),
    ).toBe(true);
    expect(validateApprovalResolveParams({ id: execRecord.id, decision: "deny" })).toBe(false);
    expect(
      validateApprovalResolveParams({ id: execRecord.id, kind: "exec", decision: "accept" }),
    ).toBe(false);
  });

  it("validates pending and every fail-closed terminal state", () => {
    const pending = { ...execRecord, status: "pending" } as const;
    const allowed = {
      ...execRecord,
      status: "allowed",
      decision: "allow-once",
      resolvedAtMs: execRecord.createdAtMs + 1_000,
      reason: "user",
    } as const;
    const denied = {
      ...pluginRecord,
      status: "denied",
      decision: "deny",
      resolvedAtMs: pluginRecord.createdAtMs + 1_000,
      reason: "user",
    } as const;
    const expired = {
      ...execRecord,
      status: "expired",
      resolvedAtMs: execRecord.expiresAtMs,
      reason: "timeout",
    } as const;
    const cancelled = {
      ...pluginRecord,
      status: "cancelled",
      resolvedAtMs: pluginRecord.createdAtMs + 500,
      reason: "run-aborted",
    } as const;

    for (const snapshot of [pending, allowed, denied, expired, cancelled]) {
      expect(validateApprovalSnapshot(snapshot)).toBe(true);
      expect(validateApprovalGetResult({ approval: snapshot })).toBe(true);
    }

    expect(validateApprovalSnapshot({ ...allowed, decision: "deny" })).toBe(false);
    expect(validateApprovalSnapshot({ ...allowed, resolvedBy: "device:phone" })).toBe(false);
    expect(validateApprovalSnapshot({ ...denied, reason: "" })).toBe(false);
    expect(validateApprovalSnapshot({ ...expired, decision: "deny" })).toBe(false);
    expect(
      validateApprovalSnapshot({
        ...execRecord,
        presentation: { ...execPresentation, kind: "plugin" },
        status: "pending",
      }),
    ).toBe(false);
  });

  it("uses one full-id field and rejects internal routing state", () => {
    expect(validateApprovalGetParams({ id: pluginRecord.id })).toBe(true);
    expect(validateApprovalGetParams({ id: "" })).toBe(false);
    expect(validateApprovalGetParams({ id: pluginRecord.id, kind: "plugin" })).toBe(false);
    expect(
      validateApprovalResolveParams({
        id: "plugin",
        kind: "plugin",
        decision: "deny",
        prefix: true,
      }),
    ).toBe(false);
    expect(
      validateApprovalResolveParams({
        id: "plugin",
        kind: "plugin",
        decision: "deny",
        resolvedBy: "public-actor",
      }),
    ).toBe(false);
    for (const id of ["\ud800", "\udc00", ".", ".."]) {
      expect(validateApprovalGetParams({ id })).toBe(false);
      expect(validateApprovalResolveParams({ id, kind: "exec", decision: "deny" })).toBe(false);
    }
    expect(validateApprovalGetParams({ id: "approval:🦞/percent%" })).toBe(true);

    expect(
      validateApprovalSnapshot({
        ...execRecord,
        status: "pending",
        sourceSessionKey: "agent:worker:subagent:123",
      }),
    ).toBe(false);
    expect(
      validateApprovalSnapshot({
        ...execRecord,
        status: "pending",
        audienceSessionKeys: ["agent:worker:subagent:123", "agent:main"],
      }),
    ).toBe(false);
  });

  it("validates terminal history pages and optional attribution", () => {
    const terminal = {
      ...pluginRecord,
      status: "denied",
      decision: "deny",
      resolvedAtMs: pluginRecord.createdAtMs + 1_000,
      reason: "user",
      source: { agentId: "release", sessionKey: "agent:release:main" },
      resolver: { kind: "device", id: "reviewer-device" },
    } as const;

    expect(validateApprovalHistoryParams({})).toBe(true);
    expect(validateApprovalHistoryParams({ cursor: "cursor", limit: 50, kind: "plugin" })).toBe(
      true,
    );
    expect(validateApprovalHistoryParams({ limit: 0 })).toBe(false);
    expect(validateApprovalHistoryParams({ limit: 101 })).toBe(false);
    expect(validateApprovalHistoryParams({ kind: "tool" })).toBe(false);

    expect(validateApprovalHistoryResult({ items: [terminal], nextCursor: "next" })).toBe(true);
    expect(validateApprovalHistoryResult({ items: [{ ...execRecord, status: "pending" }] })).toBe(
      false,
    );
    expect(validateApprovalHistoryResult({ items: [terminal], extra: true })).toBe(false);
  });

  it("returns the canonical recorded snapshot to losing resolvers", () => {
    const recorded = {
      ...execRecord,
      status: "allowed",
      decision: "allow-always",
      resolvedAtMs: execRecord.createdAtMs + 1_000,
      reason: "user",
    } as const;

    expect(validateApprovalResolveResult({ applied: true, approval: recorded })).toBe(true);
    expect(validateApprovalResolveResult({ applied: false, approval: recorded })).toBe(true);
    expect(validateTerminalApprovalSnapshot(recorded)).toBe(true);
    expect(
      validateApprovalResolveResult({
        applied: false,
        approval: { ...execRecord, status: "pending" },
      }),
    ).toBe(false);
    expect(validateApprovalResolveResult({ applied: false })).toBe(false);
  });
});
