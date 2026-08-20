// Codex tests cover node cli sessions plugin behavior.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_CLI_SESSION_RESUME_COMMAND,
  createCodexCliSessionNodeHostCommands,
  listCodexCliSessionsOnNode,
} from "./node-cli-sessions.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const CODEX_CLI_SESSIONS_LIST_COMMAND = "codex.cli.sessions.list";

let tempDir: string;
let previousCodexHome: string | undefined;

describe("codex cli node sessions", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-cli-sessions-"));
    previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = tempDir;
  });

  afterEach(async () => {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("lists recent sessions from Codex history and hydrates cwd from session files", async () => {
    const sessionId = "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd";
    await fs.writeFile(
      path.join(tempDir, "history.jsonl"),
      [
        JSON.stringify({ session_id: sessionId, ts: 1778677925, text: "first ask" }),
        JSON.stringify({ session_id: sessionId, ts: 1778678322, text: "latest ask" }),
        JSON.stringify({ session_id: "older", ts: 1778670000, text: "skip me" }),
      ].join("\n"),
    );
    const sessionDir = path.join(tempDir, "sessions", "2026", "05", "13");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, `rollout-2026-05-13T08-29-58-${sessionId}.jsonl`),
      `${JSON.stringify({
        type: "session_meta",
        payload: { id: sessionId, cwd: "/repo" },
      })}\n`,
    );

    const command = createCodexCliSessionNodeHostCommands().find(
      (entry) => entry.command === CODEX_CLI_SESSIONS_LIST_COMMAND,
    );
    const raw = await command?.handle(JSON.stringify({ filter: "latest", limit: 5 }));
    const parsed = JSON.parse(raw ?? "{}") as {
      sessions?: Array<{
        sessionId?: string;
        cwd?: string;
        lastMessage?: string;
        messageCount?: number;
      }>;
    };

    expect(parsed.sessions).toEqual([
      {
        sessionId,
        updatedAt: "2026-05-13T13:18:42.000Z",
        lastMessage: "latest ask",
        cwd: "/repo",
        sessionFile: path.join(sessionDir, `rollout-2026-05-13T08-29-58-${sessionId}.jsonl`),
        messageCount: 2,
      },
    ]);
  });

  it("ignores Date-invalid Codex history timestamps", async () => {
    const sessionId = "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cf";
    await fs.writeFile(
      path.join(tempDir, "history.jsonl"),
      JSON.stringify({ session_id: sessionId, ts: 8_700_000_000_000, text: "bad timestamp" }),
    );

    const command = createCodexCliSessionNodeHostCommands().find(
      (entry) => entry.command === CODEX_CLI_SESSIONS_LIST_COMMAND,
    );
    const raw = await command?.handle(JSON.stringify({ filter: "bad timestamp", limit: 5 }));
    const parsed = JSON.parse(raw ?? "{}") as {
      sessions?: Array<{
        sessionId?: string;
        updatedAt?: string;
        lastMessage?: string;
        messageCount?: number;
      }>;
    };

    expect(parsed.sessions).toEqual([
      {
        sessionId,
        lastMessage: "bad timestamp",
        messageCount: 1,
      },
    ]);
  });

  it("lists sessions from Codex session files when history is absent", async () => {
    const sessionId = "019e23d1-f33d-78e3-959e-0f56f30a5249";
    const sessionDir = path.join(tempDir, "sessions", "2026", "05", "14");
    const sessionFile = path.join(sessionDir, `rollout-2026-05-14T00-10-22-${sessionId}.jsonl`);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          timestamp: "2026-05-14T00:10:23.618Z",
          type: "session_meta",
          payload: { id: sessionId, cwd: "/tmp/codex-work" },
        }),
        JSON.stringify({
          timestamp: "2026-05-14T00:10:23.619Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Reply with exactly: CRABBOX" }],
          },
        }),
      ].join("\n"),
    );

    const command = createCodexCliSessionNodeHostCommands().find(
      (entry) => entry.command === CODEX_CLI_SESSIONS_LIST_COMMAND,
    );
    const raw = await command?.handle(JSON.stringify({ filter: "crabbox", limit: 5 }));
    const parsed = JSON.parse(raw ?? "{}") as {
      sessions?: Array<{
        sessionId?: string;
        cwd?: string;
        lastMessage?: string;
        messageCount?: number;
      }>;
    };

    expect(parsed.sessions).toEqual([
      {
        sessionId,
        updatedAt: "2026-05-14T00:10:23.619Z",
        lastMessage: "Reply with exactly: CRABBOX",
        cwd: "/tmp/codex-work",
        sessionFile,
        messageCount: 1,
      },
    ]);
  });

  it("streams rollout JSONL with a record spanning many chunks", async () => {
    const sessionId = "019e23d1-f33d-78e3-959e-0f56f30a5250";
    const sessionDir = path.join(tempDir, "sessions", "2026", "05", "14");
    const sessionFile = path.join(sessionDir, `rollout-2026-05-14T00-10-22-${sessionId}.jsonl`);
    await fs.mkdir(sessionDir, { recursive: true });
    const filler = JSON.stringify({
      timestamp: "2026-05-14T00:10:23.619Z",
      type: "event_msg",
      payload: { type: "token_count", padding: "x".repeat(5 * 1_024 * 1_024) },
    });
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          timestamp: "2026-05-14T00:10:23.618Z",
          type: "session_meta",
          payload: { id: sessionId, cwd: "/tmp/codex-streaming" },
        }),
        filler,
        JSON.stringify({
          timestamp: "2026-05-14T00:10:24.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "rollout fallback" }],
          },
        }),
      ].join("\n"),
    );
    const readFile = vi.spyOn(fs, "readFile");

    const command = createCodexCliSessionNodeHostCommands().find(
      (entry) => entry.command === CODEX_CLI_SESSIONS_LIST_COMMAND,
    );
    const raw = await command?.handle(JSON.stringify({ limit: 5 }));
    const parsed = JSON.parse(raw ?? "{}") as {
      sessions?: Array<{
        sessionId?: string;
        cwd?: string;
        lastMessage?: string;
        messageCount?: number;
      }>;
    };

    expect(readFile).not.toHaveBeenCalledWith(sessionFile, "utf8");
    expect(parsed.sessions).toEqual([
      {
        sessionId,
        updatedAt: "2026-05-14T00:10:24.000Z",
        cwd: "/tmp/codex-streaming",
        lastMessage: "rollout fallback",
        sessionFile,
        messageCount: 1,
      },
    ]);
  });

  it("discards partial large-file summaries and closes after a later read fails", async () => {
    const sessionId = "019e23d1-f33d-78e3-959e-0f56f30a5251";
    const sessionDir = path.join(tempDir, "sessions", "2026", "05", "14");
    const sessionFile = path.join(sessionDir, `rollout-2026-05-14T00-10-22-${sessionId}.jsonl`);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(sessionFile, "");
    await fs.truncate(sessionFile, 5 * 1_024 * 1_024);
    const firstChunk = Buffer.from(
      `${JSON.stringify({
        timestamp: "2026-05-14T00:10:23.618Z",
        type: "session_meta",
        payload: { id: sessionId, cwd: "/tmp/partial" },
      })}\n`,
    );
    const close = vi.fn(async () => undefined);
    const read = vi
      .fn()
      .mockImplementationOnce(async (buffer: Buffer) => {
        firstChunk.copy(buffer);
        return { bytesRead: firstChunk.length, buffer };
      })
      .mockRejectedValueOnce(Object.assign(new Error("read failed"), { code: "EIO" }));
    vi.spyOn(fs, "open").mockResolvedValue({ read, close } as never);

    const command = createCodexCliSessionNodeHostCommands().find(
      (entry) => entry.command === CODEX_CLI_SESSIONS_LIST_COMMAND,
    );
    const raw = await command?.handle(JSON.stringify({ limit: 5 }));
    const parsed = JSON.parse(raw ?? "{}") as { sessions?: unknown[] };

    expect(parsed.sessions).toEqual([]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps a completed large-file summary when close rejects", async () => {
    const sessionId = "019e23d1-f33d-78e3-959e-0f56f30a5252";
    const sessionDir = path.join(tempDir, "sessions", "2026", "05", "14");
    const sessionFile = path.join(sessionDir, `rollout-2026-05-14T00-10-22-${sessionId}.jsonl`);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(sessionFile, "");
    await fs.truncate(sessionFile, 5 * 1_024 * 1_024);
    const content = Buffer.from(
      [
        JSON.stringify({
          timestamp: "2026-05-14T00:10:23.618Z",
          type: "session_meta",
          payload: { id: sessionId, cwd: "/tmp/close-failure" },
        }),
        JSON.stringify({
          timestamp: "2026-05-14T00:10:24.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "survives close failure" }],
          },
        }),
      ].join("\n"),
    );
    const close = vi.fn(async () => {
      throw Object.assign(new Error("close failed"), { code: "EIO" });
    });
    const read = vi
      .fn()
      .mockImplementationOnce(async (buffer: Buffer) => {
        content.copy(buffer);
        return { bytesRead: content.length, buffer };
      })
      .mockResolvedValueOnce({ bytesRead: 0, buffer: Buffer.alloc(0) });
    vi.spyOn(fs, "open").mockResolvedValue({ read, close } as never);

    const command = createCodexCliSessionNodeHostCommands().find(
      (entry) => entry.command === CODEX_CLI_SESSIONS_LIST_COMMAND,
    );
    const raw = await command?.handle(JSON.stringify({ limit: 5 }));
    const parsed = JSON.parse(raw ?? "{}") as {
      sessions?: Array<{
        sessionId?: string;
        updatedAt?: string;
        cwd?: string;
        lastMessage?: string;
        sessionFile?: string;
        messageCount?: number;
      }>;
    };

    expect(parsed.sessions).toEqual([
      {
        sessionId,
        updatedAt: "2026-05-14T00:10:24.000Z",
        cwd: "/tmp/close-failure",
        lastMessage: "survives close failure",
        sessionFile,
        messageCount: 1,
      },
    ]);
    expect(close).toHaveBeenCalledOnce();
  });

  it("reports malformed node session payloadJSON with an owned error", async () => {
    const invoke = vi.fn(async () => ({
      ok: true,
      payloadJSON: "{not json",
    }));
    const runtime = {
      nodes: {
        list: vi.fn(async () => ({
          nodes: [
            {
              nodeId: "node-1",
              connected: true,
              commands: [CODEX_CLI_SESSIONS_LIST_COMMAND],
            },
          ],
        })),
        invoke,
      },
    } as unknown as PluginRuntime;

    await expect(
      listCodexCliSessionsOnNode({
        runtime,
        requestedNode: "node-1",
      }),
    ).rejects.toThrow("Codex CLI node command returned malformed payloadJSON.");
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ scopes: ["operator.write"] }));
  });

  it("terminates Codex option parsing before an option-shaped session id", async () => {
    const sessionId = "--dangerously-bypass-approvals-and-sandbox";
    const child = Object.assign(new EventEmitter(), {
      stdin: { end: vi.fn() },
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() => child.emit("exit", 0));
      return child as never;
    });
    vi.spyOn(fs, "readFile").mockResolvedValue("resumed");

    const command = createCodexCliSessionNodeHostCommands().find(
      (entry) => entry.command === CODEX_CLI_SESSION_RESUME_COMMAND,
    );
    await command?.handle(JSON.stringify({ sessionId, prompt: "continue" }));

    const argv = vi.mocked(spawn).mock.calls[0]?.[1];
    expect(argv?.slice(-3)).toEqual(["--", sessionId, "-"]);
  });

  it("keeps Codex history session previews on UTF-16 code point boundaries", async () => {
    const sessionId = "019e2007-1f7e-7eb1-a42b-8c01f4b9b5ce";
    const text = `${"a".repeat(136)}🤖tail`;
    await fs.writeFile(
      path.join(tempDir, "history.jsonl"),
      JSON.stringify({ session_id: sessionId, ts: 1778678322, text }),
    );

    const command = createCodexCliSessionNodeHostCommands().find(
      (entry) => entry.command === CODEX_CLI_SESSIONS_LIST_COMMAND,
    );
    const raw = await command?.handle(JSON.stringify({ filter: "", limit: 5 }));
    const parsed = JSON.parse(raw ?? "{}") as {
      sessions?: Array<{ lastMessage?: string }>;
    };

    expect(parsed.sessions?.[0]?.lastMessage).toBe(`${"a".repeat(136)}...`);
    expect(parsed.sessions?.[0]?.lastMessage).not.toContain("\ud83e");
    expect(parsed.sessions?.[0]?.lastMessage).not.toContain("\udd16");
  });

  it("keeps Codex session-file previews on UTF-16 code point boundaries", async () => {
    const sessionId = "019e23d1-f33d-78e3-959e-0f56f30a5248";
    const sessionDir = path.join(tempDir, "sessions", "2026", "05", "14");
    const sessionFile = path.join(sessionDir, `rollout-2026-05-14T00-10-22-${sessionId}.jsonl`);
    const text = `${"b".repeat(136)}🤖tail`;

    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          timestamp: "2026-05-14T00:10:23.618Z",
          type: "session_meta",
          payload: { id: sessionId, cwd: "/tmp/codex-work" },
        }),
        JSON.stringify({
          timestamp: "2026-05-14T00:10:23.619Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text }],
          },
        }),
      ].join("\n"),
    );

    const command = createCodexCliSessionNodeHostCommands().find(
      (entry) => entry.command === CODEX_CLI_SESSIONS_LIST_COMMAND,
    );
    const raw = await command?.handle(JSON.stringify({ filter: "", limit: 5 }));
    const parsed = JSON.parse(raw ?? "{}") as {
      sessions?: Array<{ lastMessage?: string }>;
    };

    expect(parsed.sessions?.[0]?.lastMessage).toBe(`${"b".repeat(136)}...`);
    expect(parsed.sessions?.[0]?.lastMessage).not.toContain("\ud83e");
    expect(parsed.sessions?.[0]?.lastMessage).not.toContain("\udd16");
  });
});
