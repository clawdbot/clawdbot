import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendTranscriptMessage,
  upsertSessionEntry,
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
    messages: [],
    prePromptMessageCount: params.sequence,
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

  it("drains a versionless v1 row after an engine adds the turn-local contract", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-context-outbox-upgrade-"));
    tempDirs.push(stateDir);
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const payload = createPayload({
      advancementKey: "session-a:legacy-ready",
      databasePath: database.path,
      sequence: 3,
      sessionId: "session-a",
    });
    enqueueContextEngineTurnCommit({ database, engineId: "test", payload });
    const commitTurn = vi.fn<NonNullable<ContextEngine["commitTurn"]>>(async () => ({
      status: "committed",
    }));
    const commitTurnLocal = vi.fn<NonNullable<ContextEngine["commitTurnLocal"]>>(async () => ({
      status: "committed",
    }));
    const engine = {
      info: {
        id: "test",
        name: "Test",
        transcriptSemantics: {
          turnAdvancementIdempotency: "atomic-idempotent-turn-local-v1",
        },
      },
      ingest: async () => ({ ingested: true }),
      assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
      compact: async () => ({ ok: true, compacted: false }),
      commitTurn,
      commitTurnLocal,
    } satisfies ContextEngine;

    await drainContextEngineTurnOutbox({
      database,
      engine,
      engineId: "test",
      warn: vi.fn(),
    });

    expect(commitTurn).toHaveBeenCalledWith(expect.objectContaining({ prePromptMessageCount: 3 }));
    expect(commitTurnLocal).not.toHaveBeenCalled();
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
    await upsertSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
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
      turnAdvancementIdempotency: "atomic-idempotent-turn-local-v1",
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
    const commitTurnLocal = vi.fn<NonNullable<ContextEngine["commitTurnLocal"]>>(async () => ({
      status: "committed",
    }));
    const engine = {
      info: {
        id: "test",
        name: "Test",
        transcriptSemantics: {
          currentTurnFence: "before-current-turn-entry-v1",
          turnAdvancementIdempotency: "atomic-idempotent-turn-local-v1",
        },
      },
      ingest: async () => ({ ingested: true }),
      assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
      compact: async () => ({ ok: true, compacted: false }),
      commitTurn: async () => ({ status: "committed" as const }),
      commitTurnLocal,
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

    expect(commitTurnLocal).toHaveBeenCalledOnce();
    expect(commitTurnLocal).toHaveBeenCalledWith(
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
    expect(commitTurnLocal.mock.calls[0]?.[0]).not.toHaveProperty("prePromptMessageCount");

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
    await upsertSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
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

  it("retains unrecoverable accepted recovery as a blocking marker", async () => {
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
      turnAdvancementIdempotency: "atomic-idempotent-v1",
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

    await drainPendingContextEngineTurnsBeforeRun({
      admission: payload.boundary.admission,
      lease,
      warn,
    });

    expect(engine.commitTurn).not.toHaveBeenCalled();
    expect(degradeBeforeStart).toHaveBeenCalledWith(
      "pending durable turn advancement could not be completed before the next turn",
    );
    expect(
      database.db
        .prepare("SELECT 1 FROM context_engine_turn_outbox WHERE advancement_key = ?")
        .get(payload.boundary.admission.logicalTurnId),
    ).toBeDefined();
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
});
