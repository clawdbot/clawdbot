/**
 * Gateway session compaction RPC tests.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import {
  stagePostCompactionDelegate,
  stagedPostCompactionDelegateCount,
} from "../auto-reply/continuation-delegate-store.js";
import type { SessionCompactionCheckpoint } from "../config/sessions.js";
import { loadPendingSessionDeliveries } from "../infra/session-delivery-queue-storage.js";
import { peekSystemEvents } from "../infra/system-events.js";
import {
  beginSessionWorkAdmission,
  runExclusiveSessionLifecycleMutation,
} from "../sessions/session-lifecycle-admission.js";
import { resetTaskFlowRegistryForTests } from "../tasks/task-flow-registry.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  embeddedRunMock,
  onceMessage,
  agentDiscoveryMock,
  rpcReq,
  startConnectedServerWithClient,
  testState,
  writeSessionStore,
} from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  createDeferred,
  getSessionManagerModule,
  getGatewayConfigModule,
  sessionStoreEntry,
  createCheckpointFixture,
  directSessionReq,
  expectSessionQueueCleanup,
} from "./test/server-sessions.test-helpers.js";

const sessionLifecycleMutationObserver = vi.hoisted(() => ({
  onEnter: undefined as
    | ((params: { prepare?: () => Promise<void>; scope: string }) => void)
    | undefined,
}));

vi.mock("../sessions/session-lifecycle-admission.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../sessions/session-lifecycle-admission.js")>();
  return {
    ...actual,
    runExclusiveSessionLifecycleMutation: async (
      params: Parameters<typeof actual.runExclusiveSessionLifecycleMutation>[0],
    ) => {
      sessionLifecycleMutationObserver.onEnter?.(params);
      return await actual.runExclusiveSessionLifecycleMutation(params);
    },
  };
});

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
  expect(compacted.ok).toBe(true);
  expect(compacted.payload?.key).toBe("agent:main:main");
  expect(compacted.payload?.compacted).toBe(expectedCompacted);
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
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry(fixture.sessionId, {
        sessionFile: fixture.sessionFile,
        compactionCheckpoints: [checkpointEntry],
      }),
    },
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
  const sessionManagerForkFromSpy = vi.spyOn(SessionManager, "forkFrom");
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
    expect(sessionManagerForkFromSpy).not.toHaveBeenCalled();
  } finally {
    sessionManagerOpenSpy.mockRestore();
    sessionManagerForkFromSpy.mockRestore();
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

  const storeAfterBranch = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
    string,
    {
      parentSessionKey?: string;
      compactionCheckpoints?: unknown[];
      sessionId?: string;
    }
  >;
  const branchedEntry = storeAfterBranch[branched.payload!.key];
  expect(branchedEntry?.parentSessionKey).toBe("agent:main:main");
  expect(branchedEntry?.compactionCheckpoints).toBeUndefined();

  const restoreSessionManagerOpenSpy = vi.spyOn(SessionManager, "open");
  const restoreSessionManagerForkFromSpy = vi.spyOn(SessionManager, "forkFrom");
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
    expect(restoreSessionManagerForkFromSpy).not.toHaveBeenCalled();
  } finally {
    restoreSessionManagerOpenSpy.mockRestore();
    restoreSessionManagerForkFromSpy.mockRestore();
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

  const storeAfterRestore = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
    string,
    { compactionCheckpoints?: unknown[]; sessionId?: string }
  >;
  expect(storeAfterRestore["agent:main:main"]?.sessionId).toBe(restored.payload?.sessionId);
  expect(storeAfterRestore["agent:main:main"]?.compactionCheckpoints).toHaveLength(1);

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
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry(fixture.sessionId, {
        sessionFile: fixture.sessionFile,
        compactionCheckpoints: [checkpointEntry],
        modelSelectionLocked: true,
      }),
    },
  });
  const filesBefore = (await fs.readdir(dir)).toSorted();
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
    const nextStore = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      { modelSelectionLocked?: boolean; sessionId?: string }
    >;
    expect(nextStore).toEqual({
      "agent:main:main": expect.objectContaining({
        modelSelectionLocked: true,
        sessionId: fixture.sessionId,
      }),
    });
    expect((await fs.readdir(dir)).toSorted()).toEqual(filesBefore);
  } finally {
    ws.close();
  }
});

test("sessions.compaction.* scopes selected global checkpoints to the requested agent", async () => {
  const { mainStorePath, workStorePath } = await createSelectedGlobalSessionStore();
  const workDir = path.dirname(workStorePath);
  await fs.mkdir(path.dirname(mainStorePath), { recursive: true });
  await fs.mkdir(workDir, { recursive: true });
  const mainSessionFile = path.join(path.dirname(mainStorePath), "sess-main-global.jsonl");
  await fs.writeFile(mainSessionFile, `${JSON.stringify({ role: "user", content: "main" })}\n`);
  const fixture = await createCheckpointFixture(workDir, { legacyPreCompactionSnapshot: false });
  const checkpointCreatedAt = Date.now();
  const checkpointEntry = compactionCheckpointEntry(fixture, {
    checkpointId: "checkpoint-work",
    sessionKey: "global",
    createdAt: checkpointCreatedAt,
    reason: "manual",
    summary: "work checkpoint",
  });
  await fs.writeFile(
    mainStorePath,
    JSON.stringify(
      { global: sessionStoreEntry("sess-main-global", { sessionFile: mainSessionFile }) },
      null,
      2,
    ),
  );
  await fs.writeFile(
    workStorePath,
    JSON.stringify(
      {
        global: sessionStoreEntry(fixture.sessionId, {
          sessionFile: fixture.sessionFile,
          compactionCheckpoints: [checkpointEntry],
        }),
      },
      null,
      2,
    ),
  );

  const listed = await directSessionReq<{
    checkpoints: Array<{ checkpointId: string; summary?: string }>;
  }>("sessions.compaction.list", { key: "global", agentId: "work" });
  expect(listed.ok).toBe(true);
  expect(listed.payload?.checkpoints).toHaveLength(1);
  expect(listed.payload?.checkpoints[0]).toMatchObject({
    checkpointId: "checkpoint-work",
    summary: "work checkpoint",
  });

  const branched = await directSessionReq<{ key?: string; sourceKey?: string }>(
    "sessions.compaction.branch",
    { key: "global", agentId: "work", checkpointId: "checkpoint-work" },
  );
  expect(branched.ok).toBe(true);
  expect(branched.payload?.sourceKey).toBe("global");
  expect(branched.payload?.key).toMatch(/^agent:work:dashboard:/);

  const restored = await directSessionReq<{ key?: string; sessionId?: string }>(
    "sessions.compaction.restore",
    { key: "global", agentId: "work", checkpointId: "checkpoint-work" },
  );
  expect(restored.ok).toBe(true);
  expect(restored.payload?.key).toBe("global");
  const mainStore = JSON.parse(await fs.readFile(mainStorePath, "utf-8")) as Record<
    string,
    { sessionId?: string }
  >;
  const workStore = JSON.parse(await fs.readFile(workStorePath, "utf-8")) as Record<
    string,
    { sessionId?: string }
  >;
  expect(mainStore.global?.sessionId).toBe("sess-main-global");
  expect(workStore.global?.sessionId).toBe(restored.payload?.sessionId);
  testState.sessionStorePath = undefined;
  testState.sessionConfig = undefined;
  testState.agentsConfig = undefined;
});

test("sessions.compact without maxLines runs embedded manual compaction for checkpoint-capable flows", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  await fs.writeFile(
    path.join(dir, "sess-main.jsonl"),
    `${JSON.stringify({ role: "user", content: "hello" })}\n`,
    "utf-8",
  );
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main", {
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
    },
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
  expect(path.basename(compactionCall.sessionFile)).toBe("sess-main.jsonl");
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

  const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
    string,
    {
      compactionCount?: number;
      contextBudgetStatus?: unknown;
      totalTokens?: number;
      totalTokensFresh?: boolean;
    }
  >;
  expect(store["agent:main:main"]?.compactionCount).toBe(1);
  expect(store["agent:main:main"]?.contextBudgetStatus).toBeUndefined();
  expect(store["agent:main:main"]?.totalTokens).toBe(80);
  expect(store["agent:main:main"]?.totalTokensFresh).toBe(true);

  ws.close();
});

test("sessions.compact records terminal Codex native compaction", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  await fs.writeFile(
    path.join(dir, "sess-codex.jsonl"),
    `${JSON.stringify({ role: "user", content: "hello codex" })}\n`,
    "utf-8",
  );
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-codex", {
        agentHarnessId: "codex",
        agentRuntimeOverride: "openclaw",
        modelSelectionLocked: true,
        compactionCount: 2,
        totalTokens: 54_321,
        totalTokensFresh: true,
      }),
    },
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
  expect(embeddedRunMock.compactEmbeddedAgentSession).toHaveBeenCalledWith(
    expect.objectContaining({
      agentHarnessId: "codex",
      modelSelectionLocked: true,
    }),
  );

  const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
    string,
    {
      compactionCount?: number;
      totalTokens?: number;
      totalTokensFresh?: boolean;
    }
  >;
  expect(store["agent:main:main"]?.compactionCount).toBe(3);
  expect(store["agent:main:main"]?.totalTokens).toBeUndefined();
  expect(store["agent:main:main"]?.totalTokensFresh).toBeUndefined();

  ws.close();
});

test("sessions.compact releases queued post-compaction delegates after manual compaction", async () => {
  resetTaskFlowRegistryForTests({ persist: false });
  const { dir, storePath } = await createSessionStoreDir();
  await fs.writeFile(
    path.join(dir, "sess-post-compaction.jsonl"),
    `${JSON.stringify({ role: "user", content: "hello delegates" })}\n`,
    "utf-8",
  );
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-post-compaction", {
        deliveryContext: {
          channel: "webchat",
          to: "webchat:user-123",
        },
      }),
    },
  });
  stagePostCompactionDelegate("agent:main:main", {
    task: "rehydrate after dashboard compact",
    createdAt: Date.now(),
  });
  expect(stagedPostCompactionDelegateCount("agent:main:main")).toBe(1);

  const { ws } = await openClient();
  const compacted = await rpcReq<{ ok: true; key: string; compacted: boolean }>(
    ws,
    "sessions.compact",
    { key: "main" },
  );

  expectMainCompactionResult(compacted, true);
  expect(stagedPostCompactionDelegateCount("agent:main:main")).toBe(0);
  const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
    string,
    { compactionCount?: number }
  >;
  expect(store["agent:main:main"]?.compactionCount).toBe(1);
  ws.close();
  resetTaskFlowRegistryForTests({ persist: false });
});

test("sessions.compact preserves legacy route fields when releasing post-compaction delegates", async () => {
  resetTaskFlowRegistryForTests({ persist: false });
  const { dir } = await createSessionStoreDir();
  await fs.writeFile(
    path.join(dir, "sess-post-compaction-legacy.jsonl"),
    `${JSON.stringify({ role: "user", content: "hello legacy route" })}\n`,
    "utf-8",
  );
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-post-compaction-legacy", {
        lastChannel: "telegram",
        lastTo: "chat-123",
        lastAccountId: "acct-1",
        lastThreadId: "topic-9",
      }),
    },
  });
  stagePostCompactionDelegate("agent:main:main", {
    task: "rehydrate after compact with legacy route",
    createdAt: Date.now(),
  });

  const { ws } = await openClient();
  const compacted = await rpcReq<{ ok: true; key: string; compacted: boolean }>(
    ws,
    "sessions.compact",
    { key: "main" },
  );

  expectMainCompactionResult(compacted, true);
  expect(stagedPostCompactionDelegateCount("agent:main:main")).toBe(0);
  const queued = await loadPendingSessionDeliveries(process.env.OPENCLAW_STATE_DIR);
  const postCompaction = queued.find(
    (entry) =>
      entry.kind === "postCompactionDelegate" &&
      entry.task === "rehydrate after compact with legacy route",
  );
  expect(postCompaction?.deliveryContext).toMatchObject({
    channel: "telegram",
    to: "chat-123",
    accountId: "acct-1",
    threadId: "topic-9",
  });
  ws.close();
  resetTaskFlowRegistryForTests({ persist: false });
});

test("sessions.compact maxLines releases queued post-compaction delegates after trim", async () => {
  resetTaskFlowRegistryForTests({ persist: false });
  const { dir } = await createSessionStoreDir();
  const sessionId = "sess-post-compaction-trim";
  const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
  const originalLines = buildSessionTranscriptLines(sessionId, 120);
  await fs.writeFile(transcriptPath, `${originalLines.join("\n")}\n`, "utf-8");
  await writeSessionStore({
    entries: { main: sessionStoreEntry(sessionId, { sessionFile: transcriptPath }) },
  });
  stagePostCompactionDelegate("agent:main:main", {
    task: "rehydrate after maxLines compact",
    createdAt: Date.now(),
  });

  const beforeEvents = peekSystemEvents("agent:main:main").length;

  const { ws } = await openClient();
  const compacted = await rpcReq<{ ok: true; key: string; compacted: boolean; kept?: number }>(
    ws,
    "sessions.compact",
    { key: "main", maxLines: 50 },
  );

  expect(compacted.ok).toBe(true);
  expect(compacted.payload?.compacted).toBe(true);
  expect(compacted.payload?.kept).toBe(50);
  await vi.waitFor(() => {
    expect(peekSystemEvents("agent:main:main").slice(beforeEvents)).toContainEqual(
      expect.stringContaining("Queued 1 post-compaction delegate(s)"),
    );
    expect(stagedPostCompactionDelegateCount("agent:main:main")).toBe(0);
  });
  ws.close();
  resetTaskFlowRegistryForTests({ persist: false });
});

test("sessions.compact skips post-compaction lifecycle when no delegates exist", async () => {
  const { dir } = await createSessionStoreDir();
  const sessionId = "sess-post-compaction-empty";
  const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
  const originalLines = buildSessionTranscriptLines(sessionId, 120);
  await fs.writeFile(transcriptPath, `${originalLines.join("\n")}\n`, "utf-8");
  await writeSessionStore({
    entries: { main: sessionStoreEntry(sessionId, { sessionFile: transcriptPath }) },
  });

  const beforeEvents = peekSystemEvents("agent:main:main").length;

  const { ws } = await openClient();
  const compacted = await rpcReq<{ ok: true; key: string; compacted: boolean; kept?: number }>(
    ws,
    "sessions.compact",
    { key: "main", maxLines: 50 },
  );

  expectMainCompactionResult(compacted, true);
  expect(compacted.payload?.kept).toBe(50);
  const trimmed = (await fs.readFile(transcriptPath, "utf-8")).trim().split("\n");
  expect(trimmed).toHaveLength(50);
  expect(JSON.parse(trimmed[0] ?? "{}")).toMatchObject({
    type: "session",
    id: "sess-post-compaction-empty",
  });
  expect(JSON.parse(trimmed[1] ?? "{}")).toMatchObject({ id: "entry-70", parentId: null });
  expect(JSON.parse(trimmed.at(-1) ?? "{}")).toMatchObject({
    id: "entry-118",
    message: { content: "line-118" },
  });
  expect(stagedPostCompactionDelegateCount("agent:main:main")).toBe(0);
  expect(peekSystemEvents("agent:main:main").slice(beforeEvents)).not.toContainEqual(
    expect.stringContaining("[system:post-compaction]"),
  );
  ws.close();
});

test("sessions.compact emits a terminal operation event when persistence fails", async () => {
  const { dir } = await createSessionStoreDir();
  const sessionId = "sess-compact-write-failure";
  await fs.writeFile(
    path.join(dir, `${sessionId}.jsonl`),
    `${JSON.stringify({ role: "user", content: "hello" })}\n`,
    "utf-8",
  );
  await writeSessionStore({ entries: { main: sessionStoreEntry(sessionId) } });
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
  const { dir, storePath } = await createSessionStoreDir();
  await fs.writeFile(
    path.join(dir, "sess-compact-old.jsonl"),
    `${JSON.stringify({ role: "user", content: "hello" })}\n`,
    "utf-8",
  );
  await writeSessionStore({ entries: { main: sessionStoreEntry("sess-compact-old") } });
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
  await writeSessionStore({ entries: { main: sessionStoreEntry("sess-replacement") } });
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
  const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
    string,
    { sessionId?: string; compactionCount?: number }
  >;
  expect(store["agent:main:main"]?.sessionId).toBe("sess-replacement");
  expect(store["agent:main:main"]?.compactionCount).toBeUndefined();
  ws.close();
});

test("sessions.reset waits for terminal compaction before replacing the session", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  await fs.writeFile(
    path.join(dir, "sess-compact-reset.jsonl"),
    `${JSON.stringify({ role: "user", content: "hello" })}\n`,
    "utf-8",
  );
  await writeSessionStore({ entries: { main: sessionStoreEntry("sess-compact-reset") } });
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
  expect(resetSessionId).not.toBe("sess-compact-reset");
  const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
    string,
    { sessionId?: string }
  >;
  expect(store["agent:main:main"]?.sessionId).toBe(resetSessionId);
  ws.close();
});

test("sessions.compaction.restore waits for terminal compaction before replacing the session", async () => {
  const { dir } = await createSessionStoreDir();
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
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry(fixture.sessionId, {
        sessionFile: fixture.sessionFile,
        compactionCheckpoints: [checkpointEntry],
      }),
    },
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
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry(fixture.sessionId, {
        sessionFile: fixture.sessionFile,
        compactionCheckpoints: [checkpointEntry],
      }),
    },
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
  await writeSessionStore({ entries: { main: sessionStoreEntry(replacementSessionId) } });

  try {
    releaseBlocker.resolve();
    await blocker;
    await expect(restore).resolves.toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        details: { reason: "session-changed" },
      },
    });
    expect(replacementInterrupted).toBe(false);
  } finally {
    releaseBlocker.resolve();
    replacementAdmission.release();
    await blocker;
    ws.close();
  }
});

test("sessions.compaction.restore rechecks the model-selection lock inside the lifecycle fence", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  const fixture = await createCheckpointFixture(dir, { legacyPreCompactionSnapshot: false });
  const checkpointEntry = compactionCheckpointEntry(fixture, {
    checkpointId: "checkpoint-lock-race",
    sessionKey: "agent:main:main",
    createdAt: Date.now(),
    reason: "manual",
    summary: "checkpoint summary",
  });
  const unlockedEntry = sessionStoreEntry(fixture.sessionId, {
    sessionFile: fixture.sessionFile,
    compactionCheckpoints: [checkpointEntry],
  });
  await writeSessionStore({ entries: { main: unlockedEntry } });
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
  const restoreReachedLifecycleFence = createDeferred<void>();
  sessionLifecycleMutationObserver.onEnter = (params) => {
    // The handler has completed its initial store read, while the blocker still
    // keeps lifecycle prepare from observing the replacement row.
    if (params.scope === storePath && params.prepare) {
      restoreReachedLifecycleFence.resolve();
    }
  };

  try {
    let restoreSettled = false;
    const restore = rpcReq(ws, "sessions.compaction.restore", {
      key: "main",
      checkpointId: "checkpoint-lock-race",
    }).finally(() => {
      restoreSettled = true;
    });
    await restoreReachedLifecycleFence.promise;
    expect(restoreSettled).toBe(false);
    await writeSessionStore({
      entries: {
        main: {
          ...unlockedEntry,
          modelSelectionLocked: true,
          updatedAt: Date.now(),
        },
      },
    });

    releaseBlocker.resolve();
    await blocker;
    await expect(restore).resolves.toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "Checkpoint branch and restore are unavailable while model selection is locked.",
      },
    });
    const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      { modelSelectionLocked?: boolean; sessionId?: string }
    >;
    expect(store["agent:main:main"]).toMatchObject({
      modelSelectionLocked: true,
      sessionId: fixture.sessionId,
    });
  } finally {
    sessionLifecycleMutationObserver.onEnter = undefined;
    releaseBlocker.resolve();
    await blocker;
    ws.close();
  }
});

test("sessions.compact blocks new work admission through terminal persistence", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  const sessionId = "sess-compact-admission";
  await fs.writeFile(
    path.join(dir, `${sessionId}.jsonl`),
    `${JSON.stringify({ role: "user", content: "hello" })}\n`,
    "utf-8",
  );
  await writeSessionStore({ entries: { main: sessionStoreEntry(sessionId) } });
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

test("sessions.compact clears queued work before draining an active admission", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  const sessionId = "sess-compact-queued-work";
  await fs.writeFile(
    path.join(dir, `${sessionId}.jsonl`),
    `${JSON.stringify({ role: "user", content: "hello" })}\n`,
    "utf-8",
  );
  await writeSessionStore({ entries: { main: sessionStoreEntry(sessionId) } });
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

  let releaseAdmission = () => {};
  const admission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: ["main", "agent:main:main", sessionId],
    assertAllowed: () => {},
    onInterrupt: () => releaseAdmission(),
  });
  releaseAdmission = admission.release;

  const { ws } = await openClient();
  try {
    const compacted = await rpcReq(ws, "sessions.compact", { key: "main" });

    expect(compacted.ok).toBe(true);
    expectSessionQueueCleanup(["main", "agent:main:main", sessionId]);
  } finally {
    admission.release();
    ws.close();
  }
});

test("sessions.patch rejects archive while terminal compaction owns the session", async () => {
  const { dir } = await createSessionStoreDir();
  const sessionKey = "agent:main:dashboard:compact-race";
  await fs.writeFile(
    path.join(dir, "sess-compact-archive.jsonl"),
    `${JSON.stringify({ role: "user", content: "hello" })}\n`,
    "utf-8",
  );
  await writeSessionStore({
    entries: { [sessionKey]: sessionStoreEntry("sess-compact-archive") },
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

test("sessions.compact maxLines truncates the transcript on disk and archives the original to .bak", async () => {
  const { dir } = await createSessionStoreDir();
  const transcriptPath = path.join(dir, "sess-main.jsonl");
  const originalLines = buildSessionTranscriptLines("sess-main", 500);
  await fs.writeFile(transcriptPath, `${originalLines.join("\n")}\n`, "utf-8");
  await writeSessionStore({ entries: { main: sessionStoreEntry("sess-main") } });

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

  // Active transcript stays reopenable: header + 49 newest entries.
  const truncated = (await fs.readFile(transcriptPath, "utf-8")).trim().split("\n");
  expect(truncated).toHaveLength(50);
  expect(JSON.parse(truncated[0] ?? "{}")).toMatchObject({ type: "session", id: "sess-main" });
  expect(JSON.parse(truncated[1] ?? "{}")).toMatchObject({ id: "entry-450", parentId: null });
  expect(JSON.parse(truncated.at(-1) ?? "{}")).toMatchObject({
    id: "entry-498",
    message: { content: "line-498" },
  });

  // Original 500 lines preserved verbatim in the .bak archive.
  const archivedPath = compacted.payload?.archived;
  if (!archivedPath) {
    throw new Error("expected archived transcript path");
  }
  const archived = (await fs.readFile(archivedPath, "utf-8")).trim().split("\n");
  expect(archived).toHaveLength(500);
  expect(JSON.parse(archived[0] ?? "{}")).toMatchObject({ type: "session", id: "sess-main" });

  // No active run present, so the interrupt guard short-circuits without aborting.
  expect(embeddedRunMock.abortCalls).toEqual([]);
  expect(embeddedRunMock.waitCalls).toEqual([]);

  ws.close();
});

test("sessions.compact maxLines interrupts an active run before truncating, matching the LLM compact path", async () => {
  const { dir } = await createSessionStoreDir();
  const transcriptPath = path.join(dir, "sess-main.jsonl");
  const originalLines = buildSessionTranscriptLines("sess-main", 500);
  await fs.writeFile(transcriptPath, `${originalLines.join("\n")}\n`, "utf-8");
  await writeSessionStore({ entries: { main: sessionStoreEntry("sess-main") } });

  const { ws } = await openClient();
  // Simulate an embedded agent run actively appending to this session transcript.
  embeddedRunMock.activeIds.add("sess-main");
  embeddedRunMock.waitResults.set("sess-main", true);

  const compacted = await rpcReq<{
    ok: true;
    compacted: boolean;
    kept?: number;
  }>(ws, "sessions.compact", { key: "main", maxLines: 50 });

  // Regression for the ClawSweeper finding: the maxLines truncate branch must
  // run the same active-run interrupt guard as the LLM-summarize branch *before*
  // archiving and overwriting the transcript, so an active runner cannot keep
  // appending to the file being truncated (the data-loss mode tracked by #72765).
  expect(embeddedRunMock.abortCalls).toEqual(["sess-main"]);
  expect(embeddedRunMock.waitCalls).toEqual(["sess-main"]);

  // The guard ran first; truncation still completed deterministically afterwards.
  expect(compacted.ok).toBe(true);
  expect(compacted.payload?.compacted).toBe(true);
  expect(compacted.payload?.kept).toBe(50);
  const truncated = (await fs.readFile(transcriptPath, "utf-8")).trim().split("\n");
  expect(truncated).toHaveLength(50);

  ws.close();
});

test("sessions.compact maxLines does not interrupt an active run when truncation is a no-op", async () => {
  const { dir } = await createSessionStoreDir();
  const transcriptPath = path.join(dir, "sess-main.jsonl");
  const originalLines = buildSessionTranscriptLines("sess-main", 10);
  await fs.writeFile(transcriptPath, `${originalLines.join("\n")}\n`, "utf-8");
  await writeSessionStore({ entries: { main: sessionStoreEntry("sess-main") } });

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
  await createSessionStoreDir();
  await writeSessionStore({ entries: { main: sessionStoreEntry("sess-main") } });

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

test("sessions.compact maxLines aborts without truncating when an active run cannot be interrupted", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  const transcriptPath = path.join(dir, "sess-main.jsonl");
  const originalLines = Array.from({ length: 500 }, (_, index) =>
    JSON.stringify({ role: "user", content: `line-${index}` }),
  );
  await fs.writeFile(transcriptPath, `${originalLines.join("\n")}\n`, "utf-8");
  await writeSessionStore({ entries: { main: sessionStoreEntry("sess-main") } });

  const { ws } = await openClient();
  // Active embedded run that fails to end within the interrupt window.
  embeddedRunMock.activeIds.add("sess-main");
  embeddedRunMock.waitResults.set("sess-main", false);

  const compacted = await rpcReq<{ ok: boolean }>(ws, "sessions.compact", {
    key: "main",
    maxLines: 50,
  });

  // Order proof: the guard ran first and failed, so the RPC errors out *before*
  // any archive/truncate. If the guard ran after truncation, the transcript
  // would already be 50 lines here. It is still 500 with no .bak, proving the
  // interrupt happens before the destructive tail-read/archive/write.
  expect(compacted.ok).toBe(false);
  expect(embeddedRunMock.abortCalls).toEqual(["sess-main"]);
  expect(embeddedRunMock.waitCalls).toEqual(["sess-main"]);

  const untouched = (await fs.readFile(transcriptPath, "utf-8")).trim().split("\n");
  expect(untouched).toHaveLength(500);
  const dirEntries = await fs.readdir(dir);
  expect(dirEntries.some((name) => name.includes(".bak"))).toBe(false);
  expect(storePath).toBeTruthy();

  ws.close();
});

test("sessions.patch preserves nested model ids under provider overrides", async () => {
  await withTempDir({ prefix: "openclaw-gw-sessions-nested-" }, async (dir) => {
    const storePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      storePath,
      JSON.stringify({
        "agent:main:main": sessionStoreEntry("sess-main"),
      }),
      "utf-8",
    );

    await withEnvAsync({ OPENCLAW_CONFIG_PATH: undefined }, async () => {
      const { clearConfigCache, clearRuntimeConfigSnapshot } = await getGatewayConfigModule();
      clearConfigCache();
      clearRuntimeConfigSnapshot();
      const cfg = {
        session: { store: storePath, mainKey: "main" },
        agents: {
          defaults: {
            model: { primary: "openai/gpt-test-a" },
          },
          list: [{ id: "main", default: true, workspace: dir }],
        },
      };
      const configPath = path.join(dir, "openclaw.json");
      await fs.writeFile(configPath, JSON.stringify(cfg, null, 2), "utf-8");

      await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath }, async () => {
        const started = await startConnectedServerWithClient();
        const { server, ws } = started;
        try {
          agentDiscoveryMock.enabled = true;
          agentDiscoveryMock.models = [
            { id: "moonshotai/kimi-k2.5", name: "Kimi K2.5 (NVIDIA)", provider: "nvidia" },
          ];

          const patched = await rpcReq<{
            ok: true;
            entry: {
              modelOverride?: string;
              providerOverride?: string;
              model?: string;
              modelProvider?: string;
            };
            resolved?: { model?: string; modelProvider?: string };
          }>(ws, "sessions.patch", {
            key: "agent:main:main",
            model: "nvidia/moonshotai/kimi-k2.5",
          });
          expect(patched.ok).toBe(true);
          expect(patched.payload?.entry.modelOverride).toBe("moonshotai/kimi-k2.5");
          expect(patched.payload?.entry.providerOverride).toBe("nvidia");
          expect(patched.payload?.entry.model).toBeUndefined();
          expect(patched.payload?.entry.modelProvider).toBeUndefined();
          expect(patched.payload?.resolved?.modelProvider).toBe("nvidia");
          expect(patched.payload?.resolved?.model).toBe("moonshotai/kimi-k2.5");

          const listed = await rpcReq<{
            sessions: Array<{ key: string; modelProvider?: string; model?: string }>;
          }>(ws, "sessions.list", {});
          expect(listed.ok).toBe(true);
          const mainSession = listed.payload?.sessions.find(
            (session) => session.key === "agent:main:main",
          );
          expect(mainSession?.modelProvider).toBe("nvidia");
          expect(mainSession?.model).toBe("moonshotai/kimi-k2.5");
        } finally {
          ws.close();
          await server.close();
        }
      });
    });
  });
});
