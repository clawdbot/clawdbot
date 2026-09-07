import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createTranscriptsTool } from "../agents/tools/transcripts-tool.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  createPluginRegistryResourceOwner,
  drainPluginRegistryResourceDisposals,
  registerPluginRegistryResourceDisposer,
} from "../plugins/registry-resources.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createTranscriptsAutoStartService } from "./auto-start.js";
import { stopTranscriptCapture } from "./capture-operations.js";
import { activeSessions, startTranscripts } from "./capture.js";
import type { TranscriptSourceProvider, TranscriptStartRequest } from "./provider-types.js";
import { TranscriptsStore, transcriptSessionSelector } from "./store.js";

const tempDirs = createTempDirTracker();

describe("transcript provider cleanup custody", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawStateDatabaseForTest();
    tempDirs.cleanup();
  });

  it.each([
    { owner: "tool", failure: "returned", registryChange: "none" },
    { owner: "tool", failure: "thrown", registryChange: "none" },
    { owner: "service", failure: "returned", registryChange: "none" },
    { owner: "service", failure: "thrown", registryChange: "none" },
    { owner: "manual-service", failure: "returned", registryChange: "none" },
    { owner: "tool", failure: "returned", registryChange: "removed" },
    { owner: "tool", failure: "thrown", registryChange: "replaced" },
  ] as const)(
    "retains $owner cleanup after a $failure failure with provider $registryChange",
    async ({ owner, failure, registryChange }) => {
      const stateDir = tempDirs.make("transcript-stop-custody-");
      const requests: TranscriptStartRequest[] = [];
      let subscribed = false;
      let failing = true;
      const stop = vi.fn<NonNullable<TranscriptSourceProvider["stop"]>>(async ({ sessionId }) => {
        if (failing) {
          if (failure === "thrown") {
            throw new Error("cleanup unavailable");
          }
          return { ok: false, error: "cleanup unavailable" };
        }
        subscribed = false;
        return { ok: true, sessionId };
      });
      const provider: TranscriptSourceProvider = {
        id: "cleanup-capture",
        name: "Cleanup capture",
        sourceKinds: ["live-caption"],
        start: async (request) => {
          requests.push(request);
          subscribed = true;
          return { ok: true, session: request.session };
        },
        stop,
      };
      const registry = createEmptyPluginRegistry();
      const registration = { pluginId: provider.id, provider, source: import.meta.url };
      registry.transcriptSourceProviders.push(registration);
      const ctx = {
        stateDir,
        agentId: "main",
        config: {
          plugins: { enabled: true },
          transcripts: { autoStart: [{ providerId: provider.id, sessionId: "notes" }] },
        },
        logger: { warn: vi.fn() },
        caller: { kind: "operator" as const, source: "local" as const },
      };
      const tool = createTranscriptsTool(ctx);
      const service = createTranscriptsAutoStartService(ctx);
      const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      const replacementStop = vi.fn<NonNullable<TranscriptSourceProvider["stop"]>>(
        async ({ sessionId }) => ({ ok: true, sessionId }),
      );
      await withPluginRuntimeRegistryScope(registry, async () => {
        try {
          if (owner !== "tool") {
            service.start();
            await vi.waitFor(async () =>
              expect(await tool.execute("status", { action: "status" })).toMatchObject({
                details: { active: [{ sessionId: "notes" }] },
              }),
            );
          } else {
            await tool.execute("start", {
              action: "start",
              providerId: provider.id,
              sessionId: "notes",
            });
          }
          const request = requests[0]!;
          await request.onUtterance({ text: "Saved before stop" });
          if (owner === "service") {
            await service.stop();
            expect
              .soft(ctx.logger.warn)
              .toHaveBeenCalledWith(expect.stringMatching(/stop failed.*cleanup unavailable/));
          } else {
            await expect
              .soft(tool.execute("stop", { action: "stop", sessionId: "notes" }))
              .rejects.toThrow("cleanup unavailable");
          }
          expect.soft(subscribed).toBe(true);
          await expect.soft(tool.execute("status", { action: "status" })).resolves.toMatchObject({
            details: {
              active: [{ sessionId: "notes", cleanupPending: true }],
              pendingFinalization: [],
            },
          });
          expect.soft((await store.readSession("notes"))?.stoppedAt).toBeUndefined();
          await request.onUtterance({ text: "Too late after failed stop" });
          expect
            .soft((await store.readUtterancesForSession(request.session)).map((line) => line.text))
            .toEqual(["Saved before stop"]);
          if (registryChange === "removed") {
            ctx.config.plugins.enabled = false;
            registry.transcriptSourceProviders.splice(0);
          } else if (registryChange === "replaced") {
            registry.transcriptSourceProviders[0] = {
              ...registration,
              provider: { ...provider, stop: replacementStop },
            };
          }
          failing = false;
          if (owner !== "tool") {
            await service.stop();
          } else {
            await tool.execute("retry-stop", { action: "stop", sessionId: "notes" });
          }
          expect.soft(stop).toHaveBeenCalledTimes(2);
          expect.soft(replacementStop).not.toHaveBeenCalled();
          expect.soft(subscribed).toBe(false);
          await expect(tool.execute("status", { action: "status" })).resolves.toMatchObject({
            details: { active: [], pendingFinalization: [] },
          });
          expect((await store.readSummary(request.session)).summary?.transcript).toEqual([
            "Saved before stop",
          ]);
        } finally {
          failing = false;
          ctx.config.plugins.enabled = true;
          registry.transcriptSourceProviders.splice(
            0,
            registry.transcriptSourceProviders.length,
            registration,
          );
          await service.stop();
          if (requests.length) {
            await tool.execute("cleanup", { action: "stop", sessionId: "notes" });
          }
        }
      });
    },
  );
});

describe("Transcript capture resource lifetime", () => {
  const resourceTempDirs = createTempDirTracker();
  afterEach(async () => {
    for (const entry of activeSessions.values()) {
      entry.resources.release();
    }
    activeSessions.clear();
    await drainPluginRegistryResourceDisposals();
    closeOpenClawStateDatabaseForTest();
    resourceTempDirs.cleanup();
  });

  it("retains the original capture database across failed stop and actual retry completion", async () => {
    const stateDir = resourceTempDirs.make("capture-resource-owner-");
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE events (value TEXT)");
    const entered = createDeferredCore();
    const finish = createDeferredCore();
    let failing = true;
    const registry = createEmptyPluginRegistry();
    registry.transcriptSourceProviders.push({
      pluginId: "capture-resource",
      source: "synthetic-fixture",
      provider: {
        id: "capture-resource",
        name: "Capture resource",
        sourceKinds: ["live-caption"],
        start: async ({ session, onUtterance }) => {
          await onUtterance({ text: "Preserved capture" });
          return { ok: true, session };
        },
        stop: async ({ sessionId }) => {
          db.prepare("INSERT INTO events VALUES (?)").run("stop");
          if (failing) {
            return { ok: false, error: "cleanup still owned" };
          }
          entered.resolve();
          await finish.promise;
          db.prepare("INSERT INTO events VALUES (?)").run("completed");
          return { ok: true, sessionId };
        },
      },
    });
    const owner = createPluginRegistryResourceOwner(registry, "scoped");
    registerPluginRegistryResourceDisposer(registry, "capture-resource", {
      id: "native-capture-database",
      dispose: () => db.close(),
    });
    const ctx = {
      stateDir,
      caller: { kind: "operator" as const, source: "local" as const },
      logger: { warn() {} },
    };
    const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    let stopping: Promise<unknown> | undefined;
    try {
      const started = await withPluginRuntimeRegistryScope(registry, () =>
        startTranscripts({
          ctx,
          store,
          rawParams: { providerId: "capture-resource", sessionId: "notes" },
        }),
      );
      const entry = activeSessions.get(started.session.sessionId)!;
      const selection = {
        session: entry.session,
        selector: transcriptSessionSelector(entry.session),
        activeCandidate: entry,
        selectedActive: entry,
        historicalRevision: undefined,
      };
      owner.release();
      await expect(stopTranscriptCapture({ ctx, store, selection })).rejects.toThrow(
        "cleanup still owned",
      );
      expect(entry.cleanupPending).toBe(true);
      expect(db.isOpen).toBe(true);
      failing = false;
      stopping = stopTranscriptCapture({ ctx, store, selection });
      await entered.promise;
      let drained = false;
      const drain = drainPluginRegistryResourceDisposals().then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(drained).toBe(false);
      finish.resolve();
      await stopping;
      await drain;
      expect(db.isOpen).toBe(false);
      expect((await store.readSummary(started.session)).summary?.transcript).toEqual([
        "Preserved capture",
      ]);
    } finally {
      finish.resolve();
      try {
        await stopping;
      } finally {
        owner.release();
      }
    }
  });
});
