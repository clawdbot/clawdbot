import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareSessionManagerForRun } from "./session-manager-init.js";

const tempPaths: string[] = [];

async function makeTempFile(): Promise<string> {
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
});
