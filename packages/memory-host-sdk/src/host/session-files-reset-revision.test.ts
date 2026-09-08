import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  persistSessionTranscriptTurn,
  replaceTranscriptEventsSync,
  resetSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../../../../src/config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../../src/state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../../../src/state/openclaw-state-db.js";
import {
  buildSessionEntry,
  matchesSessionEntryPrefixHash,
  type SessionFileEntry,
} from "./session-files.js";

function requireSessionEntry(entry: SessionFileEntry | null): SessionFileEntry {
  if (!entry) {
    throw new Error("expected session entry");
  }
  return entry;
}

let tmpDir: string;
let previousStateDir: string | undefined;
let previousConfigPath: string | undefined;

beforeEach(() => {
  tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "session-reset-revision-test-"));
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  Reflect.set(process.env, "OPENCLAW_STATE_DIR", tmpDir);
  clearRuntimeConfigSnapshot();
  clearConfigCache();
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  if (previousStateDir === undefined) {
    Reflect.deleteProperty(process.env, "OPENCLAW_STATE_DIR");
  } else {
    Reflect.set(process.env, "OPENCLAW_STATE_DIR", previousStateDir);
  }
  if (previousConfigPath === undefined) {
    Reflect.deleteProperty(process.env, "OPENCLAW_CONFIG_PATH");
  } else {
    Reflect.set(process.env, "OPENCLAW_CONFIG_PATH", previousConfigPath);
  }
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  fsSync.rmSync(tmpDir, { recursive: true, force: true });
});

describe("SQLite session snapshots and reset content revision", () => {
  it.each(["interactive", "dreaming", "cron"])(
    "preserves SQLite/archive output and callback observations for %s transcripts",
    async (kind) => {
      const scope = {
        agentId: "main",
        sessionId: "parity",
        sessionKey: "agent:main:chat:parity",
        storePath: path.join(tmpDir, "agents", "main", "sessions", "sessions.json"),
      };
      const observedAt = Date.parse("2026-07-01T10:00:00.000Z");
      const messages = [
        { role: "user", content: "Owner preference.", __openclaw: { senderIsOwner: true } },
        { role: "assistant", content: "Derived answer.", __openclaw: { turnTainted: true } },
        {
          role: "user",
          content: "Internal poll.",
          provenance: { kind: "internal_system", sourceTool: "heartbeat" },
        },
        { role: "toolResult", content: "Background result." },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "write",
              arguments: { path: "MEMORY.md", content: "Internal note." },
            },
          ],
        },
        { role: "assistant", content: "Excluded heartbeat output." },
        {
          role: "user",
          content: "Recalled text.",
          provenance: { kind: "internal_system", sourceTool: "memory_get" },
        },
        { role: "assistant", content: "Excluded recalled output." },
        {
          role: "user",
          content: [{ type: "image", source: "photo.jpg" }],
          __openclaw: { senderIsOwner: true },
        },
        { role: "assistant", content: [{ type: "text", text: "Photo answer." }] },
      ];
      const records = [
        { type: "custom", customType: "metadata", data: {} },
        ...messages.map((message, index) => ({
          type: "message",
          id: `message-${index}`,
          timestamp: "2026-07-01T10:00:00.000Z",
          message,
        })),
      ];
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: observedAt });
      expect(replaceTranscriptEventsSync(scope, records)).toBe(true);
      const archivePath = path.join(tmpDir, "parity.jsonl.deleted.2026-07-01T10-00-00.000Z");
      fsSync.writeFileSync(archivePath, records.map((record) => JSON.stringify(record)).join("\n"));
      fsSync.utimesSync(archivePath, observedAt / 1000, observedAt / 1000);
      const options = {
        generatedByCronRun: kind === "cron",
        generatedByDreamingNarrative: kind === "dreaming",
        sessionKind: "interactive" as const,
      };
      const sqliteObserver = vi.fn();
      const archiveObserver = vi.fn();
      const sqlite = requireSessionEntry(
        await buildSessionEntry(scope.sessionKey, {
          ...scope,
          ...options,
          updatedAtMs: observedAt,
          onTranscriptMessage: sqliteObserver,
        }),
      );
      const archive = requireSessionEntry(
        await buildSessionEntry(archivePath, {
          ...options,
          onTranscriptMessage: archiveObserver,
        }),
      );

      expect(sqlite).toEqual({
        ...archive,
        absPath: scope.sessionKey,
        path: "sessions/main/parity.jsonl",
      });
      expect(sqlite.content).toBe(
        kind === "interactive"
          ? "User: Owner preference.\nAssistant: Derived answer.\nAssistant: Photo answer."
          : "",
      );
      expect(sqlite.lineMap).toEqual(kind === "interactive" ? [2, 3, 11] : []);
      expect(sqlite.messageTimestampsMs).toEqual(
        kind === "interactive" ? [observedAt, observedAt, observedAt] : [],
      );
      expect(sqlite.lineProvenance.map((line) => line.originClass)).toEqual(
        kind === "interactive" ? ["owner", "untrusted", "agent"] : [],
      );
      const observations = messages
        .filter((message) => message.role !== "toolResult")
        .map((message) => [message, observedAt]);
      expect(sqliteObserver.mock.calls).toEqual(observations);
      expect(archiveObserver.mock.calls).toEqual(observations);
      const cutoff = Symbol.for("openclaw.memory.sessionResetRecallCutoff");
      expect(Object.getOwnPropertyDescriptor(sqlite, cutoff)).toEqual(
        Object.getOwnPropertyDescriptor(archive, cutoff),
      );
    },
  );

  it("finishes the transcript snapshot before callbacks can replace its rows", async () => {
    const scope = {
      agentId: "main",
      sessionId: "callback-snapshot",
      sessionKey: "agent:main:callback-snapshot",
      storePath: path.join(tmpDir, "agents", "main", "sessions", "sessions.json"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const first = {
      type: "message",
      id: "first",
      parentId: null,
      message: { role: "user", content: "first" },
    };
    const kept = {
      type: "message",
      id: "kept",
      parentId: "first",
      message: { role: "assistant", content: "kept" },
    };
    const records = [
      first,
      kept,
      { type: "reset", id: "reset", parentId: "kept", firstKeptEntryId: "kept" },
    ];
    expect(replaceTranscriptEventsSync(scope, records)).toBe(true);
    const before = requireSessionEntry(await buildSessionEntry(scope.sessionKey, scope));
    const observed: unknown[] = [];
    const during = requireSessionEntry(
      await buildSessionEntry(scope.sessionKey, {
        ...scope,
        parseYieldEveryLines: 1,
        onTranscriptMessage: (message) => {
          observed.push(message);
          if (observed.length === 1) {
            expect(replaceTranscriptEventsSync(scope, [first])).toBe(true);
          }
        },
      }),
    );

    expect(during).toEqual(before);
    expect(observed).toEqual([first.message, kept.message]);
    const cutoff = Symbol.for("openclaw.memory.sessionResetRecallCutoff");
    expect(Object.getOwnPropertyDescriptor(during, cutoff)).toMatchObject({
      configurable: false,
      enumerable: false,
      writable: false,
      value: { state: "valid", cutoffLine: 2 },
    });
    const after = requireSessionEntry(await buildSessionEntry(scope.sessionKey, scope));
    expect(after.content).toBe("User: first");
    expect(Object.getOwnPropertyDescriptor(after, cutoff)?.value).toEqual({ state: "absent" });
  });

  it("accepts a transcript append but invalidates its prefix hash after reset", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:chat:reset-revision";
    const sessionId = "reset-revision";
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey, storePath },
      { sessionId, updatedAt: 1 },
    );
    await persistSessionTranscriptTurn(
      { agentId: "main", sessionId, sessionKey, storePath },
      {
        messages: [{ message: { role: "user", content: "unchanged exported text" } }],
        touchSessionEntry: true,
        updateMode: "none",
      },
    );
    const buildOptions = {
      agentId: "main",
      sessionId,
      sessionKey,
      storePath,
      updatedAtMs: 1,
    };
    const before = requireSessionEntry(await buildSessionEntry(sessionKey, buildOptions));
    const beforeLineCount = before.content.split("\n").length;

    await persistSessionTranscriptTurn(
      { agentId: "main", sessionId, sessionKey, storePath },
      {
        messages: [{ message: { role: "assistant", content: "ordinary appended text" } }],
        touchSessionEntry: true,
        updateMode: "none",
      },
    );
    const afterAppend = requireSessionEntry(await buildSessionEntry(sessionKey, buildOptions));
    expect(matchesSessionEntryPrefixHash(afterAppend, beforeLineCount, before.hash)).toBe(true);

    await resetSessionEntryLifecycle({
      agentId: "main",
      buildNextEntry: ({ currentEntry }) => ({
        ...currentEntry,
        sessionId,
        updatedAt: 2,
      }),
      resetBoundary: { context: "preserve-tail", reason: "reset", cwd: tmpDir },
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });

    const after = requireSessionEntry(await buildSessionEntry(sessionKey, buildOptions));
    expect(after.content).toBe(afterAppend.content);
    expect(after.lineMap).toEqual(afterAppend.lineMap);
    const cutoffSymbol = Symbol.for("openclaw.memory.sessionResetRecallCutoff");
    expect(Object.getOwnPropertyDescriptor(after, cutoffSymbol)).toMatchObject({
      enumerable: false,
      value: { state: "valid", cutoffLine: expect.any(Number) },
    });
    expect(Object.keys(after)).not.toContain(cutoffSymbol.description);
    expect(after.hash).not.toBe(before.hash);
    expect(matchesSessionEntryPrefixHash(after, beforeLineCount, before.hash)).toBe(false);
  });
});
