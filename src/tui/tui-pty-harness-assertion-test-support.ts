// Shared assertions and exercises for the fake-backend TUI PTY harness.
import { readFile } from "node:fs/promises";
import { expect } from "vitest";
import * as ansiSequences from "../../packages/terminal-core/src/ansi-sequences.js";
import * as ansi from "../../packages/terminal-core/src/ansi.js";
import { sleep } from "../utils/sleep.js";
import { formatTuiFooter, sanitizeRenderableLine } from "./tui-formatters.js";
import {
  PtyTestScreen,
  type PtyRun,
  type PtyTerminalDimensions,
  waitFor,
} from "./tui-pty-test-support.js";

export type FixtureLogEntry = { method: string; payload?: unknown };
type FixtureLogPredicate = (entry: FixtureLogEntry) => boolean;

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
  predicate: FixtureLogPredicate,
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

type StartedTuiPtyFixture = {
  run: PtyRun;
  logPath: string;
  waitForLogEntry: (predicate: FixtureLogPredicate, timeoutMs?: number) => Promise<FixtureLogEntry>;
  cleanup: () => Promise<void>;
};
type TuiPtyFixtureOptions = { env?: NodeJS.ProcessEnv };
export type StartTuiPtyFixture = (opts?: TuiPtyFixtureOptions) => Promise<StartedTuiPtyFixture>;
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

const STALE_CELL_SENTINEL = "\u0000";

function assertEvidence(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

const lifecycleCsiBody = /^(?:\?25[hl]|\?2004[hl]|>7u|\?u|c|<u|>4;[02]m)$/u;
const screenMutationCsiBody = /^(?:[02]?J|[02]?K)$/u;

function assertAllowedCsi(screen: PtyTestScreen, value: string, controls: string[] = []) {
  const body = value.startsWith("\x1b[") ? value.slice(2) : "";
  const move = body.match(/^([1-9]\d*)?([ABG])$/u);
  const moveCount = Number(move?.[1] ?? "1");
  const allowed =
    controls.length === 0 &&
    ((move !== null &&
      Number.isSafeInteger(moveCount) &&
      moveCount <= Math.max(screen.cols, screen.rows)) ||
      value === "\x1b[H" ||
      /^(?:0|2|3)?J$/u.test(body) ||
      /^(?:0|2)?K$/u.test(body) ||
      lifecycleCsiBody.test(body) ||
      value === "\x1b[?2026h" ||
      value === "\x1b[?2026l" ||
      /^(?:\d+(?:;\d+)*)?m$/u.test(body));
  assertEvidence(allowed, `unsupported CSI in TUI PTY evidence: ${JSON.stringify(value)}`);
}

function applyScreenCsi(screen: PtyTestScreen, value: string, synchronized: boolean) {
  if (synchronized && lifecycleCsiBody.test(value.slice(2))) {
    throw new Error(`lifecycle CSI inside synchronized frame: ${JSON.stringify(value)}`);
  }
  screen.applyCsi(value, synchronized);
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

type TerminalReplay = {
  completedFrame: boolean;
  matchedFrame: boolean;
  osc8Open: boolean;
  screen: PtyTestScreen;
  synchronized: boolean;
};

function replayTerminalState(
  raw: string,
  dimensions: PtyTerminalDimensions,
  framePredicate?: (screen: PtyTestScreen) => boolean,
): TerminalReplay | undefined {
  const start = "\x1b[?2026h";
  const end = "\x1b[?2026l";
  const screen = new PtyTestScreen(dimensions);
  let completedFrame = false;
  let matchedFrame = false;
  let synchronized = false;
  let osc8Open = false;
  if (!terminalOutputIsComplete(raw)) {
    return undefined;
  }
  for (const segment of ansiSequences.splitAnsiSegments(raw)) {
    if (segment.kind === "text") {
      // pi-tui expands visible tabs and does not use literal HT/BS for output layout.
      // Captured HT/BS bytes are invalid evidence, not terminal operations to replay.
      if (segment.value.includes("\t") || segment.value.includes("\b")) {
        return undefined;
      }
      if (!synchronized && completedFrame && segment.value) {
        completedFrame = false;
      }
      screen.write(segment.value, synchronized);
    } else if (segment.controls.length > 0 || !segment.value.startsWith("\x1b")) {
      throw new Error("unsupported terminal sequence in TUI PTY evidence");
    } else if (segment.value === start) {
      assertEvidence(!synchronized, "nested synchronized frame");
      completedFrame = false;
      synchronized = true;
    } else if (segment.value === end) {
      assertEvidence(synchronized, "unmatched synchronized frame end");
      assertEvidence(!osc8Open, "unclosed OSC 8 hyperlink in synchronized frame");
      synchronized = false;
      completedFrame = true;
      matchedFrame ||= framePredicate?.(screen) ?? false;
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
      assertAllowedCsi(screen, segment.value, segment.controls);
      if (!synchronized && completedFrame && screenMutationCsiBody.test(segment.value.slice(2))) {
        completedFrame = false;
      }
      applyScreenCsi(screen, segment.value, synchronized);
    } else {
      throw new Error(`unsupported ESC sequence in TUI PTY evidence: ${segment.value}`);
    }
  }
  return { completedFrame, matchedFrame, osc8Open, screen, synchronized };
}

function parseTerminalState(
  raw: string,
  dimensions: PtyTerminalDimensions,
): PtyTestScreen | undefined {
  const replay = replayTerminalState(raw, dimensions);
  return replay && !replay.synchronized && !replay.osc8Open && replay.completedFrame
    ? replay.screen
    : undefined;
}

function authenticatedRowText(cells: PtyTestScreen["cells"][number]) {
  return cells
    .slice(0, cells.findLastIndex((cell) => cell.authenticated) + 1)
    .map((cell) => (cell.text === "" || cell.authenticated ? cell.text : STALE_CELL_SENTINEL))
    .join("")
    .trimEnd();
}

export function synchronizedFrameRows(raw: string, dimensions: PtyTerminalDimensions): string[][] {
  const screen = parseTerminalState(raw, dimensions);
  if (!screen) {
    return [];
  }
  const rows = screen.cells.map(authenticatedRowText);
  while (rows.length > 1 && rows.at(-1) === "") {
    rows.pop();
  }
  return [rows];
}

export async function waitForSynchronizedFrameRows(
  run: PtyRun,
  predicate: (rows: string[]) => boolean,
  timeoutMs: number,
) {
  return await waitFor({
    timeoutMs,
    read: () => {
      const rows = synchronizedFrameRows(run.output(), run).at(0);
      return rows && predicate(rows) ? rows : null;
    },
    onTimeout: () => new Error(`expected completed synchronized frame\n${run.output()}`),
  });
}

function screenHasRow(screen: PtyTestScreen, predicate: (row: string) => boolean) {
  return screen.cells.some((cells) => predicate(authenticatedRowText(cells)));
}

function latestFrameHasRow(
  raw: string,
  dimensions: PtyTerminalDimensions,
  predicate: (row: string) => boolean,
) {
  const screen = parseTerminalState(raw, dimensions);
  return screen ? screenHasRow(screen, predicate) : false;
}

function terminalAttackRowMatches(markers: string[], expectedText: string, row: string) {
  return markers.every((marker) => row.includes(marker)) && row.includes(expectedText);
}

export function hasSynchronizedFrameRow(
  raw: string,
  markers: string[],
  expectedText: string,
  dimensions: PtyTerminalDimensions,
) {
  return latestFrameHasRow(raw, dimensions, (row) =>
    terminalAttackRowMatches(markers, expectedText, row),
  );
}

export function hasHistoricalSynchronizedFrameRow(
  raw: string,
  markers: string[],
  expectedText: string,
  dimensions: PtyTerminalDimensions,
) {
  const replay = replayTerminalState(raw, dimensions, (screen) =>
    screenHasRow(screen, (row) => terminalAttackRowMatches(markers, expectedText, row)),
  );
  return replay !== undefined && !replay.synchronized && !replay.osc8Open && replay.matchedFrame;
}

async function assertTerminalAttackSanitized(
  fixture: StartedTuiPtyFixture,
  payload: TerminalAttackPayload,
  timeoutMs: number,
) {
  const observed = await fixture.run.waitForOutput(payload.markers.at(-1) ?? "", timeoutMs);
  const visible = fixture.run.visibleOutput();
  expect(payload.markers.every((marker) => visible.includes(marker))).toBe(true);
  if (!hasSynchronizedFrameRow(observed, payload.markers, payload.expectedLine, fixture.run)) {
    await waitFor({
      timeoutMs,
      read: () => {
        const output = fixture.run.output();
        return hasSynchronizedFrameRow(output, payload.markers, payload.expectedLine, fixture.run)
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

async function assertHistoricalTerminalAttackSanitized(
  fixture: StartedTuiPtyFixture,
  payload: TerminalAttackPayload,
  markers: string[],
  expectedText: string,
  timeoutMs: number,
) {
  const observed = await fixture.run.waitForOutput(markers.at(-1) ?? "", timeoutMs);
  const matchesHistoricalFrame = (raw: string) =>
    hasHistoricalSynchronizedFrameRow(raw, markers, expectedText, fixture.run);
  const raw = matchesHistoricalFrame(observed)
    ? observed
    : await waitFor({
        timeoutMs,
        read: () => {
          const output = fixture.run.output();
          return matchesHistoricalFrame(output) ? output : null;
        },
        onTimeout: () =>
          new Error(`expected historical completed synchronized row\n${fixture.run.output()}`),
      });
  const visible = fixture.run.visibleOutput();
  expect(markers.every((marker) => visible.includes(marker))).toBe(true);
  for (const attack of payload.attacks) {
    expect(raw).not.toContain(attack);
  }
  expect(matchesHistoricalFrame(raw)).toBe(true);
  expect(raw).not.toContain("\uFFFD");
}

async function assertTerminalAttackPrefixSanitized(
  fixture: StartedTuiPtyFixture,
  payload: TerminalAttackPayload,
  timeoutMs: number,
) {
  const markers = payload.markers.slice(0, 2);
  await assertHistoricalTerminalAttackSanitized(
    fixture,
    payload,
    markers,
    markers.join(""),
    timeoutMs,
  );
}

function hasStatusFrame(
  raw: string,
  markers: string[],
  status: RegExp,
  dimensions: PtyTerminalDimensions,
) {
  return latestFrameHasRow(
    raw,
    dimensions,
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
    expect(hasStatusFrame(fixture.run.output(), idlePayload.markers, /\| idle/u, fixture.run)).toBe(
      true,
    );

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
    const inFlightAssertion = assertHistoricalTerminalAttackSanitized(
      fixture,
      inFlight,
      inFlight.markers,
      inFlight.expectedLine,
      5_000,
    );
    await fixture.run.write("\x14", { delay: false });
    await inFlightAssertion;

    await fixture.run.write("/t08d", { delay: false });
    const commandAssertion = assertHistoricalTerminalAttackSanitized(
      fixture,
      command,
      command.markers,
      command.expectedLine,
      5_000,
    );
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
  startFixture: StartTuiPtyFixture,
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
