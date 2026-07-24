import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTestTimeout } from "../../../test/helpers/promise.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { appendSqliteTrajectoryRuntimeEvents } from "../../trajectory/runtime-store.sqlite.js";
import type { TrajectoryEvent } from "../../trajectory/types.js";
import {
  deliveryContextFromSession,
  sessionDeliveryRoute,
} from "../../utils/delivery-context.shared.js";
import { readSessionArchiveContentSync } from "./archive-compression.js";
import {
  applySessionEntryReplacements,
  appendTranscriptMessage,
  applySessionEntryLifecycleMutation,
  commitReplySessionInitialization,
  createSessionEntryWithTranscript,
  deleteSessionEntryLifecycle,
  findTranscriptEvent,
  listSessionEntries,
  listSessionEntriesByStatus,
  listSessionTranscriptInstances,
  loadReplySessionInitializationSnapshot,
  loadSessionEntry,
  loadTranscriptEvents,
  markSessionAbortTarget,
  onSessionIdentityMutation,
  openSessionEntryReadView,
  patchSessionEntry,
  patchSessionEntryTarget,
  persistSessionResetLifecycle,
  persistSessionTranscriptTurn,
  readTranscriptStatsSync,
  readSessionUpdatedAt,
  recordInboundSessionMeta,
  replaceSessionEntry,
  resetSessionEntryLifecycle,
  SessionInitializationAgentScopeMismatchError,
  resolveSessionEntryAccessTarget,
  resolveSessionEntryCandidateTarget,
  resolveSessionTranscriptReadTarget,
  resolveSessionTranscriptRuntimeReadTarget,
  resolveSessionTranscriptRuntimeTarget,
  rollbackPluginOwnedSessionEntryLifecycle,
  trimSessionTranscriptForManualCompact,
  updateSessionEntry,
  updateSessionLastRoute,
  upsertSessionEntry,
} from "./session-accessor.js";
import {
  readSqliteSessionEntryCount,
  readSqliteSessionEntryKeys,
} from "./session-accessor.sqlite-entry-store.js";
import {
  appendSqliteTranscriptEventSync,
  importSqliteSessionRows,
  loadExactSqliteSessionEntry,
  replaceSqliteSessionEntrySync,
  replaceSqliteTranscriptEvents,
  trimSqliteTranscriptForManualCompact,
} from "./session-accessor.sqlite.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { formatSqliteSessionFileMarker } from "./sqlite-marker.js";
import { withOwnedSessionTranscriptWrites } from "./transcript-write-context.js";
import type { SessionEntry } from "./types.js";

const cleanupArchivedSessionTranscriptsMock = vi.hoisted(() => vi.fn(async () => {}));

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

describe("session accessor seam", () => {
  let tempDir: string;
  let storePath: string;
  let transcriptPath: string;

  beforeEach(() => {
    cleanupArchivedSessionTranscriptsMock.mockReset();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-accessor-"));
    storePath = path.join(tempDir, "sessions.json");
    transcriptPath = path.join(tempDir, "session.jsonl");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("loads, lists, and patches session entries without exposing the file store shape", async () => {
    const scope = {
      sessionKey: "agent:main:main",
      storePath,
    };

    await upsertSessionEntry(scope, {
      model: "gpt-5.5",
      sessionId: "session-1",
      updatedAt: 10,
    });

    expect(loadSessionEntry(scope)).toMatchObject({
      model: "gpt-5.5",
      sessionId: "session-1",
      updatedAt: expect.any(Number),
    });
    expect(readSessionUpdatedAt(scope)).toEqual(expect.any(Number));
    expect(listSessionEntries({ storePath })).toEqual([
      {
        sessionKey: "agent:main:main",
        entry: expect.objectContaining({
          model: "gpt-5.5",
          sessionId: "session-1",
          updatedAt: expect.any(Number),
        }),
      },
    ]);

    await upsertSessionEntry(scope, { model: "sonnet-4.6", updatedAt: 20 });

    expect(loadSessionEntry(scope)).toMatchObject({
      model: "sonnet-4.6",
      sessionId: "session-1",
      updatedAt: expect.any(Number),
    });
  });

  it("excludes transcript-only nodes from logical entry counts and keys", async () => {
    await replaceSessionEntry(
      { sessionKey: "agent:main:logical-entry", storePath },
      { sessionId: "logical-entry-session", updatedAt: 10 },
    );
    await replaceSqliteTranscriptEvents(
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

    expect(readSqliteSessionEntryCount(database)).toBe(1);
    expect(readSqliteSessionEntryKeys(database)).toEqual(["agent:main:logical-entry"]);
  });

  it("retains legacy createdBy actor projections across rewrites", async () => {
    const sessionKey = "agent:main:created-by";
    await replaceSessionEntry({ sessionKey, storePath }, {
      createdBy: { id: "legacy-human" },
      sessionId: "created-by-session",
      updatedAt: 10,
    } as SessionEntry & { createdBy: { id: string } });
    await upsertSessionEntry({ sessionKey, storePath }, { label: "rewritten" });
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
    await upsertSessionEntry(scope, {
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
    await upsertSessionEntry(scope, { sessionId: "history-new", updatedAt: 20 });
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
    await upsertSessionEntry(scope, { label: "renamed", updatedAt: Date.now() + 60_000 });
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
    await upsertSessionEntry(
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

    await upsertSessionEntry(
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

    await upsertSessionEntry(
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
    await upsertSessionEntry(
      { sessionKey: "agent:main:main", storePath },
      { sessionId: "session-events", updatedAt: 10 },
    );
    await replaceSqliteTranscriptEvents(
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
    await upsertSessionEntry(
      { sessionKey: "agent:main:main", storePath },
      { sessionId: "session-find", updatedAt: 10 },
    );
    await replaceSqliteTranscriptEvents(
      { agentId: "main", sessionId: "session-find", sessionKey: "agent:main:main", storePath },
      [header, older, newer],
    );

    const seen: unknown[] = [];
    const found = await findTranscriptEvent(
      { sessionId: "session-find", sessionKey: "agent:main:main", storePath },
      (event) => {
        seen.push(event);
        return (event as { type?: string }).type === "message";
      },
    );
    // Newest-first with early exit: the older message is never visited.
    expect(found).toEqual({ event: newer });
    expect(seen).toEqual([newer]);

    await replaceSqliteTranscriptEvents(
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
    await upsertSessionEntry(
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

    await upsertSessionEntry(
      { sessionKey: mixedKey, storePath },
      { sessionId: "mixed-session", updatedAt: 10 },
    );
    await upsertSessionEntry(
      { sessionKey: lowerKey, storePath },
      { sessionId: "lower-session", updatedAt: 20 },
    );

    expect(loadSessionEntry({ sessionKey: mixedKey, storePath })?.sessionId).toBe("mixed-session");
    expect(loadSessionEntry({ sessionKey: lowerKey, storePath })?.sessionId).toBe("lower-session");
    expect(
      listSessionEntries({ agentId: "voice", storePath }).map((entry) => entry.sessionKey),
    ).toEqual([mixedKey, lowerKey]);
  });

  it("records inbound session meta as a createIfMissing upsert returning a detached entry", async () => {
    const sessionKey = "agent:main:webchat:dm:user-1";
    const ctx: MsgContext = {
      Provider: "webchat",
      Surface: "webchat",
      ChatType: "direct",
      From: "webchat:user-1",
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
      ctx: { ...ctx, From: "webchat:different-sender" },
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

  it("patches the freshest target alias and rewrites it to the canonical key", async () => {
    const canonicalKey = "agent:main:work";
    const aliasKey = "agent:main:main";
    await replaceSessionEntry(
      {
        sessionKey: "agent:main:work",
        storePath,
      },
      {
        sessionId: "canonical-session",
        updatedAt: 10,
      },
    );
    await replaceSessionEntry(
      {
        sessionKey: "agent:main:main",
        storePath,
      },
      {
        sessionId: "legacy-session",
        updatedAt: 20,
        visibility: "read-only",
      },
    );
    await replaceSqliteTranscriptEvents(
      { agentId: "main", sessionId: "legacy-history", sessionKey: aliasKey, storePath },
      [{ id: "legacy-history-event", type: "message" }],
    );
    const aliasDatabasePath = expectDefined(
      resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path,
      "alias database path",
    );
    const aliasDatabase = openOpenClawAgentDatabase({ agentId: "main", path: aliasDatabasePath });
    aliasDatabase.db
      .prepare(
        `INSERT INTO session_nodes (
           session_key, current_session_id, entry_json, updated_at
         ) VALUES (?, 'canonical-session', ?, 10)`,
      )
      .run(canonicalKey, JSON.stringify({ sessionId: "canonical-session", updatedAt: 10 }));
    aliasDatabase.db
      .prepare(
        `INSERT INTO session_windows (
           session_id, session_key, session_scope, created_at, updated_at
         ) VALUES ('canonical-session', ?, 'conversation', 10, 10)`,
      )
      .run(canonicalKey);
    aliasDatabase.db
      .prepare(
        `INSERT INTO board_tabs (
           session_key, tab_id, title, position, chat_dock, created_by, revision
         ) VALUES ('agent:main:main', 'main', 'Alias board', 0, 'right', 'user', 2)`,
      )
      .run();
    aliasDatabase.db
      .prepare(
        `INSERT INTO board_widgets (
           session_key, name, tab_id, content_kind, html, sha256, view_generation,
           revision, size_w, size_h, position, created_by, created_at, updated_at
         ) VALUES (
           'agent:main:main', 'status', 'main', 'html', X'3C703E6F6B3C2F703E',
           'alias-hash', 'view-1', 2, 4, 4, 0, 'user', 20, 20
         )`,
      )
      .run();
    aliasDatabase.db
      .prepare(
        `INSERT INTO board_tabs (
           session_key, tab_id, title, position, chat_dock, created_by, revision
         ) VALUES ('agent:main:work', 'main', 'Stale canonical board', 0, 'right', 'user', 1)`,
      )
      .run();
    aliasDatabase.db
      .prepare(
        `INSERT INTO board_widgets (
           session_key, name, tab_id, content_kind, html, sha256, view_generation,
           revision, size_w, size_h, position, created_by, created_at, updated_at
         ) VALUES (
           'agent:main:work', 'status', 'main', 'html', X'3C703E7374616C653C2F703E',
           'stale-canonical-hash', 'view-stale', 1, 4, 4, 0, 'user', 10, 10
         )`,
      )
      .run();
    aliasDatabase.db
      .prepare(
        `INSERT INTO heartbeat_outcomes (
           session_key, run_session_key, outcome, summary, occurred_at, updated_at
         ) VALUES (
           'agent:main:work', 'agent:main:work', 'progress', 'stale canonical heartbeat', 10, 10
         )`,
      )
      .run();
    aliasDatabase.db
      .prepare(
        `INSERT INTO heartbeat_outcomes (
           session_key, run_session_key, outcome, summary, occurred_at, updated_at
         ) VALUES ('agent:main:main', 'agent:main:main', 'done', 'alias heartbeat', 20, 20)`,
      )
      .run();
    aliasDatabase.db
      .prepare(
        `INSERT INTO session_members (session_key, identity_id, added_by, added_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run("agent:main:main", "member-1", "owner-1", 20);
    expect(
      aliasDatabase.db.prepare("SELECT session_key FROM session_nodes ORDER BY session_key").all(),
    ).toEqual([{ session_key: "agent:main:main" }, { session_key: "agent:main:work" }]);
    aliasDatabase.db
      .prepare(
        `INSERT INTO session_members (session_key, identity_id, added_by, added_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run("agent:main:work", "stale-canonical-member", "stale-owner", 10);

    const notify = vi.fn();
    const unsubscribe = onSessionIdentityMutation(notify);
    const patched = await patchSessionEntryTarget(
      {
        storePath,
        target: {
          canonicalKey: "agent:main:work",
          storeKeys: ["agent:main:work", "agent:main:main"],
        },
      },
      (entry, context) => {
        expect(entry.sessionId).toBe("legacy-session");
        expect(context.existingEntry?.sessionId).toBe("legacy-session");
        return {
          label: "patched",
        };
      },
    );
    expect(patched).toMatchObject({
      label: "patched",
      sessionId: "legacy-session",
      visibility: "read-only",
    });
    expect(listSessionEntries({ storePath })).toEqual([
      {
        sessionKey: "agent:main:work",
        entry: expect.objectContaining({
          label: "patched",
          sessionId: "legacy-session",
        }),
      },
    ]);
    expect(
      aliasDatabase.db
        .prepare("SELECT session_key, title, revision FROM board_tabs ORDER BY session_key")
        .all(),
    ).toEqual([{ session_key: "agent:main:work", title: "Alias board", revision: 2 }]);
    expect(
      aliasDatabase.db
        .prepare(
          "SELECT session_key, name, sha256, revision, updated_at FROM board_widgets ORDER BY session_key",
        )
        .all(),
    ).toEqual([
      {
        session_key: "agent:main:work",
        name: "status",
        sha256: "alias-hash",
        revision: 2,
        updated_at: 20,
      },
    ]);
    expect(
      aliasDatabase.db
        .prepare("SELECT session_key, summary FROM heartbeat_outcomes ORDER BY session_key")
        .all(),
    ).toEqual([{ session_key: "agent:main:work", summary: "alias heartbeat" }]);
    expect(
      aliasDatabase.db
        .prepare("SELECT session_key, identity_id FROM session_members ORDER BY session_key")
        .all(),
    ).toEqual([{ session_key: "agent:main:work", identity_id: "member-1" }]);
    expect(
      aliasDatabase.db
        .prepare("SELECT session_key FROM session_windows WHERE session_id = 'legacy-history'")
        .get(),
    ).toEqual({ session_key: canonicalKey });
    await expect(
      loadTranscriptEvents({
        agentId: "main",
        sessionId: "legacy-history",
        sessionKey: canonicalKey,
        storePath,
      }),
    ).resolves.toEqual([{ id: "legacy-history-event", type: "message" }]);
    const sessionKey = "agent:main:other";
    const scope = { sessionKey, storePath };
    await replaceSessionEntry(scope, { sessionId: "created", updatedAt: 10 });
    await patchSessionEntry(scope, () => ({ label: "same identity" }));
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
      "move",
      "replace",
      "create",
      "replace",
      "reset",
      "delete",
    ]);
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

  it("resolves non-main candidate entries from custom agent store templates", async () => {
    const storeTemplate = path.join(tempDir, "{agentId}.json");
    const supportStorePath = path.join(tempDir, "support.json");
    await upsertSessionEntry(
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
    await upsertSessionEntry(
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

    const inserted = await upsertSessionEntry(scope, { model: "gpt-5.5" });

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
    expect(created.sessionFile).toContain("sqlite:main:session-1:");
    expect(created.entry.sessionFile).toBe(created.sessionFile);
    await expect(
      loadTranscriptEvents({
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath,
      }),
    ).resolves.toEqual([expect.objectContaining({ id: "session-1", type: "session" })]);
  });

  it("persists store-backed turns to SQLite when an old sessionFile path is present", async () => {
    const legacyTranscript = path.join(tempDir, "legacy-topic.jsonl");
    const scope = {
      agentId: "main",
      sessionId: "legacy-topic-session",
      sessionKey: "agent:main:telegram:group:1:topic:2",
      storePath,
      sessionFile: legacyTranscript,
    };
    await upsertSessionEntry(
      { sessionKey: scope.sessionKey, storePath },
      {
        sessionId: scope.sessionId,
        sessionFile: legacyTranscript,
        updatedAt: 10,
      },
    );

    const result = await persistSessionTranscriptTurn(scope, {
      messages: [{ message: { role: "user", content: "store-backed sqlite turn" } }],
      touchSessionEntry: true,
      updateMode: "none",
    });

    expect(result.sessionFile).toContain("sqlite:main:legacy-topic-session:");
    const entry = loadSessionEntry({ sessionKey: scope.sessionKey, storePath });
    expect(entry?.sessionFile).toBe(result.sessionFile);
    await expect(loadTranscriptEvents(scope)).resolves.toContainEqual(
      expect.objectContaining({
        type: "message",
        message: expect.objectContaining({
          role: "user",
          content: "store-backed sqlite turn",
        }),
      }),
    );
    expect(fs.existsSync(legacyTranscript)).toBe(false);
  });

  it("resolves default-store SQLite transcript turn markers before appending", async () => {
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
    await upsertSessionEntry(
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

    expect(result.sessionFile).toBe(`sqlite:main:${scope.sessionId}:${expectedStorePath}`);
    const persistedScope = { ...scope, storePath: expectedStorePath };
    expect(loadSessionEntry(persistedScope)?.sessionFile).toBe(result.sessionFile);
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

  it("guards store-backed turns in SQLite when an old sessionFile path is present", async () => {
    const legacyTranscript = path.join(tempDir, "guarded-legacy-topic.jsonl");
    const scope = {
      agentId: "main",
      sessionId: "guarded-topic-session",
      sessionKey: "agent:main:telegram:group:1:topic:3",
      storePath,
      sessionFile: legacyTranscript,
    };
    await upsertSessionEntry(
      { sessionKey: scope.sessionKey, storePath },
      {
        sessionId: scope.sessionId,
        sessionFile: legacyTranscript,
        updatedAt: 10,
      },
    );

    const result = await persistSessionTranscriptTurn(scope, {
      expectedSessionId: scope.sessionId,
      messages: [{ message: { role: "assistant", content: "guarded sqlite turn" } }],
      touchSessionEntry: true,
      updateMode: "none",
    });

    expect(result.rejectedReason).toBeUndefined();
    expect(result.sessionFile).toContain("sqlite:main:guarded-topic-session:");
    const entry = loadSessionEntry({ sessionKey: scope.sessionKey, storePath });
    expect(entry?.sessionFile).toBe(result.sessionFile);
    await expect(loadTranscriptEvents(scope)).resolves.toContainEqual(
      expect.objectContaining({
        type: "message",
        message: expect.objectContaining({
          role: "assistant",
          content: "guarded sqlite turn",
        }),
      }),
    );
    expect(fs.existsSync(legacyTranscript)).toBe(false);
  });

  it("appends SQLite turns to the active transcript leaf", async () => {
    const scope = {
      agentId: "main",
      sessionId: "branched-topic-session",
      sessionKey: "agent:main:telegram:group:1:topic:4",
      storePath,
    };
    await replaceSqliteTranscriptEvents(scope, [
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
    expect(listSessionEntries({ storePath })).toEqual([]);
  });

  it("does not write the session database when entry preparation is rejected", async () => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:main",
      storePath,
    };
    await upsertSessionEntry(scope, {
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

  it("commits reply session initialization with a guarded snapshot", async () => {
    const sessionKey = "agent:main:main";
    const previousTranscript = path.join(tempDir, "previous.jsonl");
    fs.writeFileSync(
      previousTranscript,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "previous-session",
        timestamp: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
    await upsertSessionEntry(
      { sessionKey, storePath },
      {
        sessionFile: previousTranscript,
        sessionId: "previous-session",
        updatedAt: 10,
      },
    );

    const snapshot = loadReplySessionInitializationSnapshot({
      agentId: "main",
      sessionKey,
      storePath,
    });
    const committed = await commitReplySessionInitialization({
      activeSessionKey: sessionKey,
      agentId: "main",
      expectedRevision: snapshot.revision,
      previousEntry: snapshot.currentEntry,
      sessionEntry: {
        sessionId: "next-session",
        updatedAt: 20,
      },
      sessionKey,
      storePath,
    });

    expect(committed.ok).toBe(true);
    if (!committed.ok) {
      throw new Error("expected reply session initialization to commit");
    }
    expect(committed.sessionEntry.sessionFile).toBe(`sqlite:main:next-session:${storePath}`);
    expect(committed.sessionStoreView[sessionKey]).toMatchObject({
      sessionId: "next-session",
      sessionFile: committed.sessionEntry.sessionFile,
    });
    expect(committed.previousSessionTranscript.transcriptArchived).toBe(true);
    expect(fs.existsSync(previousTranscript)).toBe(false);
  });

  it("does not reuse the previous transcript file when initialization rotates session ids", async () => {
    const sessionKey = "agent:main:main";
    const previousTranscript = path.join(tempDir, "previous-rotation.jsonl");
    await upsertSessionEntry(
      { sessionKey, storePath },
      {
        sessionFile: previousTranscript,
        sessionId: "previous-rotation",
        updatedAt: 10,
      },
    );

    const snapshot = loadReplySessionInitializationSnapshot({
      agentId: "main",
      sessionKey,
      storePath,
    });
    const committed = await commitReplySessionInitialization({
      activeSessionKey: sessionKey,
      agentId: "main",
      expectedRevision: snapshot.revision,
      previousEntry: snapshot.currentEntry,
      sessionEntry: {
        ...snapshot.currentEntry,
        sessionFile: snapshot.currentEntry?.sessionFile,
        sessionId: "next-rotation",
        updatedAt: 20,
      },
      sessionKey,
      storePath,
    });

    expect(committed.ok).toBe(true);
    if (!committed.ok) {
      throw new Error("expected reply session initialization to commit");
    }
    expect(committed.sessionEntry.sessionFile).toBe(`sqlite:main:next-rotation:${storePath}`);
  });

  it("rejects stale reply session initialization snapshots without writing", async () => {
    const sessionKey = "agent:main:main";
    await upsertSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: "first-session",
        updatedAt: 10,
      },
    );
    const snapshot = loadReplySessionInitializationSnapshot({
      agentId: "main",
      sessionKey,
      storePath,
    });
    await upsertSessionEntry(
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

  it("commits reply session initialization despite active-turn metadata changes", async () => {
    const sessionKey = "agent:main:main";
    await upsertSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: "existing-session",
        updatedAt: 10,
      },
    );
    const snapshot = loadReplySessionInitializationSnapshot({
      agentId: "main",
      sessionKey,
      storePath,
    });
    const current = loadSessionEntry({ sessionKey, storePath });
    if (!current) {
      throw new Error("expected existing session entry");
    }
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        ...current,
        compactionCount: 1,
        totalTokensFresh: false,
        updatedAt: current.updatedAt + 1,
      },
    );

    const committed = await commitReplySessionInitialization({
      activeSessionKey: sessionKey,
      agentId: "main",
      expectedRevision: snapshot.revision,
      sessionEntry: {
        sessionId: "existing-session",
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
    expect(committed.sessionEntry).toMatchObject({
      compactionCount: 1,
      sessionId: "existing-session",
      totalTokensFresh: false,
      updatedAt: 30,
    });
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      compactionCount: 1,
      sessionId: "existing-session",
      totalTokensFresh: false,
      updatedAt: 30,
    });
  });

  it("commits reply session initialization despite non-identity metadata changes", async () => {
    const sessionKey = "agent:main:main";
    await upsertSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: "existing-session",
        updatedAt: 10,
        lastHeartbeatSentAt: 100,
        lastHeartbeatText: "heartbeat-1",
      },
    );

    const snapshot = loadReplySessionInitializationSnapshot({
      agentId: "main",
      sessionKey,
      storePath,
    });

    // Background activity (heartbeat runner, delivery retry, etc.) can touch
    // metadata fields without rotating the session. The initialization guard
    // should only care about session identity, so this must not conflict.
    const current = loadSessionEntry({ sessionKey, storePath });
    if (!current) {
      throw new Error("expected existing session entry");
    }
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        ...current,
        lastHeartbeatSentAt: 200,
        lastHeartbeatText: "heartbeat-2",
      },
    );

    const committed = await commitReplySessionInitialization({
      activeSessionKey: sessionKey,
      agentId: "main",
      expectedRevision: snapshot.revision,
      // The real caller builds the prepared entry from the snapshot, so it
      // inherits the pre-drift heartbeat values. The commit must still notice
      // the concurrent metadata change and preserve the newer values.
      sessionEntry: {
        sessionId: "existing-session",
        updatedAt: 30,
        lastHeartbeatSentAt: 100,
        lastHeartbeatText: "heartbeat-1",
      },
      sessionKey,
      snapshotEntry: snapshot.currentEntry,
      storePath,
    });

    expect(committed.ok).toBe(true);
    if (!committed.ok) {
      throw new Error("expected reply session initialization to commit");
    }
    expect(committed.sessionEntry.sessionId).toBe("existing-session");
    // The accepted commit must not roll back the metadata drift that happened
    // while the initialization was in flight.
    expect(committed.sessionEntry.lastHeartbeatSentAt).toBe(200);
    expect(committed.sessionEntry.lastHeartbeatText).toBe("heartbeat-2");
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      sessionId: "existing-session",
      lastHeartbeatSentAt: 200,
      lastHeartbeatText: "heartbeat-2",
    });
  });

  it("preserves concurrent optional additions when prepared fields are undefined", async () => {
    const sessionKey = "agent:main:main";
    await upsertSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: "existing-session",
        updatedAt: 10,
      },
    );

    const snapshot = loadReplySessionInitializationSnapshot({
      agentId: "main",
      sessionKey,
      storePath,
    });

    const current = loadSessionEntry({ sessionKey, storePath });
    if (!current) {
      throw new Error("expected existing session entry");
    }
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        ...current,
        modelOverride: "channel-model",
        modelOverrideSource: "user",
      },
    );

    const committed = await commitReplySessionInitialization({
      activeSessionKey: sessionKey,
      agentId: "main",
      expectedRevision: snapshot.revision,
      sessionEntry: {
        sessionId: "existing-session",
        updatedAt: 30,
        modelOverride: undefined,
        modelOverrideSource: undefined,
      },
      sessionKey,
      snapshotEntry: snapshot.currentEntry,
      storePath,
    });

    expect(committed.ok).toBe(true);
    if (!committed.ok) {
      throw new Error("expected reply session initialization to commit");
    }
    expect(committed.sessionEntry).toMatchObject({
      modelOverride: "channel-model",
      modelOverrideSource: "user",
      sessionId: "existing-session",
      updatedAt: 30,
    });
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      modelOverride: "channel-model",
      modelOverrideSource: "user",
      sessionId: "existing-session",
      updatedAt: 30,
    });
  });

  it("does not restore pending final delivery metadata cleared after the snapshot", async () => {
    const sessionKey = "agent:main:main";
    await upsertSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: "existing-session",
        updatedAt: 10,
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: "durable reply",
        pendingFinalDeliveryCreatedAt: 11,
        pendingFinalDeliveryLastAttemptAt: 12,
        pendingFinalDeliveryAttemptCount: 2,
        pendingFinalDeliveryLastError: "previous failure",
        pendingFinalDeliveryContext: { channel: "discord", to: "channel-1" },
        pendingFinalDeliveryIntentId: "intent-1",
      },
    );

    const snapshot = loadReplySessionInitializationSnapshot({
      agentId: "main",
      sessionKey,
      storePath,
    });
    if (!snapshot.currentEntry) {
      throw new Error("expected reply session initialization snapshot");
    }

    const current = loadSessionEntry({ sessionKey, storePath });
    if (!current) {
      throw new Error("expected existing session entry");
    }
    const currentWithoutPendingDelivery = { ...current };
    delete currentWithoutPendingDelivery.pendingFinalDelivery;
    delete currentWithoutPendingDelivery.pendingFinalDeliveryAttemptCount;
    delete currentWithoutPendingDelivery.pendingFinalDeliveryContext;
    delete currentWithoutPendingDelivery.pendingFinalDeliveryCreatedAt;
    delete currentWithoutPendingDelivery.pendingFinalDeliveryIntentId;
    delete currentWithoutPendingDelivery.pendingFinalDeliveryLastAttemptAt;
    delete currentWithoutPendingDelivery.pendingFinalDeliveryLastError;
    delete currentWithoutPendingDelivery.pendingFinalDeliveryText;
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
    expect(committed.sessionEntry.pendingFinalDeliveryText).toBeUndefined();
    expect(committed.sessionEntry.pendingFinalDeliveryCreatedAt).toBeUndefined();
    expect(committed.sessionEntry.pendingFinalDeliveryLastAttemptAt).toBeUndefined();
    expect(committed.sessionEntry.pendingFinalDeliveryAttemptCount).toBeUndefined();
    expect(committed.sessionEntry.pendingFinalDeliveryLastError).toBeUndefined();
    expect(committed.sessionEntry.pendingFinalDeliveryContext).toBeUndefined();
    expect(committed.sessionEntry.pendingFinalDeliveryIntentId).toBeUndefined();

    const persisted = loadSessionEntry({ sessionKey, storePath });
    expect(persisted?.pendingFinalDelivery).toBeUndefined();
    expect(persisted?.pendingFinalDeliveryText).toBeUndefined();
    expect(persisted?.pendingFinalDeliveryCreatedAt).toBeUndefined();
    expect(persisted?.pendingFinalDeliveryLastAttemptAt).toBeUndefined();
    expect(persisted?.pendingFinalDeliveryAttemptCount).toBeUndefined();
    expect(persisted?.pendingFinalDeliveryLastError).toBeUndefined();
    expect(persisted?.pendingFinalDeliveryContext).toBeUndefined();
    expect(persisted?.pendingFinalDeliveryIntentId).toBeUndefined();
  });

  it("does not merge old-session delivery metadata into a rotated session", async () => {
    const sessionKey = "agent:main:main";
    await upsertSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: "old-session",
        updatedAt: 10,
      },
    );

    const snapshot = loadReplySessionInitializationSnapshot({
      agentId: "main",
      sessionKey,
      storePath,
    });

    const current = loadSessionEntry({ sessionKey, storePath });
    if (!current) {
      throw new Error("expected existing session entry");
    }
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        ...current,
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: "old reply",
        pendingFinalDeliveryCreatedAt: 21,
        pendingFinalDeliveryContext: { channel: "discord", to: "channel-1" },
        pendingFinalDeliveryIntentId: "intent-old",
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
    expect(committed.sessionEntry.pendingFinalDeliveryText).toBeUndefined();
    expect(committed.sessionEntry.pendingFinalDeliveryCreatedAt).toBeUndefined();
    expect(committed.sessionEntry.pendingFinalDeliveryContext).toBeUndefined();
    expect(committed.sessionEntry.pendingFinalDeliveryIntentId).toBeUndefined();

    const persisted = loadSessionEntry({ sessionKey, storePath });
    expect(persisted?.sessionId).toBe("new-session");
    expect(persisted?.pendingFinalDelivery).toBeUndefined();
    expect(persisted?.pendingFinalDeliveryText).toBeUndefined();
    expect(persisted?.pendingFinalDeliveryCreatedAt).toBeUndefined();
    expect(persisted?.pendingFinalDeliveryContext).toBeUndefined();
    expect(persisted?.pendingFinalDeliveryIntentId).toBeUndefined();
  });

  it("commits reply session initialization from a guarded legacy alias snapshot", async () => {
    const sessionKey = "agent:main:main";
    await applySessionEntryLifecycleMutation({
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
    });

    const snapshot = loadReplySessionInitializationSnapshot({
      agentId: "main",
      sessionKey,
      storePath,
    });
    const committed = await commitReplySessionInitialization({
      activeSessionKey: sessionKey,
      agentId: "main",
      expectedRevision: snapshot.revision,
      previousEntry: snapshot.currentEntry,
      sessionEntry: {
        sessionId: "next-session",
        updatedAt: 20,
      },
      sessionKey,
      storePath,
    });

    expect(committed.ok).toBe(true);
    if (!committed.ok) {
      throw new Error("expected reply session initialization to commit");
    }
    expect(committed.sessionEntry.sessionId).toBe("next-session");
    expect(loadSessionEntry({ sessionKey, storePath })?.sessionId).toBe("next-session");
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

  it("allows an unscoped legacy alias with an explicit agent owner", async () => {
    await upsertSessionEntry(
      { agentId: "ops", sessionKey: "main", storePath },
      { sessionId: "legacy-ops-session", updatedAt: 10 },
    );

    const snapshot = loadReplySessionInitializationSnapshot({
      agentId: "ops",
      sessionKey: "main",
      storePath,
    });

    expect(snapshot.currentEntry?.sessionId).toBe("legacy-ops-session");
  });

  it("rejects reply session initialization when the entry is deleted during prepare", async () => {
    const sessionKey = "agent:main:main";
    await upsertSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: "first-session",
        updatedAt: 10,
      },
    );
    const snapshot = loadReplySessionInitializationSnapshot({
      agentId: "main",
      sessionKey,
      storePath,
    });

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
    expect(listSessionEntries({ storePath })).toEqual([]);

    await upsertSessionEntry(scope, {
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

    await upsertSessionEntry(scope, {
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

    await patchSessionEntry(
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

    await patchSessionEntry(
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

  it("can patch metadata without refreshing session activity", async () => {
    const scope = {
      sessionKey: "agent:main:main",
      storePath,
    };

    await upsertSessionEntry(scope, {
      sessionId: "session-1",
      updatedAt: 10,
    });
    const beforePatch = loadSessionEntry(scope);

    await patchSessionEntry(
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
    expect(
      listSessionEntriesByStatus({ storePath }, ["done"]).map((entry) => entry.sessionKey),
    ).toEqual(["agent:main:done", "agent:main:shared-done"]);

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

    const missingSelectionResult = await applySessionEntryReplacements({
      sessionKeys: ["agent:main:missing"],
      storePath,
      update: () => ({
        replacements: [
          {
            sessionKey: "agent:main:missing",
            entry: { sessionId: "missing", status: "running", updatedAt: 30 },
          },
        ],
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

  it("prepares entry replacements without holding a write transaction", async () => {
    const scope = {
      sessionKey: "agent:main:replacement-prepare",
      storePath,
    };
    await upsertSessionEntry(scope, {
      model: "base",
      sessionId: "replacement-prepare",
      updatedAt: 10,
    });
    let releasePlanner!: () => void;
    let markPlannerStarted!: () => void;
    const plannerStarted = new Promise<void>((resolve) => {
      markPlannerStarted = resolve;
    });
    const plannerGate = new Promise<void>((resolve) => {
      releasePlanner = resolve;
    });
    const pendingReplacement = applySessionEntryReplacements({
      sessionKeys: [scope.sessionKey],
      storePath,
      update: async (entries) => {
        markPlannerStarted();
        await plannerGate;
        return {
          replacements: entries.map(({ entry, sessionKey }) => ({
            entry: { ...entry, model: "planned" },
            sessionKey,
          })),
          result: undefined,
        };
      },
    });

    await plannerStarted;
    let replacementError: unknown;
    try {
      replaceSqliteSessionEntrySync(scope, {
        model: "newer",
        sessionId: "replacement-prepare",
        updatedAt: 20,
      });
    } catch (error) {
      replacementError = error;
    } finally {
      releasePlanner();
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

  it("does not hold a write transaction while awaiting a lifecycle entry builder", async () => {
    const sessionKey = "agent:main:lifecycle-prepare";
    await upsertSessionEntry(
      { sessionKey, storePath },
      { model: "base", sessionId: "lifecycle-prepare", updatedAt: 10 },
    );
    let releaseBuilder!: () => void;
    let markBuilderStarted!: () => void;
    const builderStarted = new Promise<void>((resolve) => {
      markBuilderStarted = resolve;
    });
    const builderGate = new Promise<void>((resolve) => {
      releaseBuilder = resolve;
    });
    const pendingMutation = applySessionEntryLifecycleMutation({
      storePath,
      upserts: [
        {
          sessionKey,
          buildEntry: async ({ currentEntry }) => {
            markBuilderStarted();
            await builderGate;
            return { ...currentEntry, model: "projected" } as SessionEntry;
          },
        },
      ],
      skipMaintenance: true,
    });

    await builderStarted;
    let unrelatedWriteError: unknown;
    try {
      appendSqliteTrajectoryRuntimeEvents({ sessionId: "lifecycle-prepare", storePath }, [
        createTestTrajectoryEvent("lifecycle-prepare"),
      ]);
    } catch (error) {
      unrelatedWriteError = error;
    } finally {
      releaseBuilder();
    }

    await expect(pendingMutation).resolves.toMatchObject({ afterCount: 1 });
    expect(unrelatedWriteError).toBeUndefined();
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({ model: "projected" });
  });

  it("rejects a lifecycle projection when its source row changes", async () => {
    const scope = { sessionKey: "agent:main:lifecycle-stale", storePath };
    await upsertSessionEntry(scope, {
      model: "base",
      sessionId: "lifecycle-stale",
      updatedAt: 10,
    });
    let releaseBuilder!: () => void;
    let markBuilderStarted!: () => void;
    const builderStarted = new Promise<void>((resolve) => {
      markBuilderStarted = resolve;
    });
    const builderGate = new Promise<void>((resolve) => {
      releaseBuilder = resolve;
    });
    const pendingMutation = applySessionEntryLifecycleMutation({
      storePath,
      upserts: [
        {
          sessionKey: scope.sessionKey,
          buildEntry: async ({ currentEntry }) => {
            markBuilderStarted();
            await builderGate;
            return { ...currentEntry, model: "stale-projection" } as SessionEntry;
          },
        },
      ],
      skipMaintenance: true,
    });

    await builderStarted;
    let replacementError: unknown;
    try {
      replaceSqliteSessionEntrySync(scope, {
        model: "newer",
        sessionId: "lifecycle-stale",
        updatedAt: 20,
      });
    } catch (error) {
      replacementError = error;
    } finally {
      releaseBuilder();
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
    await upsertSessionEntry(scope, {
      restartRecoveryDeliveryContext: {
        channel: "whatsapp",
        to: "+15551234567",
      },
      restartRecoveryDeliveryRunId: "old-run",
      sessionId: scope.sessionId,
      updatedAt: 10,
    });
    await replaceSqliteTranscriptEvents(scope, [
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
    await upsertSessionEntry(scope, {
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
      await upsertSessionEntry(scope, {
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

  it("archives shared SQLite transcript state once when plugin rollback removes aliases", async () => {
    const sessionId = "plugin-alias-session";
    const canonicalKey = "agent:main:plugin-alias";
    const aliasKey = "plugin-alias";
    const entry = {
      modelSelectionLocked: true,
      pluginOwnerId: "anthropic",
      sessionId,
      updatedAt: 10,
    } satisfies SessionEntry;
    await upsertSessionEntry({ sessionKey: aliasKey, storePath }, entry);
    await upsertSessionEntry({ sessionKey: canonicalKey, storePath }, entry);
    await replaceSqliteTranscriptEvents(
      { agentId: "main", sessionId, sessionKey: canonicalKey, storePath },
      [{ id: "plugin-alias-event", type: "message" }],
    );
    const expectedEntry = expectDefined(
      loadSessionEntry({ sessionKey: canonicalKey, storePath }),
      "canonical plugin alias entry",
    );

    const result = await rollbackPluginOwnedSessionEntryLifecycle({
      archiveTranscript: true,
      expectedEntry,
      expectedPluginOwnerId: "anthropic",
      storePath,
      target: { canonicalKey, storeKeys: [canonicalKey, aliasKey] },
    });

    expect(result).toMatchObject({ deleted: true });
    expect(result.archivedTranscripts).toHaveLength(1);
    expect(listSessionEntries({ storePath })).toEqual([]);
    await expect(
      loadTranscriptEvents({ agentId: "main", sessionId, sessionKey: canonicalKey, storePath }),
    ).resolves.toEqual([]);
  });

  it("persists reset lifecycle entry changes with an in-log boundary", async () => {
    const now = Date.now();
    const sessionKey = "agent:main:main";
    const previousTranscript = path.join(tempDir, "previous-session.jsonl");
    const previousEntry: SessionEntry = {
      sessionFile: previousTranscript,
      sessionId: "previous-session",
      updatedAt: now,
    };
    const nextEntry: SessionEntry = {
      sessionFile: formatSqliteSessionFileMarker({
        agentId: "main",
        sessionId: previousEntry.sessionId,
        storePath,
      }),
      sessionId: previousEntry.sessionId,
      updatedAt: now + 1,
    };
    fs.writeFileSync(
      previousTranscript,
      [
        JSON.stringify({ type: "session", id: "previous-session" }),
        JSON.stringify({
          id: "msg-user",
          message: { role: "user", content: "hello" },
          parentId: null,
          timestamp: "2026-06-16T00:00:00.000Z",
          type: "message",
        }),
        JSON.stringify({
          id: "msg-assistant",
          message: { role: "assistant", content: "hi" },
          parentId: "msg-user",
          timestamp: "2026-06-16T00:00:01.000Z",
          type: "message",
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
    await upsertSessionEntry({ sessionKey, storePath }, previousEntry);

    const result = await persistSessionResetLifecycle({
      agentId: "main",
      cleanupPreviousTranscript: true,
      nextEntry,
      nextSessionFile: nextEntry.sessionFile!,
      previousEntry,
      previousSessionId: previousEntry.sessionId,
      sessionKey,
      storePath,
    });

    expect(result.replayedMessages).toBe(0);
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject(nextEntry);
    expect(fs.existsSync(previousTranscript)).toBe(true);
    const archivedPreviousTranscripts = fs
      .readdirSync(tempDir)
      .filter((file) => file.startsWith("previous-session.jsonl.reset."));
    expect(archivedPreviousTranscripts).toEqual([]);
    await expect(
      loadTranscriptEvents({
        agentId: "main",
        sessionId: previousEntry.sessionId,
        sessionKey,
        storePath,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: "msg-user", parentId: null }),
      expect.objectContaining({ id: "msg-assistant", parentId: "msg-user" }),
      expect.objectContaining({
        type: "reset",
        reason: "reset",
        firstKeptEntryId: "msg-user",
      }),
    ]);
  });

  it("trims a manual compact transcript and clears stale token metadata", async () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const manualTranscriptPath = path.join(tempDir, `${sessionId}.jsonl`);
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
    await upsertSessionEntry(scope, {
      contextBudgetStatus,
      inputTokens: 10,
      outputTokens: 20,
      sessionFile: manualTranscriptPath,
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
    await replaceSqliteTranscriptEvents(
      scope,
      transcriptRecords as Parameters<typeof replaceSqliteTranscriptEvents>[1],
    );
    const updates: unknown[] = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));

    const result = await trimSessionTranscriptForManualCompact(scope, {
      maxLines: 3,
      nowMs: 500,
    });

    unsubscribe();
    expect(result).toMatchObject({ compacted: true, kept: 3 });
    const archived = result.compacted ? result.archived : "";
    expect(path.basename(archived)).toMatch(
      new RegExp(`^${sessionId}\\.jsonl\\.bak\\.\\d{4}-\\d{2}-\\d{2}T`),
    );
    expect(fs.realpathSync(path.dirname(archived))).toBe(fs.realpathSync(tempDir));
    expect(fs.existsSync(archived)).toBe(true);
    const archivedRecords = readSessionArchiveContentSync(archived)
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(archivedRecords).toEqual(transcriptRecords);
    const trimmedRecords = (await loadTranscriptEvents(scope)) as Array<Record<string, unknown>>;
    expect(trimmedRecords).toMatchObject([
      { type: "session", id: sessionId },
      { type: "message", id: "entry-3", parentId: null },
      { type: "message", id: "entry-4", parentId: "entry-3" },
    ]);
    const updatedEntry = loadSessionEntry(scope);
    expect(updatedEntry).toMatchObject({
      sessionFile: manualTranscriptPath,
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

  it("keeps every transcript row when the manual compact backup cannot be written", async () => {
    const sessionId = "44444444-4444-4444-8444-444444444444";
    const stateDir = path.join(tempDir, "state-root");
    const scope = {
      agentId: "main",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      sessionId,
      sessionKey: "agent:main:main",
    };
    const records = [
      { type: "session", version: 3, id: sessionId, timestamp: "2026-06-19T12:00:00.000Z" },
      ...[1, 2, 3, 4].map((index) => ({
        type: "message",
        id: `entry-${index}`,
        parentId: index === 1 ? null : `entry-${index - 1}`,
        timestamp: `2026-06-19T12:00:0${index}.000Z`,
        message: { role: "user", content: `message ${index}`, timestamp: index },
      })),
    ];
    await upsertSessionEntry(scope, { sessionId, updatedAt: 1 });
    await replaceSqliteTranscriptEvents(
      scope,
      records as Parameters<typeof replaceSqliteTranscriptEvents>[1],
    );
    const archiveDirPath = path.join(stateDir, "agents", "main", "sessions");
    fs.writeFileSync(archiveDirPath, "not a directory");

    await expect(trimSessionTranscriptForManualCompact(scope, { maxLines: 3 })).rejects.toThrow();

    expect((await loadTranscriptEvents(scope)).length).toBe(5);
    expect(await loadTranscriptEvents(scope)).toEqual(records);
  });

  it("keeps no-op manual compaction tolerant of a missing current session entry", async () => {
    await expect(
      trimSqliteTranscriptForManualCompact(
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
    const records = [
      { type: "session", version: 3, id: sessionId, timestamp: "2026-06-19T12:00:00.000Z" },
      ...[1, 2, 3, 4].map((index) => ({
        type: "message",
        id: `entry-${index}`,
        parentId: index === 1 ? null : `entry-${index - 1}`,
        timestamp: `2026-06-19T12:00:0${index}.000Z`,
        message: { role: "user", content: `message ${index}`, timestamp: index },
      })),
    ];
    await upsertSessionEntry(scope, {
      inputTokens: 10,
      outputTokens: 20,
      sessionId,
      totalTokens: 30,
      totalTokensFresh: true,
      updatedAt: 100,
    });
    await replaceSqliteTranscriptEvents(
      scope,
      records as Parameters<typeof replaceSqliteTranscriptEvents>[1],
    );
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
    const archiveNames = fs.readdirSync(tempDir).filter((name) => name.includes(".bak."));
    expect(archiveNames).toHaveLength(1);
    expect(
      readSessionArchiveContentSync(
        path.join(tempDir, expectDefined(archiveNames[0], "manual compact archive name")),
      ),
    ).toBe(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  });

  it("rejects a manual compact when session metadata changes after its snapshot", async () => {
    const sessionId = "88888888-8888-4888-8888-888888888888";
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey: "agent:main:main",
      storePath,
    };
    const records = [
      { type: "session", version: 3, id: sessionId, timestamp: "2026-06-19T12:00:00.000Z" },
      ...[1, 2, 3, 4].map((index) => ({
        type: "message",
        id: `entry-${index}`,
        parentId: index === 1 ? null : `entry-${index - 1}`,
        timestamp: `2026-06-19T12:00:0${index}.000Z`,
        message: { role: "user", content: `message ${index}`, timestamp: index },
      })),
    ];
    await upsertSessionEntry(scope, {
      sessionId,
      totalTokens: 30,
      totalTokensFresh: true,
      updatedAt: 100,
    });
    await replaceSqliteTranscriptEvents(
      scope,
      records as Parameters<typeof replaceSqliteTranscriptEvents>[1],
    );

    await expect(
      trimSqliteTranscriptForManualCompact(
        scope,
        (lines) => {
          replaceSqliteSessionEntrySync(scope, {
            label: "concurrent metadata",
            sessionId,
            totalTokens: 40,
            totalTokensFresh: true,
            updatedAt: 200,
          });
          return lines.slice(0, 1);
        },
        { nowMs: 500 },
      ),
    ).rejects.toThrow(
      "SQLite session state changed while preparing session.transcript.manual-compact",
    );

    expect(await loadTranscriptEvents(scope)).toEqual(records);
    expect(loadSessionEntry(scope)).toMatchObject({
      label: "concurrent metadata",
      totalTokens: 40,
      totalTokensFresh: true,
      updatedAt: 200,
    });
    const archiveNames = fs.readdirSync(tempDir).filter((name) => name.includes(".bak."));
    expect(archiveNames).toHaveLength(1);
    expect(
      readSessionArchiveContentSync(
        path.join(tempDir, expectDefined(archiveNames[0], "manual compact archive name")),
      ),
    ).toBe(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  });

  it("preserves the backup and rows written after the manual compact snapshot", async () => {
    const sessionId = "55555555-5555-4555-8555-555555555555";
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey: "agent:main:main",
      storePath,
    };
    const records = [
      { type: "session", version: 3, id: sessionId, timestamp: "2026-06-19T12:00:00.000Z" },
      ...[1, 2, 3, 4].map((index) => ({
        type: "message",
        id: `entry-${index}`,
        parentId: index === 1 ? null : `entry-${index - 1}`,
        timestamp: `2026-06-19T12:00:0${index}.000Z`,
        message: { role: "user", content: `message ${index}`, timestamp: index },
      })),
    ];
    const lateEvent = {
      type: "custom",
      id: "late-append",
      timestamp: "2026-06-19T12:00:09.000Z",
    };
    await upsertSessionEntry(scope, { sessionId, updatedAt: 1 });
    await replaceSqliteTranscriptEvents(
      scope,
      records as Parameters<typeof replaceSqliteTranscriptEvents>[1],
    );

    await expect(
      trimSqliteTranscriptForManualCompact(scope, (lines) => {
        appendSqliteTranscriptEventSync(scope, lateEvent);
        return lines.slice(0, 1);
      }),
    ).rejects.toThrow(`SQLite transcript changed while preparing rewrite for ${sessionId}`);

    const remaining = (await loadTranscriptEvents(scope)) as Array<Record<string, unknown>>;
    expect(remaining).toHaveLength(6);
    expect(remaining.slice(0, 5)).toEqual(records);
    expect(remaining[5]).toMatchObject({ id: "late-append" });
    const archiveNames = fs.readdirSync(tempDir).filter((name) => name.includes(".bak."));
    expect(archiveNames).toHaveLength(1);
    expect(
      readSessionArchiveContentSync(
        path.join(tempDir, expectDefined(archiveNames[0], "manual compact archive name")),
      ),
    ).toBe(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  });

  it("preserves a reused manual compact backup when the rewrite conflicts", async () => {
    const sessionId = "66666666-6666-4666-8666-666666666666";
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey: "agent:main:main",
      storePath,
    };
    const records = [
      { type: "session", version: 3, id: sessionId, timestamp: "2026-06-19T12:00:00.000Z" },
      ...[1, 2, 3, 4].map((index) => ({
        type: "message",
        id: `entry-${index}`,
        parentId: index === 1 ? null : `entry-${index - 1}`,
        timestamp: `2026-06-19T12:00:0${index}.000Z`,
        message: { role: "user", content: `message ${index}`, timestamp: index },
      })),
    ];
    const existingArchive = path.join(tempDir, `${sessionId}.jsonl.bak.preexisting`);
    const archiveContent = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
    await upsertSessionEntry(scope, { sessionId, updatedAt: 1 });
    await replaceSqliteTranscriptEvents(
      scope,
      records as Parameters<typeof replaceSqliteTranscriptEvents>[1],
    );
    fs.writeFileSync(existingArchive, archiveContent);

    await expect(
      trimSqliteTranscriptForManualCompact(scope, (lines) => {
        appendSqliteTranscriptEventSync(scope, {
          type: "custom",
          id: "late-append",
          timestamp: "2026-06-19T12:00:09.000Z",
        });
        return lines.slice(0, 1);
      }),
    ).rejects.toThrow(`SQLite transcript changed while preparing rewrite for ${sessionId}`);

    expect(fs.existsSync(existingArchive)).toBe(true);
    expect(readSessionArchiveContentSync(existingArchive)).toBe(archiveContent);
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
    await upsertSessionEntry(scope, { sessionFile, sessionId, updatedAt: 1 });
    await replaceSqliteTranscriptEvents(
      scope,
      records as Parameters<typeof replaceSqliteTranscriptEvents>[1],
    );

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
    await upsertSessionEntry(scope, {
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
      sessionFile: result.sessionFile,
      sessionId: scope.sessionId,
      updatedAt: expect.any(Number),
    });
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

  it("allows concurrent SQLite transcript turn and direct appends", async () => {
    const scope = {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath,
    };
    await upsertSessionEntry(scope, {
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
    await upsertSessionEntry(scope, {
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
    await upsertSessionEntry(scope, {
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
    const deduplicated = await persistSessionTranscriptTurn(scope, {
      expectedSessionId: scope.sessionId,
      expectedSessionState: {
        abortedLastRun: retryable.abortedLastRun,
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
        updatedAt: retryable.updatedAt,
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
    await upsertSessionEntry(scope, {
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
    await upsertSessionEntry(scope, {
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
      replaceSqliteSessionEntrySync(scope, {
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

  it("rejects a guarded transcript turn when same-session lifecycle ownership changes", async () => {
    const scope = {
      agentId: "main",
      sessionId: "session-same-owner",
      sessionKey: "agent:main:same-owner",
      storePath,
    };
    await upsertSessionEntry(scope, {
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
      updatedAt: stored.updatedAt,
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
    replaceSqliteSessionEntrySync(scope, {
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
    await upsertSessionEntry(scope, {
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

  it("routes SQLite transcript turn appends through an active owned file lock", async () => {
    const scope = {
      agentId: "main",
      sessionFile: transcriptPath,
      sessionId: "session-owned-publish",
      sessionKey: "agent:main:owned-publish",
      storePath,
    };
    const publishOptions: Array<boolean | undefined> = [];
    const publishedEntryBatches: unknown[][] = [];

    await withOwnedSessionTranscriptWrites(
      {
        sessionFile: transcriptPath,
        sessionKey: scope.sessionKey,
        withSessionWriteLock: async (run, options) => {
          publishOptions.push(options?.publishOwnedWrite);
          const result = await run();
          publishedEntryBatches.push([...(options?.resolvePublishedEntries?.(result) ?? [])]);
          return result;
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

    expect(publishOptions).toEqual([undefined]);
    expect(publishedEntryBatches).toEqual([[]]);
    await expect(loadTranscriptEvents(scope)).resolves.toHaveLength(2);
  });

  it("resolves store-backed runtime transcript targets with stale file paths to markers", async () => {
    const staleSessionFile = path.join(tempDir, "session-1.jsonl");
    const scope = {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath,
    };
    const marker = `sqlite:main:${scope.sessionId}:${storePath}`;

    await upsertSessionEntry(scope, {
      sessionId: scope.sessionId,
      sessionFile: staleSessionFile,
      updatedAt: 10,
    });

    const readTarget = await resolveSessionTranscriptRuntimeReadTarget(scope);
    const writeTarget = await resolveSessionTranscriptRuntimeTarget(scope);

    expect(readTarget.sessionFile).toBe(marker);
    expect(writeTarget.sessionFile).toBe(marker);
    expect(loadSessionEntry(scope)?.sessionFile).toBe(staleSessionFile);
  });

  it("resolves SQLite-backed runtime transcript targets to markers", async () => {
    const scope = {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath,
    };
    const marker = `sqlite:main:${scope.sessionId}:${storePath}`;

    await upsertSessionEntry(scope, {
      sessionId: scope.sessionId,
      sessionFile: marker,
      updatedAt: 10,
    });

    const readTarget = await resolveSessionTranscriptRuntimeReadTarget(scope);
    const writeTarget = await resolveSessionTranscriptRuntimeTarget(scope);

    expect(readTarget.sessionFile).toBe(marker);
    expect(writeTarget.sessionFile).toBe(marker);
  });

  it("normalizes imported legacy session transcript paths to SQLite markers", async () => {
    const sessionKey = "agent:main:main";
    await importSqliteSessionRows({
      agentId: "main",
      entry: {
        sessionFile: path.join(tempDir, "legacy-transcript.jsonl"),
        sessionId: "session-1",
        updatedAt: 10,
      },
      sessionKey,
      storePath,
    });

    expect(
      loadExactSqliteSessionEntry({
        agentId: "main",
        sessionKey,
        storePath,
      })?.entry.sessionFile,
    ).toBe(`sqlite:main:session-1:${path.join(tempDir, "openclaw-agent.sqlite")}`);
  });

  it("tracks replacement and deletion transcript mutations", async () => {
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const scope = {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath,
    };
    await upsertSessionEntry(scope, {
      sessionId: scope.sessionId,
      updatedAt: 10,
    });
    await replaceSqliteTranscriptEvents(scope, [
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

    await replaceSqliteTranscriptEvents(scope, []);

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

    await replaceSqliteTranscriptEvents(scope, [
      { sessionId: scope.sessionId, type: "session" },
      { id: "replacement", parentId: null, type: "custom" },
    ]);
    const replaced = readGeneration()?.generation;
    expect(replaced).toMatch(/^[0-9a-f]{32}$/);
    expect(replaced).not.toBe(first);

    await replaceSqliteTranscriptEvents(scope, []);
    expect(readGeneration()?.generation).not.toBe(replaced);
  });

  it("resolves an explicit read transcript file without agent identity", () => {
    const explicitSessionFile = path.join(tempDir, "explicit-read-session.jsonl");

    const target = resolveSessionTranscriptReadTarget({
      sessionFile: explicitSessionFile,
      sessionId: "session-1",
    });

    expect(target).toEqual({
      sessionFile: explicitSessionFile,
      sessionId: "session-1",
    });
  });

  it("does not expose legacy custom transcript paths as read fallbacks after SQLite migration", async () => {
    const legacyTranscript = path.join(tempDir, "custom-topic-transcript.jsonl");
    const sessionKey = "agent:main:telegram:group:1:topic:9";
    await upsertSessionEntry(
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

    expect(target.sessionFile).toContain("sqlite:main:custom-topic-session:");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
