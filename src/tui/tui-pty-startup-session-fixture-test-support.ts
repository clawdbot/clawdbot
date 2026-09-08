import { expect } from "vitest";
import {
  hasHistoricalSynchronizedFrameRow,
  readFixtureLog,
  type StartTuiPtyFixture,
  waitForSynchronizedFrameRows,
} from "./tui-pty-harness-assertion-test-support.js";

// Injects delayed session restore and history controls into the real-runTui PTY fixture.
export const TUI_PTY_STARTUP_SESSION_FIXTURE = {
  variables: `
      const restoreDelayMs = Number(process.env.OPENCLAW_TUI_PTY_RESTORE_DELAY_MS ?? 0);
      const restoreFailures = Number(process.env.OPENCLAW_TUI_PTY_RESTORE_FAILURES ?? 0);
      const reconnectHistoryDelayMs = Number(
        process.env.OPENCLAW_TUI_PTY_RECONNECT_HISTORY_DELAY_MS ?? 0,
      );
      let restoreAttempts = 0;
      let reconnectDuringRestore = process.env.OPENCLAW_TUI_PTY_RECONNECT_DURING_RESTORE === "1";
  `,
  loadHistory: `
          if (reconnectHistoryReady && reconnectHistoryDelayMs > 0) {
            reconnectHistoryReady = false;
            record("reconnectHistoryPending", { sessionKey });
            await new Promise((resolve) => setTimeout(resolve, reconnectHistoryDelayMs));
          }
  `,
  historyBarrier: `const startupReleasePath = process.env.OPENCLAW_TUI_PTY_STARTUP_RELEASE_PATH;
          if (startupReleasePath) {
            record("startupHistoryPending", { sessionKey });
            while (!existsSync(startupReleasePath)) {
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
            record("startupHistoryReleased", { sessionKey });
          }`,
  listSessionsSetup: `
          const isRestore = Boolean(opts?.search);
  `,
  listSessionsDelay: `
          if (isRestore && reconnectDuringRestore) {
            reconnectDuringRestore = false;
            record("restoreReconnect");
            this.onDisconnected?.("fixture reconnect during restore");
            queueMicrotask(() => this.onConnected?.());
          }
          if (isRestore && restoreDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, restoreDelayMs));
          }
          if (isRestore && restoreAttempts++ < restoreFailures) {
            throw new Error("fixture remembered-session lookup failed");
          }
  `,
} as const;

export async function exerciseStartupHistoryRendering(
  fixture: Awaited<ReturnType<StartTuiPtyFixture>> & {
    releaseStartupHistory: () => Promise<void>;
  },
  timeoutMs: number,
) {
  try {
    await fixture.waitForLogEntry((entry) => entry.method === "startupHistoryPending", timeoutMs);
    let startupOutput = "";
    const startupRows = await waitForSynchronizedFrameRows(
      {
        ...fixture.run,
        output: () => (startupOutput = fixture.run.output()),
      },
      (rows) => rows.some((row) => row.includes("starting up")),
      timeoutMs,
    );
    expect(startupRows.join("\n")).not.toContain("local ready | idle");
    expect(
      hasHistoricalSynchronizedFrameRow(startupOutput, [], "local ready | idle", fixture.run),
    ).toBe(false);
    expect(await readFixtureLog(fixture.logPath)).not.toContainEqual(
      expect.objectContaining({ method: "startupHistoryReleased" }),
    );

    await fixture.releaseStartupHistory();
    await waitForSynchronizedFrameRows(
      fixture.run,
      (rows) => rows.some((row) => row.includes("local ready | idle")),
      timeoutMs,
    );
  } finally {
    await fixture.releaseStartupHistory();
  }
}
