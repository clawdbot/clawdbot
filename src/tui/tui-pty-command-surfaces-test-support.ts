import { expect } from "vitest";
import {
  type StartTuiPtyFixture,
  waitForSynchronizedFrameRows,
} from "./tui-pty-harness-assertion-test-support.js";
import { objectFieldEquals, readFixtureLog } from "./tui-pty-harness-fixture-test-support.js";

const slashHelpMarkers =
  "Slash commands:,/help,/verbose <on|off|full|plain>,/reasoning <on|off|stream>,/goal,/goal start <objective>,/btw <side question>,/queue,/stop,/exit".split(
    ",",
  );
const countHistoryLoads = async (logPath: string) =>
  (await readFixtureLog(logPath)).filter((entry) => entry.method === "loadHistory").length;
const rowsInclude = (rows: string[], ...texts: string[]) =>
  rows.some((row) => texts.every((text) => row.includes(text)));

export async function exerciseTuiCommandSurface(
  startFixture: StartTuiPtyFixture,
  surface: "slash-commands" | "pickers" | "settings",
  startupTimeoutMs: number,
) {
  const fixture = await startFixture({
    env: {
      OPENCLAW_TUI_PTY_COLS: "100",
      OPENCLAW_TUI_PTY_ROWS: "24",
      ...(surface === "pickers" ? { OPENCLAW_TUI_PTY_PICKER_FIXTURE: "1" } : {}),
    },
  });
  try {
    const waitForRows = (predicate: Parameters<typeof waitForSynchronizedFrameRows>[1]) =>
      waitForSynchronizedFrameRows(fixture.run, predicate, startupTimeoutMs);
    await fixture.run.waitForOutput("local ready", startupTimeoutMs);
    if (surface === "slash-commands") {
      await fixture.run.write("/help\r", { delay: false });
      for (const text of slashHelpMarkers) {
        await fixture.run.waitForOutput(text, startupTimeoutMs);
      }
      await waitForRows((rows) =>
        ["/settings", "/exit"].every((text) => rows.some((row) => row.trim() === text)),
      );
      await fixture.run.write("/gateway-status\r", { delay: false });
      await fixture.waitForLogEntry((entry) => entry.method === "getGatewayStatus");
      await waitForRows((rows) => rows.some((row) => row.trim() === "fixture gateway ok"));
      return;
    }
    if (surface === "pickers") {
      await fixture.run.write("/models\r", { delay: false });
      await fixture.waitForLogEntry((entry) => entry.method === "listModels");
      await waitForRows((rows) => rows.some((row) => row.includes("Fixture 2")));
      await fixture.run.write("\x1b[B\r", { delay: false });
      await fixture.waitForLogEntry(
        (entry) =>
          entry.method === "patchSession" &&
          objectFieldEquals(entry, "model", "fixture-provider/fixture-model-2"),
      );
      await fixture.run.write("/sessions\r", { delay: false });
      await fixture.waitForLogEntry(
        (entry) => entry.method === "listSessions" && objectFieldEquals(entry, "purpose", "picker"),
      );
      await waitForRows((rows) => rows.some((row) => row.includes("Picker target")));
      await fixture.run.write("\x1b[B\r", { delay: false });
      await fixture.waitForLogEntry(
        (entry) =>
          entry.method === "loadHistory" &&
          objectFieldEquals(entry, "sessionKey", "agent:main:picker-target"),
      );
      await fixture.run.write("picker selection proof\r", { delay: false });
      const sent = await fixture.waitForLogEntry(
        (entry) =>
          entry.method === "sendChat" &&
          objectFieldEquals(entry, "message", "picker selection proof"),
      );
      expect(sent.payload).toMatchObject({ sessionKey: "agent:main:picker-target" });
      await waitForRows((rows) => rowsInclude(rows, "PTY_RESPONSE: picker selection proof"));
      return;
    }
    const initialHistoryLoads = await countHistoryLoads(fixture.logPath);
    await fixture.run.write("/settings\r", { delay: false });
    await waitForRows(
      (rows) =>
        rowsInclude(rows, "Tool output", "collapsed") && rowsInclude(rows, "Show thinking", "off"),
    );
    await fixture.run.write("\r", { delay: false });
    await waitForRows((rows) => rowsInclude(rows, "Tool output", "expanded"));
    expect(await countHistoryLoads(fixture.logPath)).toBe(initialHistoryLoads);
    await fixture.run.write("\x1b[B\r", { delay: false });
    await waitForRows((rows) => rowsInclude(rows, "Show thinking", "on"));
    await expect
      .poll(() => countHistoryLoads(fixture.logPath), { timeout: startupTimeoutMs })
      .toBe(initialHistoryLoads + 1);
  } finally {
    await fixture.cleanup();
  }
}
