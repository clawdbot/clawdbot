/**
 * Gateway session compaction RPC tests.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import type { SessionCompactionCheckpoint } from "../config/sessions.js";
import { readSessionArchiveContentSync } from "../config/sessions/archive-compression.js";
import {
  appendTranscriptMessage,
  appendTranscriptEvent,
  loadSessionEntry as loadAccessorSessionEntry,
  loadTranscriptEvents,
  patchSessionEntry as patchAccessorSessionEntry,
  replaceSessionEntry,
  upsertSessionEntry,
} from "../config/sessions/session-accessor.js";
import {
  beginSessionWorkAdmission,
  isSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../sessions/session-lifecycle-admission.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  embeddedRunMock,
  onceMessage,
  agentDiscoveryMock,
  rpcReq,
  testState,
} from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  createDeferred,
  getSessionManagerModule,
  sessionStoreEntry,
  createCheckpointFixture,
  directSessionReq,
  expectNoSessionQueueCleanup,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, createSelectedGlobalSessionStore, openClient } =
  setupGatewaySessionsTestHarness();

type CheckpointFixture = Awaited<ReturnType<typeof createCheckpointFixture>>;

function buildSessionTranscriptLines(sessionId: string, totalLines: number): string[] {
  const header = JSON.stringify({
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: "2026-06-19T12:00:00.000Z",
    cwd: "/tmp",
  });
  const entries = Array.from({ length: Math.max(0, totalLines - 1) }, (_, index) =>
    JSON.stringify({
      type: "message",
      id: `entry-${index}`,
      parentId: index === 0 ? null : `entry-${index - 1}`,
      timestamp: `2026-06-19T12:00:${String(index % 60).padStart(2, "0")}.000Z`,
      message: { role: "user", content: `line-${index}`, timestamp: index },
    }),
  );
  return [header, ...entries];
}

function compactionCheckpointEntry(
  fixture: CheckpointFixture,
  options: {
    checkpointId: string;
    sessionKey: string;
    createdAt: number;
    reason: SessionCompactionCheckpoint["reason"];
    summary: string;
    tokensBefore?: number;
    tokensAfter?: number;
  },
) {
  return {
    checkpointId: options.checkpointId,
    sessionKey: options.sessionKey,
    sessionId: fixture.sessionId,
    createdAt: options.createdAt,
    reason: options.reason,
    summary: options.summary,
    ...(options.tokensBefore === undefined ? {} : { tokensBefore: options.tokensBefore }),
    ...(options.tokensAfter === undefined ? {} : { tokensAfter: options.tokensAfter }),
    firstKeptEntryId: fixture.preCompactionLeafId,
    preCompaction: {
      sessionId: fixture.sessionId,
      leafId: fixture.preCompactionLeafId,
    },
    postCompaction: {
      sessionId: fixture.sessionId,
      sessionFile: fixture.sessionFile,
      leafId: fixture.postCompactionLeafId,
      entryId: fixture.postCompactionLeafId,
    },
  };
}

function isCompactOperationEvent(message: unknown, phase: "start" | "end") {
  const candidate = message as {
    event?: unknown;
    payload?: { operation?: unknown; phase?: unknown };
    type?: unknown;
  };
  return (
    candidate.type === "event" &&
    candidate.event === "session.operation" &&
    candidate.payload?.operation === "compact" &&
    candidate.payload?.phase === phase
  );
}

function expectMainCompactionResult(
  compacted: { ok?: boolean; payload?: { compacted?: boolean; key?: string } | null },
  expectedCompacted: boolean,
) {
  expect(compacted.ok, JSON.stringify(compacted)).toBe(true);
  expect(compacted.payload?.key).toBe("agent:main:main");
  expect(compacted.payload?.compacted).toBe(expectedCompacted);
}

async function seedSessionEntry(params: {
  agentId?: string;
  entry: ReturnType<typeof sessionStoreEntry>;
  sessionKey: string;
  storePath: string;
}): Promise<void> {
  await upsertSessionEntry(
    {
      ...(params.agentId ? { agentId: params.agentId } : {}),
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
    params.entry,
  );
}

function loadSessionEntry(params: {
  agentId?: string;
  sessionKey: string;
  storePath: string;
}): ReturnType<typeof loadAccessorSessionEntry> {
  return loadAccessorSessionEntry({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    readConsistency: "latest",
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });
}

async function seedTranscriptRows(params: {
  agentId?: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  totalLines: number;
}): Promise<void> {
  const scope = {
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  };
  if (params.totalLines <= 0) {
    return;
  }
  const header = JSON.parse(buildSessionTranscriptLines(params.sessionId, 1)[0] ?? "{}");
  await appendTranscriptEvent(scope, header);
  for (let index = 0; index < params.totalLines - 1; index += 1) {
    await appendTranscriptMessage(scope, {
      cwd: "/tmp",
      message: {
        role: "user",
        content: `line-${index}`,
        timestamp: index,
      },
      now: Date.parse(`2026-06-19T12:00:${String(index % 60).padStart(2, "0")}.000Z`),
    });
  }
}

async function loadTranscriptRows(params: {
  agentId?: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<Array<Record<string, unknown>>> {
  const rows = await loadTranscriptEvents({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });
  return rows.map((row) =>
    row && typeof row === "object" && !Array.isArray(row) ? (row as Record<string, unknown>) : {},
  );
}

test("sessions.compaction.* lists checkpoints and branches or restores from compacted transcripts", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  const fixture = await createCheckpointFixture(dir, { legacyPreCompactionSnapshot: false });
  expect((await fs.readdir(dir)).some((file) => file.includes(".checkpoint."))).toBe(false);
  const checkpointEntryCount = fixture.session.getEntries().length;
  const checkpointCreatedAt = Date.now();
  const checkpointEntry = compactionCheckpointEntry(fixture, {
    checkpointId: "checkpoint-1",
    sessionKey: "agent:main:main",
    createdAt: checkpointCreatedAt,
    reason: "manual",
    summary: "checkpoint summary",
    tokensBefore: 123,
    tokensAfter: 45,
  });
  const { SessionManager } = await getSessionManagerModule();
  await seedSessionEntry({
    entry: sessionStoreEntry(fixture.sessionId, {
      sessionFile: fixture.sessionFile,
      compactionCheckpoints: [checkpointEntry],
    }),
    sessionKey: "agent:main:main",
    storePath,
  });
  await seedTranscriptRows({
    sessionId: fixture.sessionId,
    sessionKey: "agent:main:main",
    storePath,
    totalLines: 2,
  });
  fixture.session.appendMessage({
    role: "user",
    content: "future turn after checkpoint",
    timestamp: Date.now(),
  });

  const { ws } = await openClient();

  const listedSessions = await rpcReq<{
    sessions: Array<{
      key: string;
      compactionCheckpointCount?: number;
      latestCompactionCheckpoint?: {
        checkpointId: string;
        createdAt: number;
        reason: string;
        summary?: string;
        tokensBefore?: number;
        tokensAfter?: number;
      };
    }>;
  }>(ws, "sessions.list", {});
  expect(listedSessions.ok).toBe(true);
  const main = listedSessions.payload?.sessions.find(
    (session) => session.key === "agent:main:main",
  );
  expect(main?.compactionCheckpointCount).toBe(1);
  expect(main?.latestCompactionCheckpoint).toEqual({
    checkpointId: "checkpoint-1",
    createdAt: checkpointCreatedAt,
    reason: "manual",
  });

  const listedCheckpoints = await rpcReq<{
    ok: true;
    key: string;
    checkpoints: Array<{ checkpointId: string; summary?: string; tokensBefore?: number }>;
  }>(ws, "sessions.compaction.list", { key: "main" });
  expect(listedCheckpoints.ok).toBe(true);
  expect(listedCheckpoints.payload?.key).toBe("agent:main:main");
  expect(listedCheckpoints.payload?.checkpoints).toHaveLength(1);
  expect(listedCheckpoints.payload?.checkpoints[0]).toEqual(checkpointEntry);

  const checkpoint = await rpcReq<{
    ok: true;
    key: string;
    checkpoint: { checkpointId: string; preCompaction: { sessionFile?: string } };
  }>(ws, "sessions.compaction.get", {
    key: "main",
    checkpointId: "checkpoint-1",
  });
  expect(checkpoint.ok).toBe(true);
  expect(checkpoint.payload?.checkpoint.checkpointId).toBe("checkpoint-1");
  expect(checkpoint.payload?.checkpoint.preCompaction.sessionFile).toBeUndefined();

  const sessionManagerOpenSpy = vi.spyOn(SessionManager, "open");
  let branched: Awaited<
    ReturnType<
      typeof rpcReq<{
        ok: true;
        sourceKey: string;
        key: string;
        entry: {
          sessionId: string;
          sessionFile?: string;
          parentSessionKey?: string;
          totalTokens?: number;
          totalTokensFresh?: boolean;
        };
      }>
    >
  >;
  try {
    branched = await rpcReq<{
      ok: true;
      sourceKey: string;
      key: string;
      entry: {
        sessionId: string;
        sessionFile?: string;
        parentSessionKey?: string;
        totalTokens?: number;
        totalTokensFresh?: boolean;
      };
    }>(ws, "sessions.compaction.branch", {
      key: "main",
      checkpointId: "checkpoint-1",
    });
    expect(sessionManagerOpenSpy).not.toHaveBeenCalled();
  } finally {
    sessionManagerOpenSpy.mockRestore();
  }
  expect(branched.ok).toBe(true);
  expect(branched.payload?.sourceKey).toBe("agent:main:main");
  expect(branched.payload?.entry.parentSessionKey).toBe("agent:main:main");
  expect(branched.payload?.entry.totalTokens).toBe(45);
  expect(branched.payload?.entry.totalTokensFresh).toBe(true);
  const branchedSessionFile = branched.payload?.entry.sessionFile;
  if (!branchedSessionFile) {
    throw new Error("expected branched compaction session file");
  }
  const branchedSession = SessionManager.open(branchedSessionFile, dir);
  expect(branchedSession.getEntries()).toHaveLength(checkpointEntryCount);
  expect(
    branchedSession
      .buildSessionContext()
      .messages.some(
        (message) => (message as { content?: unknown }).content === "future turn after checkpoint",
      ),
  ).toBe(false);

  const branchedEntry = loadSessionEntry({
    sessionKey: branched.payload!.key,
    storePath,
  });
  expect(branchedEntry?.parentSessionKey).toBe("agent:main:main");
  expect(branchedEntry?.compactionCheckpoints).toBeUndefined();

  const restoreSessionManagerOpenSpy = vi.spyOn(SessionManager, "open");
  let restored: Awaited<
    ReturnType<
      typeof rpcReq<{
        ok: true;
        key: string;
        sessionId: string;
        entry: {
          sessionId: string;
          sessionFile?: string;
          compactionCheckpoints?: unknown[];
          totalTokens?: number;
          totalTokensFresh?: boolean;
        };
      }>
    >
  >;
  try {
    restored = await rpcReq<{
      ok: true;
      key: string;
      sessionId: string;
      entry: {
        sessionId: string;
        sessionFile?: string;
        compactionCheckpoints?: unknown[];
        totalTokens?: number;
        totalTokensFresh?: boolean;
      };
    }>(ws, "sessions.compaction.restore", {
      key: "main",
      checkpointId: "checkpoint-1",
    });
    expect(restoreSessionManagerOpenSpy).not.toHaveBeenCalled();
  } finally {
    restoreSessionManagerOpenSpy.mockRestore();
  }
  expect(restored.ok).toBe(true);
  expect(restored.payload?.key).toBe("agent:main:main");
  expect(restored.payload?.sessionId).not.toBe(fixture.sessionId);
  expect(restored.payload?.entry.compactionCheckpoints).toHaveLength(1);
  expect(restored.payload?.entry.totalTokens).toBe(45);
  expect(restored.payload?.entry.totalTokensFresh).toBe(true);
  const restoredSessionFile = restored.payload?.entry.sessionFile;
  if (!restoredSessionFile) {
    throw new Error("expected restored compaction session file");
  }
  const restoredSession = SessionManager.open(restoredSessionFile, dir);
  expect(restoredSession.getEntries()).toHaveLength(checkpointEntryCount);
  expect(
    restoredSession
      .buildSessionContext()
      .messages.some(
        (message) => (message as { content?: unknown }).content === "future turn after checkpoint",
      ),
  ).toBe(false);

  const restoredEntry = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
  expect(restoredEntry?.sessionId).toBe(restored.payload?.sessionId);
  expect(restoredEntry?.compactionCheckpoints).toHaveLength(1);

  ws.close();
});

test("sessions.compaction.branch rejects model-selection-locked session identities", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  const fixture = await createCheckpointFixture(dir, { legacyPreCompactionSnapshot: false });
  const checkpointEntry = compactionCheckpointEntry(fixture, {
    checkpointId: "checkpoint-locked-branch",
    sessionKey: "agent:main:main",
    createdAt: Date.now(),
    reason: "manual",
    summary: "locked checkpoint",
  });
  await seedSessionEntry({
    entry: sessionStoreEntry(fixture.sessionId, {
      sessionFile: fixture.sessionFile,
      compactionCheckpoints: [checkpointEntry],
      modelSelectionLocked: true,
    }),
    sessionKey: "agent:main:main",
    storePath,
  });
  const { ws } = await openClient();
  try {
    await expect(
      rpcReq(ws, "sessions.compaction.branch", {
        key: "main",
        checkpointId: "checkpoint-locked-branch",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "Checkpoint branch and restore are unavailable while model selection is locked.",
      },
    });
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      modelSelectionLocked: true,
      sessionId: fixture.sessionId,
    });
  } finally {
    ws.close();
  }
});

test("sessions.compaction list/get scopes selected global checkpoints to the requested agent", async () => {
  const { mainStorePath, storeTemplate, workStorePath } = await createSelectedGlobalSessionStore();
  const runtimeConfig = {
    agents: { list: [{ id: "main", default: true }, { id: "work" }] },
    session: { mainKey: "main", scope: "global", store: storeTemplate },
  };
  await fs.mkdir(path.dirname(mainStorePath), { recursive: true });
  await fs.mkdir(path.dirname(workStorePath), { recursive: true });
  const checkpointCreatedAt = Date.now();
  const checkpointEntry: SessionCompactionCheckpoint = {
    checkpointId: "checkpoint-work",
    sessionKey: "global",
    createdAt: checkpointCreatedAt,
    reason: "manual",
    summary: "work checkpoint",
    sessionId: "sess-work-global",
    firstKeptEntryId: "entry-work-kept",
    preCompaction: {
      sessionId: "sess-work-global",
      leafId: "entry-work-before",
    },
    postCompaction: {
      sessionId: "sess-work-global",
      leafId: "entry-work-kept",
      entryId: "entry-work-kept",
    },
  };
  await seedSessionEntry({
    agentId: "main",
    entry: sessionStoreEntry("sess-main-global"),
    sessionKey: "global",
    storePath: mainStorePath,
  });
  await seedSessionEntry({
    agentId: "work",
    entry: sessionStoreEntry("sess-work-global", {
      compactionCheckpoints: [checkpointEntry],
    }),
    sessionKey: "global",
    storePath: workStorePath,
  });

  const listed = await directSessionReq<{
    checkpoints: Array<{ checkpointId: string; summary?: string }>;
  }>(
    "sessions.compaction.list",
    { key: "global", agentId: "work" },
    {
      context: { getRuntimeConfig: () => runtimeConfig },
    },
  );
  expect(listed.ok).toBe(true);
  expect(listed.payload?.checkpoints).toHaveLength(1);
  expect(listed.payload?.checkpoints[0]).toMatchObject({
    checkpointId: "checkpoint-work",
    summary: "work checkpoint",
  });

  const got = await directSessionReq<{
    checkpoint?: { checkpointId?: string; summary?: string };
  }>(
    "sessions.compaction.get",
    { key: "global", agentId: "work", checkpointId: "checkpoint-work" },
    { context: { getRuntimeConfig: () => runtimeConfig } },
  );
  expect(got.ok).toBe(true);
  expect(got.payload?.checkpoint).toMatchObject({
    checkpointId: "checkpoint-work",
    summary: "work checkpoint",
  });
  expect(
    loadSessionEntry({ agentId: "main", sessionKey: "global", storePath: mainStorePath })
      ?.sessionId,
  ).toBe("sess-main-global");
  expect(
    loadSessionEntry({ agentId: "work", sessionKey: "global", storePath: workStorePath })
      ?.sessionId,
  ).toBe("sess-work-global");
  testState.sessionStorePath = undefined;
  testState.sessionConfig = undefined;
  testState.agentsConfig = undefined;
});

test("sessions.compact without maxLines runs embedded manual compaction for checkpoint-capable flows", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  const sessionScope = {
    agentId: "main",
    sessionId: "sess-main",
    sessionKey: "agent:main:main",
    storePath,
  };
  await upsertSessionEntry(sessionScope, {
    ...sessionStoreEntry("sess-main", {
      spawnedCwd: "/tmp/task-repo",
      thinkingLevel: "medium",
      reasoningLevel: "stream",
      contextBudgetStatus: {
        schemaVersion: 1,
        source: "pre-prompt-estimate",
        updatedAt: Date.now() - 5_000,
        provider: "anthropic",
        model: "claude-opus-4-6",
        route: "fits",
        shouldCompact: false,
        estimatedPromptTokens: 120,
        contextTokenBudget: 200,
        promptBudgetBeforeReserve: 180,
        reserveTokens: 20,
        effectiveReserveTokens: 20,
        remainingPromptBudgetTokens: 60,
        overflowTokens: 0,
        toolResultReducibleChars: 0,
        messageCount: 2,
        unwindowedMessageCount: 2,
      },
    }),
  });
  await appendTranscriptEvent(sessionScope, {
    type: "session",
    version: 3,
    id: "sess-main",
    timestamp: "2026-06-19T12:00:00.000Z",
    cwd: "/tmp",
  });
  const seedMessage = await appendTranscriptMessage(sessionScope, {
    message: { role: "user", content: "hello", timestamp: 1 },
    now: Date.parse("2026-06-19T12:00:01.000Z"),
  });
  await appendTranscriptMessage(sessionScope, {
    message: { role: "user", content: "follow-up", timestamp: 2 },
    now: Date.parse("2026-06-19T12:00:02.000Z"),
  });
  embeddedRunMock.compactEmbeddedAgentSession.mockImplementationOnce(async (params) => {
    const call = params as {
      sessionTarget?: {
        agentId?: string;
        sessionId?: string;
        sessionKey?: string;
        storePath?: string;
      };
    };
    if (
      !call.sessionTarget?.agentId ||
      !call.sessionTarget.sessionId ||
      !call.sessionTarget.sessionKey ||
      !call.sessionTarget.storePath
    ) {
      throw new Error("expected SQLite session target");
    }
    const targetScope = {
      agentId: call.sessionTarget.agentId,
      sessionId: call.sessionTarget.sessionId,
      sessionKey: call.sessionTarget.sessionKey,
      storePath: call.sessionTarget.storePath,
    };
    const rows = await loadTranscriptEvents(targetScope);
    expect(rows).toHaveLength(3);
    await appendTranscriptEvent(targetScope, {
      type: "compaction",
      id: "compact-1",
      parentId: seedMessage.messageId,
      timestamp: "2026-06-19T12:00:02.000Z",
      summary: "summary",
      firstKeptEntryId: seedMessage.messageId,
      tokensBefore: 120,
      tokensAfter: 80,
    });
    await patchAccessorSessionEntry(targetScope, (entry) => ({
      ...entry,
      compactionCheckpoints: [
        {
          checkpointId: "checkpoint-sqlite",
          sessionKey: targetScope.sessionKey,
          sessionId: targetScope.sessionId,
          createdAt: Date.now(),
          reason: "manual",
          summary: "summary",
          firstKeptEntryId: seedMessage.messageId,
          preCompaction: { sessionId: targetScope.sessionId },
          postCompaction: { sessionId: targetScope.sessionId, entryId: "compact-1" },
        },
      ],
    }));
    return {
      ok: true,
      compacted: true,
      result: {
        summary: "summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 120,
        tokensAfter: 80,
      },
    };
  });

  const { ws } = await openClient();
  await rpcReq(ws, "sessions.subscribe", {});
  const startEventPromise = onceMessage(ws, (message) => isCompactOperationEvent(message, "start"));
  const endEventPromise = onceMessage(ws, (message) => isCompactOperationEvent(message, "end"));
  const compacted = await rpcReq<{
    ok: true;
    key: string;
    compacted: boolean;
    result?: { tokensAfter?: number };
  }>(ws, "sessions.compact", {
    key: "main",
  });

  expectMainCompactionResult(compacted, true);
  const startEvent = await startEventPromise;
  const endEvent = await endEventPromise;
  const startPayload = startEvent.payload as {
    operationId?: string;
    sessionKey?: string;
    ts?: number;
  };
  const endPayload = endEvent.payload as {
    operationId?: string;
    sessionKey?: string;
    completed?: boolean;
    ts?: number;
  };
  expect(startPayload).toMatchObject({
    operation: "compact",
    phase: "start",
    sessionKey: "agent:main:main",
  });
  expect(endPayload).toMatchObject({
    operation: "compact",
    phase: "end",
    sessionKey: "agent:main:main",
    completed: true,
  });
  expect(startPayload.operationId).toBeTruthy();
  expect(endPayload.operationId).toBe(startPayload.operationId);
  expect(typeof startPayload.ts).toBe("number");
  expect(typeof endPayload.ts).toBe("number");
  expect(embeddedRunMock.compactEmbeddedAgentSession).toHaveBeenCalledTimes(1);
  const compactionCall = embeddedRunMock.compactEmbeddedAgentSession.mock.calls.at(0)?.[0] as
    | {
        agentHarnessId?: string;
        allowGatewaySubagentBinding?: boolean;
        bashElevated?: unknown;
        config?: unknown;
        model?: string;
        provider?: string;
        reasoningLevel?: string;
        sessionFile?: string;
        sessionId?: string;
        sessionKey?: string;
        sessionTarget?: {
          agentId?: string;
          sessionId?: string;
          sessionKey?: string;
          storePath?: string;
        };
        thinkLevel?: string;
        trigger?: string;
        workspaceDir?: string;
        cwd?: string;
      }
    | undefined;
  if (!compactionCall) {
    throw new Error("expected embedded compaction call");
  }
  const callConfig = compactionCall.config as {
    agents?: { defaults?: { model?: { primary?: unknown }; workspace?: unknown } };
  };
  expect(compactionCall.sessionId).toBe("sess-main");
  expect(compactionCall.sessionKey).toBe("agent:main:main");
  if (!compactionCall.sessionFile) {
    throw new Error("expected embedded compaction session file");
  }
  expect(compactionCall.sessionFile).toContain(`sqlite:main:sess-main:${storePath}`);
  expect(compactionCall.sessionTarget).toEqual({
    agentId: "main",
    sessionId: "sess-main",
    sessionKey: "agent:main:main",
    storePath,
  });
  expect(compactionCall.workspaceDir).toBe("/tmp/task-repo");
  expect(compactionCall.cwd).toBe("/tmp/task-repo");
  expect(callConfig.agents?.defaults?.model?.primary).toBe("anthropic/claude-opus-4-6");
  expect(callConfig.agents?.defaults?.workspace).toBe(
    path.join(os.tmpdir(), "openclaw-gateway-test"),
  );
  expect(compactionCall.provider).toBe("anthropic");
  expect(compactionCall.model).toBe("claude-opus-4-6");
  expect(compactionCall.allowGatewaySubagentBinding).toBe(true);
  expect(compactionCall.agentHarnessId).toBeUndefined();
  expect(compactionCall.thinkLevel).toBe("medium");
  expect(compactionCall.reasoningLevel).toBe("stream");
  expect(compactionCall.bashElevated).toEqual({
    enabled: false,
    allowed: false,
    defaultLevel: "off",
  });
  expect(compactionCall.trigger).toBe("manual");

  const sqliteRows = await loadTranscriptEvents(sessionScope);
  expect(sqliteRows).toHaveLength(4);
  expect(sqliteRows.at(-1)).toMatchObject({
    type: "compaction",
    summary: "summary",
  });
  await expect(fs.readdir(dir)).resolves.not.toContain("sess-main.jsonl");
  const storedEntry = loadAccessorSessionEntry(sessionScope) as
    | {
        compactionCheckpoints?: unknown[];
        compactionCount?: number;
        contextBudgetStatus?: unknown;
        totalTokens?: number;
        totalTokensFresh?: boolean;
      }
    | undefined;
  expect(storedEntry?.compactionCount).toBe(1);
  expect(storedEntry?.compactionCheckpoints).toHaveLength(1);
  expect(storedEntry?.contextBudgetStatus).toBeUndefined();
  expect(storedEntry?.totalTokens).toBe(80);
  expect(storedEntry?.totalTokensFresh).toBe(true);

  ws.close();
});

test("sessions.compact uses the freshest persisted key when main-key aliases exist", async () => {
  const { storePath } = await createSessionStoreDir();
  const runtimeConfig = {
    agents: { list: [{ id: "main", default: true }] },
    session: { mainKey: "primary", store: storePath },
  };
  await seedSessionEntry({
    entry: sessionStoreEntry("sess-stale-canonical", { updatedAt: Date.now() - 10_000 }),
    sessionKey: "agent:main:primary",
    storePath,
  });
  await seedSessionEntry({
    entry: sessionStoreEntry("sess-alias", {
      updatedAt: Date.now(),
      totalTokens: 2_000,
      totalTokensFresh: true,
    }),
    sessionKey: "agent:main:main",
    storePath,
  });
  await seedTranscriptRows({
    sessionId: "sess-alias",
    sessionKey: "agent:main:main",
    storePath,
    totalLines: 3,
  });
  embeddedRunMock.compactEmbeddedAgentSession.mockImplementationOnce(async (params) => {
    const call = params as {
      sessionTarget?: {
        agentId?: string;
        sessionId?: string;
        sessionKey?: string;
        storePath?: string;
      };
    };
    expect(call.sessionTarget).toMatchObject({
      agentId: "main",
      sessionId: "sess-alias",
      sessionKey: "agent:main:primary",
      storePath,
    });
    await patchAccessorSessionEntry(
      {
        agentId: "main",
        sessionKey: "agent:main:primary",
        storePath,
      },
      (entry) => ({
        ...entry,
        compactionCheckpoints: [
          {
            checkpointId: "checkpoint-alias",
            sessionKey: "agent:main:primary",
            sessionId: "sess-alias",
            createdAt: Date.now(),
            reason: "manual",
            summary: "alias checkpoint",
            preCompaction: { sessionId: "sess-alias" },
            postCompaction: { sessionId: "sess-alias", entryId: "entry-alias" },
          },
        ],
      }),
    );
    return {
      ok: true,
      compacted: true,
      result: {
        summary: "alias summary",
        firstKeptEntryId: "entry-alias",
        tokensBefore: 2_000,
        tokensAfter: 1_000,
      },
    };
  });

  const compacted = await directSessionReq<{
    compacted?: boolean;
    key?: string;
    ok?: boolean;
  }>("sessions.compact", { key: "main" }, { context: { getRuntimeConfig: () => runtimeConfig } });

  expect(compacted.ok).toBe(true);
  expect(compacted.payload?.key).toBe("agent:main:primary");
  expect(compacted.payload?.compacted).toBe(true);
  const aliasEntry = loadSessionEntry({
    sessionKey: "agent:main:primary",
    storePath,
  });
  expect(aliasEntry?.sessionId).toBe("sess-alias");
  expect(aliasEntry?.compactionCount).toBe(1);
  expect(aliasEntry?.compactionCheckpoints).toHaveLength(1);
});

test("sessions.compact records terminal Codex native compaction", async () => {
  const { storePath } = await createSessionStoreDir();
  await seedSessionEntry({
    entry: sessionStoreEntry("sess-codex", {
      agentHarnessId: "codex",
      compactionCount: 2,
      totalTokens: 54_321,
      totalTokensFresh: true,
    }),
    sessionKey: "agent:main:main",
    storePath,
  });
  await seedTranscriptRows({
    sessionId: "sess-codex",
    sessionKey: "agent:main:main",
    storePath,
    totalLines: 2,
  });
  embeddedRunMock.compactEmbeddedAgentSession.mockResolvedValueOnce({
    ok: true,
    compacted: true,
    result: {
      summary: "",
      firstKeptEntryId: "",
      tokensBefore: 54_321,
      details: {
        backend: "codex-app-server",
        threadId: "thread-1",
        signal: "thread/compact/start",
        pending: false,
        completed: true,
      },
    },
  });

  const { ws } = await openClient();
  await rpcReq(ws, "sessions.subscribe", {});
  const endEventPromise = onceMessage(ws, (message) => isCompactOperationEvent(message, "end"));

  const compacted = await rpcReq<{
    ok: true;
    key: string;
    compacted: boolean;
    result?: { details?: unknown };
  }>(ws, "sessions.compact", {
    key: "main",
  });

  expectMainCompactionResult(compacted, true);
  expect(compacted.payload?.result?.details).toMatchObject({
    backend: "codex-app-server",
    threadId: "thread-1",
    signal: "thread/compact/start",
    pending: false,
    completed: true,
  });
  const endEvent = await endEventPromise;
  expect(endEvent.payload).toMatchObject({
    operation: "compact",
    phase: "end",
    sessionKey: "agent:main:main",
    completed: true,
  });

  // Terminal Codex native compaction persists via the accessor: the count
  // advances and stale token accounting is cleared for recomputation.
  const codexEntry = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
  expect(codexEntry?.compactionCount).toBe(3);
  expect(codexEntry?.totalTokens).toBeUndefined();
  expect(codexEntry?.totalTokensFresh).toBeUndefined();

  ws.close();
});

test("sessions.compact emits a terminal operation event when persistence fails", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionId = "sess-compact-write-failure";
  await seedSessionEntry({
    entry: sessionStoreEntry(sessionId),
    sessionKey: "agent:main:main",
    storePath,
  });
  await seedTranscriptRows({
    sessionId,
    sessionKey: "agent:main:main",
    storePath,
    totalLines: 3,
  });
  const compaction = createDeferred<{
    ok: true;
    compacted: true;
    result: {
      summary: string;
      firstKeptEntryId: string;
      tokensBefore: number;
      tokensAfter: number;
    };
  }>();
  embeddedRunMock.compactEmbeddedAgentSession.mockReturnValueOnce(compaction.promise);

  const { ws } = await openClient();
  await rpcReq(ws, "sessions.subscribe", {});
  const startEventPromise = onceMessage(ws, (message) => isCompactOperationEvent(message, "start"));
  const endEventPromise = onceMessage(ws, (message) => isCompactOperationEvent(message, "end"));
  const compactResult = rpcReq(ws, "sessions.compact", { key: "main" });
  await startEventPromise;
  const terminalResult = {
    ok: true as const,
    compacted: true as const,
    result: {
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 120,
      tokensAfter: 80,
    },
  };
  Object.defineProperty(terminalResult.result, "tokensAfter", {
    get: () => {
      throw new Error("forced persistence projection failure");
    },
  });
  compaction.resolve(terminalResult);

  const response = await compactResult;
  expect(response.ok).toBe(false);
  expect(response.error?.code).toBe("UNAVAILABLE");
  expect((await endEventPromise).payload).toMatchObject({
    operation: "compact",
    phase: "end",
    sessionKey: "agent:main:main",
    completed: false,
  });
  ws.close();
});

test("sessions.compact rejects stale terminal persistence after the session changes", async () => {
  const { storePath } = await createSessionStoreDir();
  await seedSessionEntry({
    entry: sessionStoreEntry("sess-compact-old"),
    sessionKey: "agent:main:main",
    storePath,
  });
  await seedTranscriptRows({
    sessionId: "sess-compact-old",
    sessionKey: "agent:main:main",
    storePath,
    totalLines: 3,
  });
  const compaction = createDeferred<{
    ok: true;
    compacted: true;
    result: {
      summary: string;
      firstKeptEntryId: string;
      tokensBefore: number;
      tokensAfter: number;
      sessionId: string;
    };
  }>();
  embeddedRunMock.compactEmbeddedAgentSession.mockReturnValueOnce(compaction.promise);

  const { ws } = await openClient();
  const compactResult = rpcReq(ws, "sessions.compact", { key: "main" });
  await vi.waitFor(() => {
    expect(embeddedRunMock.compactEmbeddedAgentSession).toHaveBeenCalledTimes(1);
  });
  await seedSessionEntry({
    entry: sessionStoreEntry("sess-replacement"),
    sessionKey: "agent:main:main",
    storePath,
  });
  compaction.resolve({
    ok: true,
    compacted: true,
    result: {
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 120,
      tokensAfter: 80,
      sessionId: "sess-compacted-successor",
    },
  });

  const response = await compactResult;
  expect(response.ok).toBe(false);
  expect(response.error).toMatchObject({
    details: { reason: "session-changed" },
  });
  const replacedEntry = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
  expect(replacedEntry?.sessionId).toBe("sess-replacement");
  expect(replacedEntry?.compactionCount).toBeUndefined();
  ws.close();
});

test("sessions.reset waits for terminal compaction before replacing the session", async () => {
  const { storePath } = await createSessionStoreDir();
  await seedSessionEntry({
    entry: sessionStoreEntry("sess-compact-reset"),
    sessionKey: "agent:main:main",
    storePath,
  });
  await seedTranscriptRows({
    sessionId: "sess-compact-reset",
    sessionKey: "agent:main:main",
    storePath,
    totalLines: 3,
  });
  const compaction = createDeferred<{
    ok: true;
    compacted: true;
    result: {
      summary: string;
      firstKeptEntryId: string;
      tokensBefore: number;
      tokensAfter: number;
    };
  }>();
  embeddedRunMock.compactEmbeddedAgentSession.mockReturnValueOnce(compaction.promise);

  const { ws } = await openClient();
  const compactResult = rpcReq(ws, "sessions.compact", { key: "main" });
  await vi.waitFor(() => {
    expect(embeddedRunMock.compactEmbeddedAgentSession).toHaveBeenCalledTimes(1);
  });
  let resetSettled = false;
  const resetResult = rpcReq<{ entry: { sessionId: string } }>(ws, "sessions.reset", {
    key: "main",
  }).finally(() => {
    resetSettled = true;
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  expect(resetSettled).toBe(false);

  compaction.resolve({
    ok: true,
    compacted: true,
    result: {
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 120,
      tokensAfter: 80,
    },
  });
  expect((await compactResult).ok).toBe(true);
  const reset = await resetResult;
  expect(reset.ok).toBe(true);
  const resetSessionId = reset.payload?.entry.sessionId;
  expect(resetSessionId).toBeTruthy();
  expect(resetSessionId).toBe("sess-compact-reset");
  const resetEntry = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
  expect(resetEntry?.sessionId).toBe(resetSessionId);
  ws.close();
});

test("sessions.compaction.restore waits for terminal compaction before replacing the session", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  const fixture = await createCheckpointFixture(dir, { legacyPreCompactionSnapshot: false });
  const checkpointEntry = compactionCheckpointEntry(fixture, {
    checkpointId: "checkpoint-race",
    sessionKey: "agent:main:main",
    createdAt: Date.now(),
    reason: "manual",
    summary: "checkpoint summary",
    tokensBefore: 123,
    tokensAfter: 45,
  });
  await seedSessionEntry({
    entry: sessionStoreEntry(fixture.sessionId, {
      sessionFile: fixture.sessionFile,
      compactionCheckpoints: [checkpointEntry],
    }),
    sessionKey: "agent:main:main",
    storePath,
  });
  await seedTranscriptRows({
    sessionId: fixture.sessionId,
    sessionKey: "agent:main:main",
    storePath,
    totalLines: 3,
  });
  const compaction = createDeferred<{
    ok: true;
    compacted: true;
    result: {
      summary: string;
      firstKeptEntryId: string;
      tokensBefore: number;
      tokensAfter: number;
    };
  }>();
  embeddedRunMock.compactEmbeddedAgentSession.mockReturnValueOnce(compaction.promise);

  const { ws } = await openClient();
  const compactResult = rpcReq(ws, "sessions.compact", { key: "main" });
  await vi.waitFor(() => {
    expect(embeddedRunMock.compactEmbeddedAgentSession).toHaveBeenCalledTimes(1);
  });
  let restoreSettled = false;
  const restoreResult = rpcReq<{ sessionId: string }>(ws, "sessions.compaction.restore", {
    key: "main",
    checkpointId: "checkpoint-race",
  }).finally(() => {
    restoreSettled = true;
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  expect(restoreSettled).toBe(false);

  compaction.resolve({
    ok: true,
    compacted: true,
    result: {
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 123,
      tokensAfter: 45,
    },
  });
  expect((await compactResult).ok).toBe(true);
  const restored = await restoreResult;
  expect(restored.ok).toBe(true);
  expect(restored.payload?.sessionId).toBeTruthy();
  expect(restored.payload?.sessionId).not.toBe(fixture.sessionId);
  ws.close();
});

test("sessions.compaction.restore leaves replacement-session work untouched when queued state is stale", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  const fixture = await createCheckpointFixture(dir, { legacyPreCompactionSnapshot: false });
  const checkpointEntry = compactionCheckpointEntry(fixture, {
    checkpointId: "checkpoint-stale-restore",
    sessionKey: "agent:main:main",
    createdAt: Date.now(),
    reason: "manual",
    summary: "checkpoint summary",
  });
  await seedSessionEntry({
    entry: sessionStoreEntry(fixture.sessionId, {
      sessionFile: fixture.sessionFile,
      compactionCheckpoints: [checkpointEntry],
    }),
    sessionKey: "agent:main:main",
    storePath,
  });
  const replacementSessionId = "sess-replacement-after-restore-queued";
  let replacementInterrupted = false;
  const replacementAdmission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: ["agent:main:main", replacementSessionId],
    assertAllowed: () => {},
    onInterrupt: () => {
      replacementInterrupted = true;
    },
  });
  const blockerStarted = createDeferred<void>();
  const releaseBlocker = createDeferred<void>();
  const blocker = runExclusiveSessionLifecycleMutation({
    scope: storePath,
    identities: ["main", "agent:main:main", fixture.sessionId],
    run: async () => {
      blockerStarted.resolve();
      await releaseBlocker.promise;
    },
  });
  await blockerStarted.promise;

  const { ws } = await openClient();
  const restore = rpcReq(ws, "sessions.compaction.restore", {
    key: "main",
    checkpointId: "checkpoint-stale-restore",
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  await replaceSessionEntry(
    { sessionKey: "agent:main:main", storePath },
    sessionStoreEntry(replacementSessionId),
  );

  try {
    releaseBlocker.resolve();
    await blocker;
    const response = await restore;
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("INVALID_REQUEST");
    expect(response.error?.message).toMatch(
      /checkpoint not found|changed before checkpoint restore/,
    );
    expect(replacementInterrupted).toBe(false);
  } finally {
    releaseBlocker.resolve();
    replacementAdmission.release();
    await blocker;
    ws.close();
  }
});

test("sessions.compact blocks new work admission through terminal persistence", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionId = "sess-compact-admission";
  await seedSessionEntry({
    entry: sessionStoreEntry(sessionId),
    sessionKey: "agent:main:main",
    storePath,
  });
  await seedTranscriptRows({
    sessionId,
    sessionKey: "agent:main:main",
    storePath,
    totalLines: 3,
  });
  const compaction = createDeferred<{
    ok: true;
    compacted: true;
    result: {
      summary: string;
      firstKeptEntryId: string;
      tokensBefore: number;
      tokensAfter: number;
    };
  }>();
  embeddedRunMock.compactEmbeddedAgentSession.mockReturnValueOnce(compaction.promise);

  const { ws } = await openClient();
  const compactResult = rpcReq(ws, "sessions.compact", { key: "main" });
  await vi.waitFor(() => {
    expect(embeddedRunMock.compactEmbeddedAgentSession).toHaveBeenCalledTimes(1);
  });

  let admitted = false;
  const pendingAdmission = beginSessionWorkAdmission({
    scope: storePath,
    identities: ["agent:main:main", sessionId],
    assertAllowed: () => {},
  }).then((lease) => {
    admitted = true;
    return lease;
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  expect(admitted).toBe(false);

  compaction.resolve({
    ok: true,
    compacted: true,
    result: {
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 120,
      tokensAfter: 80,
    },
  });
  expect((await compactResult).ok).toBe(true);
  const admission = await pendingAdmission;
  try {
    expect(admitted).toBe(true);
  } finally {
    admission.release();
  }
  ws.close();
});

test("sessions.compact returns a no-op without interrupting an active admission", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionId = "sess-compact-noop-active";
  await seedSessionEntry({
    entry: sessionStoreEntry(sessionId),
    sessionKey: "agent:main:main",
    storePath,
  });
  await seedTranscriptRows({
    sessionId,
    sessionKey: "agent:main:main",
    storePath,
    totalLines: 2,
  });

  let interrupted = false;
  const admission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: ["main", "agent:main:main", sessionId],
    assertAllowed: () => {},
    onInterrupt: () => {
      interrupted = true;
    },
  });

  const { ws } = await openClient();
  try {
    const compacted = await rpcReq<{
      ok: boolean;
      compacted: boolean;
      reason?: string;
    }>(ws, "sessions.compact", { key: "main" });

    expect(compacted.ok).toBe(true);
    expect(compacted.payload).toMatchObject({
      ok: false,
      compacted: false,
      reason: "Nothing to compact (session too small)",
    });
    expect(interrupted).toBe(false);
    expect(isSessionWorkAdmissionActive(storePath, [sessionId])).toBe(true);
    expect(embeddedRunMock.compactEmbeddedAgentSession).not.toHaveBeenCalled();
    expectNoSessionQueueCleanup();
  } finally {
    admission.release();
    ws.close();
  }
});

test("sessions.compact refuses real compaction without interrupting an active admission", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionId = "sess-compact-queued-work";
  await seedSessionEntry({
    entry: sessionStoreEntry(sessionId),
    sessionKey: "agent:main:main",
    storePath,
  });
  await seedTranscriptRows({
    sessionId,
    sessionKey: "agent:main:main",
    storePath,
    totalLines: 3,
  });
  embeddedRunMock.compactEmbeddedAgentSession.mockResolvedValueOnce({
    ok: true,
    compacted: true,
    result: {
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 120,
      tokensAfter: 80,
    },
  });

  let interrupted = false;
  const admission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: ["main", "agent:main:main", sessionId],
    assertAllowed: () => {},
    onInterrupt: () => {
      interrupted = true;
    },
  });

  const { ws } = await openClient();
  try {
    const compacted = await rpcReq(ws, "sessions.compact", { key: "main" });

    expect(compacted.ok).toBe(false);
    expect(compacted.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("has an active run"),
    });
    expect(interrupted).toBe(false);
    expect(isSessionWorkAdmissionActive(storePath, [sessionId])).toBe(true);
    expect(embeddedRunMock.compactEmbeddedAgentSession).not.toHaveBeenCalled();
    expectNoSessionQueueCleanup();
  } finally {
    admission.release();
    ws.close();
  }
});

test("sessions.compact refuses real compaction while a worker inference owns the session", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionId = "sess-compact-worker-inference";
  await seedSessionEntry({
    entry: sessionStoreEntry(sessionId),
    sessionKey: "agent:main:main",
    storePath,
  });
  await seedTranscriptRows({
    sessionId,
    sessionKey: "agent:main:main",
    storePath,
    totalLines: 3,
  });
  const hasInferenceForSession = vi.fn(
    (candidateSessionId: string) => candidateSessionId === sessionId,
  );
  const runtimeConfig = {
    agents: { list: [{ id: "main", default: true }] },
    session: { store: storePath },
  };

  const compacted = await directSessionReq(
    "sessions.compact",
    { key: "main" },
    {
      context: {
        getRuntimeConfig: () => runtimeConfig,
        workerEnvironmentService: { hasInferenceForSession },
      },
    },
  );

  expect(compacted.ok, JSON.stringify(compacted)).toBe(false);
  expect(compacted.error).toMatchObject({
    code: "INVALID_REQUEST",
    message: expect.stringContaining("has an active run"),
  });
  expect(hasInferenceForSession).toHaveBeenCalledWith(sessionId);
  expect(embeddedRunMock.compactEmbeddedAgentSession).not.toHaveBeenCalled();
  expectNoSessionQueueCleanup();
});

test("sessions.patch rejects archive while terminal compaction owns the session", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:dashboard:compact-race";
  await seedSessionEntry({
    entry: sessionStoreEntry("sess-compact-archive"),
    sessionKey,
    storePath,
  });
  await seedTranscriptRows({
    sessionId: "sess-compact-archive",
    sessionKey,
    storePath,
    totalLines: 3,
  });
  const compaction = createDeferred<{
    ok: true;
    compacted: true;
    result: {
      summary: string;
      firstKeptEntryId: string;
      tokensBefore: number;
      tokensAfter: number;
    };
  }>();
  embeddedRunMock.compactEmbeddedAgentSession.mockReturnValueOnce(compaction.promise);

  const { ws } = await openClient();
  const compactResult = rpcReq(ws, "sessions.compact", { key: sessionKey });
  await vi.waitFor(() => {
    expect(embeddedRunMock.compactEmbeddedAgentSession).toHaveBeenCalledTimes(1);
  });
  const archived = await rpcReq(ws, "sessions.patch", { key: sessionKey, archived: true });
  expect(archived.ok).toBe(false);
  expect(archived.error?.message).toContain("active run");

  compaction.resolve({
    ok: true,
    compacted: true,
    result: {
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 120,
      tokensAfter: 80,
    },
  });
  expect((await compactResult).ok).toBe(true);
  ws.close();
});

test("sessions.compact maxLines trims SQLite transcript rows and archives the full pre-compaction transcript", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  await seedSessionEntry({
    entry: sessionStoreEntry("sess-main"),
    sessionKey: "agent:main:main",
    storePath,
  });
  await seedTranscriptRows({
    sessionId: "sess-main",
    sessionKey: "agent:main:main",
    storePath,
    totalLines: 500,
  });
  const original = await loadTranscriptRows({
    sessionId: "sess-main",
    sessionKey: "agent:main:main",
    storePath,
  });
  expect(original).toHaveLength(500);

  const { ws } = await openClient();
  const compacted = await rpcReq<{
    ok: true;
    key: string;
    compacted: boolean;
    kept?: number;
    archived?: string;
  }>(ws, "sessions.compact", { key: "main", maxLines: 50 });

  expect(compacted.ok).toBe(true);
  expect(compacted.payload?.compacted).toBe(true);
  expect(compacted.payload?.kept).toBe(50);

  const retained = await loadTranscriptRows({
    sessionId: "sess-main",
    sessionKey: "agent:main:main",
    storePath,
  });
  expect(retained).toHaveLength(50);
  expect(retained[0]).toMatchObject({ type: "session", id: "sess-main" });
  expect(retained[1]).toMatchObject({
    parentId: null,
    message: { content: "line-450" },
  });
  expect(retained.at(-1)).toMatchObject({
    message: { content: "line-498" },
  });
  const archived = compacted.payload?.archived ?? "";
  expect(path.basename(archived)).toMatch(/^sess-main\.jsonl\.bak\.\d{4}-\d{2}-\d{2}T/);
  expect(await fs.realpath(path.dirname(archived))).toBe(await fs.realpath(dir));
  await expect(fs.stat(archived)).resolves.toMatchObject({ mode: expect.any(Number) });
  const archivedEvents = readSessionArchiveContentSync(archived)
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(archivedEvents).toEqual(original);
  await expect(fs.readdir(dir)).resolves.not.toContain("sess-main.jsonl");

  // No active run present, so the interrupt guard short-circuits without aborting.
  expect(embeddedRunMock.abortCalls).toEqual([]);
  expect(embeddedRunMock.waitCalls).toEqual([]);

  ws.close();
});

test("sessions.compact maxLines refuses an active run without trimming rows", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  await seedSessionEntry({
    entry: sessionStoreEntry("sess-main"),
    sessionKey: "agent:main:main",
    storePath,
  });
  await seedTranscriptRows({
    sessionId: "sess-main",
    sessionKey: "agent:main:main",
    storePath,
    totalLines: 500,
  });

  const { ws } = await openClient();
  // Simulate an embedded agent run actively appending to this session transcript.
  embeddedRunMock.activeIds.add("sess-main");

  const compacted = await rpcReq(ws, "sessions.compact", { key: "main", maxLines: 50 });

  expect(compacted.ok).toBe(false);
  expect(compacted.error?.message).toContain("has an active run");
  expect(embeddedRunMock.abortCalls).toEqual([]);
  expect(embeddedRunMock.waitCalls).toEqual([]);
  await expect(
    loadTranscriptRows({
      sessionId: "sess-main",
      sessionKey: "agent:main:main",
      storePath,
    }),
  ).resolves.toHaveLength(500);
  expect((await fs.readdir(dir)).some((name) => name.includes(".bak"))).toBe(false);

  ws.close();
});

test("sessions.compact maxLines does not interrupt an active run when row trimming is a no-op", async () => {
  const { storePath } = await createSessionStoreDir();
  await seedSessionEntry({
    entry: sessionStoreEntry("sess-main"),
    sessionKey: "agent:main:main",
    storePath,
  });
  await seedTranscriptRows({
    sessionId: "sess-main",
    sessionKey: "agent:main:main",
    storePath,
    totalLines: 10,
  });

  const { ws } = await openClient();
  embeddedRunMock.activeIds.add("sess-main");
  embeddedRunMock.waitResults.set("sess-main", true);

  const compacted = await rpcReq<{
    ok: true;
    compacted: boolean;
    kept?: number;
  }>(ws, "sessions.compact", { key: "main", maxLines: 50 });

  expect(compacted.ok).toBe(true);
  expect(compacted.payload?.compacted).toBe(false);
  expect(compacted.payload?.kept).toBe(10);
  expect(embeddedRunMock.abortCalls).toEqual([]);
  expect(embeddedRunMock.waitCalls).toEqual([]);

  ws.close();
});

test("sessions.compact maxLines does not interrupt an active run when no transcript exists", async () => {
  const { storePath } = await createSessionStoreDir();
  await seedSessionEntry({
    entry: sessionStoreEntry("sess-main"),
    sessionKey: "agent:main:main",
    storePath,
  });

  const { ws } = await openClient();
  embeddedRunMock.activeIds.add("sess-main");
  embeddedRunMock.waitResults.set("sess-main", true);

  const compacted = await rpcReq<{
    ok: true;
    compacted: boolean;
    reason?: string;
  }>(ws, "sessions.compact", { key: "main", maxLines: 50 });

  expect(compacted.ok).toBe(true);
  expect(compacted.payload?.compacted).toBe(false);
  expect(compacted.payload?.reason).toBe("no transcript");
  expect(embeddedRunMock.abortCalls).toEqual([]);
  expect(embeddedRunMock.waitCalls).toEqual([]);

  ws.close();
});

test("sessions.patch preserves nested model ids under provider overrides", async () => {
  await withTempDir({ prefix: "openclaw-gw-sessions-nested-" }, async (dir) => {
    const storePath = path.join(dir, "sessions.json");
    const runtimeConfig = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-test-a" },
        },
        list: [{ id: "main", default: true, workspace: dir }],
      },
      session: { mainKey: "main", store: storePath },
    };
    await seedSessionEntry({
      entry: sessionStoreEntry("sess-main"),
      sessionKey: "agent:main:main",
      storePath,
    });

    agentDiscoveryMock.enabled = true;
    agentDiscoveryMock.models = [
      { id: "moonshotai/kimi-k2.5", name: "Kimi K2.5 (NVIDIA)", provider: "nvidia" },
    ];

    const context = { getRuntimeConfig: () => runtimeConfig };
    const patched = await directSessionReq<{
      entry: {
        modelOverride?: string;
        providerOverride?: string;
        model?: string;
        modelProvider?: string;
      };
      resolved?: { model?: string; modelProvider?: string };
    }>(
      "sessions.patch",
      {
        key: "agent:main:main",
        model: "nvidia/moonshotai/kimi-k2.5",
      },
      { context },
    );
    expect(patched.ok).toBe(true);
    expect(patched.payload?.entry.modelOverride).toBe("moonshotai/kimi-k2.5");
    expect(patched.payload?.entry.providerOverride).toBe("nvidia");
    expect(patched.payload?.entry.model).toBeUndefined();
    expect(patched.payload?.entry.modelProvider).toBeUndefined();
    expect(patched.payload?.resolved?.modelProvider).toBe("nvidia");
    expect(patched.payload?.resolved?.model).toBe("moonshotai/kimi-k2.5");

    const listed = await directSessionReq<{
      sessions: Array<{ key: string; modelProvider?: string; model?: string }>;
    }>("sessions.list", {}, { context });
    expect(listed.ok).toBe(true);
    const mainSession = listed.payload?.sessions.find(
      (session) => session.key === "agent:main:main",
    );
    expect(mainSession?.modelProvider).toBe("nvidia");
    expect(mainSession?.model).toBe("moonshotai/kimi-k2.5");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
