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
