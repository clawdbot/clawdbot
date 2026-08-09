import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendTranscriptMessage,
  readActiveTranscriptEntryAnchor,
  upsertSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { ContextEngine } from "../../context-engine/types.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { ContextEngineLogicalTurnLease } from "./context-engine-logical-turn.js";
import {
  drainPendingContextEngineTurnsBeforeRun,
  finalizeAcceptedContextEngineTurn,
  type ContextEngineTurnAttemptFacts,
} from "./context-engine-turn-attempt.js";
import { enqueueContextEngineTurnIntent } from "./context-engine-turn-outbox.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

describe("accepted context-engine turn finalization", () => {
  it("silently skips engines without durable turn ownership but rejects partial declarations", async () => {
    const admission = {
      agentId: "main",
      sessionId: "accepted-turn",
      sessionKey: "agent:main:accepted-turn",
      storePath: "sqlite://accepted-turn",
      generation: "generation",
      entryId: "user-entry",
      rawSeq: 1,
      effectiveParentId: null,
      activeMessagePosition: 0,
      logicalTurnId: "logical-turn",
      role: "user" as const,
    };
    const facts = {
      boundary: {
        admission,
        terminal: {
          ...admission,
          entryId: "assistant-entry",
          rawSeq: 2,
          activeMessagePosition: 1,
        },
      },
      sessionIdUsed: admission.sessionId,
      sessionKey: admission.sessionKey,
      sessionFile: admission.storePath,
      promptError: false,
      aborted: false,
      yieldAborted: false,
    } satisfies ContextEngineTurnAttemptFacts;
    const makeLease = (engine: ContextEngine): ContextEngineLogicalTurnLease => ({
      engine,
      effectiveEngine: engine,
      effectiveEngineId: engine.info.id,
      effectiveEnginePluginId: undefined,
      degraded: false,
      degradedReason: undefined,
      selectForHost: vi.fn(),
      degradeBeforeStart: vi.fn(),
      begin: vi.fn(),
      deferDisposalUntil: () => undefined,
      dispose: async () => undefined,
    });
    const makeEngine = (declaresDurableAdvancement: boolean): ContextEngine => ({
      info: {
        id: declaresDurableAdvancement ? "partial" : "legacy",
        name: declaresDurableAdvancement ? "Partial" : "Legacy",
        ...(declaresDurableAdvancement
          ? {
              transcriptSemantics: {
                turnAdvancementIdempotency: "atomic-idempotent-v1" as const,
              },
            }
          : {}),
      },
      ingest: async () => ({ ingested: false }),
      assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
      compact: async () => ({ ok: true, compacted: false }),
    });
    const warn = vi.fn();

    await finalizeAcceptedContextEngineTurn({
      facts,
      lease: makeLease(makeEngine(false)),
      warn,
    });

    expect(warn).not.toHaveBeenCalled();

    await finalizeAcceptedContextEngineTurn({
      facts,
      lease: makeLease(makeEngine(true)),
      warn,
    });

    expect(warn).toHaveBeenCalledWith(
      "[context-engine] skipped accepted turn advancement: accepted context engine does not support durable turn advancement",
    );
  });

  it("advances only the admitted durable range and rejects stale admission facts", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-context-turn-attempt-"));
    const target = {
      agentId: "main",
      sessionId: "accepted-turn",
      sessionKey: "agent:main:accepted-turn",
      storePath: path.join(tempDir, "sessions.json"),
    };
    await upsertSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    const prior = await appendTranscriptMessage(target, {
      message: { role: "assistant", content: "prior" },
      now: 1_000,
    });
    const admitted = await appendTranscriptMessage(target, {
      message: { role: "user", content: "current" },
      parentId: prior?.messageId,
      now: 2_000,
    });
    const terminal = await appendTranscriptMessage(target, {
      message: { role: "assistant", content: "answer" },
      parentId: admitted?.messageId,
      now: 3_000,
    });
    if (!admitted?.anchor || !terminal?.anchor) {
      throw new Error("expected admitted turn transcript");
    }

    const commitTurn = vi.fn(async () => ({ status: "committed" as const }));
    const engine: ContextEngine = {
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
    };
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
      deferDisposalUntil: () => undefined,
      dispose: async () => undefined,
    } satisfies ContextEngineLogicalTurnLease;
    const admission = {
      ...admitted.anchor,
      logicalTurnId: "logical-turn-1",
      role: "user" as const,
    };
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
    const baseFacts = {
      boundary: { admission, terminal: terminal.anchor },
      sessionIdUsed: target.sessionId,
      sessionKey: target.sessionKey,
      sessionTarget: target,
      sessionFile: "sqlite://accepted-turn",
      promptError: false,
      aborted: false,
      yieldAborted: false,
    };

    await finalizeAcceptedContextEngineTurn({ facts: baseFacts, lease });

    expect(commitTurn).toHaveBeenCalledOnce();
    expect(commitTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ content: "prior" }),
          expect.objectContaining({ content: "current" }),
          expect.objectContaining({ content: "answer" }),
        ]),
        prePromptMessageCount: 1,
      }),
    );

    const warn = vi.fn();
    await finalizeAcceptedContextEngineTurn({
      facts: {
        ...baseFacts,
        boundary: {
          ...baseFacts.boundary,
          admission: { ...admission, rawSeq: admission.rawSeq + 1 },
        },
      },
      lease,
      warn,
    });

    expect(commitTurn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "[context-engine] skipped accepted turn advancement: accepted context-engine transcript range is stale",
    );
    expect(
      JSON.parse(
        (
          database.db
            .prepare(
              "SELECT payload_json FROM context_engine_turn_outbox WHERE advancement_key = ?",
            )
            .get(admission.logicalTurnId) as { payload_json: string }
        ).payload_json,
      ),
    ).toMatchObject({ state: "blocked", failure: "stale" });

    await drainPendingContextEngineTurnsBeforeRun({
      admission,
      lease,
      warn,
    });
    expect(lease.degradeBeforeStart).toHaveBeenCalledWith(
      "pending durable turn advancement could not be completed before the next turn",
    );

    const sibling = await appendTranscriptMessage(target, {
      message: { role: "assistant", content: "sibling" },
      parentId: prior?.messageId,
      now: 4_000,
    });
    if (!sibling) {
      throw new Error("expected sibling transcript");
    }
    const siblingIdentity = database.db
      .prepare("SELECT seq FROM transcript_event_identities WHERE session_id = ? AND event_id = ?")
      .get(target.sessionId, sibling.messageId) as { seq?: number } | undefined;
    if (siblingIdentity?.seq === undefined) {
      throw new Error("expected sibling transcript identity");
    }
    // Model a stale/concurrent projection that assigns a later active position
    // to a sibling. Position order alone must not make it an accepted descendant.
    database.db
      .prepare(
        "INSERT INTO session_transcript_active_events (session_id, active_position, event_seq, message_position) VALUES (?, ?, ?, ?)",
      )
      .run(
        target.sessionId,
        terminal.anchor.activeMessagePosition + 1,
        siblingIdentity.seq,
        terminal.anchor.activeMessagePosition + 1,
      );
    database.db
      .prepare(
        "UPDATE session_transcript_index_state SET indexed_seq = ?, needs_rebuild = 0 WHERE session_id = ?",
      )
      .run(siblingIdentity.seq, target.sessionId);
    const siblingAnchor = readActiveTranscriptEntryAnchor({
      ...target,
      entryId: sibling.messageId,
    });
    if (!siblingAnchor) {
      throw new Error("expected projected sibling transcript anchor");
    }
    const siblingAdmission = {
      ...admission,
      logicalTurnId: "logical-turn-2",
    };
    enqueueContextEngineTurnIntent({
      admission: siblingAdmission,
      database,
      engineId: "test",
      isHeartbeat: false,
    });
    warn.mockClear();
    await finalizeAcceptedContextEngineTurn({
      facts: {
        ...baseFacts,
        boundary: { admission: siblingAdmission, terminal: siblingAnchor },
      },
      lease,
      warn,
    });

    expect(commitTurn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "[context-engine] skipped accepted turn advancement: accepted context-engine transcript range is non-descendant",
    );
    expect(
      JSON.parse(
        (
          database.db
            .prepare(
              "SELECT payload_json FROM context_engine_turn_outbox WHERE advancement_key = ?",
            )
            .get(siblingAdmission.logicalTurnId) as { payload_json: string }
        ).payload_json,
      ),
    ).toMatchObject({ state: "blocked", failure: "non-descendant" });

    const abortedAdmission = {
      ...admission,
      logicalTurnId: "logical-turn-3",
    };
    enqueueContextEngineTurnIntent({
      admission: abortedAdmission,
      database,
      engineId: "test",
      isHeartbeat: false,
    });
    await finalizeAcceptedContextEngineTurn({
      facts: {
        ...baseFacts,
        aborted: true,
        boundary: { ...baseFacts.boundary, admission: abortedAdmission },
      },
      lease,
      warn,
    });
    expect(
      database.db
        .prepare("SELECT 1 FROM context_engine_turn_outbox WHERE advancement_key = ?")
        .get(abortedAdmission.logicalTurnId),
    ).toBeUndefined();
  });
});
