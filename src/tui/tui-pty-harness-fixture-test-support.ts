// Keeps fake-terminal test-only logs and opaque-session fixtures independently bounded.
import { readFile } from "node:fs/promises";
import { sleep } from "./tui-pty-test-support.js";

export type FixtureLogEntry = {
  method: string;
  payload?: unknown;
};

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
