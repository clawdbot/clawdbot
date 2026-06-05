// Session manager init tests cover how run startup rewrites or preserves
// transcript headers when resuming, forking, or recovering sessions.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../sessions/session-manager.js";
import { prepareSessionManagerForRun } from "./session-manager-init.js";

const tempPaths: string[] = [];

async function makeTempFile(): Promise<string> {
  // Each case gets its own transcript file so destructive rewrite checks stay
  // isolated from recovery-path assertions.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-manager-init-"));
  tempPaths.push(dir);
  return path.join(dir, "session.jsonl");
}

describe("prepareSessionManagerForRun", () => {
  afterEach(async () => {
    await Promise.all(
      tempPaths.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("rewrites pre-created no-assistant session headers to the runtime cwd", async () => {
    const sessionFile = await makeTempFile();
    await fs.writeFile(sessionFile, '{"type":"session"}\n', "utf-8");
    const sessionManager = {
      sessionId: "old-session",
      cwd: "/srv/openclaw/main",
      flushed: true,
      fileEntries: [
        {
          type: "session",
          id: "old-session",
          cwd: "/srv/openclaw/main",
        },
        {
          type: "message",
          message: { role: "user" },
        },
      ],
      byId: new Map([["old", {}]]),
      labelsById: new Map([["old", {}]]),
      leafId: "old",
    };

    await prepareSessionManagerForRun({
      sessionManager,
      sessionFile,
      hadSessionFile: true,
      sessionId: "new-session",
      cwd: "/tmp/task-repo",
    });

    expect(sessionManager.sessionId).toBe("new-session");
    expect(sessionManager.cwd).toBe("/tmp/task-repo");
    expect(sessionManager.fileEntries).toEqual([
      {
        type: "session",
        id: "new-session",
        cwd: "/tmp/task-repo",
      },
    ]);
    expect(sessionManager.byId.size).toBe(0);
    expect(sessionManager.labelsById.size).toBe(0);
    expect(sessionManager.leafId).toBeNull();
    expect(sessionManager.flushed).toBe(false);
    expect(await fs.readFile(sessionFile, "utf-8")).toBe("");
  });

  it("rewrites forked transcript headers with copied assistant messages to the runtime cwd", async () => {
    // Forked sessions keep copied assistant context but rewrite the session
    // header to the child run id and active workspace cwd.
    const sessionFile = await makeTempFile();
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          id: "parent-session",
          timestamp: "2026-05-27T00:00:00.000Z",
          cwd: "/srv/openclaw/main",
        }),
        JSON.stringify({
          type: "message",
          id: "assistant-1",
          parentId: null,
          timestamp: "2026-05-27T00:00:01.000Z",
          message: { role: "assistant", content: "copied context" },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
    const assistantEntry = {
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: "2026-05-27T00:00:01.000Z",
      message: { role: "assistant", content: "copied context" },
    };
    const sessionManager = {
      sessionId: "parent-session",
      cwd: "/srv/openclaw/main",
      flushed: true,
      fileEntries: [
        {
          type: "session",
          id: "parent-session",
          timestamp: "2026-05-27T00:00:00.000Z",
          cwd: "/srv/openclaw/main",
        },
        assistantEntry,
      ],
      byId: new Map([["assistant-1", assistantEntry]]),
      labelsById: new Map(),
      leafId: "assistant-1",
    };

    await prepareSessionManagerForRun({
      sessionManager,
      sessionFile,
      hadSessionFile: true,
      sessionId: "child-session",
      cwd: "/tmp/task-repo",
    });

    expect(sessionManager.sessionId).toBe("child-session");
    expect(sessionManager.cwd).toBe("/tmp/task-repo");
    expect(sessionManager.fileEntries[0]).toEqual(
      expect.objectContaining({
        type: "session",
        id: "child-session",
        cwd: "/tmp/task-repo",
      }),
    );
    expect(sessionManager.fileEntries[1]).toBe(assistantEntry);
    expect(sessionManager.byId.get("assistant-1")).toBe(assistantEntry);
    expect(sessionManager.leafId).toBe("assistant-1");
    expect(sessionManager.flushed).toBe(true);

    const [headerLine, assistantLine] = (await fs.readFile(sessionFile, "utf-8"))
      .trim()
      .split("\n");
    expect(JSON.parse(headerLine ?? "{}")).toEqual(
      expect.objectContaining({
        type: "session",
        id: "child-session",
        cwd: "/tmp/task-repo",
      }),
    );
    expect(JSON.parse(assistantLine ?? "{}")).toEqual(assistantEntry);
  });

  it("does not truncate an existing transcript with a corrupted header", async () => {
    // A corrupt header may still be followed by useful transcript entries; fail
    // closed instead of truncating unknown persisted user data.
    const sessionFile = await makeTempFile();
    const originalTranscript =
      [
        '{"type":"session","id":"broken"',
        JSON.stringify({
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp: "2026-05-27T00:00:01.000Z",
          message: { role: "user", content: "persisted prompt" },
        }),
      ].join("\n") + "\n";
    await fs.writeFile(sessionFile, originalTranscript, "utf-8");
    const sessionManager = {
      sessionId: "fresh-session",
      cwd: "/srv/openclaw/main",
      flushed: true,
      fileEntries: [
        {
          type: "session",
          id: "fresh-session",
          cwd: "/srv/openclaw/main",
        },
        {
          type: "message",
          message: { role: "user" },
        },
      ],
      byId: new Map([["user-1", {}]]),
      labelsById: new Map(),
      leafId: "user-1",
    };

    await expect(
      prepareSessionManagerForRun({
        sessionManager,
        sessionFile,
        hadSessionFile: true,
        sessionId: "new-session",
        cwd: "/tmp/task-repo",
      }),
    ).rejects.toThrow("Refusing to reset session transcript with unreadable header");

    expect(await fs.readFile(sessionFile, "utf-8")).toBe(originalTranscript);
    expect(sessionManager.fileEntries).toEqual([
      {
        type: "session",
        id: "fresh-session",
        cwd: "/srv/openclaw/main",
      },
      {
        type: "message",
        message: { role: "user" },
      },
    ]);
    expect(sessionManager.flushed).toBe(true);
  });

  it("keeps recovered user-only transcripts through open and run preparation", async () => {
    const sessionFile = await makeTempFile();
    const userEntry = {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: "2026-05-27T00:00:01.000Z",
      message: { role: "user", content: "persisted prompt" },
    };
    await fs.writeFile(
      sessionFile,
      ['{"type":"session","id":"broken"', JSON.stringify(userEntry)].join("\n") + "\n",
      "utf-8",
    );

    const sessionManager = SessionManager.open(sessionFile, path.dirname(sessionFile), "/old/cwd");

    await prepareSessionManagerForRun({
      sessionManager,
      sessionFile,
      hadSessionFile: true,
      sessionId: "new-session",
      cwd: "/tmp/task-repo",
    });
    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "response" }],
      api: "messages",
      provider: "anthropic",
      model: "sonnet-4.6",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });

    const entries = (await fs.readFile(sessionFile, "utf-8"))
      .trim()
      .split("\n")
      .map(
        (line) => JSON.parse(line) as { type: string; id?: string; message?: { role?: string } },
      );
    expect(entries.map((entry) => entry.type)).toEqual(["session", "message", "message"]);
    expect(entries[0]).toEqual(
      expect.objectContaining({ type: "session", id: "new-session", cwd: "/tmp/task-repo" }),
    );
    expect(entries[1]).toEqual(userEntry);
    expect(entries[2]?.message?.role).toBe("assistant");
  });
});
