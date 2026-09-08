import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type {
  TranscriptTurnAdmission,
  TranscriptTurnBoundary,
} from "../../config/sessions/transcript-entry-anchor.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { ContextEngineLogicalTurnLease } from "./context-engine-logical-turn.js";
import { drainPendingContextEngineTurnsBeforeRun } from "./context-engine-turn-attempt.js";
import {
  acceptContextEngineTurnIntent,
  drainContextEngineTurnOutbox,
  enqueueContextEngineTurnCommit,
  enqueueContextEngineTurnIntent,
  isRetryableContextEngineTurnReadFailure,
  recoverContextEngineTurnOutbox,
} from "./context-engine-turn-outbox.js";

const tempDirs: string[] = [];
type ContextEngineTurnOutboxPayload = Parameters<
  typeof enqueueContextEngineTurnCommit
>[0]["payload"];

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function createPayload(params: {
  advancementKey: string;
  databasePath: string;
  sequence: number;
  sessionId: string;
  messages?: ContextEngineTurnOutboxPayload["messages"];
}): ContextEngineTurnOutboxPayload {
  const anchor = {
    agentId: "main",
    sessionId: params.sessionId,
    sessionKey: `agent:main:${params.sessionId}`,
    storePath: params.databasePath,
    generation: "generation-1",
    entryId: `${params.advancementKey}:user`,
    rawSeq: params.sequence,
    effectiveParentId: null,
    activeMessagePosition: params.sequence,
  };
  const boundary = {
    admission: {
      ...anchor,
      logicalTurnId: params.advancementKey,
      role: "user" as const,
    },
    terminal: {
      ...anchor,
      entryId: `${params.advancementKey}:assistant`,
      rawSeq: params.sequence + 1,
      effectiveParentId: anchor.entryId,
      activeMessagePosition: params.sequence + 1,
    },
  } satisfies TranscriptTurnBoundary;
  return {
    boundary,
    isHeartbeat: false,
    messages: params.messages ?? [],
  };
}

describe("context-engine turn outbox", () => {
  it("retries only transcript failures that can make progress", () => {
    expect(isRetryableContextEngineTurnReadFailure("projection-unavailable")).toBe(true);
    expect(isRetryableContextEngineTurnReadFailure("too-large")).toBe(false);
    expect(isRetryableContextEngineTurnReadFailure("stale")).toBe(false);
  });

  it("retains a queued turn when commitTurn resolves outside its contract", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-context-outbox-contract-"));
    tempDirs.push(stateDir);
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const payload = createPayload({
      advancementKey: "session-a:invalid-result",
      databasePath: database.path,
      sequence: 1,
      sessionId: "session-a",
    });
    enqueueContextEngineTurnCommit({ database, engineId: "test", payload });
    let valid = false;
    const commitTurn = vi.fn(async () =>
      valid ? { status: "committed" as const } : ({ status: "ignored" } as never),
    );
    const engine = {
      info: { id: "test", name: "Test" },
      ingest: async () => ({ ingested: true }),
      assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
      compact: async () => ({ ok: true, compacted: false }),
      commitTurn,
    } satisfies ContextEngine;
    const warn = vi.fn();

    await drainContextEngineTurnOutbox({ database, engine, engineId: "test", warn });

    expect(
      database.db
        .prepare(
          "SELECT attempt_count, last_error FROM context_engine_turn_outbox WHERE advancement_key = ?",
        )
        .get(payload.boundary.admission.logicalTurnId),
    ).toEqual({
      attempt_count: 1,
      last_error: "invalid commitTurn result status: ignored",
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("durable turn advancement remains queued"),
    );

    valid = true;
    await drainContextEngineTurnOutbox({ database, engine, engineId: "test", warn });

    expect(
      database.db
        .prepare("SELECT 1 FROM context_engine_turn_outbox WHERE advancement_key = ?")
        .get(payload.boundary.admission.logicalTurnId),
    ).toBeUndefined();
  });

  it("keeps a row pending when its persisted payload has no state", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-context-outbox-state-"));
    tempDirs.push(stateDir);
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const payload = createPayload({
      advancementKey: "session-a:missing-state",
      databasePath: database.path,
      sequence: 1,
      sessionId: "session-a",
    });
    enqueueContextEngineTurnCommit({ database, engineId: "test", payload });
    database.db
      .prepare(
        "UPDATE context_engine_turn_outbox SET payload_json = '{}' WHERE advancement_key = ?",
      )
      .run(payload.boundary.admission.logicalTurnId);
    const commitTurn = vi.fn(async () => ({ status: "committed" as const }));
    const engine = {
      info: { id: "test", name: "Test" },
      ingest: async () => ({ ingested: true }),
      assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
      compact: async () => ({ ok: true, compacted: false }),
      commitTurn,
    } satisfies ContextEngine;

    const result = await drainContextEngineTurnOutbox({
      database,
      engine,
      engineId: "test",
      warn: vi.fn(),
    });

    expect(result.pending).toBe(true);
    expect(commitTurn).not.toHaveBeenCalled();
    expect(
      database.db
        .prepare("SELECT 1 FROM context_engine_turn_outbox WHERE advancement_key = ?")
        .get(payload.boundary.admission.logicalTurnId),
    ).toBeDefined();
  });

  it("drains prior work before fresh-turn assembly and records dispatch admission", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-context-outbox-recovery-"));
    tempDirs.push(stateDir);
    const target = {
      agentId: "main",
      sessionId: "recovered-turn",
      sessionKey: "agent:main:recovered-turn",
      storePath: path.join(stateDir, "sessions.json"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const admitted = await appendTranscriptMessage(target, {
      message: { role: "user", content: "first" },
      now: 1_000,
    });
    if (!admitted?.anchor) {
      throw new Error("expected admitted transcript entry");
    }
    const admission = {
      ...admitted.anchor,
      logicalTurnId: "recovered-logical-turn",
      role: "user" as const,
    } satisfies TranscriptTurnAdmission;
    const database = openOpenClawAgentDatabase({
      agentId: target.agentId,
      path: admission.storePath,
    });
    enqueueContextEngineTurnIntent({
      admission,
      database,
      engineId: "test",
      isHeartbeat: true,
    });
    const terminal = await appendTranscriptMessage(target, {
      message: { role: "assistant", content: "first answer" },
      parentId: admitted.messageId,
      now: 2_000,
    });
    if (!terminal?.anchor) {
      throw new Error("expected terminal transcript entry");
    }
    acceptContextEngineTurnIntent({
      boundary: {
        admission,
        terminal: terminal.anchor,
      },
      database,
      engineId: "test",
      isHeartbeat: true,
    });
    const current = await appendTranscriptMessage(target, {
      message: { role: "user", content: "second" },
      parentId: terminal.messageId,
      now: 3_000,
    });
    if (!current?.anchor) {
      throw new Error("expected current transcript entry");
    }
    const currentAdmission = {
      ...current.anchor,
      logicalTurnId: "current-logical-turn",
      role: "user" as const,
    } satisfies TranscriptTurnAdmission;
    const currentMessage = { role: "user" as const, content: "second", timestamp: 3_000 };
    const recorder = createUserTurnTranscriptRecorder({
      message: currentMessage,
      target: async () => undefined,
    });
    const commitTurn = vi.fn<NonNullable<ContextEngine["commitTurn"]>>(async () => ({
      status: "committed",
    }));
    const engine = {
      info: {
        id: "test",
        name: "Test",
        transcriptSemantics: {
          currentTurnFence: "before-current-turn-entry-v1",
          turnAdvancementIdempotency: "atomic-idempotent-v1",
        },
      },
      ingest: async () => ({ ingested: true }),
      assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
      compact: async () => ({ ok: true, compacted: false }),
      commitTurn,
    } satisfies ContextEngine;
    const lease = {
      engine,
      effectiveEngine: engine,
      effectiveEngineId: "test",
      effectiveEnginePluginId: undefined,
      degraded: false,
      degradedReason: undefined,
      selectForHost: vi.fn(),
      degradeBeforeStart: vi.fn(),
      begin: vi.fn(),
      deferDisposalUntil: vi.fn(),
      dispose: vi.fn(async () => undefined),
    } satisfies ContextEngineLogicalTurnLease;

    await drainPendingContextEngineTurnsBeforeRun({
      admission: undefined,
      isHeartbeat: false,
      lease,
      recorder,
      sessionTarget: target,
    });

    expect(commitTurn).toHaveBeenCalledOnce();
    expect(commitTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        advancementKey: admission.logicalTurnId,
        isHeartbeat: true,
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "first answer" },
        ],
      }),
    );
    expect(
      database.db.prepare("SELECT advancement_key FROM context_engine_turn_outbox").all(),
    ).toHaveLength(0);
    expect(commitTurn.mock.calls[0]?.[0]).not.toHaveProperty("prePromptMessageCount");

    recorder.markRuntimePersisted(currentMessage, currentAdmission);
    const queued = database.db
      .prepare("SELECT advancement_key, payload_json FROM context_engine_turn_outbox")
      .all() as Array<{ advancement_key: string; payload_json: string }>;
    expect(queued).toHaveLength(1);
    expect(queued[0]?.advancement_key).toBe(currentAdmission.logicalTurnId);
    expect(JSON.parse(queued[0]?.payload_json ?? "{}")).toMatchObject({
      state: "admitted",
      isHeartbeat: false,
    });
    expect(lease.degradeBeforeStart).not.toHaveBeenCalled();

    await drainPendingContextEngineTurnsBeforeRun({ admission: undefined, lease });
    expect(lease.degradeBeforeStart).not.toHaveBeenCalled();
  });

  it("discards admission-only recovery even when the transcript has descendants", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-context-outbox-unaccepted-"));
    tempDirs.push(stateDir);
    const target = {
      agentId: "main",
      sessionId: "unaccepted-turn",
      sessionKey: "agent:main:unaccepted-turn",
      storePath: path.join(stateDir, "sessions.json"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const admitted = await appendTranscriptMessage(target, {
      message: { role: "user", content: "first" },
      now: 1_000,
    });
    if (!admitted?.anchor) {
      throw new Error("expected admitted transcript entry");
    }
    const admission = {
      ...admitted.anchor,
      logicalTurnId: "unaccepted-logical-turn",
      role: "user" as const,
    } satisfies TranscriptTurnAdmission;
    const database = openOpenClawAgentDatabase({
      agentId: target.agentId,
      path: admission.storePath,
    });
    enqueueContextEngineTurnIntent({
      admission,
      database,
      engineId: "test",
      isHeartbeat: false,
    });
    const rejected = await appendTranscriptMessage(target, {
      message: { role: "assistant", content: "rejected fallback" },
      parentId: admitted.messageId,
      now: 2_000,
    });
    const current = await appendTranscriptMessage(target, {
      message: { role: "user", content: "second" },
      parentId: rejected?.messageId,
      now: 3_000,
    });
    if (!current?.anchor) {
      throw new Error("expected current transcript entry");
    }
    const currentAdmission = {
      ...current.anchor,
      logicalTurnId: "current-logical-turn",
      role: "user" as const,
    } satisfies TranscriptTurnAdmission;
    const commitTurn = vi.fn(async () => ({ status: "committed" as const }));
    const engine = {
      info: {
        id: "test",
        name: "Test",
        transcriptSemantics: {
          currentTurnFence: "before-current-turn-entry-v1",
          turnAdvancementIdempotency: "atomic-idempotent-v1",
        },
      },
      ingest: async () => ({ ingested: true }),
      assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
      compact: async () => ({ ok: true, compacted: false }),
      commitTurn,
    } satisfies ContextEngine;
    const lease = {
      engine,
      effectiveEngine: engine,
      effectiveEngineId: "test",
      effectiveEnginePluginId: undefined,
      degraded: false,
      degradedReason: undefined,
      selectForHost: vi.fn(),
      degradeBeforeStart: vi.fn(),
      begin: vi.fn(),
      deferDisposalUntil: vi.fn(),
      dispose: vi.fn(async () => undefined),
    } satisfies ContextEngineLogicalTurnLease;

    await drainPendingContextEngineTurnsBeforeRun({
      admission: currentAdmission,
      isHeartbeat: false,
      lease,
    });

    expect(commitTurn).not.toHaveBeenCalled();
    const queued = database.db
      .prepare("SELECT advancement_key, payload_json FROM context_engine_turn_outbox")
      .all() as Array<{ advancement_key: string; payload_json: string }>;
    expect(queued).toHaveLength(1);
    expect(queued[0]?.advancement_key).toBe(currentAdmission.logicalTurnId);
    expect(JSON.parse(queued[0]?.payload_json ?? "{}")).toMatchObject({
      state: "admitted",
      isHeartbeat: false,
    });
  });

  it("retains unrecoverable accepted recovery as a terminal marker without blocking later turns", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-context-outbox-blocked-"));
    tempDirs.push(stateDir);
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const payload = createPayload({
      advancementKey: "session-a:unrecoverable",
      databasePath: database.path,
      sequence: 1,
      sessionId: "session-a",
    });
    enqueueContextEngineTurnIntent({
      admission: payload.boundary.admission,
      database,
      engineId: "test",
      isHeartbeat: false,
    });
    acceptContextEngineTurnIntent({
      boundary: payload.boundary,
      database,
      engineId: "test",
      isHeartbeat: false,
    });
    const warn = vi.fn();

    recoverContextEngineTurnOutbox({
      database,
      engineId: "test",
      sessionId: payload.boundary.admission.sessionId,
      warn,
    });

    const queued = database.db
      .prepare("SELECT payload_json FROM context_engine_turn_outbox WHERE advancement_key = ?")
      .get(payload.boundary.admission.logicalTurnId) as { payload_json: string };
    expect(JSON.parse(queued.payload_json)).toMatchObject({
      state: "blocked",
      failure: "session-rebound",
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("blocked unrecoverable turn advancement"),
    );

    enqueueContextEngineTurnCommit({
      database,
      engineId: "test",
      payload: createPayload({
        advancementKey: "session-a:later-ready",
        databasePath: database.path,
        sequence: 3,
        sessionId: "session-a",
      }),
    });

    const engine = {
      info: {
        id: "test",
        name: "Test",
        transcriptSemantics: {
          currentTurnFence: "before-current-turn-entry-v1",
          turnAdvancementIdempotency: "atomic-idempotent-v1",
        },
      },
      ingest: async () => ({ ingested: true }),
      assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
      compact: async () => ({ ok: true, compacted: false }),
      commitTurn: vi.fn(async () => ({ status: "committed" as const })),
    } satisfies ContextEngine;
    const degradeBeforeStart = vi.fn();
    const lease = {
      engine,
      effectiveEngine: engine,
      effectiveEngineId: "test",
      effectiveEnginePluginId: undefined,
      degraded: false,
      degradedReason: undefined,
      selectForHost: vi.fn(),
      degradeBeforeStart,
      begin: vi.fn(),
      deferDisposalUntil: vi.fn(),
      dispose: vi.fn(async () => undefined),
    } satisfies ContextEngineLogicalTurnLease;
    const currentAdmission = {
      ...payload.boundary.admission,
      logicalTurnId: "session-a:current",
    };

    await drainPendingContextEngineTurnsBeforeRun({
      admission: currentAdmission,
      lease,
      warn,
    });

    expect(engine.commitTurn).toHaveBeenCalledOnce();
    expect(engine.commitTurn).toHaveBeenCalledWith(
      expect.objectContaining({ advancementKey: "session-a:later-ready" }),
    );
    expect(degradeBeforeStart).not.toHaveBeenCalled();
    expect(
      database.db
        .prepare("SELECT 1 FROM context_engine_turn_outbox WHERE advancement_key = ?")
        .get(payload.boundary.admission.logicalTurnId),
    ).toBeDefined();
    expect(
      database.db
        .prepare("SELECT 1 FROM context_engine_turn_outbox WHERE advancement_key = ?")
        .get("session-a:later-ready"),
    ).toBeUndefined();
    expect(
      JSON.parse(
        (
          database.db
            .prepare(
              "SELECT payload_json FROM context_engine_turn_outbox WHERE advancement_key = ?",
            )
            .get(currentAdmission.logicalTurnId) as { payload_json: string }
        ).payload_json,
      ),
    ).toMatchObject({ state: "admitted" });
  });

  it("does not let later same-session turns overtake a failed commit", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-context-outbox-order-"));
    tempDirs.push(stateDir);
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const enqueue = (advancementKey: string, sessionId: string, sequence: number) =>
      enqueueContextEngineTurnCommit({
        database,
        engineId: "test",
        payload: createPayload({
          advancementKey,
          databasePath: database.path,
          sequence,
          sessionId,
        }),
      });
    enqueue("session-a:z-first", "session-a", 1);
    for (let turn = 2; turn <= 17; turn += 1) {
      enqueue(turn === 2 ? "session-a:a-second" : `session-a:${turn}`, "session-a", turn * 2 - 1);
    }
    enqueue("session-b:1", "session-b", 1);
    database.db.exec(`
      UPDATE context_engine_turn_outbox SET created_at = CASE
        WHEN session_id = 'session-a' THEN 1
        ELSE 100
      END;
    `);

    let failFirstTurn = true;
    const commitTurn = vi.fn(async ({ advancementKey }: { advancementKey: string }) => {
      if (advancementKey === "session-a:z-first" && failFirstTurn) {
        throw new Error("temporary failure");
      }
      return { status: "committed" as const };
    });
    const engine = {
      info: { id: "test", name: "Test" },
      ingest: async () => ({ ingested: true }),
      assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
      compact: async () => ({ ok: true, compacted: false }),
      commitTurn,
    } satisfies ContextEngine;
    const warn = vi.fn();

    await drainContextEngineTurnOutbox({
      database,
      engine,
      engineId: "test",
      warn,
    });

    expect(commitTurn.mock.calls.map(([call]) => call.advancementKey)).toEqual([
      "session-a:z-first",
      "session-b:1",
    ]);
    failFirstTurn = false;

    await drainContextEngineTurnOutbox({
      database,
      engine,
      engineId: "test",
      limit: 2,
      warn,
    });

    expect(commitTurn.mock.calls.map(([call]) => call.advancementKey)).toEqual([
      "session-a:z-first",
      "session-b:1",
      "session-a:z-first",
      "session-a:a-second",
    ]);

    await drainContextEngineTurnOutbox({
      database,
      engine,
      engineId: "test",
      limit: 1,
      warn,
    });

    expect(commitTurn.mock.calls.map(([call]) => call.advancementKey)).toEqual([
      "session-a:z-first",
      "session-b:1",
      "session-a:z-first",
      "session-a:a-second",
      "session-a:3",
    ]);
  });

  it("retries the current session before the next run and degrades if it stays blocked", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-context-outbox-retry-"));
    tempDirs.push(stateDir);
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const payload = createPayload({
      advancementKey: "session-a:retry",
      databasePath: database.path,
      sequence: 1,
      sessionId: "session-a",
    });
    enqueueContextEngineTurnCommit({ database, engineId: "test", payload });

    let blocked = true;
    const commitTurn = vi.fn(async () => {
      if (blocked) {
        throw new Error("temporary failure");
      }
      return { status: "committed" as const };
    });
    const engine = {
      info: {
        id: "test",
        name: "Test",
        transcriptSemantics: {
          currentTurnFence: "before-current-turn-entry-v1",
          turnAdvancementIdempotency: "atomic-idempotent-v1",
        },
      },
      ingest: async () => ({ ingested: true }),
      assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
      compact: async () => ({ ok: true, compacted: false }),
      commitTurn,
    } satisfies ContextEngine;
    const degradeBeforeStart = vi.fn();
    const lease = {
      engine,
      effectiveEngine: engine,
      effectiveEngineId: "test",
      effectiveEnginePluginId: undefined,
      degraded: false,
      degradedReason: undefined,
      selectForHost: vi.fn(),
      degradeBeforeStart,
      begin: vi.fn(),
      deferDisposalUntil: vi.fn(),
      dispose: vi.fn(async () => undefined),
    } satisfies ContextEngineLogicalTurnLease;
    const warn = vi.fn();

    await drainContextEngineTurnOutbox({ database, engine, engineId: "test", warn });
    blocked = false;
    await drainPendingContextEngineTurnsBeforeRun({
      admission: payload.boundary.admission,
      lease,
      warn,
    });

    expect(commitTurn).toHaveBeenCalledTimes(2);
    expect(degradeBeforeStart).not.toHaveBeenCalled();

    enqueueContextEngineTurnCommit({
      database,
      engineId: "test",
      payload: createPayload({
        advancementKey: "session-a:blocked",
        databasePath: database.path,
        sequence: 3,
        sessionId: "session-a",
      }),
    });
    blocked = true;
    await drainPendingContextEngineTurnsBeforeRun({
      admission: payload.boundary.admission,
      lease,
      warn,
    });

    expect(degradeBeforeStart).toHaveBeenCalledWith(
      "pending durable turn advancement could not be completed before the next turn",
    );
  });

  it("throws a descriptive error when existing outbox payload JSON is malformed", () => {
    const stateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-context-outbox-malformed-write-"),
    );
    tempDirs.push(stateDir);
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const payload = createPayload({
      advancementKey: "session-a:malformed-write",
      databasePath: database.path,
      sequence: 1,
      sessionId: "session-a",
    });
    enqueueContextEngineTurnCommit({ database, engineId: "test", payload });

    // Corrupt the stored payload_json so the next write hits the JSON.parse path.
    database.db
      .prepare(
        "UPDATE context_engine_turn_outbox SET payload_json = '{not-valid-json' WHERE advancement_key = ?",
      )
      .run(payload.boundary.admission.logicalTurnId);

    expect(() => enqueueContextEngineTurnCommit({ database, engineId: "test", payload })).toThrow(
      /Failed to parse existing outbox payload JSON/,
    );
  });

  it("skips outbox rows with malformed payload JSON during recovery", () => {
    const stateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-context-outbox-malformed-recover-"),
    );
    tempDirs.push(stateDir);
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const payload = createPayload({
      advancementKey: "session-a:malformed-recover",
      databasePath: database.path,
      sequence: 1,
      sessionId: "session-a",
    });
    enqueueContextEngineTurnCommit({ database, engineId: "test", payload });

    // Corrupt the stored payload_json so recovery hits the JSON.parse path.
    database.db
      .prepare(
        "UPDATE context_engine_turn_outbox SET payload_json = '{not-valid-json' WHERE advancement_key = ?",
      )
      .run(payload.boundary.admission.logicalTurnId);

    const warn = vi.fn();
    recoverContextEngineTurnOutbox({
      database,
      engineId: "test",
      sessionId: payload.boundary.admission.sessionId,
      warn,
    });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "skipping outbox row with malformed payload JSON: session-a:malformed-recover",
      ),
    );
  });

  it("persists real turn messages through a durable plugin and reassembles them after a reopen past a malformed row", async () => {
    const stateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-context-outbox-durable-plugin-"),
    );
    tempDirs.push(stateDir);
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const databasePath = database.path;
    // Turn messages shaped exactly like the entries the transcript hands to
    // commitTurn in production: plain { role, content } records.
    const turnMessages = (user: string, assistant: string) =>
      [
        { role: "user", content: user },
        { role: "assistant", content: assistant },
      ] as unknown as ContextEngineTurnOutboxPayload["messages"];
    // A real (minimal) durable context plugin. commitTurn persists each accepted
    // turn's messages to the plugin's own on-disk context store and honours the
    // atomic-idempotent contract, so a host retry of an already-committed key
    // reports "duplicate" instead of storing the same messages twice.
    const pluginStorePath = path.join(stateDir, "plugin-context-store.jsonl");
    type PluginTurn = {
      advancementKey: string;
      sessionId: string;
      messages: ContextEngineTurnOutboxPayload["messages"];
    };
    const readPluginStore = (): PluginTurn[] =>
      fs.existsSync(pluginStorePath)
        ? fs
            .readFileSync(pluginStorePath, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as PluginTurn)
        : [];
    const commitTurn: NonNullable<ContextEngine["commitTurn"]> = async (params) => {
      const alreadyCommitted = readPluginStore().some(
        (turn) => turn.advancementKey === params.advancementKey,
      );
      if (alreadyCommitted) {
        return { status: "duplicate" };
      }
      fs.appendFileSync(
        pluginStorePath,
        `${JSON.stringify({
          advancementKey: params.advancementKey,
          sessionId: params.sessionId,
          messages: params.messages,
        })}\n`,
      );
      return { status: "committed" };
    };
    const engine = {
      info: {
        id: "test",
        name: "Test",
        transcriptSemantics: {
          currentTurnFence: "before-current-turn-entry-v1",
          turnAdvancementIdempotency: "atomic-idempotent-v1",
        },
      },
      ingest: async () => ({ ingested: true }),
      assemble: async ({ sessionId, messages }) => {
        // Reconstitute the persisted turns for this session, then append the
        // incoming run's messages, so a later run continues from committed context.
        const persisted = readPluginStore()
          .filter((turn) => turn.sessionId === sessionId)
          .flatMap((turn) => turn.messages);
        const assembled = [...persisted, ...messages];
        return { messages: assembled, estimatedTokens: assembled.length };
      },
      compact: async () => ({ ok: true, compacted: false }),
      commitTurn,
    } satisfies ContextEngine;
    const createLease = () => {
      const degradeBeforeStart = vi.fn();
      const lease = {
        engine,
        effectiveEngine: engine,
        effectiveEngineId: "test",
        effectiveEnginePluginId: undefined,
        degraded: false,
        degradedReason: undefined,
        selectForHost: vi.fn(),
        degradeBeforeStart,
        begin: vi.fn(),
        deferDisposalUntil: vi.fn(),
        dispose: vi.fn(async () => undefined),
      } satisfies ContextEngineLogicalTurnLease;
      return { degradeBeforeStart, lease };
    };
    const admissionFor = (advancementKey: string, sequence: number) =>
      createPayload({ advancementKey, databasePath, sequence, sessionId: "session-a" }).boundary
        .admission;
    const outboxKeys = (target: typeof database) =>
      (
        target.db
          .prepare(
            "SELECT advancement_key FROM context_engine_turn_outbox ORDER BY advancement_key",
          )
          .all() as Array<{ advancement_key: string }>
      ).map((row) => row.advancement_key);

    enqueueContextEngineTurnCommit({
      database,
      engineId: "test",
      payload: createPayload({
        advancementKey: "session-a:malformed",
        databasePath,
        sequence: 1,
        sessionId: "session-a",
      }),
    });
    // Corrupt the first stored payload so recovery and every pending-work JSON
    // projection meet invalid JSON before the later valid row.
    database.db
      .prepare(
        "UPDATE context_engine_turn_outbox SET payload_json = '{not-valid-json' WHERE advancement_key = ?",
      )
      .run("session-a:malformed");
    enqueueContextEngineTurnCommit({
      database,
      engineId: "test",
      payload: createPayload({
        advancementKey: "session-a:later-valid",
        databasePath,
        sequence: 3,
        sessionId: "session-a",
        messages: turnMessages("later valid user turn", "later valid assistant turn"),
      }),
    });

    const warn = vi.fn();
    const firstRun = createLease();
    await drainPendingContextEngineTurnsBeforeRun({
      admission: admissionFor("session-a:current-1", 5),
      lease: firstRun.lease,
      warn,
    });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "skipping outbox row with malformed payload JSON: session-a:malformed",
      ),
    );
    // Before the json_valid guard the pending-work projection faulted on the
    // corrupted row, so the pre-run owner reported a retry failure and degraded.
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("failed to retry pending turn advancement"),
    );
    expect(firstRun.degradeBeforeStart).not.toHaveBeenCalled();
    expect(readPluginStore()).toEqual([
      {
        advancementKey: "session-a:later-valid",
        sessionId: "session-a",
        messages: turnMessages("later valid user turn", "later valid assistant turn"),
      },
    ]);

    // The pre-run owner admits the current turn after draining; drop that intent so
    // the reopened run starts from the state the corrupted row actually produced.
    database.db
      .prepare("DELETE FROM context_engine_turn_outbox WHERE advancement_key = ?")
      .run("session-a:current-1");

    // Reopen the existing database so the next run sees durable state only.
    closeOpenClawAgentDatabasesForTest();
    const reopened = openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
    const reopenedWarn = vi.fn();
    recoverContextEngineTurnOutbox({
      database: reopened,
      engineId: "test",
      sessionId: "session-a",
      warn: reopenedWarn,
    });
    expect(reopenedWarn).toHaveBeenCalledWith(
      expect.stringContaining(
        "skipping outbox row with malformed payload JSON: session-a:malformed",
      ),
    );

    // Continuation on the reopened database: a later accepted turn advances while a
    // host retry of the already-committed turn stays idempotent.
    enqueueContextEngineTurnCommit({
      database: reopened,
      engineId: "test",
      payload: createPayload({
        advancementKey: "session-a:after-reopen",
        databasePath,
        sequence: 9,
        sessionId: "session-a",
        messages: turnMessages("after reopen user turn", "after reopen assistant turn"),
      }),
    });
    enqueueContextEngineTurnCommit({
      database: reopened,
      engineId: "test",
      payload: createPayload({
        advancementKey: "session-a:later-valid",
        databasePath,
        sequence: 3,
        sessionId: "session-a",
        messages: turnMessages("later valid user turn", "later valid assistant turn"),
      }),
    });
    const drained = await drainContextEngineTurnOutbox({
      database: reopened,
      engine,
      engineId: "test",
      warn: reopenedWarn,
    });

    // The corrupted row is excluded from pending work, so the reopened database
    // reports nothing outstanding and the next run keeps its full context path.
    expect(drained.pending).toBe(false);
    expect(readPluginStore()).toEqual([
      {
        advancementKey: "session-a:later-valid",
        sessionId: "session-a",
        messages: turnMessages("later valid user turn", "later valid assistant turn"),
      },
      {
        advancementKey: "session-a:after-reopen",
        sessionId: "session-a",
        messages: turnMessages("after reopen user turn", "after reopen assistant turn"),
      },
    ]);
    expect(outboxKeys(reopened)).toEqual(["session-a:malformed"]);
    const retainedOutboxRows = outboxKeys(reopened);

    const continuationRun = createLease();
    await drainPendingContextEngineTurnsBeforeRun({
      admission: admissionFor("session-a:current-2", 11),
      lease: continuationRun.lease,
      warn: reopenedWarn,
    });
    expect(continuationRun.degradeBeforeStart).not.toHaveBeenCalled();
    expect(reopenedWarn).not.toHaveBeenCalledWith(
      expect.stringContaining("failed to retry pending turn advancement"),
    );

    // A subsequent run reassembles context straight from the plugin's durable
    // store: the messages committed before the reopen come back and the incoming
    // prompt is appended, proving persisted turn content is reused, not dropped.
    const persistedTurns = readPluginStore();
    const assembled = await engine.assemble({
      sessionId: "session-a",
      messages: turnMessages("next run user prompt", "next run assistant reply"),
    });
    expect(assembled.messages).toEqual([
      ...turnMessages("later valid user turn", "later valid assistant turn"),
      ...turnMessages("after reopen user turn", "after reopen assistant turn"),
      ...turnMessages("next run user prompt", "next run assistant reply"),
    ]);

    // Terminal trace of the persisted production state, so the after-fix behaviour
    // is visible in CI output without attaching a debugger.
    console.log(
      JSON.stringify({
        scenario: "durable-plugin-message-persistence-and-reassembly",
        database: path.basename(databasePath),
        persistedTurns: persistedTurns.map((turn) => ({
          advancementKey: turn.advancementKey,
          messages: turn.messages,
        })),
        assembledContext: assembled.messages,
        assembledTokenEstimate: assembled.estimatedTokens,
        retainedOutboxRows,
        leaseDegradations:
          firstRun.degradeBeforeStart.mock.calls.length +
          continuationRun.degradeBeforeStart.mock.calls.length,
      }),
    );
  });
});
