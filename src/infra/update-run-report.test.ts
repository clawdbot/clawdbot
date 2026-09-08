import { describe, expect, it } from "vitest";
import type { UpdateRunRecord } from "./update-run-record.js";
import {
  renderUpdateRunNotice,
  renderUpdateRunReport,
  updateRunReportInputFromResult,
  updateRunReportInputFromSentinel,
} from "./update-run-report.js";

function run(patch: Partial<UpdateRunRecord> = {}): UpdateRunRecord {
  return {
    runId: "6631ecee-adbf-41e8-a0e3-1b88b28b0a59",
    createdAtMs: 1,
    updatedAtMs: 301,
    trigger: "cli",
    phase: "finished",
    status: "succeeded",
    reason: null,
    origin: {},
    target: { kind: "package" },
    before: { version: "2026.9.1" },
    after: { version: "2026.9.2" },
    steps: [{ step: "staging", status: "completed", startedAtMs: 1, endedAtMs: 301 }],
    verification: {},
    repair: [],
    confirmedAtMs: null,
    finishedAtMs: 301,
    downtimeMs: null,
    ...patch,
  };
}

describe("update run report", () => {
  it.each([
    ["requester-revoked", "A current command owner must start a new update"],
    ["repair-requires-config-change", "run openclaw doctor --fix under your own authority"],
  ])("renders the repair stop reason %s with an unambiguous next action", (reason, guidance) => {
    const report = renderUpdateRunReport(
      run({
        status: "failed",
        reason: "doctor-failed",
        repair: [{ attempt: 1, status: "failed", startedAtMs: 1, reason }],
      }),
    );
    expect(report.markdown).toContain(reason);
    expect(report.markdown).toContain(guidance);
  });

  it("limits parking notices to the pre-updater milestone without loosening phase notices", () => {
    const requested = run({ status: "running", phase: "requested" });
    expect(renderUpdateRunNotice(requested, "parking")).toContain("Restarting the gateway now");
    expect(renderUpdateRunNotice(requested, "activating")).toBeNull();
    expect(renderUpdateRunNotice(requested, "verifying")).toBeNull();
    for (const phase of ["staging", "activating", "verifying"] as const) {
      const progressed = run({ status: "running", phase });
      expect(renderUpdateRunNotice(progressed, "parking")).toBeNull();
      expect(renderUpdateRunNotice(progressed, "ack")).toBeNull();
    }
    expect(renderUpdateRunNotice(run(), "parking")).toBeNull();
  });

  it("reports changed git commits when the package version stays the same", () => {
    const report = renderUpdateRunReport(
      run({
        before: { version: "2026.8.1", sha: "1111111111111111111111111111111111111111" },
        after: { version: "2026.8.1", sha: "9f3c21a0000000000000000000000000000000aa" },
      }),
    );
    expect(report.headline).toBe("✅ OpenClaw updated to 9f3c21a0 (from 11111111).");
    expect(report.markdown).toContain(report.headline);
  });

  it("distinguishes all terminal outcomes without claiming unobserved verification", () => {
    const reports = [
      run(),
      run({
        status: "failed",
        reason: "restart-unhealthy",
        verification: { runningVersion: "2026.9.1", serviceRunning: true },
      }),
      run({ status: "skipped", reason: "dry-run", after: {} }),
      run({ status: "rolled-back", reason: "build-failed", after: { version: "2026.9.1" } }),
    ].map((record) => renderUpdateRunReport(record).markdown);
    expect(reports).toMatchInlineSnapshot(`
      [
        "✅ OpenClaw updated to 2026.9.2 (from 2026.9.1).
      Phases: staging (300ms)",
        "⚠️ OpenClaw update failed: restart-unhealthy. The gateway is running 2026.9.1.
      Phases: staging (300ms)
      Verification: service running.
      Run openclaw triage to diagnose and repair the failed update.",
        "ℹ️ OpenClaw update skipped: dry-run.
      Phases: staging (300ms)",
        "↩️ OpenClaw update rolled back to 2026.9.1: build-failed.
      Phases: staging (300ms)",
      ]
    `);
  });

  it("keeps recent failures and next action within the chat budget without truncating CLI guidance", () => {
    const report = renderUpdateRunReport(
      run({
        status: "failed",
        reason: "post-update-failed",
        steps: Array.from({ length: 5 }, (_, index) => ({
          step: `build-${index}`,
          status: "failed",
          detail: "🦞".repeat(500),
        })),
        repair: Array.from({ length: 3 }, (_, index) => ({
          attempt: index + 1,
          status: "failed",
          startedAtMs: 1,
          summary: "repair detail ".repeat(100),
        })),
        origin: { doctorHint: "Recovery instructions ".repeat(80) },
      }),
    );
    const failures = report.lines.filter((line) => line.startsWith("Failed:"));
    expect(failures).toHaveLength(3);
    expect(failures.map((line) => line.split(" — ")[0])).toEqual([
      "Failed: build-2",
      "Failed: build-3",
      "Failed: build-4",
    ]);
    expect(failures.every((line) => line.length <= 300)).toBe(true);
    expect(report.markdown.length).toBeLessThanOrEqual(1500);
    expect(Buffer.from(report.markdown).toString("utf8")).toBe(report.markdown);
    expect(
      report.markdown.endsWith("Run openclaw triage to diagnose and repair the failed update."),
    ).toBe(true);
    expect(report.lines.join("\n").length).toBeGreaterThan(1500);
  });

  it.each([
    ["preflight-insufficient-space", "Free space on the preflight staging"],
    ["pnpm-corepack-missing", "corepack is missing"],
    ["pnpm-corepack-enable-failed", "corepack enable"],
    ["pnpm-npm-bootstrap-failed", "bootstrap pnpm from npm"],
    ["preferred-manager-unavailable", "declared package manager"],
  ])("preserves recovery guidance for %s", (reason, hint) => {
    expect(renderUpdateRunReport(run({ status: "failed", reason })).markdown).toContain(hint);
  });

  it.each([
    { reason: null, source: "origin" },
    { reason: "requester-revoked", source: "origin" },
    { reason: "repair-requires-config-change", source: "origin" },
    { reason: "requester-revoked", source: "options" },
    { reason: "repair-requires-config-change", source: "options" },
  ])("keeps $source recovery scoped to its profile after $reason", ({ reason, source }) => {
    const originAction = "Run `openclaw --profile work triage` to repair this installation.";
    const nextAction =
      source === "options"
        ? "Run `openclaw --profile team triage` to repair this installation."
        : originAction;
    const report = renderUpdateRunReport(
      run({ status: "failed", reason, origin: { nextAction: originAction } }),
      source === "options" ? { nextAction } : {},
    );
    expect(report.lines.at(-1)).toBe(nextAction);
    expect(report.markdown.endsWith(nextAction)).toBe(true);
    expect(report.markdown).not.toContain("Run openclaw triage");
    expect(report.markdown).not.toContain("run openclaw doctor --fix");
    expect(report.markdown).not.toContain("operator can run openclaw triage locally");
    if (source === "options") {
      expect(report.markdown).not.toContain(originAction);
    }
    if (reason === "requester-revoked") {
      expect(report.markdown).toContain("Further recovery requires a current command owner.");
    } else if (reason === "repair-requires-config-change") {
      expect(report.markdown).toContain("Rehearsal config changes were not promoted.");
    }
  });

  it("keeps advisory steps out of failures and shows only the final diagnostic lines", () => {
    const report = renderUpdateRunReport(
      updateRunReportInputFromResult({
        status: "error",
        mode: "npm",
        durationMs: 1,
        steps: [
          {
            name: "openclaw doctor",
            command: "openclaw doctor",
            cwd: "/tmp",
            durationMs: 1,
            exitCode: 1,
            advisory: {
              kind: "package-post-install-doctor",
              message: "A plugin repair is deferred",
            },
          },
          {
            name: "build",
            command: "pnpm build",
            cwd: "/tmp",
            durationMs: 1,
            exitCode: 1,
            termination: "timeout",
            stdoutTail: "earlier output\nlast build diagnostic",
            stderrTail: "earlier error\nlast error diagnostic",
          },
        ],
      }),
    );
    expect(report.lines.filter((line) => line.startsWith("Failed:"))).toEqual([
      "Failed: build — timeout; last build diagnostic; last error diagnostic",
    ]);
  });

  it("reports pending work, verification, and repair facts without inferring success", () => {
    const report = renderUpdateRunReport(
      run({
        status: "running",
        phase: "verifying",
        after: {},
        origin: { doctorHint: "Run openclaw doctor", nextAction: "Run the update manually" },
        verification: {
          booted: true,
          versionMatch: false,
          channelsReady: false,
          inferenceProbe: "failed",
          pluginErrors: ["Activation failed"],
        },
        repair: [
          { attempt: 1, status: "failed", startedAtMs: 1, summary: "Plugin still unavailable" },
        ],
      }),
    );
    expect(report.headline).toBe("⬆️ OpenClaw update in progress: verifying.");
    expect(report.markdown).not.toContain("openclaw doctor");
    expect(report.markdown).not.toContain("Run the update manually");
    expect(report.markdown).toContain(
      "version mismatch; channels not ready; inference failed; 1 plugin activation error(s)",
    );
    expect(report.markdown).toContain("Repair 1: failed — Plugin still unavailable");
    expect(report.markdown).not.toContain("The gateway is running");
    const stopped = renderUpdateRunReport(
      run({
        status: "failed",
        verification: { serviceRunning: false, runningVersion: "2026.9.1" },
      }),
    );
    expect(stopped.headline).not.toContain("The gateway is running");
    expect(stopped.lines).toContain("Verification: service stopped.");
    const legacy = renderUpdateRunReport(
      updateRunReportInputFromSentinel({
        kind: "update",
        status: "error",
        ts: 1,
        stats: {
          steps: [
            {
              name: "build",
              command: "pnpm build",
              log: {
                exitCode: 1,
                stdoutTail: "private legacy output",
                stderrTail: "private legacy error",
              },
            },
          ],
        },
      }),
    );
    expect(legacy.markdown).toContain("Failed: build");
    expect(legacy.markdown).not.toContain("private legacy");
  });
});
