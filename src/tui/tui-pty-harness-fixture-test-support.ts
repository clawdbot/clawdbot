// Keeps fake-terminal test-only logs and opaque-session fixtures independently bounded.
import { readFile } from "node:fs/promises";
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

export function buildOpaqueSessionIsolationFixture(): string {
  return `
          if (opts.message.startsWith("opaque session isolation proof: ")) {
            const otherSessionKey = opts.sessionKey.includes(":matrix:")
              ? opts.sessionKey.replace("!MixedRoomAbCdEf", "!mixedroomabcdef")
              : opts.sessionKey.replace("AbC123=", "abc123=");
            const marker = "PTY_FOREIGN_OPAQUE_SESSION_MESSAGE";
            queueMicrotask(() => {
              record("foreignSessionEvent", { sessionKey: otherSessionKey, marker });
              this.onEvent?.({
                event: "chat",
                payload: {
                  runId: "run-foreign-opaque-session",
                  sessionKey: otherSessionKey,
                  state: "delta",
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: marker }],
                  },
                },
              });
              this.onEvent?.({
                event: "session.message",
                payload: {
                  agentId: "main",
                  sessionKey: otherSessionKey,
                  sessionId: "foreign-opaque-session",
                  updatedAt: Date.now(),
                },
              });
            });
          }
  `;
}
