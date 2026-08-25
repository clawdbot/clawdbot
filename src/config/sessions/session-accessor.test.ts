import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import {
  readSessionProgressCard,
  writeSessionProgressCard,
} from "../../session-cards/progress-card-store.js";
import {
  onInternalSessionTranscriptUpdate,
  onSessionTranscriptUpdate,
} from "../../sessions/transcript-events.js";
import {
  closeOpenClawAgentDatabasesForTest,
  isOpenClawAgentDatabaseOpen,
  listOpenClawRegisteredAgentDatabases,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  isOpenClawStateDatabaseOpen,
} from "../../state/openclaw-state-db.js";
import { appendSqliteTrajectoryRuntimeEvents } from "../../trajectory/runtime-store.sqlite.js";
import type { TrajectoryEvent } from "../../trajectory/types.js";
import {
  deliveryContextFromSession,
  sessionDeliveryRoute,
} from "../../utils/delivery-context.shared.js";
import {
  applySessionEntryReplacements,
  applySessionPatchProjections,
  appendTranscriptEvent,
  appendTranscriptMessage,
  applySessionEntryLifecycleMutation,
  assignSessionOwner,
  commitReplySessionInitialization,
  countSessionEntryRowsReadOnly,
  createSessionEntryWithTranscript,
  deleteSessionEntryLifecycle,
  findTranscriptEvent,
  ensureSessionEntrySync,
  listSessionChildEntriesReadOnly,
  listSessionEntriesCore,
  listSessionEntriesByStatus,
  listSessionTranscriptInstances,
  loadReplySessionInitializationSnapshot,
  loadSessionEntry,
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
  markSessionAbortTarget,
  onSessionIdentityMutation,
  openSessionEntryReadView,
  patchSessionEntryCore,
  patchSessionEntryTarget,
  persistSessionTranscriptTurn,
  readTranscriptStatsSync,
  readSessionUpdatedAtCore,
  recordInboundSessionMeta,
  replaceSessionEntry,
  replaceTranscriptEventsSync,
  resetSessionEntryLifecycle,
  SessionInitializationAgentScopeMismatchError,
  type SessionPatchProjectionOperation,
  resolveSessionEntryAccessTarget,
  resolveSessionEntryCandidateTarget,
  resolveSessionEntrySelection,
  resolveSessionTranscriptReadTarget,
  resolveSessionTranscriptRuntimeTarget,
  trimSessionTranscriptForManualCompact,
  updateSessionEntry,
  updateSessionLastRoute,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import {
  readSessionEntryCount,
  readSessionEntryKeys,
} from "./session-accessor.sqlite-entry-store.js";
import { loadExactSessionEntry, replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { importSqliteSessionRows } from "./session-accessor.sqlite-import.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.js";
import { applySessionEntryCanonicalReplacements } from "./session-accessor.sqlite-replacement-projection.js";
import {
  appendTranscriptEventSync,
  replaceTranscriptEvents,
  trimTranscriptForManualCompact,
} from "./session-accessor.sqlite-transcript-write.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import {
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWrites,
} from "./transcript-write-context.js";
import type { InternalSessionEntry, SessionEntry } from "./types.js";

const cleanupArchivedSessionTranscriptsMock = vi.hoisted(() => vi.fn(async () => {}));
const tempDirs: string[] = [];

vi.mock("../../gateway/session-archive.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../gateway/session-archive.runtime.js")>();
  return {
    ...actual,
    cleanupArchivedSessionTranscripts: cleanupArchivedSessionTranscriptsMock,
  };
});

function createTestTrajectoryEvent(sessionId: string): TrajectoryEvent {
  return {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    traceId: sessionId,
    source: "runtime",
    type: "test.concurrent-write",
    ts: "2026-07-09T00:00:00.000Z",
    seq: 1,
    sessionId,
  };
}

function createManualCompactRecords(sessionId: string) {
  return [
    { type: "session", version: 3, id: sessionId, timestamp: "2026-06-19T12:00:00.000Z" },
    ...[1, 2, 3, 4].map((index) => ({
      type: "message",
      id: `entry-${index}`,
      parentId: index === 1 ? null : `entry-${index - 1}`,
      timestamp: `2026-06-19T12:00:0${index}.000Z`,
      message: { role: "user", content: `message ${index}`, timestamp: index },
    })),
  ];
}

describe("session accessor seam", () => {
  let tempDir: string;
  let storePath: string;
  let transcriptPath: string;
  let cleanupProbeDatabasePath = "";
  let cleanupProbeRoot = "";

  function loadMainInitializationSnapshot(sessionKey: string) {
    return loadReplySessionInitializationSnapshot({ agentId: "main", sessionKey, storePath });
  }

  beforeEach(() => {
    cleanupArchivedSessionTranscriptsMock.mockReset();
    tempDir = makeTempDir(tempDirs, "openclaw-session-accessor-");
    storePath = path.join(tempDir, "sessions.json");
    transcriptPath = path.join(tempDir, "session.jsonl");
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    cleanupTempDirs(tempDirs);
  });

  describe.sequential("session database teardown boundary", () => {
    it("opens cached agent and shared-state handles", async () => {
      await replaceSessionEntry(
        { agentId: "main", sessionKey: "agent:main:cleanup-probe", storePath },
        { sessionId: "cleanup-probe", updatedAt: 1 },
      );
      cleanupProbeDatabasePath = expectDefined(
        resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path,
        "cleanup probe database path",
      );
      cleanupProbeRoot = tempDir;

      expect(isOpenClawAgentDatabaseOpen(cleanupProbeDatabasePath)).toBe(true);
      expect(isOpenClawStateDatabaseOpen()).toBe(true);
    });

    it("releases both cache owners before the next test", () => {
      expect(isOpenClawAgentDatabaseOpen(cleanupProbeDatabasePath)).toBe(false);
      expect(isOpenClawStateDatabaseOpen()).toBe(false);
      expect(fs.existsSync(cleanupProbeRoot)).toBe(false);
    });
  });

  it("returns typed sync event append outcomes for missing, rebound, and duplicate rows", async () => {
    const scope = {
      agentId: "main",
      sessionId: "expected-session",
      sessionKey: "agent:main:typed-append",
      storePath,
    };
    const event = { type: "custom", id: "typed-event", timestamp: 1 };

    expect(appendTranscriptEventSync(scope, event)).toEqual({
      ok: false,
      error: {
        code: "session-entry-missing",
        expectedSessionId: scope.sessionId,
        sessionKey: scope.sessionKey,
      },
    });

    await upsertSessionEntryCore(scope, { sessionId: "replacement-session", updatedAt: 1 });
    expect(appendTranscriptEventSync(scope, event)).toEqual({
      ok: false,
      error: {
        actualSessionId: "replacement-session",
        code: "session-rebound",
        expectedSessionId: scope.sessionId,
        sessionKey: scope.sessionKey,
      },
    });

    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 2 });
    expect(appendTranscriptEventSync(scope, event)).toEqual({ ok: true, value: true });
    expect(appendTranscriptEventSync(scope, event)).toEqual({ ok: true, value: false });
  });

  it("loads, lists, and patches session entries without exposing the file store shape", async () => {
    const scope = {
      sessionKey: "agent:main:main",
      storePath,
    };

    await upsertSessionEntryCore(scope, {
      model: "gpt-5.5",
      sessionId: "session-1",
      updatedAt: 10,
    });

    expect(loadSessionEntry(scope)).toMatchObject({
      model: "gpt-5.5",
      sessionId: "session-1",
      updatedAt: expect.any(Number),
    });
    expect(readSessionUpdatedAtCore(scope)).toEqual(expect.any(Number));
    expect(listSessionEntriesCore({ storePath })).toEqual([
      {
        sessionKey: "agent:main:main",
        entry: expect.objectContaining({
          model: "gpt-5.5",
          sessionId: "session-1",
          updatedAt: expect.any(Number),
        }),
      },
    ]);

    await upsertSessionEntryCore(scope, { model: "sonnet-4.6", updatedAt: 20 });

    expect(loadSessionEntry(scope)).toMatchObject({
      model: "sonnet-4.6",
      sessionId: "session-1",
      updatedAt: expect.any(Number),
    });
  });

  it("derives a scoped key owner before fixed-store read and write target resolution", async () => {
    const fixedStorePath = path.join(tempDir, "fixed-sessions.json");
    const scope = {
      defaultAgentId: "main",
      sessionKey: "agent:ops:main",
      storePath: fixedStorePath,
    };

    await replaceSessionEntry(scope, {
      sessionId: "ops-session",
      updatedAt: 10,
    });

    expect(loadSessionEntry(scope)).toMatchObject({ sessionId: "ops-session" });
    await expect(loadTranscriptEvents({ ...scope, sessionId: "ops-session" })).resolves.toEqual([]);
    const opsPath = resolveSqliteTargetFromSessionStorePath(fixedStorePath, {
      agentId: "ops",
      defaultAgentId: "main",
    }).path;
    const mainPath = resolveSqliteTargetFromSessionStorePath(fixedStorePath, {
      agentId: "main",
      defaultAgentId: "main",
    }).path;
    expect(opsPath).not.toBe(mainPath);
    expect(fs.existsSync(opsPath)).toBe(true);
    expect(fs.existsSync(mainPath)).toBe(false);
  });

  it("excludes transcript-only nodes from logical entry counts and keys", async () => {
    await replaceSessionEntry(
      { sessionKey: "agent:main:logical-entry", storePath },
      { sessionId: "logical-entry-session", updatedAt: 10 },
    );
    await replaceTranscriptEvents(
      {
        agentId: "main",
        sessionId: "transcript-only-session",
        sessionKey: "agent:main:transcript-only",
        storePath,
      },
      [{ type: "session", id: "transcript-only-session" }],
    );
    const databasePath = expectDefined(
      resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path,
      "entry count database path",
    );
    const database = openOpenClawAgentDatabase({ agentId: "main", path: databasePath });

    expect(readSessionEntryCount(database)).toBe(1);
    expect(readSessionEntryKeys(database)).toEqual(["agent:main:logical-entry"]);
    expect(countSessionEntryRowsReadOnly({ agentId: "main", storePath })).toBe(2);
  });

  it("counts rows on a cold handle without parsing invalid entry JSON", async () => {
    await replaceSessionEntry(
      { sessionKey: "agent:main:cold-count", storePath },
      { sessionId: "cold-count-session", updatedAt: 10 },
    );
    const databasePath = expectDefined(
      resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path,
      "cold count database path",
    );
    closeOpenClawAgentDatabasesForTest();
    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE session_nodes SET entry_valid = 0").run();
    database.close();

    expect(countSessionEntryRowsReadOnly({ agentId: "main", storePath })).toBe(1);
  });

  it("retains legacy createdBy actor projections across rewrites", async () => {
    const sessionKey = "agent:main:created-by";
    await replaceSessionEntry({ sessionKey, storePath }, {
      createdBy: { id: "legacy-human" },
      sessionId: "created-by-session",
      updatedAt: 10,
    } as SessionEntry & { createdBy: { id: string } });
    await upsertSessionEntryCore({ sessionKey, storePath }, { label: "rewritten" });
    const databasePath = expectDefined(
      resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path,
      "createdBy database path",
    );
    const database = openOpenClawAgentDatabase({ agentId: "main", path: databasePath });

    expect(
      database.db
        .prepare(
          "SELECT created_actor_type, created_actor_id FROM session_nodes WHERE session_key = ?",
        )
        .get(sessionKey),
    ).toEqual({ created_actor_type: "human", created_actor_id: "legacy-human" });
  });

  it("lists retained transcript instances across same-key session rotation", async () => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:main",
      storePath,
    };
    await upsertSessionEntryCore(scope, {
      sessionId: "history-old",
      updatedAt: 10,
      pluginOwnerId: "history-owner",
      hookExternalContentSource: "webhook",
    });
    await appendTranscriptMessage(
      { ...scope, sessionId: "history-old" },
      { message: { role: "assistant", content: "old transcript" } },
    );
    await replaceSessionEntry(scope, { sessionId: "history-old", updatedAt: 15 });
    await upsertSessionEntryCore(scope, { sessionId: "history-new", updatedAt: 20 });
    await appendTranscriptMessage(
      { ...scope, sessionId: "history-new" },
      { message: { role: "assistant", content: "new transcript" } },
    );

    const instances = listSessionTranscriptInstances({ agentId: "main", storePath });
    expect(instances.map((instance) => instance.sessionId).toSorted()).toEqual([
      "history-new",
      "history-old",
    ]);
    expect(instances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entry: expect.objectContaining({
            hookExternalContentSource: "webhook",
            pluginOwnerId: "history-owner",
          }),
          provenanceKnown: true,
          sessionId: "history-old",
          sessionKey: "agent:main:main",
          updatedAtMs: expect.any(Number),
        }),
      ]),
    );

    const transcriptTimes = new Map(
      instances.map((instance) => [instance.sessionId, instance.updatedAtMs]),
    );
    await upsertSessionEntryCore(scope, { label: "renamed", updatedAt: Date.now() + 60_000 });
    expect(
      new Map(
        listSessionTranscriptInstances({ agentId: "main", storePath }).map((instance) => [
          instance.sessionId,
          instance.updatedAtMs,
        ]),
      ),
    ).toEqual(transcriptTimes);
  });

  it("marks transcript-only rows as unknown provenance", async () => {
    const scope = {
      agentId: "main",
      sessionId: "transcript-only",
      sessionKey: "agent:main:transcript-only",
      storePath,
    };
    await appendTranscriptMessage(scope, {
      message: { role: "assistant", content: "orphan transcript" },
    });

    expect(listSessionTranscriptInstances({ agentId: "main", storePath })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provenanceKnown: false,
          sessionId: "transcript-only",
        }),
      ]),
    );

    const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId: "main",
    }).path;
    expect(databasePath).toBeDefined();
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      path: databasePath,
    });
    database.db
      .prepare("UPDATE session_windows SET transcript_updated_at = NULL WHERE session_id = ?")
      .run(scope.sessionId);

    await replaceSessionEntry(
      { agentId: "main", sessionKey: scope.sessionKey, storePath },
      { sessionId: scope.sessionId, updatedAt: 20 },
    );
    await appendTranscriptMessage(scope, {
      message: { role: "assistant", content: "new transcript content" },
    });
    expect(listSessionTranscriptInstances({ agentId: "main", storePath })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provenanceKnown: false,
          sessionId: "transcript-only",
        }),
      ]),
    );
  });

  it("retains ACP ownership for custom-key transcript history", async () => {
    const sessionKey = "agent:main:main";
    const scope = { agentId: "main", sessionKey, storePath };
    await replaceSessionEntry(scope, {
      sessionId: "custom-key-acp",
      updatedAt: 10,
      acp: {
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: "custom-key-acp",
        mode: "persistent",
        state: "idle",
        lastActivityAt: 10,
      },
    });
    await appendTranscriptMessage(
      { ...scope, sessionId: "custom-key-acp" },
      { message: { role: "assistant", content: "ACP transcript" } },
    );
    await replaceSessionEntry(scope, { sessionId: "custom-key-acp", updatedAt: 15 });
    await replaceSessionEntry(scope, { sessionId: "interactive-replacement", updatedAt: 20 });

    expect(listSessionTranscriptInstances({ agentId: "main", storePath })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          acpOwned: true,
          provenanceKnown: true,
          sessionId: "custom-key-acp",
          sessionKey,
        }),
      ]),
    );
  });

  it("keeps migrated unknown provenance unknown while the session remains current", async () => {
    const sessionKey = "agent:main:migrated-plugin";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey, storePath },
      {
        sessionId: "migrated-plugin-session",
        pluginOwnerId: "plugin-owner",
        updatedAt: 10,
      },
    );
    await appendTranscriptMessage(
      { agentId: "main", sessionId: "migrated-plugin-session", sessionKey, storePath },
      { message: { role: "assistant", content: "plugin transcript" } },
    );
    const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId: "main",
    }).path;
    expect(databasePath).toBeDefined();
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      path: databasePath,
    });
    database.db
      .prepare(
        "UPDATE session_windows SET session_entry_provenance = 0, plugin_owner_id = NULL WHERE session_id = ?",
      )
      .run("migrated-plugin-session");

    expect(listSessionTranscriptInstances({ agentId: "main", storePath })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entry: expect.objectContaining({ pluginOwnerId: "plugin-owner" }),
          provenanceKnown: false,
          sessionId: "migrated-plugin-session",
        }),
      ]),
    );

    await upsertSessionEntryCore(
      { agentId: "main", sessionKey, storePath },
      {
        sessionId: "migrated-plugin-session",
        label: "updated",
        pluginOwnerId: "plugin-owner",
        updatedAt: 15,
      },
    );
    expect(listSessionTranscriptInstances({ agentId: "main", storePath })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entry: expect.objectContaining({ pluginOwnerId: "plugin-owner" }),
          provenanceKnown: false,
          sessionId: "migrated-plugin-session",
        }),
      ]),
    );

    await upsertSessionEntryCore(
      { agentId: "main", sessionKey, storePath },
      { sessionId: "replacement-session", updatedAt: 20 },
    );
    expect(listSessionTranscriptInstances({ agentId: "main", storePath })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provenanceKnown: false,
          sessionId: "migrated-plugin-session",
        }),
      ]),
    );
  });

  it("loads parsed transcript events from store-derived SQLite targets", async () => {
    const header = { type: "session", id: "session-events", timestamp: 1 };
    const message = { type: "message", id: "m1", message: { role: "assistant" } };

    // Transcript reads resolve to the SQLite transcript rows for the resolved
    // agent-scoped session; there is no legacy custom sessionFile read path.
    await upsertSessionEntryCore(
      { sessionKey: "agent:main:main", storePath },
      { sessionId: "session-events", updatedAt: 10 },
    );
    await replaceTranscriptEvents(
      { agentId: "main", sessionId: "session-events", sessionKey: "agent:main:main", storePath },
      [header, message],
    );
    const derived = await loadTranscriptEvents({
      sessionId: "session-events",
      sessionKey: "agent:main:main",
      storePath,
    });
    expect(derived).toEqual([header, message]);

    const missing = await loadTranscriptEvents({
      sessionId: "session-absent",
      sessionKey: "agent:main:main",
      storePath,
    });
    expect(missing).toEqual([]);
  });

  it("finds the newest matching transcript event without loading the whole transcript", async () => {
    const header = { type: "session", id: "session-find", timestamp: 1 };
    const older = { type: "message", id: "m1", message: { role: "assistant", tag: "old" } };
    const newer = { type: "message", id: "m2", message: { role: "assistant", tag: "new" } };
    await upsertSessionEntryCore(
      { sessionKey: "agent:main:main", storePath },
      { sessionId: "session-find", updatedAt: 10 },
    );
    await replaceTranscriptEvents(
      { agentId: "main", sessionId: "session-find", sessionKey: "agent:main:main", storePath },
      [header, older, newer],
    );

    const databasePath = expectDefined(
      resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path,
      "transcript find database path",
    );
    const database = openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
    const originalPrepare = database.db.prepare.bind(database.db);
    let transcriptRowsRead = 0;
    // Count SQLite rows rather than matcher calls: eager materialization happens before matching.
    const prepareSpy = vi.spyOn(database.db, "prepare").mockImplementation((sql) => {
      const statement = originalPrepare(sql);
      return new Proxy(statement, {
        get(target, property) {
          if (property === "iterate") {
            return (...params: Parameters<typeof target.iterate>) => {
              const iterator = target.iterate(...params);
              return (function* () {
                for (const row of iterator) {
                  if ("event_json" in row) {
                    transcriptRowsRead += 1;
                  }
                  yield row;
                }
              })() as ReturnType<typeof target.iterate>;
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    const seen: unknown[] = [];
    const found = await findTranscriptEvent(
      { sessionId: "session-find", sessionKey: "agent:main:main", storePath },
      (event) => {
        seen.push(event);
        return (event as { type?: string }).type === "message";
      },
    ).finally(() => prepareSpy.mockRestore());
    // Newest-first with early exit: the older message is never visited.
    expect(found).toEqual({ event: newer });
    expect(seen).toEqual([newer]);
    expect(transcriptRowsRead).toBe(1);

    await replaceTranscriptEvents(
      { agentId: "main", sessionId: "session-falsy", sessionKey: "agent:main:falsy", storePath },
      [false],
    );
    const falsy = await findTranscriptEvent(
      { sessionId: "session-falsy", sessionKey: "agent:main:falsy", storePath },
      () => true,
    );
    expect(falsy).toEqual({ event: false });

    const missing = await findTranscriptEvent(
      { sessionId: "session-absent", sessionKey: "agent:main:main", storePath },
      () => true,
    );
    expect(missing).toBeUndefined();
  });

  it("opens a borrowed read view with raw exact-key probes and deferred enumeration", async () => {
    const mixedKey = "agent:main:matrix:channel:!RoomAbC:example.org";
    await upsertSessionEntryCore(
      { sessionKey: mixedKey, storePath },
      { sessionId: "mixed-session", updatedAt: 10 },
    );

    const view = openSessionEntryReadView({ storePath });

    expect(view.get(mixedKey)?.sessionId).toBe("mixed-session");
    // Raw probe contract: unlike loadSessionEntry, no folded-alias or
    // canonical-key resolution happens on get.
    expect(view.get(mixedKey.toLowerCase())).toBeUndefined();
    expect(view.entries()).toEqual([
      {
        sessionKey: mixedKey,
        entry: expect.objectContaining({ sessionId: "mixed-session" }),
      },
    ]);
  });

  it("keeps case-distinct Matrix sessions separate under nested agent ownership", async () => {
    const mixedKey = "agent:voice:agent:other:matrix:channel:!RoomAbC:example.org";
    const lowerKey = "agent:voice:agent:other:matrix:channel:!Roomabc:example.org";

    await upsertSessionEntryCore(
      { sessionKey: mixedKey, storePath },
      { sessionId: "mixed-session", updatedAt: 10 },
    );
    await upsertSessionEntryCore(
      { sessionKey: lowerKey, storePath },
      { sessionId: "lower-session", updatedAt: 20 },
    );

    expect(loadSessionEntry({ sessionKey: mixedKey, storePath })?.sessionId).toBe("mixed-session");
    expect(loadSessionEntry({ sessionKey: lowerKey, storePath })?.sessionId).toBe("lower-session");
    expect(
      listSessionEntriesCore({ agentId: "voice", storePath }).map((entry) => entry.sessionKey),
    ).toEqual([mixedKey, lowerKey]);
  });

  it("records inbound session meta as a createIfMissing upsert returning a detached entry", async () => {
    const sessionKey = "agent:main:webchat:dm:user-1";
    const ctx: MsgContext = {
      Provider: "webchat",
      Surface: "webchat",
      ChatType: "direct",
      From: "webchat:user-1",
      SenderId: "webchat:user-1",
      To: "webchat:agent",
      SessionKey: sessionKey,
      OriginatingTo: "webchat:user-1",
    };

    const recorded = await recordInboundSessionMeta({ storePath, sessionKey, ctx });
    expect(recorded?.delivery).toEqual({ kind: "internal" });
    expect(recorded).toMatchObject({
      chatType: "direct",
      createdVia: "channel",
      createdActor: { type: "human", id: "webchat:user-1" },
      createdAt: expect.any(Number),
    });
    const creationStamp = {
      createdVia: recorded?.createdVia,
      createdActor: recorded?.createdActor,
      createdAt: recorded?.createdAt,
    };

    await recordInboundSessionMeta({
      storePath,
      sessionKey,
      ctx: { ...ctx, From: "webchat:different-route", SenderId: "webchat:different-sender" },
    });
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject(creationStamp);

    // Detached result: caller mutations must never leak into cached store state.
    if (recorded) {
      recorded.delivery = { kind: "none" };
    }
    expect(loadSessionEntry({ sessionKey, storePath })?.delivery).toEqual({ kind: "internal" });

    const operatorKey = "agent:main:dashboard:operator-created";
    const operator = await recordInboundSessionMeta({
      storePath,
      sessionKey: operatorKey,
      ctx: {
        ...ctx,
        SessionKey: operatorKey,
        SessionCreation: {
          via: "operator",
          actor: { type: "human", id: "profile-ada" },
        },
      },
    });
    expect(operator).toMatchObject({
      createdVia: "operator",
      createdActor: { type: "human", id: "profile-ada" },
      createdAt: expect.any(Number),
    });

    const senderlessKey = "agent:main:webchat:dm:senderless";
    const senderless = await recordInboundSessionMeta({
      storePath,
      sessionKey: senderlessKey,
      ctx: {
        ...ctx,
        SessionKey: senderlessKey,
        From: "webchat:room-route",
        SenderId: undefined,
      },
    });
    expect(senderless).toMatchObject({
      createdVia: "channel",
      createdAt: expect.any(Number),
    });
    expect(senderless?.createdActor).toBeUndefined();
  });

  it("does not create sessions when inbound meta recording opts out of upsert", async () => {
    const sessionKey = "agent:main:webchat:dm:absent";
    const recorded = await recordInboundSessionMeta({
      storePath,
      sessionKey,
      ctx: { Provider: "webchat", From: "webchat:absent", OriginatingTo: "webchat:absent" },
      createIfMissing: false,
    });

    expect(recorded).toBeNull();
    expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
  });

  it("preserves activity timestamps across inbound meta and last-route updates", async () => {
    const sessionKey = "agent:main:webchat:dm:user-2";
    const anchorUpdatedAt = Date.now() - 60_000;
    await replaceSessionEntry(
      { sessionKey, storePath },
      { sessionId: "session-2", updatedAt: anchorUpdatedAt },
    );

    await recordInboundSessionMeta({
      storePath,
      sessionKey,
      ctx: {
        Provider: "webchat",
        Surface: "webchat",
        ChatType: "direct",
        From: "webchat:user-2",
        To: "webchat:agent",
        SessionKey: sessionKey,
        OriginatingTo: "webchat:user-2",
      },
    });
    const afterMeta = loadSessionEntry({ sessionKey, storePath });
    expect(afterMeta?.delivery).toEqual({ kind: "internal" });
    // Inbound metadata must not count as activity; idle reset relies on
    // updatedAt moving only for real session turns.
    expect(afterMeta?.updatedAt).toBe(anchorUpdatedAt);

    const routed = await updateSessionLastRoute({
      storePath,
      sessionKey,
      channel: "webchat",
      to: "webchat:user-2",
    });
    expect(routed?.delivery).toEqual({ kind: "internal" });
    const afterRoute = loadSessionEntry({ sessionKey, storePath });
    expect(deliveryContextFromSession(afterRoute)).toBeUndefined();
    expect(sessionDeliveryRoute(afterRoute)).toBeUndefined();
    expect(afterRoute?.updatedAt).toBe(anchorUpdatedAt);
  });

  it("returns null from last-route updates for missing sessions when createIfMissing is false", async () => {
    const sessionKey = "agent:main:webchat:dm:ghost";
    const routed = await updateSessionLastRoute({
      storePath,
      sessionKey,
      channel: "webchat",
      to: "webchat:ghost",
      createIfMissing: false,
    });

    expect(routed).toBeNull();
    expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
  });

  it("runs the last-route ownership guard at the SQLite commit edge", async () => {
    const sessionKey = "agent:main:webchat:dm:revoked-route";

    await expect(
      updateSessionLastRoute({
        storePath,
        sessionKey,
        channel: "webchat",
        to: "webchat:revoked-route",
        assertCommitAllowed: () => {
          throw new Error("route owner changed");
        },
      }),
    ).rejects.toThrow("route owner changed");

    expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
  });

  it("stamps last-route creation from the participant, never the conversation route", async () => {
    const participantKey = "agent:main:webchat:dm:route-participant";
    const participant = await updateSessionLastRoute({
      storePath,
      sessionKey: participantKey,
      channel: "webchat",
      to: "webchat:room-1",
      ctx: { From: "webchat:room-1", SenderId: "webchat:person-1" },
    });
    expect(participant).toMatchObject({
      createdVia: "channel",
      createdActor: { type: "human", id: "webchat:person-1" },
    });

    const senderlessKey = "agent:main:webchat:dm:route-senderless";
    const senderless = await updateSessionLastRoute({
      storePath,
      sessionKey: senderlessKey,
      channel: "webchat",
      to: "webchat:room-2",
      ctx: { From: "webchat:room-2" },
    });
    expect(senderless?.createdVia).toBe("channel");
    expect(senderless?.createdActor).toBeUndefined();
  });

  it("rejects alias targets and keeps canonical lifecycle mutations explicit", async () => {
    await replaceSessionEntry(
      { sessionKey: "agent:main:work", storePath },
      { sessionId: "canonical-session", updatedAt: 10 },
    );
    await replaceSessionEntry(
      { sessionKey: "agent:main:main", storePath },
      { sessionId: "legacy-session", updatedAt: 20 },
    );
    const notify = vi.fn();
    const unsubscribe = onSessionIdentityMutation(notify);
    await expect(
      patchSessionEntryTarget(
        {
          storePath,
          target: {
            canonicalKey: "agent:main:work",
            storeKeys: ["agent:main:work", "agent:main:main"],
          },
        },
        () => ({ label: "patched" }),
      ),
    ).rejects.toThrow("openclaw doctor --fix");
    await expect(
      patchSessionEntryTarget(
        {
          storePath,
          target: {
            canonicalKey: "agent:main:work",
            storeKeys: ["agent:main:main"],
          },
        },
        () => ({ label: "patched alias" }),
      ),
    ).rejects.toThrow("openclaw doctor --fix");
    await deleteSessionEntryLifecycle({
      archiveTranscript: false,
      storePath,
      target: {
        canonicalKey: "agent:main:main",
        storeKeys: ["agent:main:main"],
      },
    });
    await patchSessionEntryTarget(
      {
        storePath,
        target: {
          canonicalKey: "agent:main:work",
          storeKeys: ["agent:main:work"],
        },
      },
      () => ({ label: "patched" }),
    );
    const sessionKey = "agent:main:other";
    const scope = { sessionKey, storePath };
    await replaceSessionEntry(scope, { sessionId: "created", updatedAt: 10 });
    await patchSessionEntryCore(scope, () => ({ label: "same identity" }));
    await replaceSessionEntry(scope, { sessionId: "replaced", updatedAt: 20 });
    const target = { canonicalKey: sessionKey, storeKeys: [sessionKey] };
    await resetSessionEntryLifecycle({
      buildNextEntry: () => ({ sessionId: "reset", updatedAt: 30 }),
      storePath,
      target,
    });
    await deleteSessionEntryLifecycle({ archiveTranscript: false, storePath, target });
    unsubscribe();

    expect(notify.mock.calls.map(([event]) => event.kind)).toEqual([
      "delete",
      "create",
      "replace",
      "reset",
      "delete",
    ]);
  });

  it("rejects non-canonical lineage without poisoning the store", async () => {
    const sessionKey = "agent:main:child";
    for (const entry of [{ parentSessionKey: "Agent:Main:Parent " }, { spawnedBy: " " }]) {
      await expect(
        replaceSessionEntry(
          { agentId: "main", sessionKey, storePath },
          { ...entry, sessionId: "child", updatedAt: 10 },
        ),
      ).rejects.toThrow("openclaw doctor --fix");
    }
    expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toBeUndefined();

    await replaceSessionEntry(
      { agentId: "main", sessionKey, storePath },
      {
        parentSessionKey: "agent:main:parent",
        sessionId: "child",
        updatedAt: 10,
      },
    );
    expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toMatchObject({
      parentSessionKey: "agent:main:parent",
      sessionId: "child",
    });
  });

  it("does not persist abort target changes when the entry is absent", async () => {
    const result = await markSessionAbortTarget({
      scope: {
        sessionKey: "agent:main:missing",
        storePath,
      },
      resolveAbortCutoff: () => ({ messageSid: "unused" }),
    });

    expect(result).toBeNull();
    expect(fs.existsSync(storePath)).toBe(false);
  });

  it("returns an implicit candidate fallback without persisting it", () => {
    const resolved = resolveSessionEntryCandidateTarget({
      agentId: "main",
      candidateKeys: ["agent:main:missing"],
      cfg: { session: { store: storePath } },
      fallback: {
        sessionKey: "agent:main:current",
        entry: {
          sessionId: "",
          updatedAt: 40,
        },
      },
    });

    expect(resolved).toEqual({
      agentId: "main",
      candidateKey: "agent:main:current",
      entry: {
        sessionId: "",
        updatedAt: 40,
      },
      persisted: false,
      sessionKey: "agent:main:current",
    });
    expect(fs.existsSync(storePath)).toBe(false);
  });

  it("does not parse unrelated blobs across focused child, candidate, and transcript reads", async () => {
    const sessionKey = "agent:main:focused-session";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey, storePath },
      { sessionId: "focused-session", updatedAt: 42 },
    );
    for (const [childSessionKey, lineage] of [
      ["agent:main:focused-both-child", { spawnedBy: sessionKey }],
      ["agent:main:focused-parent-child", { parentSessionKey: sessionKey }],
      [
        "agent:main:focused-spawned-child",
        { parentSessionKey: "agent:main:other-parent", spawnedBy: sessionKey },
      ],
    ] as const) {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: childSessionKey, storePath },
        { ...lineage, sessionId: childSessionKey, updatedAt: 43 },
      );
    }
    const databasePath = expectDefined(
      resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path,
      "focused session database path",
    );
    const database = openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
    const unrelatedEntryJson = "{ unrelated, intentionally invalid JSON";
    database.db
      .prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run("agent:main:unrelated-session", "unrelated-session", unrelatedEntryJson, 1);

    const parse = vi.spyOn(JSON, "parse");
    try {
      expect(
        listSessionChildEntriesReadOnly({ agentId: "main", sessionKey, storePath }).map(
          (child) => child.sessionKey,
        ),
      ).toEqual([
        "agent:main:focused-both-child",
        "agent:main:focused-parent-child",
        "agent:main:focused-spawned-child",
      ]);
      expect(parse.mock.calls.filter(([value]) => value === unrelatedEntryJson)).toHaveLength(0);
      expect(
        resolveSessionEntrySelection({ agentId: "main", sessionKey, storePath }),
      ).toMatchObject({
        existing: { sessionId: "focused-session" },
        legacyKeys: [],
        normalizedKey: sessionKey,
      });
      expect(parse.mock.calls.filter(([value]) => value === unrelatedEntryJson)).toHaveLength(0);
      expect(
        resolveSessionEntryCandidateTarget({
          agentId: "main",
          candidateKeys: [sessionKey],
          cfg: { session: { store: storePath } },
        }),
      ).toMatchObject({ sessionKey, entry: { sessionId: "focused-session" }, persisted: true });
      expect(
        resolveSessionTranscriptReadTarget({
          agentId: "main",
          sessionId: "focused-session",
          sessionKey,
          storePath,
        }),
      ).toMatchObject({ agentId: "main", sessionId: "focused-session", sessionKey });
      expect(parse.mock.calls.filter(([value]) => value === unrelatedEntryJson)).toHaveLength(0);
    } finally {
      parse.mockRestore();
    }
  });

  it("resolves non-main candidate entries from custom agent store templates", async () => {
    const storeTemplate = path.join(tempDir, "{agentId}.json");
    const supportStorePath = path.join(tempDir, "support.json");
    await upsertSessionEntryCore(
      {
        agentId: "support",
        sessionKey: "agent:support:main",
        storePath: supportStorePath,
      },
      {
        sessionId: "support-session",
        updatedAt: 30,
      },
    );

    const resolved = resolveSessionEntryCandidateTarget({
      agentId: "support",
      candidateKeys: ["agent:support:main"],
      cfg: {
        session: { store: storeTemplate },
        agents: { entries: { support: { default: true } } },
      },
    });

    expect(resolved).toMatchObject({
      agentId: "support",
      candidateKey: "agent:support:main",
      entry: { sessionId: "support-session" },
      persisted: true,
      sessionKey: "agent:support:main",
    });
  });

  it("resolves non-main logical entries from custom agent store templates", async () => {
    const storeTemplate = path.join(tempDir, "{agentId}.json");
    const supportStorePath = path.join(tempDir, "support.json");
    await upsertSessionEntryCore(
      {
        agentId: "support",
        sessionKey: "agent:support:main",
        storePath: supportStorePath,
      },
      {
        sessionId: "support-session",
        updatedAt: 30,
      },
    );

    const resolved = resolveSessionEntryAccessTarget({
      cfg: {
        session: { store: storeTemplate },
        agents: { entries: { support: { default: true } } },
      },
      sessionKey: "agent:support:main",
    });

    expect(resolved).toMatchObject({
      agentId: "support",
      canonicalKey: "agent:support:main",
      entry: { sessionId: "support-session" },
      requestedKey: "agent:support:main",
      storeKey: "agent:support:main",
    });
  });

  it("creates durable session ids for metadata-only inserts", async () => {
    const scope = {
      sessionKey: "agent:main:main",
      storePath,
    };

    const inserted = await upsertSessionEntryCore(scope, { model: "gpt-5.5" });

    expect(inserted?.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(inserted?.sessionId).not.toBe(scope.sessionKey);
    expect(loadSessionEntry(scope)?.sessionId).toBe(inserted?.sessionId);
  });

  it("creates entries with initialized SQLite transcripts and scoped session metadata", async () => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:main",
      storePath,
    };

    const created = await createSessionEntryWithTranscript(scope, ({ sessionEntries }) => {
      expect(sessionEntries).toEqual({});
      return {
        ok: true,
        entry: {
          sessionId: "session-1",
          updatedAt: 10,
        },
      };
    });

    expect(created.ok).toBe(true);
    if (!created.ok) {
      throw new Error("expected session creation to succeed");
    }
    expect(created.sessionFile).toBe(scope.sessionKey);
    expect(created.entry).not.toHaveProperty("sessionFile");
    await expect(
      loadTranscriptEvents({
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath,
      }),
    ).resolves.toEqual([expect.objectContaining({ id: "session-1", type: "session" })]);
  });

  it("resolves the default-store SQLite identity before appending", async () => {
    const stateDir = path.join(tempDir, "state");
    const expectedStorePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const scope = {
      agentId: "main",
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
      },
      sessionId: "default-store-turn-session",
      sessionKey: "agent:main:default-store-turn",
    };
    await upsertSessionEntryCore(
      { ...scope, storePath: expectedStorePath },
      {
        sessionId: scope.sessionId,
        updatedAt: 10,
      },
    );

    const result = await persistSessionTranscriptTurn(scope, {
      messages: [{ message: { role: "user", content: "default store sqlite turn" } }],
      touchSessionEntry: true,
      updateMode: "none",
    });

    const persistedScope = { ...scope, storePath: expectedStorePath };
    expect(result.sessionEntry).not.toHaveProperty("sessionFile");
    expect(loadSessionEntry(persistedScope)).not.toHaveProperty("sessionFile");
    await expect(loadTranscriptEvents(persistedScope)).resolves.toContainEqual(
      expect.objectContaining({
        type: "message",
        message: expect.objectContaining({
          role: "user",
          content: "default store sqlite turn",
        }),
      }),
    );
  });

  it("rejects a transcript turn when the session id rotates mid-append", async () => {
    const scope = {
      agentId: "main",
      sessionId: "old-rotate-session",
      sessionKey: "agent:main:turn-rotate",
      storePath,
    };
    await replaceSessionEntry(
      { sessionKey: scope.sessionKey, storePath },
      { sessionId: scope.sessionId, updatedAt: Date.now() },
    );

    const result = await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          message: { role: "user", content: "rotate-hello", timestamp: Date.now() },
          shouldAppend: async () => {
            // Simulate a concurrent reset rotating the session id between target
            // resolution and the transcript append.
            await replaceSessionEntry(
              { sessionKey: scope.sessionKey, storePath },
              { sessionId: "new-rotate-session", updatedAt: Date.now() },
            );
            return true;
          },
        },
      ],
      touchSessionEntry: true,
      updateMode: "none",
    });

    expect(result.rejectedReason).toBe("session-rebound");
    // The message must not be silently written into the stale session transcript.
    await expect(
      loadTranscriptEvents({ ...scope, sessionId: "old-rotate-session" }),
    ).resolves.not.toContainEqual(
      expect.objectContaining({
        type: "message",
        message: expect.objectContaining({ content: "rotate-hello" }),
      }),
    );
  });

  it("rejects a default-store transcript turn when the session id rotates mid-append", async () => {
    // Caller omits storePath; resolveTranscriptTurnTarget derives the default
    // store. The guarded path must still apply so rotation is visible.
    const stateDir = path.join(tempDir, "state-rotate-default");
    const expectedStorePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const scope = {
      agentId: "main",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      sessionId: "old-default-rotate",
      sessionKey: "agent:main:default-rotate",
    };
    await replaceSessionEntry(
      { sessionKey: scope.sessionKey, storePath: expectedStorePath },
      { sessionId: scope.sessionId, updatedAt: Date.now() },
    );

    const result = await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          message: { role: "user", content: "default-rotate-hello", timestamp: Date.now() },
          shouldAppend: async () => {
            await replaceSessionEntry(
              { sessionKey: scope.sessionKey, storePath: expectedStorePath },
              { sessionId: "new-default-rotate", updatedAt: Date.now() },
            );
            return true;
          },
        },
      ],
      touchSessionEntry: true,
      updateMode: "none",
    });

    expect(result.rejectedReason).toBe("session-rebound");
    await expect(
      loadTranscriptEvents({
        agentId: "main",
        sessionId: "old-default-rotate",
        sessionKey: scope.sessionKey,
        storePath: expectedStorePath,
      }),
    ).resolves.not.toContainEqual(
      expect.objectContaining({
        type: "message",
        message: expect.objectContaining({ content: "default-rotate-hello" }),
      }),
    );
  });

  it("keeps sessionStore-mirrored transcript turns on the legacy append path (#119221)", async () => {
    // Mirror-only sessionStore callers (entry from memory, not a persisted
    // SQLite row) must stay on the legacy append — the guarded transaction
    // requires a persisted row to validate and would reject as session-rebound.
    // Populate the mirror with an entry and deliberately create NO SQLite row,
    // so resolveTranscriptTurnTarget resolves from the mirror (resolved.existing)
    // and loadSessionEntry finds nothing — entryFromPersistedStore stays false.
    const sessionStore = {} as Record<string, import("./types.js").SessionEntry>;
    const scope = {
      agentId: "main",
      sessionId: "mirror-only-session",
      sessionKey: "agent:main:mirror-only",
      storePath,
      sessionStore,
    };
    sessionStore[scope.sessionKey] = {
      sessionId: scope.sessionId,
      updatedAt: Date.now(),
    };
    // No replaceSessionEntry: the SQLite store has no row for this key.

    const result = await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          message: { role: "user", content: "mirror-only-hello", timestamp: Date.now() },
        },
      ],
      touchSessionEntry: true,
      updateMode: "none",
    });

    // No session-rebound — the legacy append accepted the message.
    expect(result.rejectedReason).toBeUndefined();
    expect(result.appendedCount).toBe(1);
  });

  it("does not create database state for rejected memory-only transcript turns", async () => {
    for (const source of ["sessionStore", "sessionEntry"] as const) {
      const stateDir = path.join(tempDir, `rejected-memory-only-${source}`);
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const agentId = "main";
      const sessionKey = `agent:main:rejected-memory-only-${source}`;
      const sessionId = `rejected-memory-only-${source}`;
      const memoryStorePath = path.join(stateDir, "agents", agentId, "sessions", "sessions.json");
      const databasePath = resolveOpenClawAgentSqlitePath({ agentId, env });
      const sessionEntry: SessionEntry = { sessionId, updatedAt: Date.now() };
      const memorySource =
        source === "sessionStore"
          ? { sessionStore: { [sessionKey]: sessionEntry } }
          : { sessionEntry };
      expect(
        loadSessionEntryReadOnly({ agentId, env, sessionKey, storePath: memoryStorePath }),
      ).toBeUndefined();
      expect(fs.existsSync(databasePath)).toBe(false);

      const result = await persistSessionTranscriptTurn(
        { agentId, env, sessionId, sessionKey, storePath: memoryStorePath, ...memorySource },
        {
          messages: [
            {
              message: { role: "user", content: "rejected-memory-only" },
              shouldAppend: () => false,
            },
          ],
          touchSessionEntry: true,
          updateMode: "none",
        },
      );

      expect(result).toMatchObject({ appendedCount: 0, messages: [] });
      expect(fs.existsSync(databasePath)).toBe(false);
      expect(isOpenClawAgentDatabaseOpen(databasePath)).toBe(false);
      expect(listOpenClawRegisteredAgentDatabases({ env })).toEqual([]);
    }
  });

  it("guards durable sessionStore transcript turns when the entry falls back to SQLite (#119221)", async () => {
    // sessionStore mirror is empty (no entry for the key), so resolveTranscriptTurnTarget
    // falls back to loadSessionEntry (SQLite). The entry is persisted — the guarded
    // path must apply and reject on rotation.
    const scope = {
      agentId: "main",
      sessionId: "durable-fallback-session",
      sessionKey: "agent:main:durable-fallback",
      storePath,
      sessionStore: {} as Record<string, import("./types.js").SessionEntry>,
    };
    await replaceSessionEntry(
      { sessionKey: scope.sessionKey, storePath },
      { sessionId: scope.sessionId, updatedAt: Date.now() },
    );

    const result = await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          message: { role: "user", content: "durable-fallback-hello", timestamp: Date.now() },
          shouldAppend: async () => {
            await replaceSessionEntry(
              { sessionKey: scope.sessionKey, storePath },
              { sessionId: "new-durable-fallback", updatedAt: Date.now() },
            );
            return true;
          },
        },
      ],
      touchSessionEntry: true,
      updateMode: "none",
    });

    expect(result.rejectedReason).toBe("session-rebound");
  });

  it("rejects a transcript turn when the session id rotates before target resolution", async () => {
    // A reset wins before resolveTranscriptTurnTarget reads the entry, so the
    // resolved entry already holds the replacement id. The caller still passes
    // its old id. The guarded transaction must use the caller's id (not the
    // resolved entry's) to detect the mismatch and reject.
    const scope = {
      agentId: "main",
      sessionId: "old-preresolve-session",
      sessionKey: "agent:main:preresolve-rotate",
      storePath,
    };
    // Rotate the entry before the turn is attempted — resolve will read the new id.
    await replaceSessionEntry(
      { sessionKey: scope.sessionKey, storePath },
      { sessionId: "new-preresolve-session", updatedAt: Date.now() },
    );

    const result = await persistSessionTranscriptTurn(scope, {
      messages: [{ message: { role: "user", content: "preresolve-hello", timestamp: Date.now() } }],
      touchSessionEntry: true,
      updateMode: "none",
    });

    expect(result.rejectedReason).toBe("session-rebound");
    await expect(
      loadTranscriptEvents({ ...scope, sessionId: "new-preresolve-session" }),
    ).resolves.not.toContainEqual(
      expect.objectContaining({
        type: "message",
        message: expect.objectContaining({ content: "preresolve-hello" }),
      }),
    );
  });

  it("appends SQLite turns to the active transcript leaf", async () => {
    const scope = {
      agentId: "main",
      sessionId: "branched-topic-session",
      sessionKey: "agent:main:telegram:group:1:topic:4",
      storePath,
    };
    await replaceTranscriptEvents(scope, [
      { type: "session", version: 3, id: scope.sessionId },
      {
        type: "message",
        id: "root",
        parentId: null,
        message: { role: "user", content: "root prompt" },
      },
      {
        type: "message",
        id: "abandoned",
        parentId: "root",
        message: { role: "assistant", content: "abandoned answer" },
      },
      {
        type: "leaf",
        id: "select-root",
        parentId: "abandoned",
        targetId: "root",
        appendParentId: "root",
      },
    ]);

    await persistSessionTranscriptTurn(scope, {
      messages: [{ message: { role: "assistant", content: "active answer" } }],
      updateMode: "none",
    });

    const appended = (await loadTranscriptEvents(scope)).at(-1);
    expect(appended).toMatchObject({
      type: "message",
      parentId: "root",
      message: { role: "assistant", content: "active answer" },
    });
  });

  it("does not persist the entry when creation validation fails", async () => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:main",
      storePath,
    };

    const created = await createSessionEntryWithTranscript(scope, () => ({
      error: "invalid patch",
      ok: false,
    }));

    expect(created).toMatchObject({
      ok: false,
      phase: "entry",
    });
    expect(loadSessionEntry(scope)).toBeUndefined();
    expect(listSessionEntriesCore({ storePath })).toEqual([]);
  });

  it("does not write the session database when entry preparation is rejected", async () => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:main",
      storePath,
    };
    await upsertSessionEntryCore(scope, {
      sessionId: "pending-session",
      updatedAt: 10,
      initializationPending: true,
    });
    const databasePath = path.join(tempDir, "openclaw-agent.sqlite");
    const fixedTime = new Date("2020-01-01T00:00:00.000Z");
    fs.utimesSync(databasePath, fixedTime, fixedTime);

    const rejected = await createSessionEntryWithTranscript(scope, () => ({
      ok: false,
      error: "still initializing",
    }));

    expect(rejected).toEqual({
      ok: false,
      error: "still initializing",
      phase: "entry",
    });
    expect(fs.statSync(databasePath).mtimeMs).toBe(fixedTime.getTime());
    expect(loadSessionEntry({ ...scope, readConsistency: "latest" })).toMatchObject({
      sessionId: "pending-session",
      initializationPending: true,
    });
  });

  it("rejects stale reply session initialization snapshots without writing", async () => {
    const sessionKey = "agent:main:main";
    await upsertSessionEntryCore(
      { sessionKey, storePath },
      {
        sessionId: "first-session",
        updatedAt: 10,
      },
    );
    const snapshot = loadMainInitializationSnapshot(sessionKey);
    await upsertSessionEntryCore(
      { sessionKey, storePath },
      {
        sessionId: "second-session",
        updatedAt: 20,
      },
    );

    const committed = await commitReplySessionInitialization({
      activeSessionKey: sessionKey,
      agentId: "main",
      expectedRevision: snapshot.revision,
      sessionEntry: {
        sessionId: "stale-session",
        updatedAt: 30,
      },
      sessionKey,
      storePath,
    });

    expect(committed).toMatchObject({
      ok: false,
      reason: "stale-snapshot",
    });
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      sessionId: "second-session",
    });
  });

  it.each([
    {
      name: "commits reply session initialization despite active-turn metadata changes",
      initial: {},
      concurrent: { compactionCount: 1, totalTokensFresh: false, updatedAt: 11 },
      prepared: {},
      expected: { compactionCount: 1, totalTokensFresh: false },
    },
    {
      name: "commits reply session initialization despite non-identity metadata changes",
      initial: { lastHeartbeatSentAt: 100, lastHeartbeatText: "heartbeat-1" },
      concurrent: { lastHeartbeatSentAt: 200, lastHeartbeatText: "heartbeat-2" },
      prepared: { lastHeartbeatSentAt: 100, lastHeartbeatText: "heartbeat-1" },
      expected: { lastHeartbeatSentAt: 200, lastHeartbeatText: "heartbeat-2" },
    },
    {
      name: "preserves concurrent optional additions when prepared fields are undefined",
      initial: {},
      concurrent: { modelOverride: "channel-model", modelOverrideSource: "user" },
      prepared: { modelOverride: undefined, modelOverrideSource: undefined },
      expected: { modelOverride: "channel-model", modelOverrideSource: "user" },
    },
  ] as const)("$name", async ({ initial, concurrent, prepared, expected }) => {
    const sessionKey = "agent:main:main";
    const scope = { sessionKey, storePath };
    await upsertSessionEntryCore(scope, {
      sessionId: "existing-session",
      updatedAt: 10,
      ...initial,
    });
    const snapshot = loadReplySessionInitializationSnapshot({
      agentId: "main",
      ...scope,
    });
    const current = expectDefined(loadSessionEntry(scope), "existing session entry");
    await replaceSessionEntry(scope, { ...current, ...concurrent });

    // Initialization guards session identity; it must retain concurrent metadata.
    const committed = await commitReplySessionInitialization({
      activeSessionKey: sessionKey,
      agentId: "main",
      expectedRevision: snapshot.revision,
      sessionEntry: {
        sessionId: "existing-session",
        updatedAt: 30,
        ...prepared,
      },
      sessionKey,
      snapshotEntry: snapshot.currentEntry,
      storePath,
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) {
      throw new Error("expected reply session initialization to commit");
    }
    const expectedEntry = { sessionId: "existing-session", updatedAt: 30, ...expected };
    expect(committed.sessionEntry).toMatchObject(expectedEntry);
    expect(loadSessionEntry(scope)).toMatchObject(expectedEntry);
  });

  it("does not restore pending final delivery metadata cleared after the snapshot", async () => {
    const sessionKey = "agent:main:main";
    await upsertSessionEntryCore(
      { sessionKey, storePath },
      {
        sessionId: "existing-session",
        updatedAt: 10,
        pendingFinalDelivery: {
          kind: "replayable",
          text: "durable reply",
          createdAt: 11,
          context: { channel: "discord", to: "channel-1" },
          intentId: "intent-1",
        },
      },
    );

    const snapshot = loadMainInitializationSnapshot(sessionKey);
    if (!snapshot.currentEntry) {
      throw new Error("expected reply session initialization snapshot");
    }

    const current = loadSessionEntry({ sessionKey, storePath });
    if (!current) {
      throw new Error("expected existing session entry");
    }
    const currentWithoutPendingDelivery = { ...current };
    delete currentWithoutPendingDelivery.pendingFinalDelivery;
    await replaceSessionEntry({ sessionKey, storePath }, currentWithoutPendingDelivery);

    const committed = await commitReplySessionInitialization({
      activeSessionKey: sessionKey,
      agentId: "main",
      expectedRevision: snapshot.revision,
      sessionEntry: {
        ...snapshot.currentEntry,
        updatedAt: 30,
      },
      sessionKey,
      snapshotEntry: snapshot.currentEntry,
      storePath,
    });

    expect(committed.ok).toBe(true);
    if (!committed.ok) {
      throw new Error("expected reply session initialization to commit");
    }
    expect(committed.sessionEntry.pendingFinalDelivery).toBeUndefined();

    const persisted = loadSessionEntry({ sessionKey, storePath });
    expect(persisted?.pendingFinalDelivery).toBeUndefined();
  });

  it("does not merge old-session delivery metadata into a rotated session", async () => {
    const sessionKey = "agent:main:main";
    await upsertSessionEntryCore(
      { sessionKey, storePath },
      {
        sessionId: "old-session",
        updatedAt: 10,
      },
    );

    const snapshot = loadMainInitializationSnapshot(sessionKey);

    const current = loadSessionEntry({ sessionKey, storePath });
    if (!current) {
      throw new Error("expected existing session entry");
    }
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        ...current,
        pendingFinalDelivery: {
          kind: "replayable",
          text: "old reply",
          createdAt: 21,
          context: { channel: "discord", to: "channel-1" },
          intentId: "intent-old",
        },
      },
    );

    const committed = await commitReplySessionInitialization({
      activeSessionKey: sessionKey,
      agentId: "main",
      expectedRevision: snapshot.revision,
      sessionEntry: {
        sessionId: "new-session",
        updatedAt: 30,
      },
      sessionKey,
      snapshotEntry: snapshot.currentEntry,
      storePath,
    });

    expect(committed.ok).toBe(true);
    if (!committed.ok) {
      throw new Error("expected reply session initialization to commit");
    }
    expect(committed.sessionEntry.sessionId).toBe("new-session");
    expect(committed.sessionEntry.pendingFinalDelivery).toBeUndefined();

    const persisted = loadSessionEntry({ sessionKey, storePath });
    expect(persisted?.sessionId).toBe("new-session");
    expect(persisted?.pendingFinalDelivery).toBeUndefined();
  });

  it("rejects reply session initialization writes to a legacy alias", async () => {
    await expect(
      applySessionEntryLifecycleMutation({
        storePath,
        upserts: [
          {
            sessionKey: "Agent:Main:Main",
            entry: {
              sessionId: "legacy-alias-session",
              updatedAt: 10,
            },
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED",
      message: expect.stringContaining("openclaw doctor --fix"),
    });
  });

  it("rejects a reply initialization key scoped to another explicit agent", () => {
    try {
      loadReplySessionInitializationSnapshot({
        agentId: "main",
        sessionKey: "agent:ops:main",
        storePath,
      });
      throw new Error("expected agent scope mismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionInitializationAgentScopeMismatchError);
      expect(error).toMatchObject({
        code: "SESSION_INITIALIZATION_AGENT_SCOPE_MISMATCH",
        agentId: "main",
        sessionKeyAgentId: "ops",
      });
    }
  });

  it("normalizes alias inputs before writes and rejects invalid owners", async () => {
    for (const sessionKey of ["main", "agent:ops:main ", "agent:OPS:upper"]) {
      await expect(
        upsertSessionEntryCore(
          { agentId: "ops", sessionKey, storePath },
          { sessionId: "legacy-ops-session", updatedAt: 10 },
        ),
      ).resolves.toMatchObject({ sessionId: "legacy-ops-session" });
    }
    await expect(
      upsertSessionEntryCore(
        { agentId: "ops", sessionKey: "", storePath },
        { sessionId: "empty-session", updatedAt: 10 },
      ),
    ).rejects.toMatchObject({ code: "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED" });
    await expect(
      upsertSessionEntryCore(
        { agentId: "ops", sessionKey: "agent:main:wrong-owner", storePath },
        { sessionId: "wrong-owner-session", updatedAt: 10 },
      ),
    ).rejects.toMatchObject({ code: "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED" });
    const insertRawEntry = (sessionKey: string, sessionId: string, updatedAt: number) => {
      const database = openOpenClawAgentDatabase({
        agentId: "ops",
        path: resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "ops" }).path,
      });
      database.db
        .prepare(
          "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run(sessionKey, sessionId, JSON.stringify({ sessionId, updatedAt }), updatedAt);
      closeOpenClawAgentDatabasesForTest();
    };
    for (const [storedKey, canonicalKey] of [
      ["agent:ops:padded ", "agent:ops:padded"],
      [" agent:ops:leading", "agent:ops:leading"],
      ["agent:ops:nbsp\u00a0", "agent:ops:nbsp"],
    ] as const) {
      const sessionId = `${canonicalKey}-session`;
      insertRawEntry(storedKey, sessionId, 5);
      await expect(
        upsertSessionEntryCore(
          { agentId: "ops", sessionKey: canonicalKey, storePath },
          { sessionId: "new-session", updatedAt: 10 },
        ),
      ).rejects.toMatchObject({ code: "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED" });
      closeOpenClawAgentDatabasesForTest();
      const canonicalSessionId = `${canonicalKey}-canonical-session`;
      insertRawEntry(canonicalKey, canonicalSessionId, 6);
      expect(() =>
        loadSessionEntry({ agentId: "ops", sessionKey: canonicalKey, storePath }),
      ).toThrow("openclaw doctor --fix");
      closeOpenClawAgentDatabasesForTest();
    }
  });

  it("supports multiple logical agents in an explicit shared SQLite store", async () => {
    const sharedStorePath = path.join(tempDir, "shared.sqlite");
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: "agent:main:shared", storePath: sharedStorePath },
      { sessionId: "main-shared", updatedAt: 10 },
    );
    await upsertSessionEntryCore(
      { agentId: "ops", sessionKey: "agent:ops:shared", storePath: sharedStorePath },
      { sessionId: "ops-shared", updatedAt: 20 },
    );

    expect(
      listSessionEntriesCore({ agentId: "main", storePath: sharedStorePath }).map(
        ({ sessionKey }) => sessionKey,
      ),
    ).toEqual(["agent:main:shared", "agent:ops:shared"]);
  });

  it("rejects reply session initialization when the entry is deleted during prepare", async () => {
    const sessionKey = "agent:main:main";
    await upsertSessionEntryCore(
      { sessionKey, storePath },
      {
        sessionId: "first-session",
        updatedAt: 10,
      },
    );
    const snapshot = loadMainInitializationSnapshot(sessionKey);

    const committed = await commitReplySessionInitialization({
      activeSessionKey: sessionKey,
      agentId: "main",
      expectedRevision: snapshot.revision,
      prepareSessionEntry: async ({ sessionEntry }) => {
        await applySessionEntryLifecycleMutation({
          removals: [{ sessionKey }],
          storePath,
        });
        return sessionEntry;
      },
      sessionEntry: {
        sessionId: "stale-session",
        updatedAt: 30,
      },
      sessionKey,
      storePath,
    });

    expect(committed).toMatchObject({
      ok: false,
      reason: "stale-snapshot",
    });
    expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
  });

  it("updates existing entries without creating missing sessions", async () => {
    const scope = {
      sessionKey: "agent:main:main",
      storePath,
    };

    await expect(updateSessionEntry(scope, () => ({ model: "gpt-5.5" }))).resolves.toBeNull();
    expect(listSessionEntriesCore({ storePath })).toEqual([]);

    await upsertSessionEntryCore(scope, {
      sessionId: "session-1",
      updatedAt: 10,
    });
    const beforeNullUpdate = loadSessionEntry(scope);
    await expect(updateSessionEntry(scope, () => null)).resolves.toEqual(beforeNullUpdate);
    expect(loadSessionEntry(scope)).toMatchObject({
      sessionId: "session-1",
      updatedAt: beforeNullUpdate?.updatedAt,
    });
    await expect(
      updateSessionEntry(scope, () => ({ model: "gpt-5.5", updatedAt: 20 })),
    ).resolves.toMatchObject({
      model: "gpt-5.5",
      sessionId: "session-1",
      updatedAt: expect.any(Number),
    });
  });

  it("replaces entries so deleted fields stay removed", async () => {
    const scope = {
      sessionKey: "agent:main:main",
      storePath,
    };

    await upsertSessionEntryCore(scope, {
      model: "gpt-5.5",
      providerOverride: "openai",
      sessionId: "session-1",
      updatedAt: 10,
    });

    await replaceSessionEntry(scope, {
      sessionId: "session-1",
      updatedAt: 20,
    });

    expect(loadSessionEntry(scope)).toMatchObject({
      sessionId: "session-1",
      updatedAt: expect.any(Number),
    });
    expect(loadSessionEntry(scope)?.model).toBeUndefined();
    expect(loadSessionEntry(scope)?.providerOverride).toBeUndefined();
  });

  it("patches entries atomically with a fallback entry", async () => {
    const scope = {
      sessionKey: "agent:main:main",
      storePath,
    };
    let missingContextEntry: SessionEntry | undefined;
    let existingContextEntry: SessionEntry | undefined;

    await patchSessionEntryCore(
      scope,
      (entry, context) => {
        missingContextEntry = context.existingEntry;
        return {
          ...entry,
          model: "gpt-5.5",
        };
      },
      {
        fallbackEntry: {
          sessionId: "session-1",
          updatedAt: 10,
        },
        replaceEntry: true,
      },
    );

    await patchSessionEntryCore(
      scope,
      (entry, context) => {
        existingContextEntry = context.existingEntry;
        return {
          ...entry,
          model: undefined,
          providerOverride: "openai",
        };
      },
      { replaceEntry: true },
    );

    expect(missingContextEntry).toBeUndefined();
    expect(existingContextEntry).toMatchObject({ model: "gpt-5.5" });
    expect(loadSessionEntry(scope)).toMatchObject({
      providerOverride: "openai",
      sessionId: "session-1",
    });
    expect(loadSessionEntry(scope)?.model).toBeUndefined();
  });

  it("rejects a patch when its commit-edge ownership guard retires", async () => {
    const scope = {
      sessionKey: "agent:main:main",
      storePath,
    };
    await upsertSessionEntryCore(scope, {
      sessionId: "session-1",
      updatedAt: 10,
    });

    await expect(
      patchSessionEntryCore(scope, () => ({ model: "gpt-5.5" }), {
        assertCommitAllowed: () => {
          throw new Error("owner retired");
        },
      }),
    ).rejects.toThrow("owner retired");

    expect(loadSessionEntry(scope)?.model).toBeUndefined();
  });

  it("can patch metadata without refreshing session activity", async () => {
    const scope = {
      sessionKey: "agent:main:main",
      storePath,
    };

    await upsertSessionEntryCore(scope, {
      sessionId: "session-1",
      updatedAt: 10,
    });
    const beforePatch = loadSessionEntry(scope);

    await patchSessionEntryCore(
      scope,
      () => ({
        model: "gpt-5.5",
        updatedAt: 20,
      }),
      { preserveActivity: true },
    );

    expect(loadSessionEntry(scope)).toMatchObject({
      model: "gpt-5.5",
      sessionId: "session-1",
      updatedAt: beforePatch?.updatedAt,
    });
  });

  it("applies explicit replacements without exposing mutable store rows", async () => {
    await applySessionEntryLifecycleMutation({
      storePath,
      upserts: [
        {
          sessionKey: "agent:main:main",
          entry: {
            sessionId: "session-1",
            status: "running",
            updatedAt: 10,
          },
        },
        {
          sessionKey: "agent:main:other",
          entry: {
            sessionId: "session-2",
            status: "running",
            updatedAt: 20,
          },
        },
        {
          sessionKey: "agent:main:done",
          entry: {
            sessionId: "session-done",
            status: "done",
            updatedAt: 25,
          },
        },
        {
          sessionKey: "agent:main:shared-running",
          entry: {
            sessionId: "session-shared",
            status: "running",
            updatedAt: 26,
          },
        },
        {
          sessionKey: "agent:main:shared-done",
          entry: {
            sessionId: "session-shared",
            status: "done",
            updatedAt: 27,
          },
        },
      ],
      skipMaintenance: true,
    });
    const doneOwner = { id: "done-owner", type: "human" as const };
    assignSessionOwner(
      { sessionKey: "agent:main:done", storePath },
      { assignedBy: doneOwner, owner: doneOwner },
    );

    const result = await applySessionEntryReplacements({
      storePath,
      update: (entries) => {
        const main = entries.find((entry) => entry.sessionKey === "agent:main:main");
        const other = entries.find((entry) => entry.sessionKey === "agent:main:other");
        if (other) {
          other.entry.status = "failed";
        }
        if (!main) {
          return { result: { replaced: false } };
        }
        main.entry.abortedLastRun = true;
        main.entry.updatedAt = 30;
        return {
          result: { replaced: true },
          replacements: [{ sessionKey: main.sessionKey, entry: main.entry }],
        };
      },
    });

    expect(result).toEqual({ replaced: true });
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      abortedLastRun: true,
      sessionId: "session-1",
      updatedAt: 30,
    });
    expect(loadSessionEntry({ sessionKey: "agent:main:other", storePath })).toMatchObject({
      sessionId: "session-2",
      status: "running",
      updatedAt: 20,
    });

    const selectedKeys = await applySessionEntryReplacements({
      sessionKeys: ["agent:main:main"],
      storePath,
      update: (entries) => ({ result: entries.map((entry) => entry.sessionKey) }),
    });
    expect(selectedKeys).toEqual(["agent:main:main"]);

    const runningKeys = await applySessionEntryReplacements({
      statuses: ["running"],
      storePath,
      update: (entries) => ({ result: entries.map((entry) => entry.sessionKey) }),
    });
    expect(runningKeys).toEqual([
      "agent:main:main",
      "agent:main:other",
      "agent:main:shared-running",
    ]);
    const doneSessions = listSessionEntriesByStatus({ storePath }, ["done"]);
    expect(doneSessions.map((entry) => entry.sessionKey)).toEqual([
      "agent:main:done",
      "agent:main:shared-done",
    ]);
    expect(doneSessions[0]?.entry.owner?.actor).toEqual(doneOwner);

    const other = loadSessionEntry({ sessionKey: "agent:main:other", storePath });
    expect(other).toBeDefined();
    await expect(
      applySessionEntryReplacements({
        sessionKeys: ["agent:main:main"],
        storePath,
        update: () => ({
          replacements: [{ sessionKey: "agent:main:other", entry: other! }],
          result: undefined,
        }),
      }),
    ).rejects.toThrow("outside the selected key set");

    const runtimeAliasMarker = {
      sessionKey: "agent:main:missing",
      entry: { sessionId: "missing", status: "running" as const, updatedAt: 30 },
      previousSessionKeys: [],
    };
    const missingSelectionResult = await applySessionEntryReplacements({
      sessionKeys: ["agent:main:missing"],
      storePath,
      update: () => ({
        replacements: [runtimeAliasMarker],
        result: "missing-row-no-op",
      }),
    });
    expect(missingSelectionResult).toBe("missing-row-no-op");
    expect(loadSessionEntry({ sessionKey: "agent:main:missing", storePath })).toBeUndefined();

    const done = loadSessionEntry({ sessionKey: "agent:main:done", storePath });
    expect(done).toBeDefined();
    await expect(
      applySessionEntryReplacements({
        statuses: ["running"],
        storePath,
        update: () => ({
          replacements: [{ sessionKey: "agent:main:done", entry: done! }],
          result: undefined,
        }),
      }),
    ).rejects.toThrow("outside the selected row set");
  });

  it("ignores runtime-only alias rekey fields on public exact replacements", async () => {
    const canonicalKey = "agent:main:runtime-canonical";
    const aliasKey = "agent:main:runtime-alias";
    await upsertSessionEntryCore(
      { sessionKey: canonicalKey, storePath },
      { sessionId: "runtime-canonical", updatedAt: 1 },
    );
    await upsertSessionEntryCore(
      { sessionKey: aliasKey, storePath },
      { sessionId: "runtime-alias", updatedAt: 2 },
    );
    const runtimeAliasRekeyMarker = {
      sessionKey: canonicalKey,
      entry: { sessionId: "runtime-canonical", label: "Updated", updatedAt: 3 },
      previousSessionKeys: [aliasKey],
    };

    await applySessionEntryReplacements({
      sessionKeys: [canonicalKey, aliasKey],
      storePath,
      update: () => ({ replacements: [runtimeAliasRekeyMarker], result: undefined }),
    });

    expect(loadSessionEntry({ sessionKey: canonicalKey, storePath })).toMatchObject({
      label: "Updated",
      sessionId: "runtime-canonical",
    });
    expect(loadSessionEntry({ sessionKey: aliasKey, storePath })).toMatchObject({
      sessionId: "runtime-alias",
    });
  });

  it("projects ordered patches against one mutable store view", async () => {
    const keys = ["a", "b", "c", "d"].map((suffix) => `agent:main:batch-${suffix}`);
    for (const [index, sessionKey] of keys.entries()) {
      await upsertSessionEntryCore(
        { sessionKey, storePath },
        { sessionId: `batch-${index}`, updatedAt: index + 1 },
      );
    }
    const snapshots = new Set<object>();
    const operation = (
      index: number,
      label: string,
      authorize?: () => { ok: false; error: string } | undefined,
    ): SessionPatchProjectionOperation<{ ok: false; error: string }> => ({
      resolveTarget: (snapshot) => {
        snapshots.add(snapshot.store);
        return { primaryKey: keys[index]! };
      },
      project: ({ existingEntry, isLabelInUse }) => {
        if (isLabelInUse(label)) {
          return { ok: false as const, error: `duplicate:${label}` };
        }
        return { ok: true as const, entry: { ...existingEntry!, label } };
      },
      ...(authorize ? { authorize } : {}),
    });

    const results = await applySessionPatchProjections({
      storePath,
      operations: [
        operation(0, "Shared"),
        operation(1, "Shared"),
        operation(2, "Blocked", () => ({ ok: false, error: "authorization changed" })),
        operation(3, "Blocked"),
      ],
    });

    expect(snapshots.size).toBe(1);
    expect(results.map((result) => (result.ok ? result.entry.label : result.error))).toEqual([
      "Shared",
      "duplicate:Shared",
      "authorization changed",
      "Blocked",
    ]);
    expect(loadSessionEntry({ sessionKey: keys[0]!, storePath })?.label).toBe("Shared");
    expect(loadSessionEntry({ sessionKey: keys[1]!, storePath })?.label).toBeUndefined();
    expect(loadSessionEntry({ sessionKey: keys[2]!, storePath })?.label).toBeUndefined();
    expect(loadSessionEntry({ sessionKey: keys[3]!, storePath })?.label).toBe("Blocked");
  });

  it("inserts and canonically rekeys through the bulk replacement owner", async () => {
    const insertedKey = "agent:main:replacement-insert";
    await applySessionEntryCanonicalReplacements({
      sessionKeys: [insertedKey],
      storePath,
      update: () => ({
        replacements: [
          {
            entry: { sessionId: "inserted", updatedAt: 1 },
            previousSessionKeys: [],
            sessionKey: insertedKey,
          },
        ],
        result: undefined,
      }),
    });
    expect(loadSessionEntry({ sessionKey: insertedKey, storePath })).toMatchObject({
      sessionId: "inserted",
    });

    const canonicalKey = "agent:main:replacement-canonical";
    const previousKey = "agent:main:replacement-previous";
    await upsertSessionEntryCore(
      { sessionKey: canonicalKey, storePath },
      { sessionId: "canonical-older", updatedAt: 10 },
    );
    await upsertSessionEntryCore(
      { sessionKey: previousKey, storePath },
      { sessionId: "rekeyed", updatedAt: 20 },
    );
    for (const [sessionKey, count] of [
      [canonicalKey, 2],
      [previousKey, 3],
    ] as const) {
      for (let promptedAt = 0; promptedAt < count; promptedAt += 1) {
        recordSessionParticipant(
          { sessionKey, storePath },
          { actor: { type: "human", id: "profile-shared" }, promptedAt, source: "profile" },
        );
      }
    }
    const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId: "main",
    }).path;
    const database = openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
    database.db
      .prepare(
        "INSERT INTO session_members (session_key, identity_id, added_by, added_at) VALUES (?, ?, ?, ?)",
      )
      .run(previousKey, "member-1", "test", 1);
    const identityListener = vi.fn();
    const unsubscribe = onSessionIdentityMutation(identityListener);
    await applySessionEntryCanonicalReplacements({
      sessionKeys: [canonicalKey, previousKey],
      storePath,
      update: (entries) => ({
        replacements: [
          {
            entry: {
              ...entries.find((entry) => entry.sessionKey === previousKey)!.entry,
              label: "Moved",
            },
            previousSessionKeys: [previousKey],
            sessionKey: canonicalKey,
          },
        ],
        result: undefined,
      }),
    });
    unsubscribe();
    expect(loadSessionEntry({ sessionKey: previousKey, storePath })).toBeUndefined();
    expect(loadSessionEntry({ sessionKey: canonicalKey, storePath })).toMatchObject({
      label: "Moved",
      sessionId: "rekeyed",
    });
    expect(
      database.db
        .prepare("SELECT session_key FROM session_windows WHERE session_id = ?")
        .get("rekeyed"),
    ).toEqual({ session_key: canonicalKey });
    expect(
      database.db
        .prepare("SELECT session_key, identity_id FROM session_members WHERE identity_id = ?")
        .get("member-1"),
    ).toEqual({ session_key: canonicalKey, identity_id: "member-1" });
    expect(
      database.db
        .prepare("SELECT contribution_count FROM session_participants WHERE actor_id = ?")
        .get("profile-shared"),
    ).toEqual({ contribution_count: 5 });
    expect(identityListener.mock.calls.map(([event]) => event.kind)).toEqual(["move", "replace"]);
  });

  it("rejects internal canonical targets and alias sources without changing rows or events", async () => {
    const visibleKey = "agent:main:replacement-visible";
    const internalKey = "agent:main:internal-session-effects:replacement-guard";
    await upsertSessionEntryCore(
      { sessionKey: visibleKey, storePath },
      { label: "Visible", sessionId: "replacement-visible", updatedAt: 10 },
    );
    await upsertSessionEntryCore(
      { sessionKey: internalKey, storePath },
      { label: "Internal", sessionId: "replacement-internal", updatedAt: 20 },
    );
    const snapshot = () =>
      [visibleKey, internalKey].map((sessionKey) =>
        loadExactSessionEntry({ sessionKey, storePath }),
      );
    const before = snapshot();
    const identityListener = vi.fn();
    const unsubscribe = onSessionIdentityMutation(identityListener);

    try {
      for (const replacement of [
        {
          entry: { sessionId: "fabricated-target", updatedAt: 30 },
          previousSessionKeys: [],
          sessionKey: internalKey,
        },
        {
          entry: { sessionId: "fabricated-alias", updatedAt: 30 },
          previousSessionKeys: [internalKey],
          sessionKey: visibleKey,
        },
      ]) {
        await expect(
          applySessionEntryCanonicalReplacements({
            sessionKeys: [visibleKey, internalKey],
            storePath,
            update: () => ({ replacements: [replacement], result: undefined }),
          }),
        ).rejects.toThrow("cannot target internal effects rows");
        expect(snapshot()).toEqual(before);
      }
    } finally {
      unsubscribe();
    }
    expect(identityListener).not.toHaveBeenCalled();
  });

  it("rolls back mixed exact replacements and canonical rekeys as one transaction", async () => {
    const exactKey = "agent:main:replacement-rollback-exact";
    const canonicalKey = "agent:main:replacement-rollback-canonical";
    const previousKey = "agent:main:replacement-rollback-previous";
    await upsertSessionEntryCore(
      { sessionKey: exactKey, storePath },
      { label: "Exact original", sessionId: "rollback-exact", updatedAt: 10 },
    );
    await upsertSessionEntryCore(
      { sessionKey: canonicalKey, storePath },
      { label: "Canonical original", sessionId: "rollback-canonical", updatedAt: 20 },
    );
    await upsertSessionEntryCore(
      { sessionKey: previousKey, storePath },
      { label: "Previous original", sessionId: "rollback-previous", updatedAt: 30 },
    );
    const before = new Map(
      [exactKey, canonicalKey, previousKey].map((sessionKey) => [
        sessionKey,
        structuredClone(loadSessionEntry({ sessionKey, storePath })),
      ]),
    );
    const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId: "main",
    }).path;
    const database = openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
    database.db.exec(`
      CREATE TRIGGER fail_mixed_replacement_after_exact_write
      BEFORE UPDATE OF entry_json ON session_nodes
      WHEN NEW.session_key = '${canonicalKey}'
        AND (
          SELECT json_extract(entry_json, '$.label')
          FROM session_nodes
          WHERE session_key = '${exactKey}'
        ) = 'Exact updated'
      BEGIN
        SELECT RAISE(ABORT, 'injected mixed replacement failure');
      END;
    `);
    const identityListener = vi.fn();
    const unsubscribe = onSessionIdentityMutation(identityListener);

    try {
      await expect(
        applySessionEntryCanonicalReplacements({
          sessionKeys: [exactKey, canonicalKey, previousKey],
          storePath,
          update: (entries) => ({
            replacements: [
              {
                entry: {
                  ...entries.find((entry) => entry.sessionKey === exactKey)!.entry,
                  label: "Exact updated",
                },
                previousSessionKeys: [],
                sessionKey: exactKey,
              },
              {
                entry: {
                  ...entries.find((entry) => entry.sessionKey === previousKey)!.entry,
                  label: "Canonical updated",
                },
                previousSessionKeys: [previousKey],
                sessionKey: canonicalKey,
              },
            ],
            result: undefined,
          }),
        }),
      ).rejects.toThrow("injected mixed replacement failure");
    } finally {
      unsubscribe();
      database.db.exec("DROP TRIGGER fail_mixed_replacement_after_exact_write");
    }

    for (const sessionKey of [exactKey, canonicalKey, previousKey]) {
      expect(loadSessionEntry({ sessionKey, storePath })).toEqual(before.get(sessionKey));
    }
    expect(identityListener).not.toHaveBeenCalled();
  });

  it("prepares entry replacements without holding a write transaction", async () => {
    const scope = {
      sessionKey: "agent:main:replacement-prepare",
      storePath,
    };
    await upsertSessionEntryCore(scope, {
      model: "base",
      sessionId: "replacement-prepare",
      updatedAt: 10,
    });
    const plannerStarted = createDeferred();
    const plannerGate = createDeferred();
    const pendingReplacement = applySessionEntryReplacements({
      sessionKeys: [scope.sessionKey],
      storePath,
      update: async (entries) => {
        plannerStarted.resolve();
        await plannerGate.promise;
        return {
          replacements: entries.map(({ entry, sessionKey }) => ({
            entry: { ...entry, model: "planned" },
            sessionKey,
          })),
          result: undefined,
        };
      },
    });

    await plannerStarted.promise;
    let replacementError: unknown;
    try {
      replaceSessionEntrySync(scope, {
        model: "newer",
        sessionId: "replacement-prepare",
        updatedAt: 20,
      });
    } catch (error) {
      replacementError = error;
    } finally {
      plannerGate.resolve();
    }
    const planningError = await pendingReplacement.then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(replacementError).toBeUndefined();
    expect(planningError).toMatchObject({
      message: expect.stringContaining("changed before replacement"),
    });
    expect(loadSessionEntry(scope)).toMatchObject({ model: "newer", updatedAt: 20 });
  });

  it("replaces a status-selected entry whose participants are projected only inside the transaction", async () => {
    const scope = { sessionKey: "agent:main:participant-replacement", storePath };
    await upsertSessionEntryCore(scope, {
      sessionId: "participant-replacement",
      status: "running",
      updatedAt: 10,
    });
    // No owner or createdActor, so this participant survives owner filtering and the
    // transaction-side read hydrates fields the status-selected snapshot never sees.
    recordSessionParticipant(scope, {
      actor: { id: "8167215807", type: "human" },
      source: "channel",
    });

    await applySessionEntryReplacements({
      statuses: ["running"],
      storePath,
      update: (entries) => ({
        replacements: entries.map(({ entry, sessionKey }) => ({
          entry: { ...entry, abortedLastRun: true },
          sessionKey,
        })),
        result: undefined,
      }),
    });

    expect(loadSessionEntry(scope)).toMatchObject({ abortedLastRun: true });
  });

  it("awaits lifecycle builders outside transactions while keeping their commit indivisible", async () => {
    const scope = { sessionKey: "agent:main:lifecycle-prepare", storePath };
    await upsertSessionEntryCore(scope, {
      model: "base",
      sessionId: "lifecycle-prepare",
      updatedAt: 10,
    });
    const owner = { id: "lifecycle-owner", type: "human" as const };
    assignSessionOwner(scope, { assignedBy: owner, owner });
    const builderStarted = createDeferred();
    const builderGate = createDeferred();
    const pendingMutation = applySessionEntryLifecycleMutation({
      storePath,
      upserts: [
        {
          sessionKey: scope.sessionKey,
          buildEntry: async ({ currentEntry }) => {
            builderStarted.resolve();
            await builderGate.promise;
            return { ...currentEntry, model: "projected", updatedAt: 20 } as SessionEntry;
          },
        },
      ],
      skipMaintenance: true,
    });

    await builderStarted.promise;
    let unrelatedWriteError: unknown;
    try {
      appendSqliteTrajectoryRuntimeEvents({ sessionId: "lifecycle-prepare", storePath }, [
        createTestTrajectoryEvent("lifecycle-prepare"),
      ]);
    } catch (error) {
      unrelatedWriteError = error;
    }
    const replacement = {
      model: "replacement",
      sessionId: "lifecycle-prepare",
      updatedAt: 30,
    };
    const queuedReplacement = replaceSessionEntry(scope, replacement);
    builderGate.resolve();

    await expect(pendingMutation).resolves.toMatchObject({ afterCount: 1 });
    expect(unrelatedWriteError).toBeUndefined();
    await expect(queuedReplacement).resolves.toMatchObject(replacement);
    expect(loadSessionEntry(scope)).toMatchObject(replacement);
  });

  it("rejects a lifecycle projection when its source row changes", async () => {
    const scope = { sessionKey: "agent:main:lifecycle-stale", storePath };
    await upsertSessionEntryCore(scope, {
      model: "base",
      sessionId: "lifecycle-stale",
      updatedAt: 10,
    });
    const builderStarted = createDeferred();
    const builderGate = createDeferred();
    const pendingMutation = applySessionEntryLifecycleMutation({
      storePath,
      upserts: [
        {
          sessionKey: scope.sessionKey,
          buildEntry: async ({ currentEntry }) => {
            builderStarted.resolve();
            await builderGate.promise;
            return { ...currentEntry, model: "stale-projection" } as SessionEntry;
          },
        },
      ],
      skipMaintenance: true,
    });

    await builderStarted.promise;
    let replacementError: unknown;
    try {
      replaceSessionEntrySync(scope, {
        model: "newer",
        sessionId: "lifecycle-stale",
        updatedAt: 20,
      });
    } catch (error) {
      replacementError = error;
    } finally {
      builderGate.resolve();
    }
    const mutationError = await pendingMutation.then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(replacementError).toBeUndefined();
    expect(mutationError).toMatchObject({
      message: expect.stringContaining("changed before lifecycle upsert"),
    });
    expect(loadSessionEntry(scope)).toMatchObject({ model: "newer", updatedAt: 20 });
  });

  it("reclaims SQLite transcript rows for lifecycle removals without archive intent", async () => {
    const scope = {
      sessionId: "session-1",
      sessionKey: "agent:main:preserve",
      storePath,
    };
    await upsertSessionEntryCore(scope, {
      restartRecoveryDeliveryContext: {
        channel: "whatsapp",
        to: "+15551234567",
      },
      restartRecoveryDeliveryRunId: "old-run",
      sessionId: scope.sessionId,
      updatedAt: 10,
    });
    const owner = { id: "lifecycle-owner", type: "human" as const };
    assignSessionOwner(scope, { assignedBy: owner, owner });
    await replaceTranscriptEvents(scope, [
      {
        id: "event-1",
        message: { role: "user", content: "keep me" },
        type: "message",
      },
    ]);

    const notify = vi.fn();
    const unsubscribe = onSessionIdentityMutation(notify);
    const result = await applySessionEntryLifecycleMutation({
      storePath,
      removals: [{ expectedSessionId: scope.sessionId, sessionKey: scope.sessionKey }],
    });
    unsubscribe();

    expect(result.removedEntries).toBe(1);
    expect(notify).toHaveBeenCalledWith({
      kind: "delete",
      previous: { sessionId: scope.sessionId, sessionKeys: [scope.sessionKey] },
    });
    expect(result.archivedTranscriptDirectories).toEqual([]);
    expect(loadSessionEntry(scope)).toBeUndefined();
    await expect(loadTranscriptEvents(scope)).resolves.toEqual([]);
  });

  it("captures SQLite archived transcript cleanup failures when requested", async () => {
    const cleanupError = new Error("cleanup failed");
    cleanupArchivedSessionTranscriptsMock.mockRejectedValueOnce(cleanupError);
    const scope = {
      sessionId: "session-1",
      sessionKey: "agent:main:cleanup",
      storePath,
    };
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      updatedAt: 10,
    });
    await appendTranscriptMessage(scope, {
      cwd: tempDir,
      message: { role: "user", content: "cleanup me" },
    });

    const result = await applySessionEntryLifecycleMutation({
      storePath,
      removals: [
        {
          archiveRemovedTranscript: true,
          expectedSessionId: scope.sessionId,
          sessionKey: scope.sessionKey,
        },
      ],
      cleanupArchivedTranscripts: {
        rules: [{ reason: "deleted", olderThanMs: 0 }],
        nowMs: Date.now(),
      },
      captureArtifactCleanupError: true,
      skipMaintenance: true,
    });

    expect(result.removedEntries).toBe(1);
    expect(result.archivedTranscriptDirectories).toHaveLength(1);
    expect(result.artifactCleanupError).toBe(cleanupError);
    expect(cleanupArchivedSessionTranscriptsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        directories: result.archivedTranscriptDirectories,
      }),
    );
  });

  it.each([
    {
      name: "exact entry",
      params: {
        expectedEntry: {
          lifecycleRevision: "original-revision",
          sessionId: "session-1",
          updatedAt: 999,
        },
      },
    },
    {
      name: "session id",
      params: { expectedSessionId: "session-2" },
    },
    {
      name: "lifecycle revision",
      params: { expectedLifecycleRevision: "replacement-revision" },
    },
    {
      name: "updatedAt",
      params: { expectedUpdatedAt: 20 },
    },
  ])(
    "does not delete SQLite lifecycle entries when the $name guard mismatches",
    async ({ params }) => {
      const scope = {
        sessionId: "session-1",
        sessionKey: "agent:main:guarded-delete",
        storePath,
      };
      await upsertSessionEntryCore(scope, {
        lifecycleRevision: "original-revision",
        sessionId: scope.sessionId,
        updatedAt: 10,
      });

      const result = await deleteSessionEntryLifecycle({
        archiveTranscript: false,
        storePath,
        target: {
          canonicalKey: scope.sessionKey,
          storeKeys: [scope.sessionKey],
        },
        ...params,
      });

      expect(result.deleted).toBe(false);
      expect(loadSessionEntry(scope)).toMatchObject({
        lifecycleRevision: "original-revision",
        sessionId: scope.sessionId,
        updatedAt: expect.any(Number),
      });
    },
  );

  it("clears progress cards when lifecycle deletion retains transcript windows", async () => {
    const sessionKey = "agent:main:progress-delete";
    const scope = { agentId: "main", sessionId: "progress-delete", sessionKey, storePath };
    await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 10 });
    const databasePath = expectDefined(
      resolveSqliteTargetFromSessionStorePath(storePath, { agentId: scope.agentId }).path,
      "progress delete database path",
    );
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, path: databasePath });
    writeSessionProgressCard(database.db, sessionKey, { markdown: "Working" });

    const result = await deleteSessionEntryLifecycle({
      archiveTranscript: false,
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });

    expect(result.deleted).toBe(true);
    expect(loadSessionEntry(scope)).toBeUndefined();
    expect(
      database.db
        .prepare("SELECT entry_valid FROM session_nodes WHERE session_key = ?")
        .get(sessionKey),
    ).toEqual({ entry_valid: -1 });
    expect(readSessionProgressCard(database.db, sessionKey)).toBeNull();
  });

  it("trims a manual compact transcript and clears stale token metadata", async () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey: "agent:main:main",
      storePath,
    };
    const contextBudgetStatus: NonNullable<SessionEntry["contextBudgetStatus"]> = {
      schemaVersion: 1,
      source: "pre-prompt-estimate",
      updatedAt: 90,
      provider: "openai",
      model: "gpt-5.5",
      route: "fits",
      shouldCompact: false,
      estimatedPromptTokens: 10,
      contextTokenBudget: 100,
      promptBudgetBeforeReserve: 80,
      reserveTokens: 20,
      effectiveReserveTokens: 20,
      remainingPromptBudgetTokens: 70,
      overflowTokens: 0,
      toolResultReducibleChars: 0,
      messageCount: 1,
      unwindowedMessageCount: 1,
    };
    await upsertSessionEntryCore(scope, {
      contextBudgetStatus,
      inputTokens: 10,
      outputTokens: 20,
      sessionId,
      totalTokens: 30,
      totalTokensFresh: true,
      updatedAt: 100,
    });
    const transcriptRecords = [
      {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-06-19T12:00:00.000Z",
        cwd: tempDir,
      },
      ...[1, 2, 3, 4].map((index) => ({
        type: "message",
        id: `entry-${index}`,
        parentId: index === 1 ? null : `entry-${index - 1}`,
        timestamp: `2026-06-19T12:00:0${index}.000Z`,
        message: { role: "user", content: `message ${index}`, timestamp: index },
      })),
    ];
    await replaceTranscriptEvents(
      scope,
      transcriptRecords as Parameters<typeof replaceTranscriptEvents>[1],
    );
    const updates: unknown[] = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));

    const result = await trimSessionTranscriptForManualCompact(scope, {
      maxLines: 3,
      nowMs: 500,
    });

    unsubscribe();
    expect(result).toMatchObject({ compacted: true, kept: 3 });
    const trimmedRecords = (await loadTranscriptEvents(scope)) as Array<Record<string, unknown>>;
    expect(trimmedRecords).toMatchObject([
      { type: "session", id: sessionId },
      { type: "message", id: "entry-3", parentId: null },
      { type: "message", id: "entry-4", parentId: "entry-3" },
    ]);
    const updatedEntry = loadSessionEntry(scope);
    expect(updatedEntry).toMatchObject({
      sessionId,
      updatedAt: 500,
    });
    expect(updatedEntry?.contextBudgetStatus).toBeUndefined();
    expect(updatedEntry?.inputTokens).toBeUndefined();
    expect(updatedEntry?.outputTokens).toBeUndefined();
    expect(updatedEntry?.totalTokens).toBeUndefined();
    expect(updatedEntry?.totalTokensFresh).toBeUndefined();
    expect(updates).toEqual([]);
  });

  it("keeps no-op manual compaction tolerant of a missing current session entry", async () => {
    await expect(
      trimTranscriptForManualCompact(
        {
          agentId: "main",
          sessionId: "99999999-9999-4999-8999-999999999999",
          sessionKey: "agent:main:main",
          storePath,
        },
        () => null,
      ),
    ).resolves.toEqual({ trimmed: false });
  });

  it("rolls back the manual compact row trim when token metadata cannot be cleared", async () => {
    const sessionId = "77777777-7777-4777-8777-777777777777";
    const sessionKey = "agent:main:main";
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey,
      storePath,
    };
    const records = createManualCompactRecords(sessionId);
    await upsertSessionEntryCore(scope, {
      inputTokens: 10,
      outputTokens: 20,
      sessionId,
      totalTokens: 30,
      totalTokensFresh: true,
      updatedAt: 100,
    });
    await replaceTranscriptEvents(scope, records as Parameters<typeof replaceTranscriptEvents>[1]);
    const entryBeforeCompact = loadSessionEntry(scope);
    const databasePath = expectDefined(
      resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path,
      "manual compact database path",
    );
    const database = openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
    database.db.exec(`
      CREATE TRIGGER reject_manual_compact_metadata_update
      BEFORE UPDATE OF entry_json ON session_nodes
      WHEN OLD.session_key = '${sessionKey}'
      BEGIN
        SELECT RAISE(ABORT, 'injected manual compact metadata failure');
      END;
    `);

    await expect(
      trimSessionTranscriptForManualCompact(scope, { maxLines: 3, nowMs: 500 }),
    ).rejects.toThrow("injected manual compact metadata failure");
    database.db.exec("DROP TRIGGER reject_manual_compact_metadata_update;");

    expect(await loadTranscriptEvents(scope)).toEqual(records);
    expect(loadSessionEntry(scope)).toEqual(entryBeforeCompact);
  });

  it.each([
    {
      name: "rejects a manual compact when session metadata changes after its snapshot",
      sessionId: "88888888-8888-4888-8888-888888888888",
      conflict: "metadata",
    },
    {
      name: "preserves rows written after the manual compact snapshot",
      sessionId: "55555555-5555-4555-8555-555555555555",
      conflict: "transcript",
    },
  ] as const)("$name", async ({ sessionId, conflict }) => {
    const scope = { agentId: "main", sessionId, sessionKey: "agent:main:main", storePath };
    const records = createManualCompactRecords(sessionId);
    await upsertSessionEntryCore(
      scope,
      conflict === "metadata"
        ? { sessionId, totalTokens: 30, totalTokensFresh: true, updatedAt: 100 }
        : { sessionId, updatedAt: 1 },
    );
    await replaceTranscriptEvents(scope, records as Parameters<typeof replaceTranscriptEvents>[1]);

    const expectedError =
      conflict === "metadata"
        ? "SQLite session state changed while preparing session.transcript.manual-compact"
        : `SQLite transcript changed while preparing rewrite for ${sessionId}`;
    await expect(
      trimTranscriptForManualCompact(
        scope,
        (lines) => {
          if (conflict === "metadata") {
            replaceSessionEntrySync(scope, {
              label: "concurrent metadata",
              sessionId,
              totalTokens: 40,
              totalTokensFresh: true,
              updatedAt: 200,
            });
          } else {
            appendTranscriptEventSync(scope, {
              type: "custom",
              id: "late-append",
              timestamp: "2026-06-19T12:00:09.000Z",
            });
          }
          return lines.slice(0, 1);
        },
        conflict === "metadata" ? { nowMs: 500 } : undefined,
      ),
    ).rejects.toThrow(expectedError);

    const remaining = (await loadTranscriptEvents(scope)) as Array<Record<string, unknown>>;
    if (conflict === "metadata") {
      expect(remaining).toEqual(records);
      expect(loadSessionEntry(scope)).toMatchObject({
        label: "concurrent metadata",
        totalTokens: 40,
        totalTokensFresh: true,
        updatedAt: 200,
      });
    } else {
      expect(remaining).toHaveLength(6);
      expect(remaining.slice(0, 5)).toEqual(records);
      expect(remaining[5]).toMatchObject({ id: "late-append" });
    }
  });

  it("repairs a retained compaction boundary when its first kept entry was trimmed", async () => {
    const sessionId = "33333333-3333-4333-8333-333333333333";
    const sessionFile = path.join(tempDir, `${sessionId}.jsonl`);
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey: "agent:main:main",
      storePath,
    };
    const records = [
      {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-06-19T12:00:00.000Z",
        cwd: tempDir,
      },
      {
        type: "message",
        id: "old-boundary",
        parentId: null,
        timestamp: "2026-06-19T12:00:01.000Z",
        message: { role: "user", content: "old", timestamp: 1 },
      },
      {
        type: "message",
        id: "kept-before-compaction",
        parentId: "old-boundary",
        timestamp: "2026-06-19T12:00:02.000Z",
        message: { role: "user", content: "kept before", timestamp: 2 },
      },
      {
        type: "compaction",
        id: "compaction-1",
        parentId: "kept-before-compaction",
        timestamp: "2026-06-19T12:00:03.000Z",
        summary: "summary",
        firstKeptEntryId: "old-boundary",
        tokensBefore: 100,
      },
      {
        type: "compaction",
        id: "compaction-2",
        parentId: "compaction-1",
        timestamp: "2026-06-19T12:00:04.000Z",
        summary: "hardened summary",
        firstKeptEntryId: "compaction-2",
        tokensBefore: 50,
      },
      {
        type: "message",
        id: "kept-after-compaction",
        parentId: "compaction-2",
        timestamp: "2026-06-19T12:00:05.000Z",
        message: { role: "user", content: "kept after", timestamp: 5 },
      },
    ];
    await upsertSessionEntryCore(scope, { sessionFile, sessionId, updatedAt: 1 });
    await replaceTranscriptEvents(scope, records as Parameters<typeof replaceTranscriptEvents>[1]);

    await expect(
      trimSessionTranscriptForManualCompact(scope, { maxLines: 5 }),
    ).resolves.toMatchObject({ compacted: true, kept: 5 });

    const reopened = (await loadTranscriptEvents(scope)) as Array<Record<string, unknown>>;
    expect(
      reopened.find((entry) => entry.type === "compaction" && entry.id === "compaction-1"),
    ).toMatchObject({
      firstKeptEntryId: "kept-before-compaction",
    });
    expect(
      reopened.find((entry) => entry.type === "compaction" && entry.id === "compaction-2"),
    ).toMatchObject({ firstKeptEntryId: "compaction-2" });
    const serializedContext = JSON.stringify(reopened);
    expect(serializedContext).toContain("kept before");
    expect(serializedContext).toContain("kept after");
  });

  it("persists a transcript turn, touches metadata, and publishes after the write", async () => {
    const scope = {
      agentId: "main",
      sessionId: "session-lock-order",
      sessionKey: "agent:main:lock-order",
      storePath,
    };
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      updatedAt: 10,
    });
    const updates: Array<{
      target: unknown;
      updatedAt: number | undefined;
    }> = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => {
      updates.push({
        target: update.target,
        updatedAt: loadSessionEntry(scope)?.updatedAt,
      });
    });

    const result = await persistSessionTranscriptTurn(scope, {
      cwd: tempDir,
      messages: [
        {
          message: {
            role: "user",
            content: "hello",
            timestamp: 100,
          },
        },
        {
          message: {
            role: "assistant",
            content: "hi there",
            timestamp: 200,
          },
        },
      ],
      publishWhen: "always",
      touchSessionEntry: true,
      updateMode: "file-only",
    });
    unsubscribe();

    expect(result.appendedCount).toBe(2);
    await expect(loadTranscriptEvents(scope)).resolves.toHaveLength(3);
    expect(loadSessionEntry(scope)).toMatchObject({
      sessionId: scope.sessionId,
      updatedAt: expect.any(Number),
    });
    expect(result).not.toHaveProperty("sessionFile");
    expect(loadSessionEntry(scope)?.updatedAt).toBeGreaterThanOrEqual(10);
    expect(updates).toEqual([
      {
        target: {
          agentId: "main",
          sessionId: "session-lock-order",
          sessionKey: "agent:main:lock-order",
        },
        updatedAt: expect.any(Number),
      },
    ]);
  });

  it.each([
    { guarded: false, name: "ordinary" },
    { guarded: true, name: "expected-session" },
  ])(
    "publishes each committed $name turn message with its active sequence",
    async ({ guarded }) => {
      const scope = {
        agentId: "main",
        sessionId: `session-ordered-turn-${guarded ? "guarded" : "ordinary"}`,
        sessionKey: `agent:main:ordered-turn-${guarded ? "guarded" : "ordinary"}`,
        storePath,
      };
      await upsertSessionEntryCore(scope, {
        lifecycleRevision: "ordered-turn-revision",
        sessionId: scope.sessionId,
        updatedAt: 10,
      });
      await replaceTranscriptEvents(scope, [
        { type: "session", version: 3, id: scope.sessionId },
        {
          type: "message",
          id: "existing-message",
          parentId: null,
          message: { role: "user", content: "existing message", timestamp: 1 },
        },
        {
          type: "message",
          id: "abandoned-message",
          parentId: "existing-message",
          message: { role: "assistant", content: "abandoned reply", timestamp: 2 },
        },
        {
          type: "leaf",
          id: "select-existing-message",
          parentId: "abandoned-message",
          targetId: "existing-message",
          appendParentId: "existing-message",
        },
      ]);

      const updates: Array<{
        target: unknown;
        message?: unknown;
        messageId?: string;
        messageSeq?: number;
      }> = [];
      const unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));
      const internalUpdates: Array<{ lifecycleRevision?: string; target?: unknown }> = [];
      const unsubscribeInternal = onInternalSessionTranscriptUpdate((update) => {
        if (update.message !== undefined) {
          internalUpdates.push({
            lifecycleRevision: update.lifecycleRevision,
            target: update.target,
          });
        }
      });
      let result: Awaited<ReturnType<typeof persistSessionTranscriptTurn>>;
      try {
        result = await persistSessionTranscriptTurn(scope, {
          ...(guarded ? { expectedSessionId: scope.sessionId } : {}),
          runId: "run-ordered-turn",
          messages: [
            {
              message: {
                role: "user",
                content: "first committed message",
                idempotencyKey: "ordered-turn-first:user",
                timestamp: 2,
              },
            },
            {
              message: {
                role: "assistant",
                content: "second committed message",
                idempotencyKey: "ordered-turn-second",
                timestamp: 3,
              },
            },
          ],
          updateMode: "inline",
        });
      } finally {
        unsubscribe();
        unsubscribeInternal();
      }

      expect(result.appendedCount).toBe(2);
      expect(updates).toEqual([
        {
          target: {
            agentId: scope.agentId,
            sessionId: scope.sessionId,
            sessionKey: scope.sessionKey,
          },
          sessionKey: scope.sessionKey,
          agentId: scope.agentId,
          sessionId: scope.sessionId,
          message: {
            role: "user",
            content: "first committed message",
            idempotencyKey: "ordered-turn-first:user",
            timestamp: 2,
          },
          messageId: result.messages[0]?.messageId,
          messageSeq: 2,
        },
        {
          target: {
            agentId: scope.agentId,
            sessionId: scope.sessionId,
            sessionKey: scope.sessionKey,
          },
          sessionKey: scope.sessionKey,
          agentId: scope.agentId,
          sessionId: scope.sessionId,
          message: {
            role: "assistant",
            content: "second committed message",
            idempotencyKey: "ordered-turn-second",
            timestamp: 3,
            __openclaw: { runId: "run-ordered-turn" },
          },
          messageId: result.messages[1]?.messageId,
          messageSeq: 3,
          runId: "run-ordered-turn",
        },
      ]);
      expect(internalUpdates).toEqual([
        {
          lifecycleRevision: "ordered-turn-revision",
          target: {
            agentId: scope.agentId,
            sessionId: scope.sessionId,
            sessionKey: scope.sessionKey,
            storePath,
          },
        },
        {
          lifecycleRevision: "ordered-turn-revision",
          target: {
            agentId: scope.agentId,
            sessionId: scope.sessionId,
            sessionKey: scope.sessionKey,
            storePath,
          },
        },
      ]);
    },
  );

  it("invalidates a legacy multi-message turn when active cursors cannot be proven", async () => {
    const scope = {
      agentId: "main",
      sessionId: "session-legacy-unsequenced-turn",
      sessionKey: "agent:main:legacy-unsequenced-turn",
      storePath,
    };
    await upsertSessionEntryCore(scope, {
      lifecycleRevision: "legacy-unsequenced-revision",
      sessionId: scope.sessionId,
      updatedAt: 10,
    });
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "legacy-unsequenced-root",
          parentId: null,
          message: { role: "user", content: "canonical root" },
        },
      ],
      updateMode: "none",
    });
    await appendTranscriptEvent(scope, {
      id: "legacy-unsequenced-child",
      parentId: "legacy-unsequenced-root",
      message: { role: "assistant", content: "legacy raw event" },
    });

    const publicUpdates: Array<{ target: unknown; message?: unknown; messageSeq?: number }> = [];
    const internalUpdates: Array<{
      target?: unknown;
      lifecycleRevision?: string;
      message?: unknown;
      messageSeq?: number;
    }> = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => publicUpdates.push(update));
    const unsubscribeInternal = onInternalSessionTranscriptUpdate((update) =>
      internalUpdates.push(update),
    );
    let result: Awaited<ReturnType<typeof persistSessionTranscriptTurn>>;
    try {
      result = await persistSessionTranscriptTurn(scope, {
        messages: [
          {
            eventId: "legacy-unsequenced-first",
            message: {
              role: "user",
              content: "first unsequenced message",
              idempotencyKey: "legacy-unsequenced-first:user",
            },
          },
          {
            eventId: "legacy-unsequenced-second",
            message: {
              role: "assistant",
              content: "second unsequenced message",
              idempotencyKey: "legacy-unsequenced-second",
            },
          },
        ],
        updateMode: "inline",
      });
    } finally {
      unsubscribe();
      unsubscribeInternal();
    }

    expect(result.appendedCount).toBe(2);
    expect(publicUpdates).toEqual([
      {
        target: {
          agentId: scope.agentId,
          sessionId: scope.sessionId,
          sessionKey: scope.sessionKey,
        },
        agentId: scope.agentId,
        sessionId: scope.sessionId,
        sessionKey: scope.sessionKey,
      },
    ]);
    expect(internalUpdates).toEqual([
      {
        target: {
          agentId: scope.agentId,
          sessionId: scope.sessionId,
          sessionKey: scope.sessionKey,
          storePath,
        },
        agentId: scope.agentId,
        lifecycleRevision: "legacy-unsequenced-revision",
        sessionId: scope.sessionId,
        sessionKey: scope.sessionKey,
      },
    ]);
    await expect(loadTranscriptEvents(scope)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "legacy-unsequenced-first" }),
        expect.objectContaining({ id: "legacy-unsequenced-second" }),
      ]),
    );
  });

  it.each([
    { guarded: false, name: "ordinary" },
    { guarded: true, name: "expected-session" },
  ])("never publishes rows abandoned inside one $name turn", async ({ guarded }) => {
    const scope = {
      agentId: "main",
      sessionId: `session-diverging-turn-${guarded ? "guarded" : "ordinary"}`,
      sessionKey: `agent:main:diverging-turn-${guarded ? "guarded" : "ordinary"}`,
      storePath,
    };
    await upsertSessionEntryCore(scope, {
      lifecycleRevision: "diverging-turn-revision",
      sessionId: scope.sessionId,
      updatedAt: 10,
    });
    const expectedSession = guarded ? { expectedSessionId: scope.sessionId } : {};
    await persistSessionTranscriptTurn(scope, {
      ...expectedSession,
      messages: [
        {
          eventId: "diverging-turn-root",
          parentId: null,
          message: { role: "user", content: "common branch root" },
        },
      ],
      updateMode: "none",
    });

    const updates: Array<{
      target: unknown;
      message?: unknown;
      messageId?: string;
      messageSeq?: number;
    }> = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));
    let result: Awaited<ReturnType<typeof persistSessionTranscriptTurn>>;
    try {
      result = await persistSessionTranscriptTurn(scope, {
        ...expectedSession,
        messages: [
          {
            eventId: "diverging-turn-abandoned",
            parentId: "diverging-turn-root",
            message: {
              role: "assistant",
              content: "abandoned branch",
              idempotencyKey: "diverging-turn-abandoned",
            },
          },
          {
            eventId: "diverging-turn-active",
            parentId: "diverging-turn-root",
            message: {
              role: "assistant",
              content: "final active branch",
              idempotencyKey: "diverging-turn-active",
            },
          },
        ],
        updateMode: "inline",
      });
    } finally {
      unsubscribe();
    }

    expect(result.appendedCount).toBe(2);
    expect(updates).toEqual([
      {
        target: {
          agentId: scope.agentId,
          sessionId: scope.sessionId,
          sessionKey: scope.sessionKey,
        },
        agentId: scope.agentId,
        sessionId: scope.sessionId,
        sessionKey: scope.sessionKey,
      },
    ]);
    await expect(loadTranscriptEvents(scope)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "diverging-turn-abandoned" }),
        expect.objectContaining({ id: "diverging-turn-active" }),
      ]),
    );
  });

  it.each([
    { guarded: false, name: "ordinary" },
    { guarded: true, name: "expected-session" },
  ])("does not republish replayed $name turn messages", async ({ guarded }) => {
    const scope = {
      agentId: "main",
      sessionId: `session-replayed-turn-${guarded ? "guarded" : "ordinary"}`,
      sessionKey: `agent:main:replayed-turn-${guarded ? "guarded" : "ordinary"}`,
      storePath,
    };
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      updatedAt: 10,
    });
    const existing = {
      role: "user",
      content: "persisted once",
      idempotencyKey: "replayed-turn-existing:user",
      timestamp: 1,
    };
    const expectedSession = guarded ? { expectedSessionId: scope.sessionId } : {};
    await persistSessionTranscriptTurn(scope, {
      ...expectedSession,
      messages: [{ idempotencyLookup: "scan", message: existing }],
      updateMode: "none",
    });

    const updates: Array<{ message?: unknown; messageId?: string; messageSeq?: number }> = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));
    let result: Awaited<ReturnType<typeof persistSessionTranscriptTurn>>;
    try {
      result = await persistSessionTranscriptTurn(scope, {
        ...expectedSession,
        messages: [
          { idempotencyLookup: "scan", message: existing },
          {
            message: {
              role: "assistant",
              content: "new committed reply",
              idempotencyKey: "replayed-turn-new",
              timestamp: 2,
            },
          },
        ],
        updateMode: "inline",
      });
    } finally {
      unsubscribe();
    }

    expect(result.appendedCount).toBe(1);
    expect(result.messages.map((message) => message.appended)).toEqual([false, true]);
    expect(updates).toEqual([
      expect.objectContaining({
        message: {
          role: "assistant",
          content: "new committed reply",
          idempotencyKey: "replayed-turn-new",
          timestamp: 2,
        },
        messageId: result.messages[1]?.messageId,
        messageSeq: 2,
      }),
    ]);
  });

  it("accepts idempotent transcript replays with reordered JSON fields", async () => {
    const scope = {
      agentId: "main",
      sessionId: "session-reordered-replay",
      sessionKey: "agent:main:reordered-replay",
      storePath,
    };
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      updatedAt: 10,
    });
    const first = await appendTranscriptMessage(scope, {
      idempotencyLookup: "scan",
      message: {
        role: "user",
        content: "same message",
        idempotencyKey: "reordered-replay:user",
        metadata: { first: 1, second: 2 },
        timestamp: 1,
      },
    });
    const replay = await appendTranscriptMessage(scope, {
      idempotencyLookup: "scan",
      message: {
        timestamp: 2,
        metadata: { second: 2, first: 1 },
        optional: undefined,
        idempotencyKey: "reordered-replay:user",
        content: "same message",
        role: "user",
      },
    });

    expect(first?.appended).toBe(true);
    expect(replay).toMatchObject({
      appended: false,
      messageId: first?.messageId,
    });
  });

  it("accepts idempotent transcript replays after storage redaction", async () => {
    const scope = {
      agentId: "main",
      sessionId: "session-redacted-replay",
      sessionKey: "agent:main:redacted-replay",
      storePath,
    };
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      updatedAt: 10,
    });
    const message = {
      role: "user",
      content: "same secret sk-abcdef1234567890xyz",
      idempotencyKey: "redacted-replay:user",
      timestamp: 1,
    };
    const first = await appendTranscriptMessage(scope, {
      idempotencyLookup: "scan",
      message,
    });
    const replay = await appendTranscriptMessage(scope, {
      idempotencyLookup: "scan",
      message,
    });

    expect(first?.appended).toBe(true);
    expect(JSON.stringify(first?.message)).not.toContain("sk-abcdef1234567890xyz");
    expect(replay).toMatchObject({
      appended: false,
      messageId: first?.messageId,
    });
  });

  it("allows concurrent SQLite transcript turn and direct appends", async () => {
    const scope = {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath,
    };
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      updatedAt: 10,
    });
    let markShouldAppendEntered!: () => void;
    const shouldAppendEntered = new Promise<void>((resolve) => {
      markShouldAppendEntered = resolve;
    });
    let resumeShouldAppend!: () => void;
    const shouldAppendReleased = new Promise<boolean>((resolve) => {
      resumeShouldAppend = () => resolve(true);
    });

    const turnPromise = persistSessionTranscriptTurn(scope, {
      cwd: tempDir,
      messages: [
        {
          message: {
            role: "assistant",
            content: "batch reply",
            timestamp: 100,
          },
          shouldAppend: async () => {
            markShouldAppendEntered();
            return await shouldAppendReleased;
          },
        },
      ],
      publishWhen: "always",
      touchSessionEntry: true,
      updateMode: "file-only",
    });

    await shouldAppendEntered;
    let unrelatedWriteError: unknown;
    try {
      appendSqliteTrajectoryRuntimeEvents({ sessionId: scope.sessionId, storePath }, [
        createTestTrajectoryEvent(scope.sessionId),
      ]);
    } catch (error) {
      unrelatedWriteError = error;
    }
    const queuedAppendPromise = appendTranscriptMessage(scope, {
      cwd: tempDir,
      message: {
        role: "user",
        content: "queued prompt",
        timestamp: 200,
      },
    });
    resumeShouldAppend();

    const results = Promise.all([turnPromise, queuedAppendPromise]);
    await withTestTimeout(results, 1_000, "timed out waiting for queued transcript writes");
    await results;
    expect(unrelatedWriteError).toBeUndefined();
  });

  it("persists expected-session SQLite transcript turns without reentering the writer queue", async () => {
    const scope = {
      agentId: "main",
      sessionId: "session-expected",
      sessionKey: "agent:main:expected",
      storePath,
    };
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      updatedAt: 10,
    });

    const turnPromise = persistSessionTranscriptTurn(scope, {
      cwd: tempDir,
      expectedSessionId: scope.sessionId,
      messages: [
        {
          message: {
            role: "assistant",
            content: "expected reply",
            timestamp: 100,
          },
        },
      ],
      publishWhen: "always",
      touchSessionEntry: true,
      updateMode: "file-only",
    });

    await withTestTimeout(
      turnPromise,
      1_000,
      "timed out waiting for expected-session transcript turn",
    );
    const result = await turnPromise;

    expect(result.appendedCount).toBe(1);
    await expect(loadTranscriptEvents(scope)).resolves.toHaveLength(2);
  });

  it("commits admission metadata only for an inserted turn or exact retryable claim", async () => {
    const scope = {
      agentId: "main",
      sessionId: "session-admission",
      sessionKey: "agent:main:admission",
      storePath,
    };
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      status: "done",
      updatedAt: 10,
    });
    const message = {
      role: "user" as const,
      content: "accepted once",
      idempotencyKey: "run-1:user",
      timestamp: 100,
    };
    const admission = {
      abortedLastRun: false,
      endedAt: undefined,
      restartRecoveryDeliveryContext: undefined,
      restartRecoveryDeliveryRequestFingerprint: "fingerprint-1",
      restartRecoveryDeliveryRunId: "run-1",
      restartRecoveryDeliverySourceRunId: "run-1",
      startedAt: 100,
      status: "running" as const,
      updatedAt: 100,
    };

    const inserted = await persistSessionTranscriptTurn(scope, {
      expectedSessionId: scope.sessionId,
      messages: [{ idempotencyLookup: "scan", message }],
      sessionLifecyclePatch: admission,
      updateMode: "none",
    });
    expect(inserted.appendedCount).toBe(1);
    expect(loadSessionEntry(scope)).toMatchObject({
      abortedLastRun: false,
      restartRecoveryDeliveryRunId: "run-1",
      restartRecoveryDeliverySourceRunId: "run-1",
      startedAt: 100,
      status: "running",
      updatedAt: expect.any(Number),
    });
    expect(loadSessionEntry(scope)?.restartRecoveryDeliveryContext).toBeUndefined();
    expect(loadSessionEntry(scope)?.endedAt).toBeUndefined();

    const retryable = await updateSessionEntry(scope, () => ({
      abortedLastRun: false,
      endedAt: 200,
      restartRecoveryDeliveryContext: undefined,
      restartRecoveryDeliveryRequestFingerprint: "fingerprint-1",
      restartRecoveryDeliveryRunId: "run-1",
      restartRecoveryDeliverySourceRunId: "run-1",
      status: "failed",
      updatedAt: 200,
    }));
    if (!retryable) {
      throw new Error("expected retryable admission");
    }
    const retryableMainRestartRecovery = (retryable as InternalSessionEntry).mainRestartRecovery;
    const deduplicated = await persistSessionTranscriptTurn(scope, {
      expectedSessionId: scope.sessionId,
      expectedSessionState: {
        abortedLastRun: retryable.abortedLastRun,
        mainRestartRecoveryCycleId: retryableMainRestartRecovery?.cycleId,
        mainRestartRecoveryRevision: retryableMainRestartRecovery?.revision,
        restartRecoveryBeforeAgentReplyState: retryable.restartRecoveryBeforeAgentReplyState,
        restartRecoveryDeliveryReceiptState: retryable.restartRecoveryDeliveryReceiptState,
        restartRecoveryDeliveryToolCallId: retryable.restartRecoveryDeliveryToolCallId,
        restartRecoveryDeliveryRequestFingerprint:
          retryable.restartRecoveryDeliveryRequestFingerprint,
        restartRecoveryDeliveryRunId: retryable.restartRecoveryDeliveryRunId,
        restartRecoveryDeliverySourceRunId: retryable.restartRecoveryDeliverySourceRunId,
        restartRecoveryRequesterAccountId: retryable.restartRecoveryRequesterAccountId,
        restartRecoveryRequesterSenderId: retryable.restartRecoveryRequesterSenderId,
        restartRecoverySameChannelThreadRequired:
          retryable.restartRecoverySameChannelThreadRequired,
        restartRecoverySourceIngress: retryable.restartRecoverySourceIngress,
        restartRecoverySourceReplyDeliveryMode: retryable.restartRecoverySourceReplyDeliveryMode,
        restartRecoveryTerminalRunIds: retryable.restartRecoveryTerminalRunIds,
        status: retryable.status,
      },
      messages: [
        {
          idempotencyLookup: "scan",
          message: { ...message, timestamp: 300 },
        },
      ],
      sessionLifecyclePatch: { ...admission, startedAt: 300, updatedAt: 300 },
      updateMode: "none",
    });
    expect(deduplicated.appendedCount).toBe(0);
    expect(deduplicated.messages).toHaveLength(1);
    expect(loadSessionEntry(scope)).toMatchObject({
      abortedLastRun: false,
      restartRecoveryDeliveryRequestFingerprint: "fingerprint-1",
      restartRecoveryDeliveryRunId: "run-1",
      restartRecoveryDeliverySourceRunId: "run-1",
      status: "running",
      startedAt: 300,
      updatedAt: expect.any(Number),
    });
    expect(loadSessionEntry(scope)?.endedAt).toBeUndefined();

    await updateSessionEntry(scope, () => ({
      endedAt: 350,
      restartRecoveryDeliveryContext: undefined,
      restartRecoveryDeliveryRequestFingerprint: undefined,
      restartRecoveryDeliveryRunId: undefined,
      restartRecoveryDeliverySourceRunId: undefined,
      status: "done",
      updatedAt: 350,
    }));
    const historicalMatch = await persistSessionTranscriptTurn(scope, {
      expectedSessionId: scope.sessionId,
      messages: [
        {
          idempotencyLookup: "scan",
          message: { ...message, timestamp: 400 },
        },
      ],
      sessionLifecyclePatch: { ...admission, startedAt: 400, updatedAt: 400 },
      updateMode: "none",
    });
    expect(historicalMatch.appendedCount).toBe(0);
    expect(historicalMatch.messages).toHaveLength(1);
    expect(loadSessionEntry(scope)).toMatchObject({
      endedAt: 350,
      status: "done",
      updatedAt: expect.any(Number),
    });
    expect(loadSessionEntry(scope)?.restartRecoveryDeliveryRequestFingerprint).toBeUndefined();
    expect(loadSessionEntry(scope)?.restartRecoveryDeliveryRunId).toBeUndefined();
    await expect(loadTranscriptEvents(scope)).resolves.toHaveLength(2);
  });

  it("rejects expected-session transcript turns after a session rebind", async () => {
    const scope = {
      agentId: "main",
      sessionId: "session-original",
      sessionKey: "agent:main:main",
      storePath,
    };
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      updatedAt: 10,
    });
    await updateSessionEntry(
      {
        sessionKey: scope.sessionKey,
        storePath,
      },
      () => ({
        sessionFile: "sqlite:main:session-replacement",
        sessionId: "session-replacement",
      }),
      { skipMaintenance: true },
    );

    const result = await persistSessionTranscriptTurn(scope, {
      expectedSessionId: scope.sessionId,
      messages: [
        {
          message: {
            role: "assistant",
            content: "late reply",
            timestamp: 100,
          },
        },
      ],
      publishWhen: "always",
      touchSessionEntry: true,
      updateMode: "file-only",
    });

    expect(result).toMatchObject({
      appendedCount: 0,
      rejectedReason: "session-rebound",
    });
    await expect(loadTranscriptEvents(scope)).resolves.toEqual([]);
  });

  it("rejects an expected-session transcript turn rebound during predicate preparation", async () => {
    const scope = {
      agentId: "main",
      sessionId: "session-predicate-original",
      sessionKey: "agent:main:predicate-rebind",
      storePath,
    };
    await upsertSessionEntryCore(scope, {
      lifecycleRevision: "predicate-revision",
      sessionId: scope.sessionId,
      updatedAt: 10,
    });
    let releasePredicate!: () => void;
    let markPredicateStarted!: () => void;
    const predicateStarted = new Promise<void>((resolve) => {
      markPredicateStarted = resolve;
    });
    const predicateGate = new Promise<void>((resolve) => {
      releasePredicate = resolve;
    });
    const pendingTurn = persistSessionTranscriptTurn(scope, {
      expectedLifecycleRevision: "predicate-revision",
      expectedSessionId: scope.sessionId,
      messages: [
        {
          message: { role: "assistant", content: "late reply", timestamp: 100 },
          shouldAppend: async () => {
            markPredicateStarted();
            await predicateGate;
            return true;
          },
        },
      ],
      touchSessionEntry: true,
      updateMode: "file-only",
    });

    await predicateStarted;
    let replacementError: unknown;
    try {
      replaceSessionEntrySync(scope, {
        lifecycleRevision: "replacement-revision",
        sessionId: "session-predicate-replacement",
        updatedAt: 20,
      });
    } catch (error) {
      replacementError = error;
    } finally {
      releasePredicate();
    }
    const result = await pendingTurn;

    expect(replacementError).toBeUndefined();
    expect(result).toMatchObject({ appendedCount: 0, rejectedReason: "session-rebound" });
    await expect(loadTranscriptEvents(scope)).resolves.toEqual([]);
  });

  it("exposes only transcript identity to append predicates", async () => {
    const scope = {
      agentId: "main",
      sessionId: "session-predicate-context",
      sessionKey: "agent:main:predicate-context",
      storePath,
    };
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      updatedAt: 10,
      lastRunError: "private entry state",
    });
    let predicateContext: unknown;

    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          message: { role: "assistant", content: "not appended", timestamp: 100 },
          shouldAppend: (context) => {
            predicateContext = context;
            return false;
          },
        },
      ],
      updateMode: "file-only",
    });

    expect(predicateContext).toEqual(scope);
    expect(predicateContext).not.toHaveProperty("sessionEntry");
  });

  it("rejects a guarded transcript turn when same-session lifecycle ownership changes", async () => {
    const scope = {
      agentId: "main",
      sessionId: "session-same-owner",
      sessionKey: "agent:main:same-owner",
      storePath,
    };
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      abortedLastRun: true,
      restartRecoveryDeliveryRunId: "recovery-run",
      restartRecoveryDeliverySourceRunId: "control-ui-run",
      status: "running",
      updatedAt: 10,
    });
    const stored = loadSessionEntry(scope);
    if (!stored) {
      throw new Error("expected guarded session");
    }
    const expectedSessionState = {
      abortedLastRun: stored.abortedLastRun,
      mainRestartRecoveryCycleId: undefined,
      mainRestartRecoveryRevision: undefined,
      restartRecoveryBeforeAgentReplyState: stored.restartRecoveryBeforeAgentReplyState,
      restartRecoveryDeliveryReceiptState: stored.restartRecoveryDeliveryReceiptState,
      restartRecoveryDeliveryToolCallId: stored.restartRecoveryDeliveryToolCallId,
      restartRecoveryDeliveryRequestFingerprint: stored.restartRecoveryDeliveryRequestFingerprint,
      restartRecoveryDeliveryRunId: stored.restartRecoveryDeliveryRunId,
      restartRecoveryDeliverySourceRunId: stored.restartRecoveryDeliverySourceRunId,
      restartRecoveryRequesterAccountId: stored.restartRecoveryRequesterAccountId,
      restartRecoveryRequesterSenderId: stored.restartRecoveryRequesterSenderId,
      restartRecoverySameChannelThreadRequired: stored.restartRecoverySameChannelThreadRequired,
      restartRecoverySourceIngress: stored.restartRecoverySourceIngress,
      restartRecoverySourceReplyDeliveryMode: stored.restartRecoverySourceReplyDeliveryMode,
      restartRecoveryTerminalRunIds: stored.restartRecoveryTerminalRunIds,
      status: stored.status,
    };
    let releasePredicate!: () => void;
    let markPredicateStarted!: () => void;
    const predicateStarted = new Promise<void>((resolve) => {
      markPredicateStarted = resolve;
    });
    const predicateGate = new Promise<void>((resolve) => {
      releasePredicate = resolve;
    });
    const pendingTurn = persistSessionTranscriptTurn(scope, {
      expectedSessionId: scope.sessionId,
      expectedSessionState,
      messages: [
        {
          message: { role: "assistant", content: "stale recovery notice", timestamp: 100 },
          shouldAppend: async () => {
            markPredicateStarted();
            await predicateGate;
            return true;
          },
        },
      ],
      touchSessionEntry: true,
      updateMode: "file-only",
    });

    await predicateStarted;
    replaceSessionEntrySync(scope, {
      abortedLastRun: false,
      restartRecoveryDeliveryRunId: "new-run",
      restartRecoveryDeliverySourceRunId: "new-run",
      sessionId: scope.sessionId,
      status: "running",
      updatedAt: 20,
    });
    releasePredicate();
    const result = await pendingTurn;

    expect(result).toMatchObject({ appendedCount: 0, rejectedReason: "session-rebound" });
    await expect(loadTranscriptEvents(scope)).resolves.toEqual([]);
  });

  it("rejects expected-session transcript turns after lifecycle ownership changes", async () => {
    const scope = {
      agentId: "main",
      sessionId: "session-original",
      sessionKey: "agent:main:main",
      storePath,
    };
    await upsertSessionEntryCore(scope, {
      lifecycleRevision: "original-revision",
      sessionId: scope.sessionId,
      updatedAt: 10,
    });
    await updateSessionEntry(
      {
        sessionKey: scope.sessionKey,
        storePath,
      },
      () => ({
        lifecycleRevision: "replacement-revision",
      }),
      { skipMaintenance: true },
    );

    const result = await persistSessionTranscriptTurn(scope, {
      expectedLifecycleRevision: "original-revision",
      expectedSessionId: scope.sessionId,
      messages: [
        {
          message: {
            role: "assistant",
            content: "late reply",
            timestamp: 100,
          },
        },
      ],
      publishWhen: "always",
      touchSessionEntry: true,
      updateMode: "file-only",
    });

    expect(result).toMatchObject({
      appendedCount: 0,
      rejectedReason: "session-rebound",
    });
    await expect(loadTranscriptEvents(scope)).resolves.toEqual([]);
  });

  it("routes SQLite transcript turn appends through an active owned write context", async () => {
    const scope = {
      agentId: "main",
      sessionFile: transcriptPath,
      sessionId: "session-owned-publish",
      sessionKey: "agent:main:owned-publish",
      storePath,
    };
    let ownedWriteCount = 0;

    await withOwnedSessionTranscriptWrites(
      {
        sessionFile: scope.sessionKey,
        sessionKey: scope.sessionKey,
        sessionTarget: scope,
        withTranscriptWrite: async (run) => {
          ownedWriteCount += 1;
          return await run();
        },
      },
      async () =>
        await persistSessionTranscriptTurn(scope, {
          cwd: tempDir,
          messages: [
            {
              message: {
                role: "assistant",
                content: "owned batch",
                timestamp: 100,
              },
            },
          ],
          publishWhen: "always",
          touchSessionEntry: true,
          updateMode: "file-only",
        }),
    );

    expect(ownedWriteCount).toBe(1);
    await expect(loadTranscriptEvents(scope)).resolves.toHaveLength(2);
  });

  it("fences matching sync transcript mutations with the admitted writer claim", async () => {
    const scope = {
      agentId: "main",
      sessionId: "session-owned-fence",
      sessionKey: "agent:main:owned-fence",
      storePath,
    };
    replaceSessionEntrySync(scope, {
      activeWriterRunId: "current-run",
      sessionId: scope.sessionId,
      updatedAt: 1,
    } as InternalSessionEntry);

    await withOwnedSessionTranscriptWrites(
      {
        sessionFile: scope.sessionKey,
        sessionKey: scope.sessionKey,
        sessionTarget: {
          ...scope,
          expectedWriterRunId: "superseded-run",
        },
        withTranscriptWrite: async (run) => await run(),
      },
      async () => {
        expect(ensureSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 2 })).toBe(
          true,
        );
        expect(() => replaceTranscriptEventsSync(scope, [])).toThrow(
          SessionTranscriptWriterClaimReboundError,
        );
      },
    );

    expect(loadSessionEntry(scope)?.updatedAt).toBe(1);
    await expect(loadTranscriptEvents(scope)).resolves.toEqual([]);
  });

  it("resolves store-backed runtime transcript targets from structured identity", async () => {
    const staleSessionFile = path.join(tempDir, "session-1.jsonl");
    const scope = {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath,
    };

    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      sessionFile: staleSessionFile,
      updatedAt: 10,
    });

    const readTarget = await resolveSessionTranscriptRuntimeTarget(scope);
    const writeTarget = await resolveSessionTranscriptRuntimeTarget(scope);

    expect(readTarget).toEqual(scope);
    expect(writeTarget).toEqual(scope);
    expect(loadSessionEntry(scope)).not.toHaveProperty("sessionFile");
  });

  it("keeps the persisted transcript owner when a caller supplies a stale session key", async () => {
    const sessionId = "session-canonical-owner";
    const canonicalScope = {
      agentId: "main",
      sessionId,
      sessionKey: "agent:main:main",
      storePath,
    };
    await upsertSessionEntryCore(canonicalScope, { sessionId, updatedAt: 10 });

    const target = await resolveSessionTranscriptRuntimeTarget({
      ...canonicalScope,
      sessionKey: "agent:main:telegram:default:direct:fixture-peer",
    });
    await appendTranscriptEvent(target, {
      id: "canonical-owner-event",
      timestamp: new Date(20).toISOString(),
      type: "metadata",
    });

    const database = openOpenClawAgentDatabase({
      agentId: "main",
      path: expectDefined(
        resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path,
        "session database path",
      ),
    });
    expect(
      database.db
        .prepare("SELECT session_key, entry_valid FROM session_nodes ORDER BY session_key")
        .all(),
    ).toEqual([{ session_key: canonicalScope.sessionKey, entry_valid: 1 }]);
    expect(
      database.db
        .prepare("SELECT session_key FROM session_windows WHERE session_id = ?")
        .get(sessionId),
    ).toEqual({ session_key: canonicalScope.sessionKey });
    expect(target.sessionKey).toBe(canonicalScope.sessionKey);
  });

  it("drops imported legacy transcript paths and untrusted owners from canonical rows", async () => {
    const sessionKey = "agent:main:main";
    await importSqliteSessionRows({
      agentId: "main",
      entry: {
        owner: { actor: { type: "human", id: "spoofed" } },
        sessionFile: path.join(tempDir, "legacy-transcript.jsonl"),
        sessionId: "session-1",
        updatedAt: 10,
      },
      sessionKey,
      storePath,
    });

    const entry = loadExactSessionEntry({
      agentId: "main",
      sessionKey,
      storePath,
    })?.entry;
    expect(entry).not.toHaveProperty("sessionFile");
    expect(entry).not.toHaveProperty("owner");
  });

  it("reads imported transcripts before opening the SQLite transaction", async () => {
    const agentId = "main";
    const sessionId = "session-1";
    const database = openOpenClawAgentDatabase({
      agentId,
      path: expectDefined(
        resolveSqliteTargetFromSessionStorePath(storePath, { agentId }).path,
        "session database path",
      ),
    });
    let readInsideTransaction: boolean | undefined;

    await importSqliteSessionRows({
      agentId,
      entry: { sessionId, updatedAt: 10 },
      readTranscriptEvents: (append) => {
        readInsideTransaction = database.db.isTransaction;
        append({ sessionId, type: "session" });
      },
      sessionKey: "agent:main:main",
      storePath,
    });

    expect(readInsideTransaction).toBe(false);
  });

  it("tracks replacement and deletion transcript mutations", async () => {
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const scope = {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath,
    };
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      updatedAt: 10,
    });
    await replaceTranscriptEvents(scope, [
      { sessionId: scope.sessionId, type: "session" },
      { timestamp: "1970-01-01T00:00:00.001Z", type: "custom" },
    ]);

    const replaced = readTranscriptStatsSync(scope);
    expect(replaced).toMatchObject({
      eventCount: 2,
      lastMutationAtMs: expect.any(Number),
    });
    expect(replaced.lastMutationAtMs).toBeGreaterThanOrEqual(1_700_000_000_000);

    await importSqliteSessionRows({
      agentId: scope.agentId,
      entry: {
        sessionId: scope.sessionId,
        updatedAt: 10,
      },
      sessionKey: scope.sessionKey,
      storePath: scope.storePath,
      transcriptMtimeMs: 1_600_000_000_000,
    });
    const imported = readTranscriptStatsSync(scope);
    expect(imported.lastMutationAtMs).toBe(replaced.lastMutationAtMs);
    expect(imported.lastObservedMutationAtMs).toBe(replaced.lastMutationAtMs);

    await replaceTranscriptEvents(scope, []);

    const cleared = readTranscriptStatsSync(scope);
    dateNow.mockRestore();
    expect(cleared).toMatchObject({
      eventCount: 0,
      lastMutationAtMs: expect.any(Number),
    });
    expect(cleared.lastMutationAtMs).toBeGreaterThan(imported.lastMutationAtMs ?? 0);
  });

  it("preserves transcript generation on append and rotates it on replacement", async () => {
    const scope = {
      agentId: "main",
      sessionId: "generation-session",
      sessionKey: "agent:main:generation-session",
      storePath,
    };
    const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId: scope.agentId,
    }).path;
    expect(databasePath).toBeDefined();
    const readGeneration = () =>
      openOpenClawAgentDatabase({ agentId: scope.agentId, path: databasePath })
        .db.prepare("SELECT generation FROM transcript_rewrite_watermarks WHERE session_id = ?")
        .get(scope.sessionId) as { generation: string } | undefined;

    await appendTranscriptMessage(scope, {
      message: { role: "user", content: "first" },
    });
    const first = readGeneration()?.generation;
    expect(first).toMatch(/^[0-9a-f]{32}$/);

    await appendTranscriptMessage(scope, {
      message: { role: "assistant", content: "second" },
    });
    expect(readGeneration()?.generation).toBe(first);

    await replaceTranscriptEvents(scope, [
      { sessionId: scope.sessionId, type: "session" },
      { id: "replacement", parentId: null, type: "custom" },
    ]);
    const replaced = readGeneration()?.generation;
    expect(replaced).toMatch(/^[0-9a-f]{32}$/);
    expect(replaced).not.toBe(first);

    await replaceTranscriptEvents(scope, []);
    expect(readGeneration()?.generation).not.toBe(replaced);
  });

  it("ignores an explicit legacy read file and resolves SQLite identity", () => {
    const explicitSessionFile = path.join(tempDir, "explicit-read-session.jsonl");

    const target = resolveSessionTranscriptReadTarget({
      agentId: "main",
      sessionFile: explicitSessionFile,
      sessionId: "session-1",
    });

    expect(target).toMatchObject({
      agentId: "main",
      sessionId: "session-1",
      storePath: expect.stringMatching(/sessions\.json$/),
    });
    expect(target).not.toHaveProperty("sessionFile");
  });

  it("does not expose legacy custom transcript paths as read fallbacks after SQLite migration", async () => {
    const legacyTranscript = path.join(tempDir, "custom-topic-transcript.jsonl");
    const sessionKey = "agent:main:telegram:group:1:topic:9";
    await upsertSessionEntryCore(
      { sessionKey, storePath },
      {
        sessionId: "custom-topic-session",
        sessionFile: legacyTranscript,
        updatedAt: 10,
      },
    );

    const target = resolveSessionTranscriptReadTarget({
      agentId: "main",
      sessionId: "custom-topic-session",
      sessionKey,
      storePath,
    });

    expect(target).toEqual({
      agentId: "main",
      sessionId: "custom-topic-session",
      sessionKey,
      storePath,
    });
  });

  it("preserves a matching preloaded entry identity without rereading the session row", () => {
    const sessionKey = "agent:main:preloaded-read";
    const target = resolveSessionTranscriptReadTarget({
      agentId: "main",
      sessionEntry: { sessionId: "preloaded-session" },
      sessionId: "preloaded-session",
      sessionKey,
      storePath,
    });

    expect(target).toEqual({
      agentId: "main",
      sessionId: "preloaded-session",
      sessionKey,
      storePath,
    });
  });

  it("does not trust a preloaded entry for a different session id", async () => {
    const sessionKey = "agent:main:mismatched-preloaded-read";
    await upsertSessionEntryCore(
      { sessionKey, storePath },
      {
        sessionId: "stored-session",
        updatedAt: 10,
      },
    );

    const target = resolveSessionTranscriptReadTarget({
      agentId: "main",
      sessionEntry: { sessionId: "different-session" },
      sessionId: "stored-session",
      sessionKey,
      storePath,
    });

    expect(target).toEqual({
      agentId: "main",
      sessionId: "stored-session",
      sessionKey,
      storePath,
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
