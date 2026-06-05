// Session manager tests cover JSONL recovery behavior for interrupted or
// corrupted transcript writes.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "./session-manager.js";

const tempPaths: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-manager-"));
  tempPaths.push(dir);
  return dir;
}

describe("SessionManager.open", () => {
  afterEach(async () => {
    await Promise.all(
      tempPaths.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("recovers a corrupted first-line header without truncating later messages", async () => {
    // A damaged header should be repairable without treating valid later
    // message entries as disposable transcript state.
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const originalHeader = {
      type: "session",
      version: 3,
      id: "original-session",
      timestamp: "2026-05-27T00:00:00.000Z",
      cwd: "/srv/openclaw/main",
    };
    const userEntry = {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: "2026-05-27T00:00:01.000Z",
      message: { role: "user", content: "important question" },
    };
    const assistantEntry = {
      type: "message",
      id: "assistant-1",
      parentId: "user-1",
      timestamp: "2026-05-27T00:00:02.000Z",
      message: { role: "assistant", content: "important answer" },
    };
    const originalTranscript =
      [
        JSON.stringify(originalHeader).slice(0, 30),
        JSON.stringify(userEntry),
        JSON.stringify(assistantEntry),
      ].join("\n") + "\n";
    await fs.writeFile(sessionFile, originalTranscript, "utf8");
    if (process.platform !== "win32") {
      await fs.chmod(sessionFile, 0o600);
    }

    const sessionManager = SessionManager.open(sessionFile, dir, "/tmp/task-repo");

    expect(sessionManager.getEntries()).toEqual([userEntry, assistantEntry]);
    expect(await fs.readFile(sessionFile, "utf8")).toContain("important question");
    expect(await fs.readFile(sessionFile, "utf8")).toContain("important answer");
    await expect(fs.readFile(sessionFile, "utf8")).resolves.not.toBe(originalTranscript);

    const backupFiles = (await fs.readdir(dir)).filter((file) => file.includes(".corrupt-"));
    expect(backupFiles).toHaveLength(1);
    // Keep an exact backup for audit/debugging before rewriting the live file.
    await expect(fs.readFile(path.join(dir, backupFiles[0] ?? ""), "utf8")).resolves.toBe(
      originalTranscript,
    );
    if (process.platform !== "win32") {
      const backupStat = await fs.stat(path.join(dir, backupFiles[0] ?? ""));
      expect(backupStat.mode & 0o777).toBe(0o600);
    }
  });

  it("does not duplicate the header after recovering a header-only corrupt file", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    await fs.writeFile(sessionFile, '{"type":"session","version":3,"id":"sess', "utf8");

    const sessionManager = SessionManager.open(sessionFile, dir, "/tmp/task-repo");
    sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
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

    const entries = (await fs.readFile(sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });

    expect(entries.map((entry) => entry.type)).toEqual(["session", "message", "message"]);
    expect(entries.filter((entry) => entry.type === "session")).toHaveLength(1);
  });
});
