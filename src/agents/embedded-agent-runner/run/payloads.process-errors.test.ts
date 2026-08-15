import { describe, expect, it } from "vitest";
import type { ProcessTerminalDiagnostic, ToolErrorSummary } from "../../tool-error-summary.js";
import { buildPayloads, expectSingleToolErrorPayload } from "./payloads.test-helpers.js";

describe("buildEmbeddedRunPayloads process-error warnings", () => {
  it("surfaces safe terminal diagnostics when verbose mode is off", () => {
    const dummyTelegramToken = `123456:${"A".repeat(28)}WXYZ`;
    const lastToolError: ToolErrorSummary = {
      toolName: "process",
      error: `SAFE_PROCESS_STDERR ${dummyTelegramToken}`,
      terminalDiagnostic: {
        kind: "process",
        sessionId: "wild-lagoon",
        reason: { kind: "exit", exitCode: 7 },
      },
    };
    const payloads = buildPayloads({ lastToolError, verboseLevel: "off" });

    expectSingleToolErrorPayload(payloads, {
      title: "Process",
      absentDetail: "SAFE_PROCESS_STDERR",
    });
    expect(payloads[0]?.text).not.toContain("wild-lagoon");
    expect(payloads[0]?.text).not.toContain(dummyTelegramToken);
    expect(payloads[0]?.text).toContain("exit 7");
    expect(payloads[0]?.text).toContain("/verbose full");
  });

  it("shows a sanitized bounded error only at full verbosity", () => {
    const payloads = buildPayloads({
      lastToolError: {
        toolName: "process",
        error: "SAFE_PROCESS_STDERR",
        terminalDiagnostic: {
          kind: "process",
          sessionId: "wild-lagoon",
          reason: { kind: "exit", exitCode: 7 },
        },
      },
      verboseLevel: "full",
    });

    expect(payloads[0]?.text).toContain("SAFE_PROCESS_STDERR");
    expect(payloads[0]?.text).not.toContain("/verbose full");
  });

  it.each([
    {
      label: "signal",
      reason: { kind: "signal", signal: "SIGKILL" } as const,
      expected: "signal SIGKILL",
    },
    {
      label: "overall timeout",
      reason: { kind: "timeout", timeoutKind: "overall-timeout" } as const,
      expected: "timed out",
    },
    {
      label: "no-output timeout",
      reason: { kind: "timeout", timeoutKind: "no-output-timeout" } as const,
      expected: "timed out waiting for output",
    },
  ])("renders $label without fabricating an exit code", ({ reason, expected }) => {
    const terminalDiagnostic: ProcessTerminalDiagnostic = {
      kind: "process",
      sessionId: "wild-lagoon",
      reason,
    };
    const payloads = buildPayloads({
      lastToolError: { toolName: "process", terminalDiagnostic },
      verboseLevel: "off",
    });

    expect(payloads[0]?.text).toContain(expected);
    expect(payloads[0]?.text).not.toMatch(/exit -?\d+/u);
  });
});
