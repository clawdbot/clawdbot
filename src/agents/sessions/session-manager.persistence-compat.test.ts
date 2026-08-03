// Focused persistence compatibility tests kept separate from the session tree suite.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openFileBackedSessionManagerForTest } from "../../../test/helpers/session-manager-file-fixture.js";
import {
  formatSqliteSessionFileMarker,
  parseSqliteSessionFileMarker,
} from "../../config/sessions/legacy-sqlite-marker.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  upsertSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { CURRENT_SESSION_VERSION, SessionManager } from "./session-manager.js";

const tempPaths: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-manager-compat-"));
  tempPaths.push(dir);
  return dir;
}

function buildAssistantMessage(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "messages" as const,
    provider: "anthropic" as const,
    model: "sonnet-4.6" as const,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

describe("SessionManager persistence compatibility", () => {
  afterEach(async () => {
    await Promise.all(
      tempPaths.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("rewrites SQLite transcript rows when removing trailing entries", async () => {
    const dir = await makeTempDir();
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "sqlite-remove-trailing-session";
    const sessionKey = "agent:main:dashboard:sqlite-remove-trailing";
    const marker = formatSqliteSessionFileMarker({ agentId: "main", sessionId, storePath });
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await upsertSessionEntry(
      { agentId: "main", sessionKey, storePath },
      { sessionFile: marker, sessionId, updatedAt: 10 },
    );
    const user = await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "user-message",
      message: { role: "user", content: "question" },
    });
    const baseAnswer = await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "base-answer",
      message: buildAssistantMessage("base answer"),
      parentId: user.messageId,
    });
    const temporaryError = await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "temporary-error",
      message: buildAssistantMessage("temporary error"),
      parentId: baseAnswer.messageId,
    });
    const target = parseSqliteSessionFileMarker(marker);
    if (!target) {
      throw new Error("expected SQLite transcript marker fixture");
    }
    const manager = SessionManager.open({ ...target, sessionKey }, dir);

    expect(manager.removeTrailingEntries((entry) => entry.id === temporaryError.messageId)).toBe(1);
    expect(manager.getLeafId()).toBe(baseAnswer.messageId);
    const replacementId = manager.appendMessage(buildAssistantMessage("replacement answer"));
    const records = await loadTranscriptEvents(scope);

    expect(
      records.map((record) =>
        record && typeof record === "object" && "id" in record ? record.id : undefined,
      ),
    ).not.toContain(temporaryError.messageId);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: replacementId,
          message: expect.objectContaining({
            content: [{ type: "text", text: "replacement answer" }],
            role: "assistant",
          }),
          parentId: baseAnswer.messageId,
          type: "message",
        }),
      ]),
    );
    await expect(fs.stat(path.join(process.cwd(), marker))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps file fixture factories off the production SessionManager class", () => {
    expect(SessionManager).not.toHaveProperty("create");
    expect(SessionManager).not.toHaveProperty("openFile");
  });

  it("keeps the default fixture cwd independent from its transcript directory", async () => {
    const dir = await makeTempDir();
    const manager = openFileBackedSessionManagerForTest(path.join(dir, "session.jsonl"));

    expect(manager.getCwd()).toBe(process.cwd());
    expect(manager.getSessionDir()).toBe(dir);
  });

  it("separates appended records from a final unterminated JSONL record", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "unterminated.jsonl");
    await fs.writeFile(
      sessionFile,
      JSON.stringify({
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: "unterminated",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: dir,
      }),
    );
    openFileBackedSessionManagerForTest(sessionFile, dir).appendMessage({
      role: "user",
      content: "appended",
      timestamp: 1,
    });
    expect(
      openFileBackedSessionManagerForTest(sessionFile, dir).buildSessionContext().messages,
    ).toEqual([expect.objectContaining({ content: "appended", role: "user" })]);
  });

  it("rotates new-session fixtures without rewriting the previous file", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "original.jsonl");
    const manager = openFileBackedSessionManagerForTest(sessionFile, dir);
    manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
    const original = await fs.readFile(sessionFile, "utf8");
    manager.newSession({ id: "replacement" });
    expect(await fs.readFile(sessionFile, "utf8")).toBe(original);
    expect(manager.getSessionFile()).toBe(path.join(dir, "replacement.jsonl"));
    expect(await fs.readFile(path.join(dir, "replacement.jsonl"), "utf8")).toContain(
      '"id":"replacement"',
    );
  });
});
