import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { auditListCommand, testApi } from "./audit.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

describe("audit command parsing", () => {
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

  it("renders untrusted metadata as one terminal-safe row", () => {
    const [header, row] = testApi.formatAuditRows([
      {
        eventId: "event-1",
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
    ]);

    expect(header).toContain("TIME");
    expect(row).not.toContain("\n");
    expect(row).not.toContain("\u001b");
    expect(row).toContain("main\\nforged");
    expect(row).toContain("run\\tcolumn");
  });

  it("keeps truncated audit cells UTF-16 well-formed", () => {
    const [, row] = testApi.formatAuditRows([
      {
        eventId: "event-utf16",
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
    ]);

    expect(row).toContain(`${"x".repeat(16)}…`);
    expect(row).not.toContain("\uD83D");
  });
});
