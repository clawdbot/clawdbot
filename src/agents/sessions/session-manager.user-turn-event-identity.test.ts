// Regression coverage for #115389: recorder-pre-persisted user turns must keep
// one SQLite event identity when the run-side SessionManager appends the same turn.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatSqliteSessionFileMarker,
  parseSqliteSessionFileMarker,
} from "../../config/sessions/legacy-sqlite-marker.js";
import {
  loadTranscriptEvents,
  upsertSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import { SessionManager } from "./session-manager.js";

const tempPaths: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-user-turn-identity-"));
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

type TranscriptMessageEvent = {
  id: string;
  parentId: string | null;
  type: string;
  message: { role?: string; idempotencyKey?: string };
};

function isTranscriptMessageEvent(event: unknown): event is TranscriptMessageEvent {
  return (
    typeof event === "object" &&
    event !== null &&
    (event as { type?: unknown }).type === "message" &&
    typeof (event as { message?: unknown }).message === "object"
  );
}

async function setUpPrePersistedUserTurn(params: {
  dir: string;
  idempotencyKey: string;
  text: string;
}) {
  const sessionId = "user-turn-identity-session";
  const sessionKey = "agent:main:whatsapp:user-turn-identity";
  const storePath = path.join(params.dir, "sessions.json");
  const marker = formatSqliteSessionFileMarker({ agentId: "main", sessionId, storePath });
  const scope = { agentId: "main", sessionId, sessionKey, storePath };
  await upsertSessionEntry(
    { agentId: "main", sessionKey, storePath },
    { sessionFile: marker, sessionId, updatedAt: 10 },
  );

  // Production enrollment emitter: admitUserTurn pre-persists the inbound turn
  // through the recorder before the embedded run opens its SessionManager.
  const recorder = createUserTurnTranscriptRecorder({
    input: {
      text: params.text,
      timestamp: 123,
      idempotencyKey: params.idempotencyKey,
    },
    target: {
      agentId: "main",
      cwd: params.dir,
      sessionEntry: undefined,
      sessionId,
      sessionKey,
      storePath,
    },
  });
  const prePersisted = await recorder.persistApproved();
  if (!prePersisted?.appended) {
    throw new Error("expected the recorder to pre-persist the user turn");
  }

  // Production run-side writer: the guarded SessionManager merges the prepared
  // turn into the runtime user message before persistence.
  const target = parseSqliteSessionFileMarker(marker);
  if (!target) {
    throw new Error("expected SQLite transcript marker fixture");
  }
  const sessionManager = guardSessionManager(
    SessionManager.open({ ...target, sessionKey }, params.dir),
    {
      agentId: "main",
      sessionKey,
      preparedUserTurnMessage: await recorder.resolveMessage(),
    },
  );
  return { prePersisted, recorder, scope, sessionManager };
}

describe("SessionManager user-turn event identity", () => {
  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    await Promise.all(
      tempPaths.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("keeps one transcript row when the run re-appends a pre-persisted user turn", async () => {
    const dir = await makeTempDir();
    const idempotencyKey =
      "channel-user:v1:a94030e1a94030e1a94030e1a94030e1a94030e1a94030e1a94030e1a94030e1";
    const { prePersisted, scope, sessionManager } = await setUpPrePersistedUserTurn({
      dir,
      idempotencyKey,
      text: "hello twice?",
    });

    const entryId = sessionManager.appendMessage({
      role: "user",
      content: "hello twice?",
      timestamp: Date.now(),
    });

    // One canonical row: the run-side append must dedupe to the recorder's event id.
    const events = await loadTranscriptEvents(scope);
    const userRows = events
      .filter(isTranscriptMessageEvent)
      .filter(
        (event) => event.message.role === "user" && event.message.idempotencyKey === idempotencyKey,
      );
    expect(userRows.map((event) => event.id)).toEqual([prePersisted.messageId]);
    expect(entryId).toBe(prePersisted.messageId);

    // The identity row keeps its indexed key: no force-insert NULLed it out.
    const { path: dbPath } = resolveSqliteTargetFromSessionStorePath(scope.storePath, {
      agentId: "main",
    });
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(dbPath);
    try {
      const identityRows = db
        .prepare(
          `SELECT event_id FROM transcript_event_identities
           WHERE session_id = ? AND message_idempotency_key = ?`,
        )
        .all(scope.sessionId, idempotencyKey) as Array<{ event_id: string }>;
      expect(identityRows.map((row) => row.event_id)).toEqual([prePersisted.messageId]);
    } finally {
      db.close();
    }
  });

  it("adopts a loaded pre-persisted turn onto the active path when the leaf moved elsewhere", async () => {
    const dir = await makeTempDir();
    const idempotencyKey =
      "channel-user:v1:c94030e1c94030e1c94030e1c94030e1c94030e1c94030e1c94030e1c94030e1";
    const sessionId = "user-turn-identity-session";
    const sessionKey = "agent:main:whatsapp:user-turn-identity";
    const storePath = path.join(dir, "sessions.json");
    const marker = formatSqliteSessionFileMarker({ agentId: "main", sessionId, storePath });
    await upsertSessionEntry(
      { agentId: "main", sessionKey, storePath },
      { sessionFile: marker, sessionId, updatedAt: 10 },
    );
    const target = parseSqliteSessionFileMarker(marker);
    if (!target) {
      throw new Error("expected SQLite transcript marker fixture");
    }

    // A manager opened before enrollment: its in-memory leaf will diverge from
    // the recorder's row, putting the pre-persisted turn on a sibling branch.
    const earlierManager = SessionManager.open({ ...target, sessionKey }, dir);
    earlierManager.appendMessage({ role: "user", content: "earlier turn", timestamp: Date.now() });
    earlierManager.appendMessage(buildAssistantMessage("earlier reply"));

    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "keep the active turn", timestamp: 456, idempotencyKey },
      target: {
        agentId: "main",
        cwd: dir,
        sessionEntry: undefined,
        sessionId,
        sessionKey,
        storePath,
      },
    });
    const prePersisted = await recorder.persistApproved();
    if (!prePersisted?.appended) {
      throw new Error("expected the recorder to pre-persist the user turn");
    }
    // The stale manager appends after enrollment: the store's newest event is now
    // a sibling of the recorder's row, so a fresh open lands its leaf there.
    earlierManager.appendMessage(buildAssistantMessage("sibling branch tip"));

    const sessionManager = guardSessionManager(
      SessionManager.open({ ...target, sessionKey }, dir),
      {
        agentId: "main",
        sessionKey,
        preparedUserTurnMessage: await recorder.resolveMessage(),
      },
    );
    const entryId = sessionManager.appendMessage({
      role: "user",
      content: "keep the active turn",
      timestamp: Date.now(),
    });
    expect(entryId).toBe(prePersisted.messageId);

    // The adoption must survive a mid-run transcript reload: the embedded runner
    // reloads from SQLite when another writer touches the session, so an
    // in-memory-only leaf repoint would silently drop the turn from the prompt.
    sessionManager.reloadPersistedTranscript();
    expect(sessionManager.getLeafId()).toBe(prePersisted.messageId);

    // The short-circuit must adopt the loaded row as the leaf: the turn has to be
    // in the prompt path, and the next assistant event must parent off it.
    const contextJson = JSON.stringify(sessionManager.buildSessionContext().messages);
    expect(contextJson).toContain("keep the active turn");
    const assistantEntryId = sessionManager.appendMessage(buildAssistantMessage("adopted reply"));
    const events = (
      await loadTranscriptEvents({ agentId: "main", sessionId, sessionKey, storePath })
    ).filter(isTranscriptMessageEvent);
    expect(events.find((event) => event.id === assistantEntryId)?.parentId).toBe(
      prePersisted.messageId,
    );
  });

  it("persists the user entry before the first assistant event parents off it", async () => {
    const dir = await makeTempDir();
    const idempotencyKey =
      "channel-user:v1:b94030e1b94030e1b94030e1b94030e1b94030e1b94030e1b94030e1b94030e1";
    const { prePersisted, scope, sessionManager } = await setUpPrePersistedUserTurn({
      dir,
      idempotencyKey,
      text: "ordering pin",
    });

    sessionManager.appendMessage({
      role: "user",
      content: "ordering pin",
      timestamp: Date.now(),
    });
    const assistantEntryId = sessionManager.appendMessage(buildAssistantMessage("reply"));

    // Creation-time adoption leaves no descendants to repoint: the user row exists
    // before the first assistant event, which parents off the canonical row.
    const events = (await loadTranscriptEvents(scope)).filter(isTranscriptMessageEvent);
    const userIndex = events.findIndex((event) => event.id === prePersisted.messageId);
    const assistantIndex = events.findIndex((event) => event.id === assistantEntryId);
    expect(userIndex).toBeGreaterThanOrEqual(0);
    expect(assistantIndex).toBeGreaterThan(userIndex);
    expect(events[assistantIndex]?.parentId).toBe(prePersisted.messageId);
  });
});
