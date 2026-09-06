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
  readSessionTranscriptWatermark,
  replaceTranscriptEventsSync,
  resolveSessionTranscriptDatabasePath,
  updateSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { waitForSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import { withOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import { CURRENT_SESSION_VERSION, SessionManager } from "./session-manager.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function buildAssistantMessage(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "messages" as const,
    provider: "anthropic" as const,
    model: "sonnet-4.6" as const,
    usage: createZeroUsageFixture(),
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

describe("SessionManager persistence compatibility", () => {
  it("persists an assistant-first session after creating its header", async () => {
    const dir = tempDirs.make("openclaw-session-manager-assistant-first-");
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "assistant-first-session";
    const sessionKey = "agent:main:dashboard:assistant-first";
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });

    const manager = SessionManager.open(scope, dir);
    const assistantId = manager.appendMessage(buildAssistantMessage("first response"));

    await expect(loadTranscriptEvents(scope)).resolves.toEqual([
      expect.objectContaining({ id: sessionId, type: "session" }),
      expect.objectContaining({ id: assistantId, type: "message", parentId: null }),
    ]);
  });

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

  it("preserves and rebases trailing metadata, labels, and leaf controls", async () => {
    const dir = tempDirs.make("openclaw-session-manager-controls-");
    const scope = {
      agentId: "main",
      sessionId: "sqlite-remove-controls-session",
      sessionKey: "agent:main:dashboard:sqlite-remove-controls",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const events = [
      {
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: scope.sessionId,
        timestamp: new Date(0).toISOString(),
        cwd: dir,
      },
      {
        type: "message",
        id: "user",
        parentId: null,
        timestamp: new Date(1).toISOString(),
        message: { role: "user", content: "question" },
      },
      {
        type: "message",
        id: "temporary",
        parentId: "user",
        timestamp: new Date(2).toISOString(),
        message: buildAssistantMessage("temporary"),
      },
      {
        type: "label",
        id: "temporary-label",
        parentId: "temporary",
        timestamp: new Date(3).toISOString(),
        targetId: "temporary",
        label: "retry",
      },
      {
        type: "custom",
        id: "plugin-state",
        parentId: "temporary-label",
        timestamp: new Date(4).toISOString(),
        customType: "plugin-state",
        data: { enabled: true },
      },
      {
        type: "session_info",
        id: "session-info",
        parentId: "plugin-state",
        timestamp: new Date(5).toISOString(),
        name: "kept session",
      },
      {
        type: "leaf",
        id: "leaf-control",
        parentId: "session-info",
        targetId: "temporary",
        appendParentId: "temporary",
      },
    ];
    expect(replaceTranscriptEventsSync(scope, events)).toBe(true);
    const generationBefore = readSessionTranscriptWatermark(scope).generation;
    const manager = SessionManager.open(scope, dir);

    expect(
      manager.removeTrailingEntries((entry) => entry.id === "temporary", {
        preserveTrailing: (entry) =>
          entry.type === "custom" || entry.type === "label" || entry.type === "session_info",
      }),
    ).toBe(1);

    expect(readSessionTranscriptWatermark(scope).generation).not.toBe(generationBefore);
    expect(await loadTranscriptEvents(scope)).toMatchObject([
      { type: "session" },
      { id: "user", parentId: null, type: "message" },
      { id: "plugin-state", parentId: "user", type: "custom" },
      { id: "session-info", parentId: "plugin-state", type: "session_info" },
      {
        id: "leaf-control",
        parentId: "session-info",
        targetId: "user",
        appendParentId: "user",
        type: "leaf",
      },
    ]);
  });

  it("allows stale suffix cleanup to remain a no-op when its target is absent", async () => {
    const dir = tempDirs.make("openclaw-session-manager-concurrent-noop-");
    const scope = {
      agentId: "main",
      sessionId: "sqlite-remove-concurrent-noop-session",
      sessionKey: "agent:main:dashboard:sqlite-remove-concurrent-noop",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "base",
      message: { role: "user", content: "question" },
    });
    const manager = SessionManager.open(scope, dir);
    await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "concurrent",
      message: { role: "user", content: "concurrent" },
    });

    expect(manager.removeTrailingEntries((entry) => entry.id === "absent")).toBe(0);
    expect(manager.buildSessionContext().messages).toMatchObject([
      { role: "user", content: "question" },
    ]);
    expect(
      (await loadTranscriptEvents(scope)).map((event) =>
        event && typeof event === "object" && "id" in event ? event.id : undefined,
      ),
    ).toEqual([scope.sessionId, "base", "concurrent"]);
  });

  it("rejects stale suffix removal without deleting concurrent history", async () => {
    const dir = tempDirs.make("openclaw-session-manager-concurrent-");
    const scope = {
      agentId: "main",
      sessionId: "sqlite-remove-concurrent-session",
      sessionKey: "agent:main:dashboard:sqlite-remove-concurrent",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "base",
      message: { role: "user", content: "question" },
    });
    await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "temporary",
      message: buildAssistantMessage("temporary"),
    });
    const manager = SessionManager.open(scope, dir);
    await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "concurrent",
      message: { role: "user", content: "concurrent" },
    });

    expect(() => manager.removeTrailingEntries((entry) => entry.id === "temporary")).toThrow(
      "SQLite transcript changed while preparing suffix removal",
    );
    expect(manager.buildSessionContext().messages).toMatchObject([
      { role: "user", content: "question" },
      { role: "assistant", content: [{ type: "text", text: "temporary" }] },
    ]);
    expect(
      (await loadTranscriptEvents(scope)).map((event) =>
        event && typeof event === "object" && "id" in event ? event.id : undefined,
      ),
    ).toEqual([scope.sessionId, "base", "temporary", "concurrent"]);
  });

  it("rejects a prepared assistant after another writer advances the transcript fence", async () => {
    const dir = tempDirs.make("openclaw-session-manager-stale-append-fence-");
    const scope = {
      agentId: "main",
      sessionId: "sqlite-stale-append-fence-session",
      sessionKey: "agent:main:dashboard:sqlite-stale-append-fence",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "base",
      message: { role: "user", content: "question" },
    });
    const manager = SessionManager.open(scope, dir);
    await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "concurrent",
      message: { role: "user", content: "concurrent" },
    });

    expect(() => manager.appendMessage(buildAssistantMessage("temporary"))).toThrow(
      "SQLite transcript changed while preparing rewrite",
    );
    expect(manager.buildSessionContext().messages).toMatchObject([
      { role: "user", content: "question" },
    ]);
    expect(
      (await loadTranscriptEvents(scope)).map((event) =>
        event && typeof event === "object" && "id" in event ? event.id : undefined,
      ),
    ).toEqual([scope.sessionId, "base", "concurrent"]);
  });

  it("retains the append transaction fence when another write starts after commit", async () => {
    const dir = tempDirs.make("openclaw-session-manager-append-fence-");
    const scope = {
      agentId: "main",
      sessionId: "sqlite-append-fence-session",
      sessionKey: "agent:main:dashboard:sqlite-append-fence",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "base",
      message: { role: "user", content: "question" },
    });
    const manager = SessionManager.open(scope, dir);
    const temporaryId = manager.appendMessage(buildAssistantMessage("temporary"));
    const afterAppend = await loadTranscriptEvents(scope);
    const base = afterAppend[1];
    if (!base || typeof base !== "object") {
      throw new Error("Expected persisted base transcript event");
    }
    expect(
      replaceTranscriptEventsSync(scope, [
        afterAppend[0],
        { ...base, message: { role: "user", content: "rewritten question" } },
        afterAppend[2],
      ]),
    ).toBe(true);

    expect(() => manager.removeTrailingEntries((entry) => entry.id === temporaryId)).toThrow(
      "SQLite transcript changed while preparing suffix removal",
    );
    expect(await loadTranscriptEvents(scope)).toMatchObject([
      { type: "session" },
      { id: "base", message: { role: "user", content: "rewritten question" } },
      { id: temporaryId },
    ]);
  });

  it("rejects suffix removal after a concurrent retained-prefix rewrite", async () => {
    const dir = tempDirs.make("openclaw-session-manager-prefix-concurrent-");
    const scope = {
      agentId: "main",
      sessionId: "sqlite-remove-prefix-concurrent-session",
      sessionKey: "agent:main:dashboard:sqlite-remove-prefix-concurrent",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "base",
      message: { role: "user", content: "question" },
    });
    await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "temporary",
      message: buildAssistantMessage("temporary"),
    });
    const manager = SessionManager.open(scope, dir);
    const current = await loadTranscriptEvents(scope);
    const base = current[1];
    if (!base || typeof base !== "object") {
      throw new Error("Expected persisted base transcript event");
    }
    expect(
      replaceTranscriptEventsSync(scope, [
        current[0],
        { ...base, message: { role: "user", content: "rewritten question" } },
        current[2],
      ]),
    ).toBe(true);

    expect(() => manager.removeTrailingEntries((entry) => entry.id === "temporary")).toThrow(
      "SQLite transcript changed while preparing suffix removal",
    );
    expect(manager.buildSessionContext().messages).toMatchObject([
      { role: "user", content: "question" },
      { role: "assistant", content: [{ type: "text", text: "temporary" }] },
    ]);
    expect(await loadTranscriptEvents(scope)).toMatchObject([
      { type: "session" },
      { id: "base", message: { role: "user", content: "rewritten question" } },
      { id: "temporary" },
    ]);
  });

  it("keeps file fixture factories off the production SessionManager class", () => {
    expect(SessionManager).not.toHaveProperty("create");
    expect(SessionManager).not.toHaveProperty("openFile");
  });

  it.each(["sqlite", "bounded-sqlite", "identity", "writer", "lifecycle"])(
    "keeps the live tree unchanged after a rejected %s tail rewrite",
    async (failure) => {
      const dir = tempDirs.make("openclaw-session-manager-tail-");
      const scope = {
        agentId: "main",
        sessionId: "tail-rewrite",
        sessionKey: "agent:main:tail-rewrite",
        storePath: path.join(dir, "openclaw-agent.sqlite"),
      };
      const initialEntry = {
        sessionId: scope.sessionId,
        updatedAt: 1,
        activeWriterRunId: "original-writer",
        lifecycleRevision: "original-lifecycle",
      };
      await upsertSessionEntryCore(scope, initialEntry);
      const seed = SessionManager.open(scope, dir);
      seed.appendMessage({ role: "user", content: "earlier history", timestamp: 1 });
      seed.appendMessage({ role: "user", content: "question", timestamp: 2 });
      const temporaryId = seed.appendMessage(buildAssistantMessage("temporary error"));
      seed.appendCustomEntry("preserved-state", { retained: true });
      seed.appendLabelChange(temporaryId, "temporary label");
      const manager = SessionManager.open(
        scope,
        dir,
        failure === "bounded-sqlite" ? { maxEvents: 3, maxBytes: 4096 } : undefined,
      );
      const database = openOpenClawAgentDatabase({
        agentId: scope.agentId,
        path: resolveSessionTranscriptDatabasePath(scope),
      });
      const readRows = () =>
        database.db
          .prepare(
            "SELECT seq, event_json FROM transcript_events WHERE session_id = ? ORDER BY seq",
          )
          .all(scope.sessionId);
      const readManager = () => ({
        entries: manager.getEntries(),
        leafId: manager.getLeafId(),
        appendParentId: manager.getAppendParentId(),
        label: manager.getLabel(temporaryId),
        target: manager.getSessionTarget(),
        context: manager.buildSessionContext(),
      });
      const beforeRows = readRows();
      const beforeManager = structuredClone(readManager());
      if (failure.endsWith("sqlite")) {
        database.db.exec(`CREATE TRIGGER reject_tail_rewrite BEFORE INSERT ON transcript_events
          BEGIN SELECT RAISE(ABORT, 'tail rewrite failed'); END;`);
      } else {
        await updateSessionEntry(scope, () =>
          failure === "identity"
            ? { sessionId: "replacement-session" }
            : failure === "writer"
              ? { activeWriterRunId: "replacement-writer" }
              : { lifecycleRevision: "replacement-lifecycle" },
        );
      }
      const remove = () =>
        manager.removeTrailingEntries((entry) => entry.id === temporaryId, {
          preserveTrailing: (entry) => entry.type === "custom" || entry.type === "label",
        });
      const rewrite = () =>
        withOwnedSessionTranscriptWrites(
          {
            ...(failure === "writer" || failure === "lifecycle"
              ? {
                  sessionTarget: {
                    ...scope,
                    expectedWriterRunId: initialEntry.activeWriterRunId,
                    expectedLifecycleRevision: initialEntry.lifecycleRevision,
                  },
                }
              : {}),
            withTranscriptWrite: async (run) => await run(),
          },
          async () => remove(),
        );

      await expect(rewrite()).rejects.toThrow();
      expect(readRows()).toEqual(beforeRows);
      expect(readManager()).toEqual(beforeManager);

      if (failure.endsWith("sqlite")) {
        database.db.exec("DROP TRIGGER reject_tail_rewrite");
      } else {
        await upsertSessionEntryCore(scope, initialEntry);
      }
      await expect(rewrite()).resolves.toBe(1);
      expect(manager.getEntry(temporaryId)).toBeUndefined();
      expect(manager.getLabel(temporaryId)).toBeUndefined();
      if (failure === "bounded-sqlite") {
        await waitForSessionTranscriptIndexReconcile({
          agentId: scope.agentId,
          path: resolveSessionTranscriptDatabasePath(scope),
        });
      }
      const reopened =
        failure === "bounded-sqlite"
          ? SessionManager.open(scope, dir, { maxEvents: 3, maxBytes: 4096 })
          : SessionManager.open(scope, dir);
      if (failure === "bounded-sqlite") {
        expect(reopened.getEntry(temporaryId)).toBeUndefined();
        expect(reopened.getLabel(temporaryId)).toBeUndefined();
        expect(manager.getEntry(temporaryId)).toBeUndefined();
        expect(manager.getLabel(temporaryId)).toBeUndefined();
      } else {
        expect(reopened.getPersistedEntries()).toEqual(manager.getPersistedEntries());
      }
    },
  );

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

  it("keeps file fixture appends and rewrites readable after an unterminated record", async () => {
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
    const manager = openFileBackedSessionManagerForTest(sessionFile, dir);
    manager.appendMessage({
      role: "user",
      content: "appended",
      timestamp: 1,
    });
    expect(
      openFileBackedSessionManagerForTest(sessionFile, dir).buildSessionContext().messages,
    ).toEqual([expect.objectContaining({ content: "appended", role: "user" })]);
    expect(manager.removeTrailingEntries((entry) => entry.type === "message")).toBe(1);
    expect(
      openFileBackedSessionManagerForTest(sessionFile, dir).buildSessionContext().messages,
    ).toEqual([]);
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
