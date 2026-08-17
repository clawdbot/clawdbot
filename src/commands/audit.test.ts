import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUDIT_ACTIVITY_DIRECTIONS,
  AUDIT_ACTIVITY_KINDS,
  AUDIT_ACTIVITY_STATUSES,
} from "../../packages/gateway-protocol/src/schema/audit-activity.js";
import { runCommandWithRuntime } from "../cli/cli-utils.js";
import type { RuntimeEnv } from "../runtime.js";
import { auditListCommand } from "./audit.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

const callGateway = mocks.callGateway;

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

function unknownActivityMethodError() {
  return Object.assign(new Error("unknown method: audit.activity.list"), {
    name: "GatewayClientRequestError",
    gatewayCode: "INVALID_REQUEST",
  });
}

function unknownRunInspectMethodError() {
  return Object.assign(new Error("unknown method: audit.run.inspect"), {
    name: "GatewayClientRequestError",
    gatewayCode: "INVALID_REQUEST",
  });
}

function oldGatewayUnknownMethodScopeError() {
  return Object.assign(new Error("missing scope: operator.admin"), {
    name: "GatewayClientRequestError",
    gatewayCode: "INVALID_REQUEST",
  });
}

describe("audit command parsing", () => {
  beforeEach(() => {
    callGateway.mockReset();
    callGateway.mockResolvedValue({ events: [] });
    vi.mocked(runtime.log).mockClear();
    vi.mocked(runtime.error).mockClear();
    vi.mocked(runtime.exit).mockClear();
  });

  it("converts ISO and millisecond timestamps before querying the Gateway", async () => {
    await auditListCommand({ after: "1234", before: "2024-02-29T00:00:00Z" }, runtime);

    expect(callGateway).toHaveBeenCalledWith({
      method: "audit.activity.list",
      params: {
        limit: 100,
        after: 1234,
        before: Date.parse("2024-02-29T00:00:00Z"),
      },
    });
  });

  it.each([
    { flag: "--after", options: { after: "2026-02-30T00:00:00Z" } },
    { flag: "--before", options: { before: "2026-02-30T00:00:00Z" } },
    { flag: "--after", options: { after: "-1" } },
    { flag: "--before", options: { before: "July 1, 2026" } },
    { flag: "--after", options: { after: "not-a-date" } },
  ])("rejects invalid $flag before calling the Gateway", async ({ flag, options }) => {
    await expect(auditListCommand(options, runtime)).rejects.toThrow(flag);
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("preserves the local-time result for timezone-less timestamps", async () => {
    const input = "2026-07-01T00:00:00";
    const localMs = 1_782_878_400_000;
    const utcMs = 1_782_864_000_000;
    const parse = vi.spyOn(Date, "parse").mockImplementation((value) => {
      if (value === input) {
        return localMs;
      }
      if (value === `${input}Z`) {
        return utcMs;
      }
      return Number.NaN;
    });

    try {
      await auditListCommand({ after: input }, runtime);
      expect(callGateway).toHaveBeenCalledWith({
        method: "audit.activity.list",
        params: { limit: 100, after: localMs },
      });
    } finally {
      parse.mockRestore();
    }
  });

  it("enforces the list export bound before querying the Gateway", async () => {
    await auditListCommand({ limit: "500" }, runtime);
    expect(callGateway).toHaveBeenCalledWith({
      method: "audit.activity.list",
      params: { limit: 500 },
    });

    callGateway.mockClear();
    await expect(auditListCommand({ limit: "501" }, runtime)).rejects.toThrow("1 and 500");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it.each([
    {
      options: { kind: "bogus" as never },
      message: "--kind must be agent_run, tool_action, or message.",
    },
    {
      options: { status: "bogus" as never },
      message:
        "--status must be started, succeeded, failed, cancelled, timed_out, blocked, or unknown.",
    },
    {
      options: { direction: "sideways" as never },
      message: "--direction must be inbound or outbound.",
    },
    {
      options: { kind: "agent_run" as const, direction: "inbound" as const },
      message: "--direction only applies to --kind message.",
    },
    {
      options: { kind: "agent_run" as const, channel: "telegram" },
      message: "--channel only applies to --kind message.",
    },
    {
      options: { kind: "message" as const, sessionKey: "agent:main:main" },
      message: "--session only applies to --kind agent_run or tool_action.",
    },
    {
      options: { sessionKey: "agent:main:main", direction: "inbound" as const },
      message: "--direction cannot be combined with --session.",
    },
    {
      options: { sessionKey: "agent:main:main", channel: "telegram" },
      message: "--channel cannot be combined with --session.",
    },
  ])("rejects invalid audit filters before querying the Gateway", async ({ options, message }) => {
    await runCommandWithRuntime(runtime, () =>
      auditListCommand({ ...options, limit: "10" }, runtime),
    );
    expect(runtime.error).toHaveBeenCalledWith(message);
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(callGateway).not.toHaveBeenCalled();
  });

  it.each([
    ["kind", AUDIT_ACTIVITY_KINDS],
    ["status", AUDIT_ACTIVITY_STATUSES],
    ["direction", AUDIT_ACTIVITY_DIRECTIONS],
  ] as const)("forwards every canonical %s value unchanged", async (filter, values) => {
    for (const value of values) {
      await auditListCommand({ [filter]: value }, runtime);
      expect(callGateway).toHaveBeenLastCalledWith({
        method: "audit.activity.list",
        params: { limit: 100, [filter]: value },
      });
    }
  });

  it("renders activity safely without inventing message provenance", async () => {
    callGateway.mockResolvedValue({
      events: [
        {
          occurredAt: 0,
          kind: "tool_action",
          action: "tool.action.finished",
          status: "failed",
          agentId: "main\nforged",
          runId: "run\tcolumn",
          toolName: "\u001b]8;;https://example.invalid\u0007unsafe",
        },
        {
          occurredAt: 0,
          kind: "message",
          action: "message.inbound.processed",
          status: "succeeded",
          direction: "inbound",
          channel: "telegram",
        },
        {
          occurredAt: 0,
          kind: "tool_action",
          action: "tool.action.finished",
          status: "failed",
          agentId: `${"x".repeat(16)}🚀tail`,
        },
      ],
    });

    await auditListCommand({}, runtime);
    const [header, unsafeRow, messageRow, truncatedRow] = vi
      .mocked(runtime.log)
      .mock.calls.map(([line]) => line);

    expect(header).toContain("DIRECTION\tCHANNEL");
    expect(unsafeRow).not.toContain("\n");
    expect(unsafeRow).not.toContain("\u001b");
    expect(unsafeRow).toContain("main\\nforged");
    expect(unsafeRow).toContain("run\\tcolumn");
    expect(messageRow).toContain("message\tinbound\ttelegram\tsucceeded\t-\t-");
    expect(truncatedRow).toContain(`${"x".repeat(16)}…`);
    expect(truncatedRow).not.toContain("\uD83D");
  });
});

describe("audit command gateway compatibility", () => {
  beforeEach(() => {
    callGateway.mockReset();
    callGateway.mockResolvedValue({ events: [] });
    vi.mocked(runtime.error).mockClear();
    vi.mocked(runtime.exit).mockClear();
  });

  it("forwards valid filters unchanged and keeps an empty page successful", async () => {
    await runCommandWithRuntime(runtime, () =>
      auditListCommand(
        {
          agentId: "main",
          kind: "message",
          status: "failed",
          direction: "inbound",
          channel: "telegram",
          after: "100",
          before: "200",
          cursor: "42",
          limit: "25",
        },
        runtime,
      ),
    );

    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(callGateway).toHaveBeenCalledWith({
      method: "audit.activity.list",
      params: {
        limit: 25,
        agentId: "main",
        kind: "message",
        status: "failed",
        direction: "inbound",
        channel: "telegram",
        after: 100,
        before: 200,
        cursor: "42",
      },
    });
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("falls back to audit.list only with legacy-compatible filters", async () => {
    callGateway.mockRejectedValueOnce(unknownActivityMethodError()).mockResolvedValueOnce({
      events: [],
      nextCursor: "8",
    });

    await auditListCommand(
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        runId: "run-1",
        kind: "tool_action",
        status: "failed",
        after: "100",
        before: "200",
        cursor: "9",
        limit: "25",
      },
      runtime,
    );

    expect(callGateway.mock.calls).toEqual([
      [
        {
          method: "audit.activity.list",
          params: {
            limit: 25,
            agentId: "main",
            sessionKey: "agent:main:main",
            runId: "run-1",
            kind: "tool_action",
            status: "failed",
            after: 100,
            before: 200,
            cursor: "9",
          },
        },
      ],
      [
        {
          method: "audit.list",
          params: {
            agentId: "main",
            sessionKey: "agent:main:main",
            runId: "run-1",
            kind: "tool_action",
            status: "failed",
            after: 100,
            before: 200,
            limit: 25,
            cursor: "9",
          },
        },
      ],
    ]);
  });

  it("falls back when an old gateway authorizes an unknown method as admin", async () => {
    callGateway.mockRejectedValueOnce(oldGatewayUnknownMethodScopeError()).mockResolvedValueOnce({
      events: [],
    });

    await auditListCommand({ limit: "10" }, runtime);

    expect(callGateway).toHaveBeenNthCalledWith(2, {
      method: "audit.list",
      params: { limit: 10 },
    });
  });

  it("fails clearly instead of dropping message-specific filters on old gateways", async () => {
    callGateway.mockRejectedValueOnce(unknownActivityMethodError());

    await expect(auditListCommand({ direction: "inbound", limit: "10" }, runtime)).rejects.toThrow(
      "does not support message audit filters",
    );
    expect(callGateway).toHaveBeenCalledTimes(1);
  });

  it("renders other request errors without the Gateway error class name", async () => {
    const error = Object.assign(new Error("invalid audit activity params"), {
      name: "GatewayClientRequestError",
      gatewayCode: "INVALID_REQUEST",
    });
    callGateway.mockRejectedValueOnce(error);

    await runCommandWithRuntime(runtime, () => auditListCommand({ limit: "10" }, runtime));

    expect(runtime.error).toHaveBeenCalledWith("invalid audit activity params");
    expect(String(vi.mocked(runtime.error).mock.calls[0]?.[0])).not.toContain(
      "GatewayClientRequestError",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(callGateway).toHaveBeenCalledTimes(1);
  });

  it("turns an opaque cursor rejection into an operator recovery step", async () => {
    callGateway.mockRejectedValueOnce(
      Object.assign(new Error("invalid audit.activity.list range or cursor"), {
        name: "GatewayClientRequestError",
        gatewayCode: "INVALID_REQUEST",
      }),
    );

    await runCommandWithRuntime(runtime, () => auditListCommand({ cursor: "abc" }, runtime));

    expect(runtime.error).toHaveBeenCalledWith(
      "--cursor must be a continuation token returned by a previous audit result.",
    );
    expect(String(vi.mocked(runtime.error).mock.calls[0]?.[0])).not.toContain(
      "audit.activity.list",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});

describe("audit run explanation", () => {
  beforeEach(() => {
    callGateway.mockReset();
    vi.mocked(runtime.log).mockClear();
  });

  it("rejects --execution without --explain before querying the Gateway", async () => {
    await expect(auditListCommand({ executionId: "execution-1" }, runtime)).rejects.toThrow(
      "--execution requires --explain",
    );
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("requires one exact run without activity-list filters", async () => {
    await expect(auditListCommand({ explain: true }, runtime)).rejects.toThrow(
      "exactly one of --run <id> or --execution <id>",
    );
    await expect(
      auditListCommand({ explain: true, runId: "run-1", executionId: "execution-1" }, runtime),
    ).rejects.toThrow("exactly one");
    await expect(
      auditListCommand({ explain: true, runId: "run-1", agentId: "main" }, runtime),
    ).rejects.toThrow("remove activity-list filters");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("keeps decision and run discovery queries bounded", async () => {
    callGateway.mockResolvedValue({
      schemaVersion: 1,
      run: { runId: "run-1", status: "unknown" },
      identity: {
        state: "unknown",
        reasonCode: "run_not_found",
        missingEvidence: ["run.record"],
        remediation: [],
      },
      decisions: [],
      coverage: { state: "unknown", missingEvidence: ["run.record"] },
    });

    await auditListCommand({ explain: true, runId: "run-1", json: true }, runtime);
    await auditListCommand(
      { explain: true, executionId: "execution-1", limit: "100", json: true },
      runtime,
    );
    await auditListCommand({ explain: true, runId: "run-1", limit: "100", json: true }, runtime);

    expect(callGateway.mock.calls).toEqual([
      [
        {
          method: "audit.run.inspect",
          params: { runId: "run-1", executionLimit: 50, decisionLimit: 50 },
        },
      ],
      [
        {
          method: "audit.run.inspect",
          params: { executionId: "execution-1", decisionLimit: 100 },
        },
      ],
      [
        {
          method: "audit.run.inspect",
          params: { runId: "run-1", executionLimit: 50, decisionLimit: 100 },
        },
      ],
    ]);

    callGateway.mockClear();
    await expect(
      auditListCommand({ explain: true, executionId: "execution-1", limit: "101" }, runtime),
    ).rejects.toThrow("with --explain");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("queries audit.run.inspect and renders all identity fields with explicit state", async () => {
    const hmacRef = `hmac-sha256:v1:${"a".repeat(32)}:${"b".repeat(64)}`;
    callGateway.mockResolvedValue({
      schemaVersion: 1,
      run: { runId: "run-1", executionId: "execution-1", status: "known" },
      identity: {
        state: "present",
        context: {
          schemaVersion: 1,
          contextId: "context-1",
          executionId: "execution-1",
          runId: "run-1",
          createdAt: 1,
          trustDomain: { kind: "gateway-cell", domainRef: hmacRef, state: "present" },
          invoker: { state: "absent" },
          ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
          agentPrincipal: { kind: "agent", domainRef: hmacRef, principalRef: "main" },
          agentDefinition: { definitionRef: "main", state: "present" },
          runtimeInstance: { runtimeRef: hmacRef, kind: "embedded", state: "present" },
          applicableGrants: [],
          assurance: [
            {
              kind: "runtime-binding",
              evidenceRef: hmacRef,
              strength: "boundary-verified",
            },
          ],
          coverageState: "unattributed",
          missingEvidence: ["invoker.principal"],
        },
      },
      decisions: [
        {
          schemaVersion: 1,
          receiptId: "context-1:admission",
          contextId: "context-1",
          executionId: "execution-1",
          runId: "run-1",
          occurredAt: 1,
          action: { family: "run", operation: "admission" },
          decision: {
            outcome: "not-applicable",
            reasonCode: "run_admission_identity_not_evaluated",
          },
          enforcement: {
            coverageState: "unattributed",
            policyRefs: [],
            grantRefs: [],
            contextFieldsUsed: [],
          },
          source: {
            owner: "agent-command",
            recordRef: "context-1",
            decisionBoundary: "agent-command.run-admission",
          },
          missingEvidence: ["invoker.principal"],
          remediation: [{ code: "no_claim", text: "Treat this receipt as attribution only." }],
        },
        {
          schemaVersion: 1,
          receiptId: "approval:receipt-1",
          contextId: "context-1",
          executionId: "execution-1",
          runId: "run-1",
          actionId: "receipt-1",
          occurredAt: 2,
          action: { family: "exec", operation: "approval" },
          decision: {
            outcome: "denied",
            reasonCode: "operator_approval_denied_by_reviewer",
          },
          enforcement: {
            coverageState: "enforced",
            evaluatorRef: "operator-approval:device",
            policyRefs: ["operator-approval:human-decision"],
            grantRefs: [],
            contextFieldsUsed: ["contextId", "executionId", "runId"],
          },
          source: {
            owner: "operator_approvals",
            recordRef: "receipt-1",
            decisionBoundary: "gateway.operator-approval.first-answer",
          },
          missingEvidence: [],
          remediation: [{ code: "review_and_request_again", text: "Review the denial and retry." }],
        },
        {
          schemaVersion: 1,
          receiptId: "fact-corrupt",
          contextId: "context-1",
          executionId: "execution-1",
          runId: "run-1",
          occurredAt: 3,
          action: { family: "tool", operation: "decision" },
          decision: { outcome: "unknown", reasonCode: "decision_fact_record_corrupt" },
          enforcement: {
            coverageState: "unknown",
            policyRefs: [],
            grantRefs: [],
            contextFieldsUsed: [],
          },
          source: {
            owner: "tool-policy",
            recordRef: "fact-corrupt",
            decisionBoundary: "execution-decision-facts",
          },
          missingEvidence: ["decision.fact.valid"],
          remediation: [{ code: "inspect_state_integrity", text: "Inspect state integrity." }],
        },
      ],
      coverage: { state: "enforced", missingEvidence: ["invoker.principal"] },
    });

    await auditListCommand({ explain: true, runId: "run-1", cursor: "1", limit: "25" }, runtime);

    expect(callGateway).toHaveBeenCalledWith({
      method: "audit.run.inspect",
      params: {
        runId: "run-1",
        executionCursor: "1",
        executionLimit: 25,
        decisionCursor: "1",
        decisionLimit: 25,
      },
    });
    const output = vi.mocked(runtime.log).mock.calls.flat().join("\n");
    for (const label of [
      "Trust domain [present]",
      "Invoker [absent]",
      "Ingress [present]",
      "Agent principal [present]",
      "Agent definition [present]",
      "Runtime instance [present]",
      "Represented subject [absent]",
      "Sponsor [absent]",
      "Applicable grants [absent]",
      "Assurance [present]",
      "Parent [absent]",
    ]) {
      expect(output).toContain(label);
    }
    expect(output).toContain("not-applicable");
    expect(output).toContain("run_admission_identity_not_evaluated");
    expect(output).toContain("operator_approval_denied_by_reviewer");
    expect(output).toContain("authoritative owner-native SQLite record; retained 30 days");
    expect(output).toContain("admission provenance only; no enforcement decision");
    expect(output).toContain("evidence unavailable or corrupt; do not infer authorization");
    expect(output).not.toContain("named authoritative decision source");
    expect(output).toContain("Policy refs: operator-approval:human-decision");
    expect(output).toContain("Context used: contextId, executionId, runId");
  });

  it("renders ambiguous run discovery and selects an exact execution", async () => {
    callGateway.mockResolvedValueOnce({
      schemaVersion: 1,
      run: { runId: "session-run", status: "known" },
      identity: {
        state: "ambiguous",
        reasonCode: "execution_selection_required",
        candidates: [
          { executionId: "execution-1", contextId: "context-1", createdAt: 1 },
          { executionId: "execution-2", contextId: "context-2", createdAt: 2 },
        ],
        missingEvidence: ["execution.selection"],
        remediation: [
          {
            code: "select_execution_id",
            text: "Select one candidate with openclaw audit --execution <id> --explain.",
          },
        ],
      },
      decisions: [],
      coverage: { state: "unknown", missingEvidence: ["execution.selection"] },
    });

    await auditListCommand({ explain: true, runId: "session-run" }, runtime);
    const output = vi.mocked(runtime.log).mock.calls.flat().join("\n");
    expect(output).toContain("Candidate: execution-1");
    expect(output).toContain("--execution <id> --explain");

    callGateway.mockReset();
    callGateway.mockResolvedValue({
      schemaVersion: 1,
      run: { runId: "session-run", executionId: "execution-2", status: "unknown" },
      identity: {
        state: "unknown",
        reasonCode: "execution_not_found",
        missingEvidence: ["identity.context"],
        remediation: [{ code: "verify_execution_id", text: "Verify the exact execution id." }],
      },
      decisions: [],
      coverage: { state: "unknown", missingEvidence: ["identity.context"] },
    });
    await auditListCommand({ explain: true, executionId: "execution-2", json: true }, runtime);
    expect(callGateway).toHaveBeenCalledWith({
      method: "audit.run.inspect",
      params: { executionId: "execution-2", decisionLimit: 50 },
    });
  });

  it("routes the shared explain cursor by selector and grammar", async () => {
    callGateway.mockResolvedValue({
      schemaVersion: 1,
      run: { runId: "run-1", executionId: "execution-1", status: "known" },
      identity: {
        state: "unknown",
        reasonCode: "execution_not_found",
        missingEvidence: ["identity.context"],
        remediation: [],
      },
      decisions: [],
      coverage: { state: "unknown", missingEvidence: ["identity.context"] },
    });

    for (const [options, params] of [
      [
        { explain: true, runId: "run-1", cursor: "a:2000:42" },
        { runId: "run-1", executionLimit: 50, decisionCursor: "a:2000:42", decisionLimit: 50 },
      ],
      [
        { explain: true, executionId: "execution-1", cursor: "1" },
        { executionId: "execution-1", decisionCursor: "1", decisionLimit: 50 },
      ],
      [
        { explain: true, runId: "run-1", cursor: "001" },
        {
          runId: "run-1",
          executionLimit: 50,
          executionCursor: "001",
          decisionCursor: "001",
          decisionLimit: 50,
        },
      ],
      [
        { explain: true, executionId: "execution-1", cursor: "g:2000:42" },
        { executionId: "execution-1", decisionCursor: "g:2000:42", decisionLimit: 50 },
      ],
    ] as const) {
      callGateway.mockClear();
      await auditListCommand(options, runtime);
      expect(callGateway).toHaveBeenCalledWith({ method: "audit.run.inspect", params });
    }
  });

  it("renders expired identity as unsupported without context fields or decisions", async () => {
    callGateway.mockResolvedValue({
      schemaVersion: 1,
      run: { runId: "expired-run", status: "known" },
      identity: {
        state: "unsupported",
        reasonCode: "identity_context_unavailable",
        missingEvidence: ["identity.context"],
        remediation: [
          {
            code: "run_again_after_expiry",
            text: "This run's identity context is outside the 30-day retention window; run the operation again to record a new context.",
          },
        ],
      },
      decisions: [],
      coverage: { state: "unsupported", missingEvidence: ["identity.context"] },
    });

    await auditListCommand({ explain: true, runId: "expired-run" }, runtime);

    const output = vi.mocked(runtime.log).mock.calls.flat().join("\n");
    expect(output).toContain("Ingress [unsupported]");
    expect(output).toContain("none [absent]");
    expect(output).toContain("outside the 30-day retention window");
    expect(output).not.toContain("Context:");
    expect(output).not.toContain("run_admission_identity_not_evaluated");
  });

  it("returns an explicit upgrade state from an older Gateway", async () => {
    callGateway.mockRejectedValue(unknownRunInspectMethodError());

    await auditListCommand({ explain: true, runId: "old-run", json: true }, runtime);

    expect(callGateway).toHaveBeenCalledTimes(1);
    const output = vi.mocked(runtime.log).mock.calls.flat().join("\n");
    expect(output).toContain('"state": "unsupported"');
    expect(output).toContain("gateway_upgrade_required");
    expect(output).toContain("upgrade_gateway");
  });
});
