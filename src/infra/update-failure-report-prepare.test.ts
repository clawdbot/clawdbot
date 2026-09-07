import { describe, expect, it } from "vitest";
import { prepareUpdateFailureReport } from "./update-failure-report-prepare.js";

const context = { env: {}, stateDir: "/report-test-state" };

function prepareDiagnosticReport(reason: string) {
  return prepareUpdateFailureReport(
    {
      attemptId: "diagnostic-value",
      result: { mode: "npm", status: "error", reason, steps: [], durationMs: 1 },
    },
    context,
  );
}

describe("update report diagnostic command boundary", () => {
  it.each([
    'Command failed: python -c "private-customer-text"',
    'ruby -e "private-customer-text"',
    "custom-tool private-customer-text",
    "custom-tool\u00a0private-customer-text",
    "custom-tool;private-customer-text",
    "$(private-customer-text)",
    "`private-customer-text`",
  ])("omits command-shaped diagnostic value %s without an executable-name list", async (value) => {
    const report = await prepareDiagnosticReport(value);
    expect(report.body).not.toContain("private-customer-text");
    expect(report.body).toContain("- Reason code: [redacted-command]\n");
  });

  it.each([
    "build",
    "global-install-failed",
    "origin/main@abcdef",
    "openclaw@2026.9.1",
    "linux/arm64",
    "🦞".repeat(5),
  ])("preserves scalar structured fact %s", async (value) => {
    const report = await prepareDiagnosticReport(value);
    expect(report.body).toContain(`- Reason code: ${value}\n`);
  });

  it.each(["\n", "\r\n", "\r", "\u2028", "\u2029"])(
    "keeps independent scalar lines around a command with separator %j",
    async (separator) => {
      const value = ["build", "custom-tool private-customer-text", "linux/arm64"].join(separator);
      const report = await prepareDiagnosticReport(value);
      expect(report.body).not.toContain("private-customer-text");
      expect(report.body).toContain(
        `- Reason code: ${["build", "[redacted-command]", "linux/arm64"].join(separator)}\n`,
      );
    },
  );

  it("excludes arbitrary command arguments from the prepared public body", async () => {
    const report = await prepareUpdateFailureReport(
      {
        attemptId: "unlisted-executable",
        target: 'custom-updater --customer "private-customer-text"',
        result: {
          mode: "npm",
          status: "error",
          reason: 'Command failed: python -c "private-customer-text"',
          before: { version: "custom-tool private-customer-text", sha: "/private-customer-text" },
          after: {
            version: "C:\\private-customer-text",
            sha: "~\\private-customer-text",
            buildId: '"PowerShell.EXE" -EncodedCommand private-customer-text',
          },
          steps: [
            {
              name: 'ruby -e "private-customer-text"',
              command: "never copied",
              cwd: "/private",
              durationMs: 1,
              exitCode: 7,
            },
          ],
          recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
          durationMs: 1,
        },
      },
      context,
    );
    expect(report.body).not.toContain("private-customer-text");
    expect(report.body).toContain("exit 7");
    expect(report.body).toContain("Update mode: npm");
    expect(report.body).toContain("Rollback outcome: not verified");
  });

  it.each([
    "version 2026.9.1",
    "version 2026.9.1-beta.1",
    "version 2026.9.1+build.abc",
    "stable channel",
    "extended-stable channel",
    "beta channel",
    "dev channel",
  ])("retains the canonical structured target %s", async (target) => {
    const report = await prepareUpdateFailureReport(
      {
        attemptId: "structured-target",
        target,
        result: { mode: "npm", status: "error", reason: "build-failed", steps: [], durationMs: 1 },
      },
      context,
    );
    expect(report.body).toContain(`- Update target: ${target}\n`);
  });

  it.each([
    "version private-customer-text",
    "version 2026.9.1 private-customer-text",
    "version 2026.9.1\u00a0private-customer-text",
    "version 2026.9.1;private-customer-text",
    "stable channel private-customer-text",
    "private-customer-text channel",
  ])("does not treat unvalidated target prose as structured facts: %s", async (target) => {
    const report = await prepareUpdateFailureReport(
      {
        attemptId: "untrusted-target",
        target,
        result: { mode: "npm", status: "error", reason: "build-failed", steps: [], durationMs: 1 },
      },
      context,
    );
    expect(report.body).not.toContain("private-customer-text");
    expect(report.body).toContain("- Update target: [redacted-command]\n");
  });

  it("uses the failure code when a phase label is executable text", async () => {
    const report = await prepareUpdateFailureReport(
      {
        attemptId: "structured-phase",
        result: {
          mode: "npm",
          status: "error",
          reason: "doctor-failed",
          steps: [
            {
              name: "openclaw doctor",
              command: "not copied",
              cwd: "/private",
              durationMs: 1,
              exitCode: 1,
            },
          ],
          durationMs: 1,
        },
      },
      context,
    );
    expect(report.body).toContain("- Failed phase: doctor-failed\n");
    expect(report.body).not.toContain("openclaw doctor");
  });
});
