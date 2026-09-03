import { expect, it } from "vitest";
import {
  objectFieldEquals,
  startTuiFixture,
  waitForSynchronizedFrameRows,
} from "./tui-pty-harness-fixture-test-support.js";

const cancelKeys = [
  { key: "\x1b", name: "Escape" },
  { key: "\u0003", name: "Ctrl+C" },
  { key: "\x1b[99;5u", name: "Kitty Ctrl+C" },
  { key: "\x1b[27;5;99~", name: "modifyOtherKeys Ctrl+C" },
];

it.each(
  ["/models", "/sessions"].flatMap((command) =>
    cancelKeys.map(({ key, name }) => ({ command, key, name })),
  ),
)(
  "returns to chat from $command with $name",
  async ({ command, key, name }) => {
    const fixture = await startTuiFixture({
      env: {
        TERM_PROGRAM: "vscode",
        TMUX: undefined,
        KITTY_WINDOW_ID: undefined,
        GHOSTTY_RESOURCES_DIR: undefined,
        WEZTERM_PANE: undefined,
        ITERM_SESSION_ID: undefined,
        WT_SESSION: undefined,
        WARP_SESSION_ID: undefined,
        WARP_TERMINAL_SESSION_UUID: undefined,
        TERMINAL_EMULATOR: undefined,
        OPENCLAW_TUI_PTY_PICKER_FIXTURE: "1",
        OPENCLAW_TUI_PTY_COLS: "100",
        OPENCLAW_TUI_PTY_ROWS: "30",
      },
    });
    const waitForRows = (predicate: Parameters<typeof waitForSynchronizedFrameRows>[1]) =>
      waitForSynchronizedFrameRows(fixture.run, predicate, 20_000);
    try {
      await fixture.run.waitForOutput("local ready", 20_000);
      if (name === "Kitty Ctrl+C") {
        await fixture.run.write("\x1b[?1u", { delay: false });
      }
      await fixture.run.write(command + "\r", { delay: false });
      const prompt = command === "/sessions" ? "Filter:" : "search:";
      await waitForRows((rows) => rows.some((row) => row.trimStart().startsWith(prompt)));
      await fixture.run.write("missing", { delay: false });
      const filtered = await waitForRows((rows) =>
        rows.some((row) => row.includes(prompt) && row.includes("missing")),
      );
      console.log(
        "[picker-frame] " + JSON.stringify({ command, name, phase: "filtered", rows: filtered }),
      );
      await fixture.run.write(key, { delay: false });
      if (key === "\x1b") {
        // Let the terminal disambiguate lone Escape before sending printable input.
        await waitForRows((rows) =>
          command === "/sessions"
            ? rows.some((row) => row.trim() === "Filter: >")
            : !rows.some((row) => row.trimStart().startsWith(prompt)),
        );
      }

      if (command === "/sessions") {
        await fixture.run.write("Picker", { delay: false });
        const cleared = await waitForRows((rows) =>
          rows.some((row) => row.includes(prompt) && row.includes("Picker")),
        );
        console.log(
          "[picker-frame] " +
            JSON.stringify({ command, name, phase: "clear-first", rows: cleared }),
        );
        expect(cleared.some((row) => row.trim() === "Filter: > Picker")).toBe(true);
        expect(cleared.some((row) => row.includes("No match"))).toBe(false);
        await fixture.run.write(key, { delay: false });
        await waitForRows((rows) => rows.some((row) => row.trim() === "Filter: >"));
        await fixture.run.write(key, { delay: false });
        if (key === "\x1b") {
          await waitForRows((rows) => !rows.some((row) => row.trimStart().startsWith(prompt)));
        }
      }

      const message = "picker cancel proof";
      await fixture.run.write(message + "\r", { delay: false });
      const rows = await waitForRows((frame) =>
        frame.some(
          (row) =>
            row.includes("PTY_RESPONSE: " + message) ||
            (row.includes(prompt) && row.includes(message)),
        ),
      );
      console.log("[picker-frame] " + JSON.stringify({ command, name, phase: "chat", rows }));
      expect(rows.some((row) => row.includes("PTY_RESPONSE: " + message))).toBe(true);
      expect(rows.some((row) => row.trimStart().startsWith(prompt))).toBe(false);
      await fixture.waitForLogEntry(
        (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", message),
      );
      await fixture.run.write("/exit\r", { delay: false });
      expect((await fixture.run.waitForExit()).exitCode).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  },
  30_000,
);
