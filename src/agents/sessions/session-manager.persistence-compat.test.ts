// Focused persistence compatibility tests kept separate from the session tree suite.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFileBackedSessionManagerForTest } from "../../../test/helpers/session-manager-file-fixture.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  formatSqliteSessionFileMarker,
  parseSqliteSessionFileMarker,
} from "../../config/sessions/legacy-sqlite-marker.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { CURRENT_SESSION_VERSION, SessionManager } from "./session-manager.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
  it("persists canonical delivery facts and keeps the live assistant bytes identical", async () => {
    const dir = tempDirs.make("openclaw-session-manager-directives-");
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "directive-session";
    const sessionKey = "agent:main:dashboard:directives";
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });

    const manager = SessionManager.open(scope, dir);
    const tagged = buildAssistantMessage(
      [
        "[[reply_to_current]]",
        "[[reply_to:message-7]]",
        "[[audio_as_voice]]",
        "[[tts:provider=mock voiceId=voice-7]]",
        "Final answer [[tts:text]]Spoken answer[[/tts:text]]",
      ].join("\n"),
    );
    const codeExampleText = [
      "Use `[[reply_to_current]]` literally.",
      "Use `[[tts:text]]spoken[[/tts:text]]` literally.",
      "```text",
      "[[audio_as_voice]]",
      "[[tts:provider=mock voiceId=voice-7]]",
      "```",
    ].join("\n");
    const codeExample = buildAssistantMessage(codeExampleText);
    const indentedCode = buildAssistantMessage("    [[reply_to_current]]\n    [[audio_as_voice]]");
    const malformed = buildAssistantMessage("[[reply_to_current]\nVisible reply");
    const laterLiteral = buildAssistantMessage("Visible reply\n[[reply_to_current] literally");
    const ordinaryRelativeMedia = buildAssistantMessage("Generated image\nMEDIA:./render.png");
    manager.appendMessage(tagged);
    manager.appendMessage(codeExample);
    manager.appendMessage(indentedCode);
    manager.appendMessage(malformed);
    manager.appendMessage(laterLiteral);
    manager.appendMessage(ordinaryRelativeMedia);

    expect(tagged.content).toEqual([{ type: "text", text: "Final answer" }]);
    expect(tagged).toMatchObject({
      openclawDelivery: {
        audioAsVoice: true,
        replyToId: "message-7",
        tts: {
          tagged: true,
          text: "Spoken answer",
          directives: [
            {
              provider: "mock",
              values: { voiceid: "voice-7" },
            },
          ],
        },
      },
    });
    expect(codeExample.content).toEqual([{ type: "text", text: codeExampleText }]);
    expect(codeExample).not.toHaveProperty("openclawDelivery");
    expect(indentedCode).not.toHaveProperty("openclawDelivery");
    expect(malformed.content).toEqual([{ type: "text", text: "Visible reply" }]);
    expect(malformed).not.toHaveProperty("openclawDelivery");
    expect(laterLiteral.content).toEqual([
      { type: "text", text: "Visible reply\n[[reply_to_current] literally" },
    ]);
    expect(laterLiteral).not.toHaveProperty("openclawDelivery");
    expect(ordinaryRelativeMedia).not.toHaveProperty("openclawDelivery");

    const persistedMessages = (await loadTranscriptEvents(scope))
      .filter((event) => (event as { type?: unknown }).type === "message")
      .map((event) => (event as { message: unknown }).message);
    expect(persistedMessages).toEqual([
      tagged,
      codeExample,
      indentedCode,
      malformed,
      laterLiteral,
      ordinaryRelativeMedia,
    ]);
    expect(SessionManager.open(scope, dir).buildSessionContext().messages).toEqual([
      tagged,
      codeExample,
      indentedCode,
      malformed,
      laterLiteral,
      ordinaryRelativeMedia,
    ]);
  });

  it("rewrites SQLite transcript rows when removing trailing entries", async () => {
    const dir = tempDirs.make("openclaw-session-manager-compat-");
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "sqlite-remove-trailing-session";
    const sessionKey = "agent:main:dashboard:sqlite-remove-trailing";
    const marker = formatSqliteSessionFileMarker({ agentId: "main", sessionId, storePath });
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await upsertSessionEntryCore(
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
    const dir = tempDirs.make("openclaw-session-manager-compat-");
    const manager = openFileBackedSessionManagerForTest(path.join(dir, "session.jsonl"));

    expect(manager.getCwd()).toBe(process.cwd());
    expect(manager.getSessionDir()).toBe(dir);
  });

  it("keeps requested file fixture session identities aligned", async () => {
    const dir = tempDirs.make("openclaw-session-manager-compat-");
    const sessionFile = path.join(dir, "session.jsonl");
    const manager = openFileBackedSessionManagerForTest(sessionFile, {
      sessionId: "session-1",
      sessionDir: dir,
      cwd: dir,
    });

    expect(manager.getSessionId()).toBe("session-1");
    expect(manager.getCwd()).toBe(dir);
    expect(await fs.readFile(sessionFile, "utf8")).toContain('"id":"session-1"');
    expect(() =>
      openFileBackedSessionManagerForTest(sessionFile, { sessionId: "session-2" }),
    ).toThrow("belongs to session-1, not session-2");
    const inMemory = vi.fn((cwd?: string) => SessionManager.inMemory(cwd));
    const ManagerClass = { inMemory } as unknown as typeof SessionManager;
    openFileBackedSessionManagerForTest(
      path.join(dir, "legacy.jsonl"),
      undefined,
      dir,
      ManagerClass,
    );
    expect(inMemory).toHaveBeenCalledWith(dir);
  });

  it("separates appended records from a final unterminated JSONL record", async () => {
    const dir = tempDirs.make("openclaw-session-manager-compat-");
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
    const dir = tempDirs.make("openclaw-session-manager-compat-");
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
