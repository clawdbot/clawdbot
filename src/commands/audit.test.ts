import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { auditListCommand } from "./audit.js";
import { testApi } from "./audit.test-support.js";

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
  });

  it("parses ISO and millisecond timestamps", () => {
    expect(testApi.parseAuditTimestamp("2026-07-01T00:00:00Z", "--after")).toBe(
      Date.parse("2026-07-01T00:00:00Z"),
    );
    expect(testApi.parseAuditTimestamp("1234", "--after")).toBe(1234);
    expect(testApi.parseAuditTimestamp("2024-02-29T00:00:00Z", "--after")).toBe(
      Date.parse("2024-02-29T00:00:00Z"),
    );
    expect(() => testApi.parseAuditTimestamp("not-a-date", "--after")).toThrow("--after");
  });

  it.each(["--after", "--before"])("rejects impossible calendar dates for %s", (flag) => {
    expect(() => testApi.parseAuditTimestamp("2026-02-30T00:00:00Z", flag)).toThrow(flag);
  });

  it.each(["--after", "--before"])("rejects parseable non-ISO values for %s", (flag) => {
    for (const input of ["-1", "July 1, 2026"]) {
      expect(Number.isNaN(Date.parse(input))).toBe(false);
      expect(() => testApi.parseAuditTimestamp(input, flag)).toThrow(flag);
    }
  });

  it.each([
    { flag: "--after", options: { after: "2026-02-30T00:00:00Z" } },
    { flag: "--before", options: { before: "July 1, 2026" } },
  ])("rejects invalid $flag before calling the Gateway", async ({ flag, options }) => {
    mocks.callGateway.mockClear();

    await expect(auditListCommand(options, runtime)).rejects.toThrow(flag);
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("keeps the original local-time result for timezone-less timestamps", () => {
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
      expect(testApi.parseAuditTimestamp(input, "--after")).toBe(localMs);
    } finally {
      parse.mockRestore();
    }
  });

  it("keeps exports bounded", () => {
    expect(testApi.parseAuditLimit(undefined)).toBe(100);
    expect(testApi.parseAuditLimit("500")).toBe(500);
    expect(() => testApi.parseAuditLimit("501")).toThrow("1 and 500");
  });

  it("rejects unknown event kinds before querying the Gateway", async () => {
    await expect(
      auditListCommand({ kind: "bogus" as never, limit: "10" }, runtime),
    ).rejects.toThrow("--kind must be agent_run, tool_action, or message");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("renders untrusted metadata as one terminal-safe row", () => {
    const events = [
      {
        eventId: "event-1",
        schemaVersion: 1,
        sequence: 1,
        sourceSequence: 1,
        occurredAt: 0,
        kind: "tool_action",
        action: "tool.action.finished",
        status: "failed",
        actor: { type: "agent", id: "main" },
        agentId: "main\nforged",
        runId: "run\tcolumn",
        toolName: "\u001b]8;;https://example.invalid\u0007unsafe",
        redaction: "metadata_only",
      },
    ];
    const [header, row] = testApi.formatAuditRows(events);

    expect(header).toContain("TIME");
    expect(row).not.toContain("\n");
    expect(row).not.toContain("\u001b");
    expect(row).toContain("main\\nforged");
    expect(row).toContain("run\\tcolumn");
  });

  it("renders message direction and channel without synthetic run provenance", () => {
    const events = [
      {
        schemaVersion: 1,
        eventId: "event-message-1",
        sequence: 2,
        occurredAt: 0,
        kind: "message",
        action: "message.inbound.processed",
        status: "succeeded",
        actor: { type: "channel_sender" },
        direction: "inbound",
        channel: "telegram",
        conversationKind: "direct",
        outcome: "completed",
        redaction: "metadata_only",
      },
    ];
    const [header, row] = testApi.formatAuditRows(events);

    expect(header).toContain("DIRECTION\tCHANNEL");
    expect(row).toContain("message\tinbound\ttelegram\tsucceeded\t-\t-");
  });

  it("keeps truncated audit cells UTF-16 well-formed", () => {
    const events = [
      {
        eventId: "event-utf16",
        schemaVersion: 1,
        sequence: 1,
        sourceSequence: 1,
        occurredAt: 0,
        kind: "tool_action",
        action: "tool.action.finished",
        status: "failed",
        actor: { type: "agent", id: "main" },
        agentId: `${"x".repeat(16)}🚀tail`,
        runId: "run-utf16",
        redaction: "metadata_only",
      },
    ];
    const [, row] = testApi.formatAuditRows(events);

    expect(row).toContain(`${"x".repeat(16)}…`);
    expect(row).not.toContain("\uD83D");
  });
});

describe("audit command gateway compatibility", () => {
  beforeEach(() => {
    callGateway.mockReset();
    callGateway.mockResolvedValue({ events: [] });
  });

  it("forwards all filters to audit.activity.list", async () => {
    await auditListCommand(
      {
        agentId: "main",
        kind: "message",
        status: "failed",
        direction: "outbound",
        channel: "telegram",
        after: "100",
        before: "200",
        cursor: "42",
        limit: "25",
      },
      runtime,
    );

    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(callGateway).toHaveBeenCalledWith({
      method: "audit.activity.list",
      params: {
        limit: 25,
        agentId: "main",
        kind: "message",
        status: "failed",
        direction: "outbound",
        channel: "telegram",
        after: 100,
        before: 200,
        cursor: "42",
      },
    });
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

  it("does not fall back for other request errors", async () => {
    const error = Object.assign(new Error("invalid audit activity params"), {
      name: "GatewayClientRequestError",
      gatewayCode: "INVALID_REQUEST",
    });
    callGateway.mockRejectedValueOnce(error);

    await expect(auditListCommand({ limit: "10" }, runtime)).rejects.toBe(error);
    expect(callGateway).toHaveBeenCalledTimes(1);
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

  it("requires one exact run and keeps decision queries bounded", async () => {
    await expect(auditListCommand({ explain: true }, runtime)).rejects.toThrow(
      "exactly one of --run <id> or --execution <id>",
    );
    await expect(
      auditListCommand({ explain: true, runId: "run-1", executionId: "execution-1" }, runtime),
    ).rejects.toThrow("exactly one");
    await expect(
      auditListCommand({ explain: true, runId: "run-1", agentId: "main" }, runtime),
    ).rejects.toThrow("remove activity-list filters");
    expect(testApi.parseAuditDecisionLimit(undefined)).toBe(50);
    expect(testApi.parseAuditDecisionLimit("100")).toBe(100);
    expect(() => testApi.parseAuditDecisionLimit("101")).toThrow("with --explain");
    expect(testApi.parseAuditExecutionLimit("50")).toBe(50);
    expect(() => testApi.parseAuditExecutionLimit("51")).toThrow("run discovery");
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
      ],
      coverage: { state: "unattributed", missingEvidence: ["invoker.principal"] },
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
