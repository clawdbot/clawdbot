/**
 * Gateway session compaction RPC tests.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import type { SessionCompactionCheckpoint } from "../config/sessions.js";
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
  getSessionManagerModule,
  getGatewayConfigModule,
  sessionStoreEntry,
  createCheckpointFixture,
  directSessionReq,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, createSelectedGlobalSessionStore, openClient } =
  setupGatewaySessionsTestHarness();

type CheckpointFixture = Awaited<ReturnType<typeof createCheckpointFixture>>;

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
  expect(compactionCall.workspaceDir).toBe(path.join(os.tmpdir(), "openclaw-gateway-test"));
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

test("sessions.compact treats Codex native compaction start as pending, not completed", async () => {
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
        compactionCount: 2,
        totalTokens: 54_321,
        totalTokensFresh: true,
      }),
    },
  });
  embeddedRunMock.compactEmbeddedAgentSession.mockResolvedValueOnce({
    ok: true,
    compacted: false,
    result: {
      summary: "",
      firstKeptEntryId: "",
      tokensBefore: 54_321,
      details: {
        backend: "codex-app-server",
        threadId: "thread-1",
        signal: "thread/compact/start",
        pending: true,
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

  expectMainCompactionResult(compacted, false);
  expect(compacted.payload?.result?.details).toMatchObject({
    backend: "codex-app-server",
    threadId: "thread-1",
    signal: "thread/compact/start",
    pending: true,
  });
  const endEvent = await endEventPromise;
  expect(endEvent.payload).toMatchObject({
    operation: "compact",
    phase: "end",
    sessionKey: "agent:main:main",
    completed: false,
  });

  const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
    string,
    {
      compactionCount?: number;
      totalTokens?: number;
      totalTokensFresh?: boolean;
    }
  >;
  expect(store["agent:main:main"]?.compactionCount).toBe(2);
  expect(store["agent:main:main"]?.totalTokens).toBe(54_321);
  expect(store["agent:main:main"]?.totalTokensFresh).toBe(true);

  ws.close();
});

test("sessions.patch preserves nested model ids under provider overrides", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-sessions-nested-"));
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
