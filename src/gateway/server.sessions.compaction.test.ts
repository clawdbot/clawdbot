import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import {
  embeddedRunMock,
  piSdkMock,
  rpcReq,
  startConnectedServerWithClient,
  writeSessionStore,
} from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  getSessionManagerModule,
  getGatewayConfigModule,
  sessionStoreEntry,
  createCheckpointFixture,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

test("sessions.compaction.* lists checkpoints and branches or restores from pre-compaction snapshots", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  const fixture = await createCheckpointFixture(dir);
  const { SessionManager } = await getSessionManagerModule();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry(fixture.sessionId, {
        sessionFile: fixture.sessionFile,
        compactionCheckpoints: [
          {
            checkpointId: "checkpoint-1",
            sessionKey: "agent:main:main",
            sessionId: fixture.sessionId,
            createdAt: Date.now(),
            reason: "manual",
            tokensBefore: 123,
            tokensAfter: 45,
            summary: "checkpoint summary",
            firstKeptEntryId: fixture.preCompactionLeafId,
            preCompaction: {
              sessionId: fixture.preCompactionSession.getSessionId(),
              sessionFile: fixture.preCompactionSessionFile,
              leafId: fixture.preCompactionLeafId,
            },
            postCompaction: {
              sessionId: fixture.sessionId,
              sessionFile: fixture.sessionFile,
              leafId: fixture.postCompactionLeafId,
              entryId: fixture.postCompactionLeafId,
            },
          },
        ],
      }),
    },
  });

  const { ws } = await openClient();

  const listedSessions = await rpcReq<{
    sessions: Array<{
      key: string;
      compactionCheckpointCount?: number;
      latestCompactionCheckpoint?: {
        checkpointId: string;
        reason: string;
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
  expect(main?.latestCompactionCheckpoint?.checkpointId).toBe("checkpoint-1");
  expect(main?.latestCompactionCheckpoint?.reason).toBe("manual");

  const listedCheckpoints = await rpcReq<{
    ok: true;
    key: string;
    checkpoints: Array<{ checkpointId: string; summary?: string; tokensBefore?: number }>;
  }>(ws, "sessions.compaction.list", { key: "main" });
  expect(listedCheckpoints.ok).toBe(true);
  expect(listedCheckpoints.payload?.key).toBe("agent:main:main");
  expect(listedCheckpoints.payload?.checkpoints).toHaveLength(1);
  expect(listedCheckpoints.payload?.checkpoints[0]).toMatchObject({
    checkpointId: "checkpoint-1",
    summary: "checkpoint summary",
    tokensBefore: 123,
  });

  const checkpoint = await rpcReq<{
    ok: true;
    key: string;
    checkpoint: { checkpointId: string; preCompaction: { sessionFile: string } };
  }>(ws, "sessions.compaction.get", {
    key: "main",
    checkpointId: "checkpoint-1",
  });
  expect(checkpoint.ok).toBe(true);
  expect(checkpoint.payload?.checkpoint.checkpointId).toBe("checkpoint-1");
  expect(checkpoint.payload?.checkpoint.preCompaction.sessionFile).toBe(
    fixture.preCompactionSessionFile,
  );

  const sessionManagerOpenSpy = vi.spyOn(SessionManager, "open");
  const sessionManagerForkFromSpy = vi.spyOn(SessionManager, "forkFrom");
  let branched: Awaited<
    ReturnType<
      typeof rpcReq<{
        ok: true;
        sourceKey: string;
        key: string;
        entry: { sessionId: string; sessionFile?: string; parentSessionKey?: string };
      }>
    >
  >;
  try {
    branched = await rpcReq<{
      ok: true;
      sourceKey: string;
      key: string;
      entry: { sessionId: string; sessionFile?: string; parentSessionKey?: string };
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
  const branchedSessionFile = branched.payload?.entry.sessionFile;
  expect(branchedSessionFile).toBeTruthy();
  const branchedSession = SessionManager.open(branchedSessionFile!, dir);
  expect(branchedSession.getEntries()).toHaveLength(
    fixture.preCompactionSession.getEntries().length,
  );

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
        entry: { sessionId: string; sessionFile?: string; compactionCheckpoints?: unknown[] };
      }>
    >
  >;
  try {
    restored = await rpcReq<{
      ok: true;
      key: string;
      sessionId: string;
      entry: { sessionId: string; sessionFile?: string; compactionCheckpoints?: unknown[] };
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
  const restoredSessionFile = restored.payload?.entry.sessionFile;
  expect(restoredSessionFile).toBeTruthy();
  const restoredSession = SessionManager.open(restoredSessionFile!, dir);
  expect(restoredSession.getEntries()).toHaveLength(
    fixture.preCompactionSession.getEntries().length,
  );

  const storeAfterRestore = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
    string,
    { compactionCheckpoints?: unknown[]; sessionId?: string }
  >;
  expect(storeAfterRestore["agent:main:main"]?.sessionId).toBe(restored.payload?.sessionId);
  expect(storeAfterRestore["agent:main:main"]?.compactionCheckpoints).toHaveLength(1);

  ws.close();
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
        thinkingLevel: "medium",
        reasoningLevel: "stream",
      }),
    },
  });

  const { ws } = await openClient();
  const compacted = await rpcReq<{
    ok: true;
    key: string;
    compacted: boolean;
    result?: { tokensAfter?: number };
  }>(ws, "sessions.compact", {
    key: "main",
  });

  expect(compacted.ok).toBe(true);
  expect(compacted.payload?.key).toBe("agent:main:main");
  expect(compacted.payload?.compacted).toBe(true);
  expect(embeddedRunMock.compactEmbeddedPiSession).toHaveBeenCalledTimes(1);
  expect(embeddedRunMock.compactEmbeddedPiSession).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: "sess-main",
      sessionKey: "agent:main:main",
      sessionFile: expect.stringMatching(/sess-main\.jsonl$/),
      config: expect.any(Object),
      provider: expect.any(String),
      model: expect.any(String),
      thinkLevel: "medium",
      reasoningLevel: "stream",
      trigger: "manual",
    }),
  );

  const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
    string,
    { compactionCount?: number; totalTokens?: number; totalTokensFresh?: boolean }
  >;
  expect(store["agent:main:main"]?.compactionCount).toBe(1);
  expect(store["agent:main:main"]?.totalTokens).toBe(80);
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
        piSdkMock.enabled = true;
        piSdkMock.models = [
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
