import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_CLI_SESSIONS_LIST_COMMAND,
  createCodexCliSessionNodeHostCommands,
  listCodexCliSessionsOnNode,
  resolveCodexCliResumeSpawnInvocation,
} from "./node-cli-sessions.js";

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

  it("resolves Windows npm .cmd Codex shims through Node for resume", async () => {
    const binDir = path.join(tempDir, "bin");
    const entryPath = path.join(binDir, "node_modules", "@openai", "codex", "bin", "codex.js");
    const shimPath = path.join(binDir, "codex.cmd");
    await fs.mkdir(path.dirname(entryPath), { recursive: true });
    await fs.writeFile(entryPath, "console.log('codex')\n", "utf8");
    await fs.writeFile(
      shimPath,
      '@ECHO off\r\n"%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
      "utf8",
    );

    const resolved = resolveCodexCliResumeSpawnInvocation(["exec", "resume", "session-id"], {
      platform: "win32",
      env: { PATH: binDir, PATHEXT: ".CMD;.EXE;.BAT" },
      execPath: "C:\\node\\node.exe",
    });

    expect(resolved).toEqual({
      command: "C:\\node\\node.exe",
      args: [entryPath, "exec", "resume", "session-id"],
      shell: undefined,
      windowsHide: true,
    });
  });

  it("reports malformed node session payloadJSON with an owned error", async () => {
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
        invoke: vi.fn(async () => ({
          ok: true,
          payloadJSON: "{not json",
        })),
      },
    } as unknown as PluginRuntime;

    await expect(
      listCodexCliSessionsOnNode({
        runtime,
        requestedNode: "node-1",
      }),
    ).rejects.toThrow("Codex CLI node command returned malformed payloadJSON.");
  });
});
