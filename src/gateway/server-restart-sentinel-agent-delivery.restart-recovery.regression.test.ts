import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRestartRecoveryTerminalDeliveryEvidence } from "../agents/agent-command-restart-recovery.js";
import { buildRestartRecoveryClaimCleanupPatch } from "../config/sessions/restart-recovery-state.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import {
  enqueueSessionDelivery,
  loadPendingSessionDelivery,
  type QueuedSessionDelivery,
} from "../infra/session-delivery-queue.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { deliverQueuedGeneratedMediaAgentTurn } from "./server-restart-sentinel-agent-delivery.js";

describe("restart-sentinel generated-media terminal evidence regression (#119736)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-terminal-evidence-"));
  });

  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function storePath(agentId: string): string {
    return path.join(tempDir, "agents", agentId, "sessions", "sessions.json");
  }

  async function ensureSessionsDir(agentId: string): Promise<void> {
    await fs.mkdir(path.dirname(storePath(agentId)), { recursive: true });
  }

  async function seedPersistedRecoveryCase(params: {
    agentId: string;
    sessionKey: string;
    sessionId: string;
    messageId: string;
    unsafeSideEffectsDetected?: true;
    legacyAliasOnly?: true;
  }): Promise<string> {
    await ensureSessionsDir(params.agentId);
    const entry = {
      sessionId: params.sessionId,
      status: "done" as const,
      updatedAt: 1,
      restartRecoveryDeliveryRunId: `${params.messageId}:internal`,
      restartRecoveryDeliverySourceRunId: params.messageId,
    };
    const terminalDeliveryEvidence = buildRestartRecoveryTerminalDeliveryEvidence({
      payloads: [{ visible: true }],
      deliveryStatus: { status: "sent" },
      ...(params.unsafeSideEffectsDetected ? { unsafeSideEffectsDetected: true as const } : {}),
    });
    const cleanupPatch = buildRestartRecoveryClaimCleanupPatch({
      entry,
      recordTerminalSource: true,
      terminalDeliveryEvidence,
      terminalRunId: params.messageId,
    });
    await replaceSessionEntry(
      { sessionKey: params.sessionKey, storePath: storePath(params.agentId) },
      {
        ...entry,
        ...cleanupPatch,
        ...(params.legacyAliasOnly
          ? {
              restartRecoveryTerminalDeliveryEvidence: [
                {
                  runId: params.messageId,
                  restartUnsafeSideEffectsDetected: true as const,
                },
              ],
            }
          : {}),
      },
    );

    return await enqueueSessionDelivery(
      {
        kind: "agentTurn",
        sessionKey: params.sessionKey,
        message: `resume ${params.messageId}`,
        messageId: params.messageId,
        idempotencyKey: params.messageId,
        route: {
          channel: "discord",
          to: "channel:123",
          accountId: "default",
          chatType: "channel",
        },
        inputProvenance: {
          kind: "inter_session",
          sourceChannel: "webchat",
          sourceTool: "image_generate",
        },
        sourceReplyDeliveryMode: "automatic",
      },
      tempDir,
    );
  }

  function readRawPersistedEntry(agentId: string, sessionKey: string): Record<string, unknown> {
    const sqliteTarget = resolveSqliteTargetFromSessionStorePath(storePath(agentId), {
      agentId,
    });
    const database = openOpenClawAgentDatabase({
      agentId,
      path: sqliteTarget.path,
      env: { ...process.env, OPENCLAW_STATE_DIR: tempDir },
    });
    const row = database.db
      .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
      .get(sessionKey) as { entry_json?: string } | undefined;
    if (!row?.entry_json) {
      throw new Error(`expected persisted session row for ${sessionKey}`);
    }
    return JSON.parse(row.entry_json) as Record<string, unknown>;
  }

  function readQueueStatus(id: string): string | undefined {
    const { db } = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: tempDir },
    });
    const row = db
      .prepare("SELECT status FROM delivery_queue_entries WHERE queue_name = 'session' AND id = ?")
      .get(id) as { status?: string } | undefined;
    return row?.status;
  }

  function requireAgentTurn(
    entry: QueuedSessionDelivery | null,
    expectedId: string,
  ): Extract<QueuedSessionDelivery, { kind: "agentTurn" }> {
    if (!entry || entry.kind !== "agentTurn") {
      throw new Error(`expected pending agentTurn delivery ${expectedId}`);
    }
    return entry;
  }

  it("reopens persisted terminal evidence without fresh redispatch and keeps the legacy unsafe field shape", async () => {
    const safeAgentId = "safe";
    const safeSessionKey = "agent:safe:terminal-safe";
    const safeSessionId = "session-safe";
    const safeMessageId = "image:task-terminal-safe:agent-loop";
    const unsafeAgentId = "unsafe";
    const unsafeSessionKey = "agent:unsafe:terminal-unsafe";
    const unsafeSessionId = "session-unsafe";
    const unsafeMessageId = "image:task-terminal-unsafe:agent-loop";

    const safeQueueId = await seedPersistedRecoveryCase({
      agentId: safeAgentId,
      sessionKey: safeSessionKey,
      sessionId: safeSessionId,
      messageId: safeMessageId,
    });
    const unsafeQueueId = await seedPersistedRecoveryCase({
      agentId: unsafeAgentId,
      sessionKey: unsafeSessionKey,
      sessionId: unsafeSessionId,
      messageId: unsafeMessageId,
      unsafeSideEffectsDetected: true,
      legacyAliasOnly: true,
    });

    const rawUnsafeEntry = readRawPersistedEntry(unsafeAgentId, unsafeSessionKey);
    const rawUnsafeEvidence = (
      rawUnsafeEntry.restartRecoveryTerminalDeliveryEvidence as Array<Record<string, unknown>>
    )?.[0];
    expect(rawUnsafeEvidence).toMatchObject({
      runId: unsafeMessageId,
      restartUnsafeSideEffectsDetected: true,
    });
    expect(rawUnsafeEvidence).not.toHaveProperty("unsafeSideEffectsDetected");

    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();

    const rawSafeEntry = readRawPersistedEntry(safeAgentId, safeSessionKey);
    expect(
      (rawSafeEntry.restartRecoveryTerminalDeliveryEvidence as Array<Record<string, unknown>>)?.[0],
    ).toMatchObject({
      runId: safeMessageId,
      captured: true,
      payloads: [{ visible: true }],
      deliveryStatus: { status: "sent" },
    });
    const reopenedSafeEntry = loadSessionEntry({
      agentId: safeAgentId,
      sessionKey: safeSessionKey,
      storePath: storePath(safeAgentId),
      env: { ...process.env, OPENCLAW_STATE_DIR: tempDir },
      readConsistency: "latest",
    });
    const reopenedUnsafeEntry = loadSessionEntry({
      agentId: unsafeAgentId,
      sessionKey: unsafeSessionKey,
      storePath: storePath(unsafeAgentId),
      env: { ...process.env, OPENCLAW_STATE_DIR: tempDir },
      readConsistency: "latest",
    });
    expect(reopenedSafeEntry).toBeDefined();
    expect(reopenedUnsafeEntry).toBeDefined();
    const reopenedSafeQueue = requireAgentTurn(
      await loadPendingSessionDelivery(safeQueueId, tempDir),
      safeQueueId,
    );
    const reopenedUnsafeQueue = requireAgentTurn(
      await loadPendingSessionDelivery(unsafeQueueId, tempDir),
      unsafeQueueId,
    );

    expect(reopenedSafeEntry.restartRecoveryTerminalDeliveryEvidence).toEqual([
      {
        runId: safeMessageId,
        captured: true,
        payloads: [{ visible: true }],
        deliveryStatus: { status: "sent" },
      },
    ]);
    expect(reopenedUnsafeEntry.restartRecoveryTerminalDeliveryEvidence).toEqual([
      {
        runId: unsafeMessageId,
        restartUnsafeSideEffectsDetected: true,
      },
    ]);

    await expect(
      deliverQueuedGeneratedMediaAgentTurn({
        entry: reopenedSafeQueue,
        canonicalKey: safeSessionKey,
        sessionEntry: reopenedSafeEntry,
        stateDir: tempDir,
      }),
    ).resolves.toBe(true);
    expect(readQueueStatus(safeQueueId)).toBe("pending");

    await expect(
      deliverQueuedGeneratedMediaAgentTurn({
        entry: reopenedUnsafeQueue,
        canonicalKey: unsafeSessionKey,
        sessionEntry: reopenedUnsafeEntry,
        stateDir: tempDir,
      }),
    ).rejects.toThrow(
      "queued generated-media delivery dead-lettered after an unexpected committed side effect",
    );
    await expect(
      deliverQueuedGeneratedMediaAgentTurn({
        entry: reopenedUnsafeQueue,
        canonicalKey: unsafeSessionKey,
        sessionEntry: reopenedUnsafeEntry,
        stateDir: tempDir,
      }),
    ).rejects.toThrow(
      "queued generated-media delivery dead-lettered after an unexpected committed side effect",
    );
    expect(readQueueStatus(unsafeQueueId)).toBe("pending");
  });
});
