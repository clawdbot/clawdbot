import { expect, it } from "vitest";
import { sleep } from "../utils/sleep.js";
import {
  startTuiFixture,
  waitForSynchronizedFrameRows,
} from "./tui-pty-harness-fixture-test-support.js";

const RECONNECT_CASES = [
  { outcome: "interrupted", marker: "run aborted", activity: "idle" },
  { outcome: "failed", marker: "run error: fixture provider failed", activity: "error" },
  { outcome: "completed", marker: "PTY_RECONNECT_COMPLETED", activity: "idle" },
  { outcome: "active", marker: "PTY_RECONNECT_PARTIAL", activity: "streaming" },
] as const;

export function registerTuiReconnectTests(timeouts: {
  startupTimeoutMs: number;
  testTimeoutMs: number;
  startupTestTimeoutMs: number;
}): void {
  it(
    "reconciles active, replacement, and terminal runs after reconnect history",
    () => exerciseTuiReconnectOutcomes(35_000),
    45_000,
  );
  it.each(
    ["reconnect", "gap"].flatMap((recovery) => [
      { recovery, membership: "replacement", activity: "idle" },
      { recovery, membership: "concurrent", activity: "running" },
      { recovery, membership: "unknown", activity: "running" },
    ]),
  )(
    "reconciles $membership run membership before a replacement finishes after $recovery",
    async ({ recovery, membership, activity }) => {
      const fixture = await startTuiFixture({
        env: {
          OPENCLAW_TUI_PTY_DISCONNECT_REASON: "fixture transport loss",
          OPENCLAW_TUI_PTY_RECONNECT_OUTCOME: recovery === "gap" ? "gap" : "replacement",
          OPENCLAW_TUI_PTY_RECONNECT_MEMBERSHIP: membership,
        },
      });
      try {
        await fixture.run.waitForOutput("local ready", timeouts.startupTimeoutMs);
        await fixture.run.write("reconnect terminal proof\r", { delay: false });
        await fixture.run.waitForOutput("PTY_RECONNECT_PARTIAL", timeouts.testTimeoutMs);
        await fixture.run.write("/gateway-status\r", { delay: false });
        await fixture.run.waitForOutput("PTY_RECONNECT_REPLACEMENT", timeouts.testTimeoutMs);
        await fixture.run.write("/gateway-status\r", { delay: false });
        await waitForSynchronizedFrameRows(
          fixture.run,
          (rows) =>
            rows.some((row) => row.includes("PTY_REPLACEMENT_FINAL")) &&
            rows.some((row) => row.includes(`| ${activity}`) || row.includes(`${activity} •`)),
          timeouts.testTimeoutMs,
        );
      } finally {
        await fixture.cleanup();
      }
    },
    timeouts.startupTestTimeoutMs,
  );
}

async function exerciseTuiReconnectOutcomes(timeoutMs: number): Promise<void> {
  await Promise.all([
    ...RECONNECT_CASES.map(async ({ outcome, marker, activity }) => {
      const fixture = await startTuiFixture({
        env: {
          OPENCLAW_TUI_PTY_DISCONNECT_REASON: "fixture transport loss",
          OPENCLAW_TUI_PTY_RECONNECT_OUTCOME: outcome,
        },
      });
      try {
        await fixture.run.waitForOutput("local ready", timeoutMs);
        await fixture.run.write("reconnect terminal proof\r", { delay: false });
        await fixture.run.waitForOutput("PTY_RECONNECT_PARTIAL", timeoutMs);
        await fixture.run.write("/gateway-status\r", { delay: false });
        await fixture.run.waitForOutput("gateway reconnected after transport loss", timeoutMs);
        await waitForSynchronizedFrameRows(
          fixture.run,
          (rows) =>
            rows.some((row) => row.includes(marker)) &&
            rows.some((row) => row.includes(`| ${activity}`) || row.includes(`${activity} •`)),
          timeoutMs,
        );
        await sleep(500);
        const frame = await waitForSynchronizedFrameRows(
          fixture.run,
          (rows) => rows.some((row) => row.includes(marker)),
          timeoutMs,
        );
        expect(frame.join("\n")).not.toContain("PTY_LATE_RECONNECT_FINAL");
        expect(frame.join("\n").includes("run aborted")).toBe(outcome === "interrupted");
      } finally {
        await fixture.cleanup();
      }
    }),
    exerciseTuiReplacementReconnectRecovery(timeoutMs),
  ]);
}

async function exerciseTuiReplacementReconnectRecovery(timeoutMs: number): Promise<void> {
  await Promise.all(
    ["replacement", "appeared"].map(async (outcome) => {
      const fixture = await startTuiFixture({
        env: {
          OPENCLAW_TUI_PTY_DISCONNECT_REASON: "fixture transport loss",
          OPENCLAW_TUI_PTY_RECONNECT_OUTCOME: outcome,
        },
      });
      try {
        await fixture.run.waitForOutput("local ready", timeoutMs);
        if (outcome === "replacement") {
          await fixture.run.write("reconnect terminal proof\r", { delay: false });
          await fixture.run.waitForOutput("PTY_RECONNECT_PARTIAL", timeoutMs);
        }
        await fixture.run.write("/gateway-status\r", { delay: false });
        await fixture.run.waitForOutput("gateway reconnected after transport loss", timeoutMs);
        await fixture.run.waitForOutput("PTY_RECONNECT_REPLACEMENT", timeoutMs);
        await fixture.run.waitForOutput("PTY_RECONNECT_RECOVERED", timeoutMs);

        const frame = await waitForSynchronizedFrameRows(
          fixture.run,
          (rows) => rows.some((row) => row.includes("PTY_RECONNECT_RECOVERED")),
          timeoutMs,
        );
        expect(frame.join("\n")).not.toContain("PTY_RECONNECT_REPLACEMENT");
      } finally {
        await fixture.cleanup();
      }
    }),
  );
}
