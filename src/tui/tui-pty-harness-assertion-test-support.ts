// Shared assertions and exercises for the fake-backend TUI PTY harness.
import { readFile } from "node:fs/promises";
import { expect } from "vitest";
import * as ansiSequences from "../../packages/terminal-core/src/ansi-sequences.js";
import * as ansi from "../../packages/terminal-core/src/ansi.js";
import { formatTuiFooter, sanitizeRenderableLine } from "./tui-formatters.js";
import { sleep, type PtyRun, waitFor } from "./tui-pty-test-support.js";

export type FixtureLogEntry = { method: string; payload?: unknown };

export const COMPACT_TERMINAL_SIZES = [
  [64, 18],
  [68, 18],
  [72, 20],
  [80, 20],
] as const;

export async function readFixtureLog(logPath: string): Promise<FixtureLogEntry[]> {
  try {
    const text = await readFile(logPath, "utf8");
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FixtureLogEntry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function waitForFixtureLogEntry(
  logPath: string,
  predicate: (entry: FixtureLogEntry) => boolean,
  timeoutMs: number,
  readPtyOutput?: () => string,
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const entries = await readFixtureLog(logPath);
    const match = entries.find(predicate);
    if (match) {
      return match;
    }
    await sleep(25);
  }
  const entries = await readFixtureLog(logPath);
  // A swallowed command leaves no RPC; its visible rejection survives only in the terminal.
  const ptyOutput = readPtyOutput?.() ?? "";
  throw new Error(
    `timed out waiting for fixture log entry\n${JSON.stringify(entries, null, 2)}\n${ptyOutput}`,
  );
}

export function objectFieldEquals(entry: FixtureLogEntry, field: string, value: unknown) {
  if (typeof entry.payload !== "object" || entry.payload === null) {
    return false;
  }
  const payload = entry.payload as Record<string, unknown>;
  return Object.hasOwn(payload, field) && payload[field] === value;
}

type StartTuiPtyFixture = Parameters<typeof exerciseFragmentedUnicodePrompt>[0];
type StartedTuiPtyFixture = Awaited<ReturnType<StartTuiPtyFixture>>;
type TerminalAttackPayload = {
  text: string;
  markers: string[];
  attacks: string[];
  expectedLine: string;
};

function buildCompactTerminalAttackPayload(tag: string, attack: string): TerminalAttackPayload {
  const markers = [`${tag}a`, `${tag}b`, `${tag}c`, `${tag}d`];
  const lineBreakAttack = `\r\n${markers[2]}`;
  const tabAttack = "\tשלום";
  return {
    text: `${markers[0]}${attack}${markers[1]} café 東京 👩🏽‍💻${lineBreakAttack} مرحبا${tabAttack} ${markers[3]}`,
    markers,
    attacks: [attack, lineBreakAttack, tabAttack],
    expectedLine: `${markers[0]}${markers[1]} café 東京 👩🏽‍💻 ${markers[2]} مرحبا שלום ${markers[3]}`,
  };
}

function buildInlineTerminalAttackPayload(tag: string, attack: string): TerminalAttackPayload {
  const markers = [`${tag}a`, `${tag}b`, `${tag}c`];
  return {
    text: `${markers[0]}${attack}${markers[1]} café 東京 👩🏽‍💻 مرحبا שלום ${markers[2]}`,
    markers,
    attacks: [attack],
    expectedLine: `${markers[0]}${markers[1]} café 東京 👩🏽‍💻 مرحبا שלום ${markers[2]}`,
  };
}

type TestScreen = {
  blankFrom: Array<number | undefined>;
  blankRowsFrom: number | null;
  col: number;
  row: number;
  rows: string[][];
  provenance: boolean[][];
};

type SynchronizedFrame = { cells: string[][]; provenance: boolean[][]; rows: string[] };

const STALE_CELL_SENTINEL = "\u0000";

function setCellProvenance(row: boolean[], start: number, end: number, current: boolean) {
  row.push(...Array(Math.max(0, end - row.length)).fill(false));
  row.fill(current, start, end);
}

function markBlankFrom(screen: TestScreen, row: number, col: number, current: boolean) {
  screen.blankFrom[row] = current ? Math.min(screen.blankFrom[row] ?? col, col) : undefined;
}

function assertEvidence(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function clearScreenCell(row: string[], provenance: boolean[], col: number, current: boolean) {
  let lead = col;
  while (lead > 0 && row[lead] === "") {
    lead -= 1;
  }
  const width = Math.max(1, ansi.visibleWidth(row[lead] ?? ""));
  setCellProvenance(provenance, lead, Math.min(row.length, lead + width), current);
  return row.fill(" ", lead, lead + width);
}

function writeScreenText(screen: TestScreen, text: string, synchronized: boolean) {
  for (const part of text.split(/([\b\r\n\t])/u)) {
    if (part === "\r") {
      screen.col = 0;
    } else if (part === "\n") {
      screen.row += 1;
    } else if (part === "\t") {
      screen.col = Math.floor(screen.col / 8 + 1) * 8;
    } else if (part === "\b") {
      screen.col = Math.max(0, screen.col - 1);
    } else {
      for (const grapheme of ansi.splitGraphemes(part)) {
        if (ansi.sanitizeForLog(grapheme) !== grapheme) {
          throw new Error("unsupported terminal control in TUI PTY evidence");
        }
        const row = (screen.rows[screen.row] ??= []);
        if (/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(grapheme)) {
          continue;
        }
        const width = ansi.visibleWidth(grapheme);
        const provenance = (screen.provenance[screen.row] ??= []);
        const gapStart = row.length;
        row.push(...Array(Math.max(0, screen.col - row.length)).fill(" "));
        provenance.push(...Array(Math.max(0, row.length - provenance.length)).fill(false));
        const from = screen.blankRowsFrom;
        const blankFrom = from !== null && screen.row >= from ? 0 : screen.blankFrom[screen.row];
        if (synchronized && blankFrom !== undefined) {
          setCellProvenance(provenance, Math.max(gapStart, blankFrom), row.length, true);
        }
        for (let col = screen.col; col < screen.col + width; col += 1) {
          clearScreenCell(row, provenance, col, synchronized);
        }
        row[screen.col] = grapheme;
        row.splice(screen.col + 1, Math.max(0, width - 1), ...Array(width - 1).fill(""));
        setCellProvenance(provenance, screen.col, screen.col + width, synchronized);
        screen.col += width;
      }
    }
  }
}

const lifecycleCsiBody = /^(?:\?25[hl]|\?2004[hl]|>7u|\?u|c|<u|>4;[02]m)$/u;

function assertAllowedCsi(value: string, controls: string[] = []) {
  const body = value.startsWith("\x1b[") ? value.slice(2) : "";
  const move = body.match(/^([1-9]\d*)?([ABG])$/u);
  const moveCount = Number(move?.[1] ?? "1");
  const allowed =
    controls.length === 0 &&
    ((move !== null && Number.isSafeInteger(moveCount) && moveCount <= 10_000) ||
      value === "\x1b[H" ||
      /^(?:0|2|3)?J$/u.test(body) ||
      /^(?:0|2)?K$/u.test(body) ||
      lifecycleCsiBody.test(body) ||
      value === "\x1b[?2026h" ||
      value === "\x1b[?2026l" ||
      /^(?:\d+(?:;\d+)*)?m$/u.test(body));
  assertEvidence(allowed, `unsupported CSI in TUI PTY evidence: ${JSON.stringify(value)}`);
}

function applyScreenCsi(screen: TestScreen, value: string, synchronized: boolean) {
  if (synchronized && lifecycleCsiBody.test(value.slice(2))) {
    throw new Error(`lifecycle CSI inside synchronized frame: ${JSON.stringify(value)}`);
  }
  const final = value.at(-1) ?? "";
  const param = value.slice(2, -1);
  const count = Number(param || "1");
  if (final === "A") {
    screen.row = Math.max(0, screen.row - count);
  } else if (final === "B") {
    screen.row += count;
  } else if (final === "G") {
    screen.col = count - 1;
  } else if (value === "\x1b[H") {
    screen.row = 0;
    screen.col = 0;
  } else if (final === "J") {
    const mode = Number(param || "0");
    if (mode === 0) {
      const row = (screen.rows[screen.row] ??= []);
      const provenance = (screen.provenance[screen.row] ??= []);
      clearScreenCell(row, provenance, screen.col, synchronized);
      row.splice(screen.col);
      provenance.splice(screen.col);
      screen.rows.length = screen.row + 1;
      screen.provenance.length = screen.rows.length;
      markBlankFrom(screen, screen.row, screen.col, synchronized);
      screen.blankRowsFrom = synchronized
        ? Math.min(screen.blankRowsFrom ?? screen.rows.length, screen.rows.length)
        : null;
    } else if (mode === 2) {
      screen.rows = [];
      screen.provenance = [];
      screen.blankFrom = [];
      screen.blankRowsFrom = synchronized ? 0 : null;
    }
  } else if (final === "K") {
    const row = (screen.rows[screen.row] ??= []);
    const provenance = (screen.provenance[screen.row] ??= []);
    const mode = Number(param || "0");
    if (mode === 0) {
      clearScreenCell(row, provenance, screen.col, synchronized);
      row.splice(screen.col);
      provenance.splice(screen.col);
      markBlankFrom(screen, screen.row, screen.col, synchronized);
    } else if (mode === 2) {
      screen.rows[screen.row] = [];
      screen.provenance[screen.row] = [];
      markBlankFrom(screen, screen.row, 0, synchronized);
    }
  }
}

function scanOsc(raw: string, bodyStart: number) {
  const candidates: Array<[index: number, length: number]> = [
    [raw.indexOf("\x07", bodyStart), 1],
    [raw.indexOf("\x1b\\", bodyStart), 2],
    [raw.indexOf("\u009c", bodyStart), 1],
  ];
  const terminator = candidates
    .filter(([index]) => index >= 0)
    .toSorted(([left], [right]) => left - right)[0];
  if (!terminator) {
    return undefined;
  }
  const [index, length] = terminator;
  const body = raw.slice(bodyStart, index);
  if (raw[index] === "\u009c" || ansi.sanitizeForLog(body) !== body) {
    throw new Error("unsupported terminal control in TUI PTY OSC evidence");
  }
  return { body, end: index + length };
}

function assertAllowedOsc(body: string) {
  const target = body.startsWith("8;;") ? body.slice(3) : undefined;
  if (
    target === undefined ||
    (target !== "" &&
      (!/^https?:\/\/\S+$/u.test(target) ||
        ansi.sanitizeForLog(target) !== target ||
        !URL.canParse(target)))
  ) {
    throw new Error(`unsupported OSC in TUI PTY evidence: ${JSON.stringify(body)}`);
  }
  return target;
}

function terminalOutputIsComplete(raw: string) {
  const oscStart = Math.max(raw.lastIndexOf("\x1b]"), raw.lastIndexOf("\u009d"));
  if (oscStart >= 0 && !scanOsc(raw, oscStart + (raw[oscStart] === "\x1b" ? 2 : 1))) {
    return false;
  }
  const csiStart = Math.max(raw.lastIndexOf("\x1b["), raw.lastIndexOf("\u009b"));
  const csi = csiStart >= 0 ? ansiSequences.scanAnsiCsiAt(raw, csiStart) : undefined;
  return csi?.ended !== false && !raw.endsWith("\x1b");
}

function parseSynchronizedFrames(raw: string): SynchronizedFrame[] {
  const start = "\x1b[?2026h";
  const end = "\x1b[?2026l";
  const frames: SynchronizedFrame[] = [];
  const screen: TestScreen = {
    blankFrom: [],
    blankRowsFrom: null,
    col: 0,
    row: 0,
    rows: [],
    provenance: [],
  };
  let synchronized = false;
  let osc8Open = false;
  if (!terminalOutputIsComplete(raw)) {
    return frames;
  }
  for (const segment of ansiSequences.splitAnsiSegments(raw)) {
    if (segment.kind === "text") {
      writeScreenText(screen, segment.value, synchronized);
    } else if (segment.controls.length > 0 || !segment.value.startsWith("\x1b")) {
      throw new Error("unsupported terminal sequence in TUI PTY evidence");
    } else if (segment.value === start) {
      assertEvidence(!synchronized, "nested synchronized frame");
      synchronized = true;
      screen.provenance = screen.rows.map((row) => Array(row.length).fill(false));
      screen.blankFrom = [];
      screen.blankRowsFrom = null;
    } else if (segment.value === end) {
      assertEvidence(synchronized, "unmatched synchronized frame end");
      assertEvidence(!osc8Open, "unclosed OSC 8 hyperlink in synchronized frame");
      const cells = screen.rows.map((row) => [...row]);
      frames.push({
        cells,
        provenance: cells.map((row, rowIndex) =>
          row.map((_, colIndex) => screen.provenance[rowIndex]?.[colIndex] === true),
        ),
        rows: cells.map((row) => row.join("").trimEnd()),
      });
      synchronized = false;
    } else if (segment.value.startsWith("\x1b]")) {
      const target = assertAllowedOsc(
        segment.value.slice(2, segment.value.endsWith("\x1b\\") ? -2 : -1),
      );
      assertEvidence(synchronized || target === "", "OSC 8 open outside synchronized frame");
      if (!synchronized) {
        continue;
      }
      assertEvidence(
        target === "" || !osc8Open,
        "unbalanced OSC 8 hyperlink in synchronized frame",
      );
      osc8Open = target !== "";
    } else if (segment.value.startsWith("\x1b[")) {
      assertAllowedCsi(segment.value, segment.controls);
      applyScreenCsi(screen, segment.value, synchronized);
    } else {
      throw new Error(`unsupported ESC sequence in TUI PTY evidence: ${segment.value}`);
    }
  }
  return synchronized || osc8Open ? [] : frames;
}

export function synchronizedFrameRows(raw: string): string[][] {
  return parseSynchronizedFrames(raw).map((frame) => frame.rows);
}

function latestFrameHasRow(raw: string, predicate: (row: string) => boolean) {
  const frame = parseSynchronizedFrames(raw).at(-1);
  return (
    frame?.cells.some((cells, rowIndex) => {
      const provenance = frame.provenance[rowIndex] ?? [];
      const authoredRow = cells
        .map((cell, colIndex) => (cell === "" || provenance[colIndex] ? cell : STALE_CELL_SENTINEL))
        .join("")
        .trimEnd();
      return predicate(authoredRow);
    }) ?? false
  );
}

export function hasSynchronizedFrameRow(raw: string, markers: string[], expectedText: string) {
  return latestFrameHasRow(
    raw,
    (row) =>
      !row.includes("\t") &&
      markers.every((marker) => row.includes(marker)) &&
      row.includes(expectedText),
  );
}

async function assertTerminalAttackSanitized(
  fixture: StartedTuiPtyFixture,
  payload: TerminalAttackPayload,
  timeoutMs: number,
) {
  const observed = await fixture.run.waitForOutput(payload.markers.at(-1) ?? "", timeoutMs);
  const visible = fixture.run.visibleOutput();
  expect(payload.markers.every((marker) => visible.includes(marker))).toBe(true);
  if (!hasSynchronizedFrameRow(observed, payload.markers, payload.expectedLine)) {
    await waitFor({
      timeoutMs,
      read: () => {
        const output = fixture.run.output();
        return hasSynchronizedFrameRow(output, payload.markers, payload.expectedLine)
          ? output
          : null;
      },
      onTimeout: () => new Error(`expected completed synchronized row\n${fixture.run.output()}`),
    });
  }
  const raw = fixture.run.output();
  for (const attack of payload.attacks) {
    expect(raw).not.toContain(attack);
  }
  expect(raw).not.toContain("\uFFFD");
}

async function assertTerminalAttackPrefixSanitized(
  fixture: StartedTuiPtyFixture,
  payload: TerminalAttackPayload,
  timeoutMs: number,
) {
  await fixture.run.waitForOutput(payload.markers[1] ?? "", timeoutMs);
  const visible = fixture.run.visibleOutput();
  expect(payload.markers.slice(0, 2).every((marker) => visible.includes(marker))).toBe(true);
  const raw = fixture.run.output();
  for (const attack of payload.attacks) {
    expect(raw).not.toContain(attack);
  }
  expect(
    hasSynchronizedFrameRow(
      raw,
      payload.markers.slice(0, 2),
      `${payload.markers[0]}${payload.markers[1]}`,
    ),
  ).toBe(true);
  expect(raw).not.toContain("\uFFFD");
}

function hasStatusFrame(raw: string, markers: string[], status: RegExp) {
  return latestFrameHasRow(
    raw,
    (row) => markers.every((marker) => row.includes(marker)) && status.test(row),
  );
}

async function exerciseSelectorOutputSafety(
  startFixture: StartTuiPtyFixture,
  startupTimeoutMs: number,
) {
  const modelValue = buildCompactTerminalAttackPayload("t08mv", "\x1b[777;888H");
  const modelName = buildCompactTerminalAttackPayload("t08mn", "\x1b]52;c;t08_model_clipboard\x07");
  const sessionTitle = buildCompactTerminalAttackPayload("t08st", "\x1b]0;t08_session_title\x07");
  const sessionPreview = buildCompactTerminalAttackPayload(
    "t08sp",
    "\u009d0;t08_session_preview\u009c",
  );
  const sessionDisplay = buildCompactTerminalAttackPayload("t08sd", "\x1b[777\u0001m");
  const sessionKey = buildCompactTerminalAttackPayload("t08sk", "\u009b777;888h");
  const selectedModel = `fixture-provider/${modelValue.text}`;
  const selectedSessionKey = `agent:main:${sessionKey.text}`;
  const fixture = await startFixture({
    env: {
      OPENCLAW_TUI_PTY_COLS: "240",
      OPENCLAW_TUI_PTY_ROWS: "24",
      OPENCLAW_TUI_PTY_MODEL: "fixture-provider/fixture-model",
      OPENCLAW_TUI_PTY_PICKER_FIXTURE: "1",
      OPENCLAW_TUI_PTY_PICKER_MODEL_VALUE: selectedModel,
      OPENCLAW_TUI_PTY_PICKER_MODEL_NAME: modelName.text,
      OPENCLAW_TUI_PTY_PICKER_SESSION_KEY: selectedSessionKey,
      OPENCLAW_TUI_PTY_PICKER_SESSION_TITLE: sessionTitle.text,
      OPENCLAW_TUI_PTY_PICKER_SESSION_PREVIEW: sessionPreview.text,
      OPENCLAW_TUI_PTY_PICKER_SESSION_DISPLAY_NAME: sessionDisplay.text,
    },
  });

  try {
    await fixture.run.waitForOutput("local ready", startupTimeoutMs);
    await fixture.run.write("\u000c", { delay: false });
    await fixture.waitForLogEntry((entry) => entry.method === "listModels");
    await assertTerminalAttackPrefixSanitized(fixture, modelValue, 5_000);
    await assertTerminalAttackPrefixSanitized(fixture, modelName, 5_000);

    await fixture.run.write("\x1b[B", { delay: false });
    await fixture.run.write("\r", { delay: false });
    const modelPatch = await fixture.waitForLogEntry(
      (entry) =>
        entry.method === "patchSession" && objectFieldEquals(entry, "model", selectedModel),
    );
    expect(modelPatch.payload).toMatchObject({ model: selectedModel });
    await fixture.run.waitForOutput(
      formatTuiFooter({
        agentLabel: `main (${sessionDisplay.text})`,
        sessionLabel: "main (Main)",
        sessionInfo: { model: selectedModel, contextTokens: 128 },
        deliver: false,
      }),
      5_000,
    );
    await assertTerminalAttackSanitized(fixture, modelValue, 5_000);

    await fixture.run.write("\u0010", { delay: false });
    await fixture.waitForLogEntry(
      (entry) => entry.method === "listSessions" && objectFieldEquals(entry, "purpose", "picker"),
    );
    await assertTerminalAttackPrefixSanitized(fixture, sessionTitle, 5_000);
    await assertTerminalAttackPrefixSanitized(fixture, sessionPreview, 5_000);

    await fixture.run.write("\x1b[B", { delay: false });
    await fixture.run.write("\r", { delay: false });
    const historyLoad = await fixture.waitForLogEntry(
      (entry) =>
        entry.method === "loadHistory" &&
        objectFieldEquals(entry, "sessionKey", selectedSessionKey),
    );
    expect(historyLoad.payload).toMatchObject({ sessionKey: selectedSessionKey });
    await assertTerminalAttackSanitized(fixture, sessionKey, 5_000);
    const expectedAgentLabel = `main (${sessionDisplay.text})`;
    const expectedSessionLabel = `${sessionKey.text} (${sessionDisplay.text})`;
    await fixture.run.waitForOutput(
      sanitizeRenderableLine(
        `openclaw tui pty fixture - pty-fixture://local - agent ${expectedAgentLabel} - session ${sessionKey.text}`,
      ),
      5_000,
    );
    await fixture.run.waitForOutput(
      formatTuiFooter({
        agentLabel: expectedAgentLabel,
        sessionLabel: expectedSessionLabel,
        sessionInfo: { model: selectedModel, contextTokens: 128 },
        deliver: false,
      }),
      5_000,
    );
    await assertTerminalAttackSanitized(fixture, sessionDisplay, 5_000);
    expect(fixture.run.output()).not.toContain("\uFFFD");
  } finally {
    await fixture.cleanup();
  }
}

export async function exerciseNarrowTerminalRendering(
  startFixture: StartTuiPtyFixture,
  startupTimeoutMs: number,
) {
  const url =
    "https://example.test/tui/copy-safe/very-long-path/with-query?mode=narrow&value=alpha%20beta#proof";
  const message =
    "terminal rendering proof Long output must wrap across several narrow terminal rows without " +
    `losing text. Unicode stays intact: café 東京 👩🏽‍💻. Copy this URL exactly: ${url}`;
  const fixture = await startFixture({
    env: {
      OPENCLAW_TUI_PTY_COLS: "28",
      OPENCLAW_TUI_PTY_ROWS: "18",
      OPENCLAW_TUI_PTY_INITIAL_MESSAGE: message,
    },
  });

  try {
    await fixture.run.waitForOutput("PTY_RESPONSE: terminal rendering proof", startupTimeoutMs);
    await fixture.run.waitForOutput("café 東京 👩🏽‍💻", startupTimeoutMs);
    const sent = await fixture.waitForLogEntry(
      (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", message),
    );
    expect(sent.payload).toMatchObject({ message });
    const raw = fixture.run.output();
    expect(raw.split(`\x1b]8;;${url}\x07`).length - 1).toBeGreaterThan(1);
    expect(raw).not.toContain("\uFFFD");
  } finally {
    await fixture.cleanup();
  }
}

async function exerciseGatewayOutputSafety(
  startFixture: StartTuiPtyFixture,
  startupTimeoutMs: number,
) {
  const systemAttacks = [
    "\x1b[?7776h",
    "\x1b[777;887H",
    "\x1b]0;t08_system_title\x07",
    "\x1b]52;c;t08_system_clipboard\x07",
    "\u009b777;887H",
    "\u009d0;t08_system_c1\u009c",
  ];
  const idlePayload = buildCompactTerminalAttackPayload("T08I", "\x1b[?7775h");
  const fixture = await startFixture({
    env: {
      OPENCLAW_TUI_PTY_COLS: "120",
      OPENCLAW_TUI_PTY_ROWS: "18",
      OPENCLAW_TUI_PTY_GATEWAY_STATUS: systemAttacks.join(""),
      OPENCLAW_TUI_PTY_DISCONNECT_REASON: idlePayload.text,
    },
  });

  try {
    await fixture.run.waitForOutput("local ready", startupTimeoutMs);
    await fixture.run.write("/gateway-status\r", { delay: false });
    await fixture.waitForLogEntry((entry) => entry.method === "getGatewayStatus");
    await fixture.waitForLogEntry((entry) => entry.method === "disconnect");
    await fixture.run.waitForOutput("(no output)", startupTimeoutMs);
    await assertTerminalAttackSanitized(fixture, idlePayload, startupTimeoutMs);
    const raw = fixture.run.output();
    for (const attack of systemAttacks) {
      expect(raw).not.toContain(attack);
    }
    expect(hasStatusFrame(fixture.run.output(), idlePayload.markers, /\| idle/u)).toBe(true);

    const helpOffset = fixture.run.visibleOutput().length;
    await fixture.run.write("/help\r", { delay: false });
    await fixture.run.waitForOutput("Slash commands:", startupTimeoutMs);
    await fixture.run.waitForOutput("/exit", startupTimeoutMs);
    const helpOutput = fixture.run.visibleOutput().slice(helpOffset);
    expect(helpOutput).toContain("/help");
    expect(helpOutput).toContain("/exit");
  } finally {
    await fixture.cleanup();
  }
}

async function exerciseMarkdownAndAutocompleteOutputSafety(
  startFixture: StartTuiPtyFixture,
  startupTimeoutMs: number,
) {
  const inFlight = buildInlineTerminalAttackPayload("T08F", "\x1b]52;c;t08_inflight\x07");
  const command = buildCompactTerminalAttackPayload("T08C", "\u009d0;t08_command\u009c");
  const thinking = buildCompactTerminalAttackPayload("T08L", "\x1b[777;886H");
  const fixture = await startFixture({
    env: {
      OPENCLAW_TUI_PTY_COLS: "140",
      OPENCLAW_TUI_PTY_DYNAMIC_COMMAND_DESCRIPTION: command.text,
      OPENCLAW_TUI_PTY_IN_FLIGHT_TEXT: `**${inFlight.text}** [copy-safe](https://example.test/t08-inflight)`,
      OPENCLAW_TUI_PTY_ROWS: "22",
      OPENCLAW_TUI_PTY_SAFE_THINKING_LABEL: "T08_SAFE_THINKING",
      OPENCLAW_TUI_PTY_THINKING_LABEL: thinking.text,
    },
  });

  try {
    await fixture.run.waitForOutput("local ready", startupTimeoutMs);
    await fixture.waitForLogEntry((entry) => entry.method === "listCommands");
    const inFlightAssertion = assertTerminalAttackSanitized(fixture, inFlight, 5_000);
    await fixture.run.write("\x14", { delay: false });
    await inFlightAssertion;

    await fixture.run.write("/t08d", { delay: false });
    const commandAssertion = assertTerminalAttackSanitized(fixture, command, 5_000);
    await fixture.run.write("\x14", { delay: false });
    await commandAssertion;

    await fixture.run.write("\x1b", { delay: false });
    await sleep(50);
    await fixture.run.write("\x15", { delay: false });
    await sleep(50);
    await fixture.run.write("/think ", { delay: false });
    await fixture.run.waitForOutput("T08_SAFE_THINKING", 5_000);
    const raw = fixture.run.output();
    expect(thinking.markers.some((marker) => raw.includes(marker))).toBe(false);
    expect(thinking.attacks.some((attack) => raw.includes(attack))).toBe(false);
  } finally {
    await fixture.cleanup();
  }
}

async function exerciseInteractiveOutputSafety(
  startFixture: StartTuiPtyFixture,
  startupTimeoutMs: number,
) {
  const btwPayload = buildCompactTerminalAttackPayload("T08B", "\u009b776;889H");
  const rawToolPayload = buildCompactTerminalAttackPayload("T08T", "\x1b]0;t08_tool_title\x07");
  const toolPayload = {
    ...rawToolPayload,
    expectedLine: rawToolPayload.expectedLine.replace("café", "Café"),
  };
  const fixture = await startFixture({
    env: {
      OPENCLAW_TUI_PTY_BTW_QUESTION: btwPayload.text,
      OPENCLAW_TUI_PTY_COLS: "120",
      OPENCLAW_TUI_PTY_MODEL: "fixture-provider/fixture-model",
      OPENCLAW_TUI_PTY_ROWS: "20",
      OPENCLAW_TUI_PTY_TOOL_NAME: toolPayload.text,
      OPENCLAW_TUI_PTY_VERBOSE_LEVEL: "on",
    },
  });

  try {
    await fixture.run.waitForOutput("local ready", startupTimeoutMs);
    await fixture.run.write("/btw picker focus proof\r", { delay: false });
    await fixture.waitForLogEntry((entry) => entry.method === "pickerSideResult");
    await assertTerminalAttackSanitized(fixture, btwPayload, startupTimeoutMs);
    await fixture.run.write("\r", { delay: false });
    await sleep(25);

    await fixture.run.write("tool chronology proof\r", { delay: false });
    await fixture.waitForLogEntry((entry) => entry.method === "toolChronologyComplete");
    await assertTerminalAttackSanitized(fixture, toolPayload, startupTimeoutMs);
    await fixture.run.waitForOutput("PTY_AFTER_TOOL", startupTimeoutMs);
  } finally {
    await fixture.cleanup();
  }
}

export async function exerciseTerminalOutputSafety(
  startFixture: StartTuiPtyFixture,
  startupTimeoutMs: number,
) {
  await Promise.all([
    exerciseGatewayOutputSafety(startFixture, startupTimeoutMs),
    exerciseInteractiveOutputSafety(startFixture, startupTimeoutMs),
    exerciseMarkdownAndAutocompleteOutputSafety(startFixture, startupTimeoutMs),
    exerciseSelectorOutputSafety(startFixture, startupTimeoutMs),
  ]);
}

/** Proves fixture-local fragmentation preserves a Unicode prompt through the real TUI loop. */
export async function exerciseFragmentedUnicodePrompt(
  startFixture: (opts: { env?: NodeJS.ProcessEnv }) => Promise<{
    run: PtyRun;
    waitForLogEntry: (predicate: (entry: FixtureLogEntry) => boolean) => Promise<FixtureLogEntry>;
    cleanup: () => Promise<void>;
  }>,
  startupTimeoutMs: number,
) {
  const fixture = await startFixture({
    env: { OPENCLAW_TUI_PTY_TYPE_CHUNK_SIZE: "1", OPENCLAW_TUI_PTY_TYPE_DELAY_MS: "1" },
  });
  const message = "hello 👋 from pty";

  try {
    await fixture.run.waitForOutput("local ready", startupTimeoutMs);
    await fixture.run.write(`${message}\r`);
    await fixture.run.waitForOutput(`PTY_RESPONSE: ${message}`);
    await fixture.waitForLogEntry(
      (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", message),
    );
  } finally {
    await fixture.cleanup();
  }
}

/** Approves a workspace skill using exact fragments that survive narrow-terminal wrapping. */
export async function approveWorkspaceSkill(
  fixture: {
    run: PtyRun;
    waitForLogEntry: (predicate: (entry: FixtureLogEntry) => boolean) => Promise<FixtureLogEntry>;
  },
  message: string,
) {
  await fixture.run.write(`${message}\r`);
  await fixture.run.waitForOutput("workspace skill approval: Apply workspace skill proposal");
  await fixture.run.waitForOutput("Plugin: workspace-skills");
  // A compact PTY wraps the request; exact fragments avoid matching across terminal redraws.
  await fixture.run.waitForOutput("Apply a pending workspace skill proposal");
  await fixture.run.waitForOutput("into live workspace");
  await fixture.run.waitForOutput("skills.");

  await fixture.run.write("\x1b[A", { delay: false });
  await fixture.run.write("\r");
  await fixture.waitForLogEntry(
    (entry) =>
      entry.method === "resolvePluginApproval" &&
      objectFieldEquals(entry, "decision", "allow-once"),
  );
  await fixture.run.waitForOutput("PTY_SKILL_APPROVAL_RESOLVED: allow-once");
}
