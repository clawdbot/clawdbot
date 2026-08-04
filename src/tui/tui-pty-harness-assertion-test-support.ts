// Shared assertions and exercises for the fake-backend TUI PTY harness.
import { readFile } from "node:fs/promises";
import { expect } from "vitest";
import { sleep, type PtyRun } from "./tui-pty-test-support.js";

export type FixtureLogEntry = {
  method: string;
  payload?: unknown;
};

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
type TerminalAttackPayload = { text: string; markers: string[]; attacks: string[] };

function buildTerminalAttackPayload(tag: string): TerminalAttackPayload {
  const attacks = [
    "\x1b[38;5;201m",
    "\x1b[3J",
    `\x1b]0;${tag}_OSC_TITLE_PAYLOAD\x07`,
    `\x1b]52;c;${tag}_OSC52_PAYLOAD\x07`,
    "\u009b3J",
    `\u009d0;${tag}_C1_TITLE_PAYLOAD\u009c`,
  ];
  const markers = Array.from(
    { length: 14 },
    (_, index) => `${tag}${index.toString(16).toUpperCase()}`,
  );
  return {
    text: [
      markers[0],
      ...attacks.map(
        (attack, index) => `${markers[index * 2 + 1]}${attack}${markers[index * 2 + 2]}`,
      ),
      `${markers[13]} café 東京 👩🏽‍💻`,
    ].join(" "),
    markers,
    attacks: attacks.map((attack, index) => `${attack}${markers[index * 2 + 2]}`),
  };
}

async function assertTerminalAttackSanitized(
  fixture: StartedTuiPtyFixture,
  payload: TerminalAttackPayload,
  timeoutMs: number,
) {
  await fixture.run.waitForOutput(payload.markers[13] ?? "", timeoutMs);
  const visible = fixture.run.visibleOutput();
  expect(payload.markers.every((marker) => visible.includes(marker))).toBe(true);
  expect(visible).toContain("café 東京 👩🏽‍💻");
  const raw = fixture.run.output();
  for (const attack of payload.attacks) {
    expect(raw).not.toContain(attack);
  }
  expect(raw).not.toContain("\uFFFD");
}

function hasStatusFrame(raw: string, marker: string, status: RegExp) {
  return raw
    .split("\x1b[?2026h")
    .slice(1)
    .some((chunk) => {
      const frame = chunk.split("\x1b[?2026l", 1)[0] ?? "";
      return frame.includes(marker) && status.test(frame);
    });
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

export async function exerciseTerminalOutputSafety(
  startFixture: StartTuiPtyFixture,
  startupTimeoutMs: number,
) {
  const gatewayPayload = buildTerminalAttackPayload("T08G");
  const idlePayload = buildTerminalAttackPayload("T08I");
  const fixture = await startFixture({
    env: {
      OPENCLAW_TUI_PTY_COLS: "30",
      OPENCLAW_TUI_PTY_ROWS: "18",
      OPENCLAW_TUI_PTY_GATEWAY_STATUS: gatewayPayload.text,
      OPENCLAW_TUI_PTY_DISCONNECT_REASON: idlePayload.text,
    },
  });

  try {
    await fixture.run.waitForOutput("local ready", startupTimeoutMs);
    const outputOffset = fixture.run.output().length;
    await fixture.run.write("/gateway-status\r", { delay: false });
    await fixture.waitForLogEntry((entry) => entry.method === "getGatewayStatus");
    await fixture.waitForLogEntry((entry) => entry.method === "disconnect");
    await assertTerminalAttackSanitized(fixture, gatewayPayload, startupTimeoutMs);
    await assertTerminalAttackSanitized(fixture, idlePayload, startupTimeoutMs);
    expect(
      hasStatusFrame(
        fixture.run.output().slice(outputOffset),
        idlePayload.markers[0] ?? "",
        /\| idle/u,
      ),
    ).toBe(true);

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
