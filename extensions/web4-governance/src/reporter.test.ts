import { describe, expect, it } from "vitest";
import { AuditReporter } from "./reporter.js";
import type { AuditRecord } from "./audit.js";

function makeRecord(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    recordId: "audit:test",
    r6RequestId: "r6:test",
    timestamp: "2026-01-27T10:00:00.000Z",
    tool: "Read",
    category: "file_read",
    target: "/foo/bar.ts",
    result: {
      status: "success",
      durationMs: 10,
    },
    provenance: {
      sessionId: "s1",
      actionIndex: 0,
      prevRecordHash: "genesis",
    },
    ...overrides,
  };
}

function makeSyntheticRecords(): AuditRecord[] {
  return [
    makeRecord({ tool: "Read", category: "file_read", result: { status: "success", durationMs: 10 }, timestamp: "2026-01-27T10:00:00.000Z" }),
    makeRecord({ tool: "Read", category: "file_read", result: { status: "success", durationMs: 20 }, timestamp: "2026-01-27T10:00:30.000Z" }),
    makeRecord({ tool: "Bash", category: "command", result: { status: "success", durationMs: 50 }, timestamp: "2026-01-27T10:01:00.000Z" }),
    makeRecord({ tool: "Bash", category: "command", result: { status: "error", errorMessage: "exit 1", durationMs: 5 }, timestamp: "2026-01-27T10:01:30.000Z" }),
    makeRecord({ tool: "WebFetch", category: "network", result: { status: "blocked" }, timestamp: "2026-01-27T10:02:00.000Z" }),
    makeRecord({ tool: "Write", category: "file_write", result: { status: "success", durationMs: 15 }, timestamp: "2026-01-27T10:02:30.000Z" }),
    makeRecord({ tool: "Bash", category: "command", result: { status: "error", errorMessage: "exit 1" }, timestamp: "2026-01-27T10:03:00.000Z" }),
    makeRecord({ tool: "Bash", category: "command", result: { status: "error", errorMessage: "timeout" }, timestamp: "2026-01-27T10:03:30.000Z" }),
  ];
}

describe("AuditReporter", () => {
  describe("generate", () => {
    it("should handle empty records", () => {
      const reporter = new AuditReporter([]);
      const report = reporter.generate();
      expect(report.totalRecords).toBe(0);
      expect(report.timeRange).toBeNull();
      expect(report.toolStats).toHaveLength(0);
      expect(report.categoryBreakdown).toHaveLength(0);
      expect(report.policyStats.totalEvaluated).toBe(0);
    });

    it("should compute correct total", () => {
      const records = makeSyntheticRecords();
      const report = new AuditReporter(records).generate();
      expect(report.totalRecords).toBe(8);
    });

    it("should compute time range", () => {
      const records = makeSyntheticRecords();
      const report = new AuditReporter(records).generate();
      expect(report.timeRange).not.toBeNull();
      expect(report.timeRange!.from).toBe("2026-01-27T10:00:00.000Z");
      expect(report.timeRange!.to).toBe("2026-01-27T10:03:30.000Z");
    });
  });

  describe("tool stats", () => {
    it("should aggregate per tool", () => {
      const records = makeSyntheticRecords();
      const report = new AuditReporter(records).generate();
      const bash = report.toolStats.find((t) => t.tool === "Bash");
      expect(bash).toBeDefined();
      expect(bash!.invocations).toBe(4);
      expect(bash!.successCount).toBe(1);
      expect(bash!.errorCount).toBe(3);
    });

    it("should calculate success rate", () => {
      const records = makeSyntheticRecords();
      const report = new AuditReporter(records).generate();
      const read = report.toolStats.find((t) => t.tool === "Read");
      expect(read!.successRate).toBe(1);
      const bash = report.toolStats.find((t) => t.tool === "Bash");
      expect(bash!.successRate).toBe(0.25);
    });

    it("should calculate avg duration", () => {
      const records = makeSyntheticRecords();
      const report = new AuditReporter(records).generate();
      const read = report.toolStats.find((t) => t.tool === "Read");
      expect(read!.avgDurationMs).toBe(15); // (10+20)/2
    });

    it("should return null avgDuration when no durations", () => {
      const records = makeSyntheticRecords();
      const report = new AuditReporter(records).generate();
      const wf = report.toolStats.find((t) => t.tool === "WebFetch");
      expect(wf!.avgDurationMs).toBeNull();
    });

    it("should sort by invocation count descending", () => {
      const records = makeSyntheticRecords();
      const report = new AuditReporter(records).generate();
      expect(report.toolStats[0]!.tool).toBe("Bash");
    });
  });

  describe("category breakdown", () => {
    it("should compute category counts and percentages", () => {
      const records = makeSyntheticRecords();
      const report = new AuditReporter(records).generate();
      const cmd = report.categoryBreakdown.find((c) => c.category === "command");
      expect(cmd!.count).toBe(4);
      expect(cmd!.percentage).toBe(50);
    });

    it("should sort by count descending", () => {
      const records = makeSyntheticRecords();
      const report = new AuditReporter(records).generate();
      expect(report.categoryBreakdown[0]!.category).toBe("command");
    });
  });

  describe("policy stats", () => {
    it("should count blocked as deny", () => {
      const records = makeSyntheticRecords();
      const report = new AuditReporter(records).generate();
      expect(report.policyStats.denyCount).toBe(1);
      expect(report.policyStats.allowCount).toBe(7);
    });

    it("should compute block rate", () => {
      const records = makeSyntheticRecords();
      const report = new AuditReporter(records).generate();
      expect(report.policyStats.blockRate).toBeCloseTo(1 / 8);
    });
  });

  describe("errors", () => {
    it("should aggregate errors by tool", () => {
      const records = makeSyntheticRecords();
      const report = new AuditReporter(records).generate();
      expect(report.errors).toHaveLength(1); // only Bash has errors
      expect(report.errors[0]!.tool).toBe("Bash");
      expect(report.errors[0]!.count).toBe(3);
    });

    it("should list top error messages", () => {
      const records = makeSyntheticRecords();
      const report = new AuditReporter(records).generate();
      expect(report.errors[0]!.topMessages).toContain("exit 1");
      expect(report.errors[0]!.topMessages).toContain("timeout");
    });

    it("should sort messages by frequency", () => {
      const records = makeSyntheticRecords();
      const report = new AuditReporter(records).generate();
      // "exit 1" appears twice, "timeout" once
      expect(report.errors[0]!.topMessages[0]).toBe("exit 1");
    });
  });

  describe("timeline", () => {
    it("should bucket by minute", () => {
      const records = makeSyntheticRecords();
      const report = new AuditReporter(records).generate();
      expect(report.timeline.length).toBeGreaterThan(0);
      // First two records share the same minute bucket (both at :00 seconds apart)
      // The exact minute string depends on local timezone, so just check the first bucket has 2
      expect(report.timeline[0]!.count).toBe(2);
    });

    it("should sort chronologically", () => {
      const records = makeSyntheticRecords();
      const report = new AuditReporter(records).generate();
      for (let i = 1; i < report.timeline.length; i++) {
        expect(report.timeline[i]!.minute >= report.timeline[i - 1]!.minute).toBe(true);
      }
    });
  });

  describe("formatText", () => {
    it("should produce non-empty text output", () => {
      const records = makeSyntheticRecords();
      const text = new AuditReporter(records).formatText();
      expect(text.length).toBeGreaterThan(0);
      expect(text).toContain("Audit Report");
      expect(text).toContain("Tool Stats");
      expect(text).toContain("Categories");
      expect(text).toContain("Policy");
      expect(text).toContain("Errors");
      expect(text).toContain("Timeline");
    });

    it("should handle empty records", () => {
      const text = new AuditReporter([]).formatText();
      expect(text).toContain("Total records: 0");
    });
  });
});
