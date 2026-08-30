import { createServer } from "node:http";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { ActiveSessionCatalog } from "openclaw/plugin-sdk/session-catalog-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { createBeamRequestHandler } from "./http.js";
import { beamMirrorId, createBeamMirrorRunner, type BeamMirrorUpload } from "./mirror.js";
import type { BeamStore } from "./store.js";
import { BEAM_MAX_SESSIONS, BEAM_RETENTION_MS, type BeamStoredSession } from "./types.js";

const NOW = Date.parse("2026-07-27T12:00:00.000Z");
type TestSession = { threadId: string; recencyAt: number };
type SentRequest = { payload: BeamMirrorUpload; status: number };
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function retryRuntime(endpoint: string): Parameters<typeof createBeamMirrorRunner>[0]["runtime"] {
  return {
    config: {
      current: () => ({
        plugins: { entries: { beam: { config: { mirror: { endpoint, catalogs: ["claude"] } } } } },
      }),
    },
  };
}

function retryCatalog(
  sessions: () => TestSession[],
  transcriptText: (threadId: string) => string = (threadId) => threadId,
): ActiveSessionCatalog {
  return {
    pluginId: "claude",
    id: "claude",
    label: "Claude",
    processHomeFallbackAllowed: true,
    list: async () => [
      {
        hostId: "gateway:local",
        label: "Local",
        kind: "gateway",
        connected: true,
        sessions: sessions().map((session) => ({
          threadId: session.threadId,
          status: "stored",
          createdAt: session.recencyAt,
          updatedAt: session.recencyAt,
          recencyAt: session.recencyAt,
          archived: false,
          canContinue: false,
          canArchive: false,
        })),
      },
    ],
    read: async ({ hostId, threadId }) => ({
      hostId,
      label: "Local",
      threadId,
      items: [{ type: "agentMessage", text: transcriptText(threadId) }],
    }),
  };
}

function createRetryRunner(params: {
  sessions: () => TestSession[];
  sent: SentRequest[];
  status: (payload: BeamMirrorUpload) => number;
  now: () => number;
}) {
  const catalog = retryCatalog(params.sessions);
  const fetchFn = async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body !== "string") {
      throw new Error("expected Beam JSON request body");
    }
    const payload = JSON.parse(init.body) as BeamMirrorUpload;
    const status = params.status(payload);
    params.sent.push({ payload, status });
    return new Response("{}", { status });
  };
  return createBeamMirrorRunner({
    runtime: retryRuntime("http://127.0.0.1:19351/api/v1/beam/sessions"),
    logger: { warn: () => {}, info: () => {} },
    fetchFn: fetchFn as typeof fetch,
    now: params.now,
    listCatalogs: () => [catalog],
  });
}

describe("Beam terminal retry policy", () => {
  it("expires failed terminal work with the receiver row", async () => {
    const sent: SentRequest[] = [];
    let active = true;
    let clock = NOW;
    const runner = createRetryRunner({
      sessions: () => (active ? [{ threadId: "t1", recencyAt: NOW - 60_000 }] : []),
      sent,
      status: (payload) => (payload.completed ? 503 : 200),
      now: () => clock,
    });

    try {
      await runner.tick();
      active = false;
      clock += 4 * 60 * 60_000;
      await runner.tick();
      clock = NOW + BEAM_RETENTION_MS;
      await runner.tick();
      await runner.tick();

      expect(sent.map((request) => request.payload.completed)).toEqual([false, true]);
    } finally {
      await runner.stop();
    }
  });

  it("rotates failed terminal work behind later sessions", async () => {
    const sent: SentRequest[] = [];
    let clock = NOW;
    let activeThreadIds = Array.from({ length: 32 }, (_, index) => `early-${index}`);
    const runner = createRetryRunner({
      sessions: () => activeThreadIds.map((threadId) => ({ threadId, recencyAt: clock - 60_000 })),
      sent,
      status: (payload) => (payload.completed ? 503 : 200),
      now: () => clock,
    });

    try {
      await runner.tick();
      activeThreadIds = ["late"];
      clock += 60_000;
      await runner.tick();
      activeThreadIds = [];
      clock += 60_000;
      const beforeLaterRetry = sent.length;
      await runner.tick();
      const laterRetries = sent.slice(beforeLaterRetry);

      expect(laterRetries).toHaveLength(32);
      expect(
        laterRetries.some(
          (request) => request.payload.beamId === beamMirrorId("claude", "gateway:local", "late"),
        ),
      ).toBe(true);
    } finally {
      await runner.stop();
    }
  });

  it("does not retry a failed terminal upload for an active overflow session", async () => {
    const sent: SentRequest[] = [];
    const overflowThreadId = "active-overflow";
    const overflowBeamId = beamMirrorId("claude", "gateway:local", overflowThreadId);
    let activeSessions: TestSession[] = [{ threadId: overflowThreadId, recencyAt: NOW }];
    let overflowTerminalAttempts = 0;
    const runner = createRetryRunner({
      sessions: () => activeSessions,
      sent,
      status: (payload) => {
        if (payload.beamId === overflowBeamId && payload.completed) {
          overflowTerminalAttempts += 1;
        }
        return 200;
      },
      now: () => NOW,
    });

    try {
      await runner.tick();
      activeSessions = [
        ...Array.from({ length: 32 }, (_, index) => ({
          threadId: `newer-${index}`,
          recencyAt: NOW + index + 1,
        })),
        { threadId: overflowThreadId, recencyAt: NOW },
      ];
      await runner.tick();
      await runner.tick();

      expect(overflowTerminalAttempts).toBe(0);
      expect(
        sent
          .filter((request) => request.payload.beamId === overflowBeamId)
          .map((request) => request.payload.completed),
      ).toEqual([false]);
    } finally {
      await runner.stop();
    }
  });

  it("keeps receiver-retained retry state with independent clocks", async () => {
    const targetThreadId = "session-273";
    const targetBeamId = beamMirrorId("claude", "gateway:local", targetThreadId);
    const stateDir = tempDirs.make("beam-capacity-");
    const stateEnv: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: stateDir };
    resetPluginStateStoreForTests();
    const keyedStore = createPluginStateKeyedStoreForTests<BeamStoredSession>("beam-capacity", {
      namespace: "sessions",
      maxEntries: BEAM_MAX_SESSIONS,
      overflowPolicy: "evict-oldest",
      defaultTtlMs: BEAM_RETENTION_MS,
      env: stateEnv,
    });
    const acceptedTargetStates: boolean[] = [];
    let phase: "build" | "final" = "build";
    let rejectedTargetWrites = 0;
    const store: BeamStore = {
      put: async (session) => {
        if (session.completed && phase === "build") {
          throw new Error("hold terminal state while filling capacity");
        }
        if (session.completed && session.beamId === targetBeamId && rejectedTargetWrites === 0) {
          rejectedTargetWrites += 1;
          throw new Error("temporary target terminal failure");
        }
        if (session.completed && phase === "final" && session.beamId !== targetBeamId) {
          throw new Error("hold non-target terminal state");
        }
        if (session.beamId === targetBeamId) {
          acceptedTargetStates.push(session.completed);
        }
        await keyedStore.register(session.beamId, session);
      },
      get: (beamId) => keyedStore.lookup(beamId),
      list: async () => (await keyedStore.entries()).map((entry) => entry.value),
    };
    let requestNumber = 0;
    const handler = createBeamRequestHandler({
      store,
      resolveClient: () => ({
        clientIp: `capacity-test-${requestNumber}`,
        scopes: ["operator.write"],
      }),
      resolveControlUiTarget: () => ({ agentId: "main" }),
    });
    const server = createServer((request, response) => {
      requestNumber += 1;
      void handler(request, response).catch(() => {
        if (!response.writableEnded) {
          response.statusCode = 503;
          response.end("temporary receiver failure");
        }
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("capacity receiver did not expose a TCP port");
    }

    let activeSessions: TestSession[] = [];
    const catalog = retryCatalog(() => activeSessions);
    const runner = createBeamMirrorRunner({
      runtime: retryRuntime(`http://127.0.0.1:${address.port}/api/v1/beam/sessions`),
      logger: { warn: () => {}, info: () => {} },
      now: () => NOW,
      listCatalogs: () => [catalog],
    });
    try {
      let createdSessions = 0;
      for (let batch = 0; createdSessions < BEAM_MAX_SESSIONS; batch += 1) {
        const batchSize = Math.min(32, BEAM_MAX_SESSIONS - createdSessions);
        activeSessions = Array.from({ length: batchSize }, (_, index) => ({
          threadId: `session-${createdSessions + index}`,
          recencyAt: NOW + batch,
        }));
        createdSessions += batchSize;
        await runner.tick();
      }

      activeSessions = [{ threadId: "session-500", recencyAt: NOW + 101 }];
      await runner.tick();
      await expect(store.get(targetBeamId)).resolves.toMatchObject({ completed: false });

      activeSessions = [];
      phase = "final";
      for (let tick = 0; tick < 40; tick += 1) {
        await runner.tick();
      }

      expect(rejectedTargetWrites).toBe(1);
      expect(acceptedTargetStates).toEqual([false, true]);
      await expect(store.get(targetBeamId)).resolves.toMatchObject({ completed: true });
    } finally {
      await runner.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      resetPluginStateStoreForTests();
    }
  });
});
