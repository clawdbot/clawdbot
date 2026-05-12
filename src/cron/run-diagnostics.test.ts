import { describe, expect, it } from "vitest";
import {
  createCronRunDiagnosticsFromAgentResult,
  createCronRunDiagnosticsFromError,
  mergeCronRunDiagnostics,
  normalizeCronRunDiagnostics,
  summarizeCronRunDiagnostics,
} from "./run-diagnostics.js";

describe("cron run diagnostics", () => {
  it("normalizes and bounds diagnostic entries", () => {
    const diagnostics = normalizeCronRunDiagnostics({
      summary: "x".repeat(2_100),
      entries: Array.from({ length: 12 }, (_, i) => ({
        ts: i,
        source: "exec",
        severity: "error",
        message: i === 11 ? `secret sk-1234567890abcdef ${"a".repeat(1_100)}` : `entry ${i}`,
      })),
    });

    expect(diagnostics?.entries).toHaveLength(10);
    expect(diagnostics?.entries[0]?.message).toBe("entry 2");
    expect(diagnostics?.entries.at(-1)?.message.endsWith("…")).toBe(true);
    expect(diagnostics?.entries.at(-1)?.message).not.toContain("sk-1234567890abcdef");
    expect(diagnostics?.entries.at(-1)?.truncated).toBe(true);
    expect(diagnostics?.summary).toHaveLength(2_000);
  });

  it("preserves later terminal diagnostics when capping entries", () => {
    const diagnostics = normalizeCronRunDiagnostics({
      entries: [
        ...Array.from({ length: 10 }, (_, i) => ({
          ts: i,
          source: "tool",
          severity: "warn",
          message: `tool warning ${i}`,
        })),
        {
          ts: 11,
          source: "delivery",
          severity: "error",
          message: "delivery failed",
        },
      ],
    });

    expect(diagnostics?.entries).toHaveLength(10);
    expect(diagnostics?.entries.map((entry) => entry.message)).not.toContain("tool warning 0");
    expect(diagnostics?.entries.at(-1)).toEqual({
      ts: 11,
      source: "delivery",
      severity: "error",
      message: "delivery failed",
    });
  });

  it("returns undefined for empty diagnostics", () => {
    expect(normalizeCronRunDiagnostics({ entries: [] })).toBeUndefined();
    expect(normalizeCronRunDiagnostics({ entries: [{ source: "exec" }] })).toBeUndefined();
    expect(summarizeCronRunDiagnostics(undefined)).toBeUndefined();
  });

  it("creates diagnostics from errors and prefers the latest error summary", () => {
    const first = createCronRunDiagnosticsFromError("cron-preflight", "first failure", {
      nowMs: () => 100,
    });
    const second = createCronRunDiagnosticsFromError("delivery", new Error("delivery failed"), {
      nowMs: () => 200,
    });

    const merged = mergeCronRunDiagnostics(first, second);
    expect(merged?.summary).toBe("delivery failed");
    expect(merged?.entries.map((entry) => entry.message)).toEqual([
      "first failure",
      "delivery failed",
    ]);
    expect(summarizeCronRunDiagnostics(merged)).toBe("delivery failed");
  });

  it("keeps a later delivery error summary ahead of an earlier warning", () => {
    const warning = normalizeCronRunDiagnostics({
      summary: "agent warning",
      entries: [{ ts: 100, source: "agent-run", severity: "warn", message: "agent warning" }],
    });
    const deliveryError = createCronRunDiagnosticsFromError("delivery", "delivery failed", {
      nowMs: () => 200,
    });

    expect(mergeCronRunDiagnostics(warning, deliveryError)?.summary).toBe("delivery failed");
  });

  it("extracts fatal agent result payloads and meta errors", () => {
    const diagnostics = createCronRunDiagnosticsFromAgentResult(
      {
        payloads: [
          { text: "normal" },
          { text: "tool stderr", isError: true, toolName: "shell" },
          {
            toolName: "exec",
            details: {
              status: "completed",
              exitCode: 2,
              aggregated: "stdout\nstderr failure",
            },
          },
        ],
        meta: {
          error: { kind: "retry_limit", message: "retry limit exceeded" },
          failureSignal: { message: "SYSTEM_RUN_DENIED" },
        },
      },
      { nowMs: () => 123 },
    );

    expect(diagnostics?.entries.map((entry) => entry.message)).toEqual([
      "tool stderr",
      "stdout\nstderr failure",
      "retry limit exceeded",
      "SYSTEM_RUN_DENIED",
    ]);
    expect(diagnostics?.entries[1]).toEqual({
      ts: 123,
      source: "exec",
      severity: "warn",
      message: "stdout\nstderr failure",
      toolName: "exec",
      exitCode: 2,
    });
  });

  it("does not capture harmless successful exec output", () => {
    const result = {
      payloads: [
        {
          toolName: "exec",
          details: {
            status: "completed",
            exitCode: 0,
            aggregated: "progress written to stderr",
          },
        },
      ],
    };

    expect(createCronRunDiagnosticsFromAgentResult(result)).toBeUndefined();
    expect(
      createCronRunDiagnosticsFromAgentResult(result, { finalStatus: "error" }),
    ).toBeUndefined();
  });

  it("captures silent failed exec details with a fallback message", () => {
    const diagnostics = createCronRunDiagnosticsFromAgentResult(
      {
        payloads: [
          {
            toolName: "exec",
            details: {
              status: "completed",
              exitCode: 2,
            },
          },
        ],
      },
      { nowMs: () => 500 },
    );

    expect(diagnostics?.entries).toEqual([
      {
        ts: 500,
        source: "exec",
        severity: "warn",
        message: "exec failed with exit code 2",
        toolName: "exec",
        exitCode: 2,
      },
    ]);
  });
});
