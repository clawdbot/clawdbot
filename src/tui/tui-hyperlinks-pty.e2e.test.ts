import { expect, it } from "vitest";
import { splitAnsiSegments } from "../../packages/terminal-core/src/ansi-sequences.js";
import {
  objectFieldEquals,
  startTuiFixture,
  waitForSynchronizedFrameRows,
} from "./tui-pty-harness-fixture-test-support.js";

function linkedText(output: string) {
  let target = "";
  const spans: Array<{ target: string; text: string }> = [];
  for (const segment of splitAnsiSegments(output)) {
    if (segment.kind === "ansi") {
      if (segment.value.startsWith("\x1b]8;;")) {
        const terminatorLength = segment.value.endsWith("\x1b\\") ? 2 : 1;
        target = segment.value.slice(5, -terminatorLength);
      }
    } else if (target) {
      spans.push({ target, text: segment.value });
    }
  }
  return spans;
}

it.each([
  { label: "VS Code", termProgram: "vscode", cols: 100, labelPath: "label" },
  {
    label: "wrapped VS Code",
    termProgram: "vscode",
    cols: 36,
    labelPath: "label/with/a/long/path",
  },
  { label: "unidentified terminal", termProgram: "", cols: 36, labelPath: "label" },
])(
  "preserves authored link targets in $label",
  async ({ label, termProgram, cols, labelPath }) => {
    const target = "https://example.test/actual-destination";
    const plainTarget = "https://example.test/documentation";
    const visibleUrl = `https://example.test/${labelPath}`;
    const message = `[${visibleUrl}](${target}) and [Documentation](${plainTarget})`;
    const fixture = await startTuiFixture({
      env: {
        TERM_PROGRAM: termProgram,
        TMUX: undefined,
        KITTY_WINDOW_ID: undefined,
        GHOSTTY_RESOURCES_DIR: undefined,
        WEZTERM_PANE: undefined,
        ITERM_SESSION_ID: undefined,
        WT_SESSION: undefined,
        WARP_SESSION_ID: undefined,
        WARP_TERMINAL_SESSION_UUID: undefined,
        TERMINAL_EMULATOR: undefined,
        OPENCLAW_TUI_PTY_COLS: String(cols),
        OPENCLAW_TUI_PTY_ROWS: "30",
      },
    });
    try {
      await fixture.run.waitForOutput("local ready", 20_000);
      await fixture.run.write(`${message}\r`, { delay: false });
      await fixture.waitForLogEntry(
        (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", message),
      );
      await fixture.run.waitForOutput("PTY_RESPONSE:", 20_000);
      const raw = fixture.run.output();
      const response = raw.slice(raw.lastIndexOf("PTY_RESPONSE:"));
      const links = linkedText(response);
      console.log(
        `[behavior-evidence] ${JSON.stringify({
          label,
          columns: cols,
          links,
          terminal: "real PTY",
        })}`,
      );
      if (termProgram) {
        expect(links.filter((span) => span.target === visibleUrl)).toEqual([]);
        if (visibleUrl.length > cols) {
          expect(links.filter((span) => span.target === target).length).toBeGreaterThan(1);
        }
        expect(
          links
            .filter((span) => span.target === target)
            .map((span) => span.text)
            .join(""),
        ).toContain(visibleUrl);
        expect(
          links
            .filter((span) => span.target === plainTarget)
            .map((span) => span.text)
            .join(""),
        ).toContain("Documentation");
      } else {
        expect(links.some((span) => span.target === target)).toBe(true);
        expect(links.some((span) => span.target === plainTarget)).toBe(true);
      }
      const rows = await waitForSynchronizedFrameRows(
        fixture.run,
        (frame) =>
          frame.some((row) => row.includes("PTY_RESPONSE:")) &&
          frame.some((row) => row.includes("idle")),
        20_000,
      );
      console.log(`[terminal-frame] ${JSON.stringify({ label, columns: cols, rows })}`);
      await fixture.run.write("/exit\r", { delay: false });
      expect((await fixture.run.waitForExit()).exitCode).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  },
  30_000,
);
