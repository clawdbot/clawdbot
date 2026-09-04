import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type {
  TranscriptOccupancyWatchRequest,
  TranscriptSourceProvider,
  TranscriptStartRequest,
} from "../../transcripts/provider-types.js";
import { TranscriptsStore } from "../../transcripts/store.js";
import { activeSessions } from "./transcripts-tool-runtime.js";
import { createTranscriptsAutoStartService, createTranscriptsTool } from "./transcripts-tool.js";

const tempDirs = createTempDirTracker();
afterEach(() => {
  activeSessions.clear();
  vi.useRealTimers();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

function harness() {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-08-01T12:00:00Z"));
  const stateDir = tempDirs.make("transcript-occupancy-");
  const requests: TranscriptStartRequest[] = [];
  const watches: TranscriptOccupancyWatchRequest[] = [];
  const unwatch = vi.fn();
  const logger = { warn: vi.fn() };
  const provider: TranscriptSourceProvider = {
    id: "room-capture",
    name: "Room capture",
    sourceKinds: ["live-audio"],
    accessControl: {
      channelId: "room",
      resolveAccountId: ({ source }) => ({ ok: true, value: source.accountId ?? "default" }),
      authorize: async () => ({ ok: true, value: undefined }),
    },
    watchOccupancy: vi.fn<NonNullable<TranscriptSourceProvider["watchOccupancy"]>>(
      async (request) => {
        watches.push(request);
        return { ok: true, value: { stop: unwatch } };
      },
    ),
    start: vi.fn<NonNullable<TranscriptSourceProvider["start"]>>(async (request) => {
      requests.push(request);
      return { ok: true, session: request.session };
    }),
    stop: vi.fn<NonNullable<TranscriptSourceProvider["stop"]>>(async ({ sessionId }) => ({
      ok: true,
      sessionId,
    })),
  };
  const entry = {
    providerId: provider.id,
    guildId: "guild",
    channelId: "voice",
    whenOccupied: true,
    sessionId: "ignored-id",
  };
  const registry = createEmptyPluginRegistry();
  registry.transcriptSourceProviders.push({
    pluginId: provider.id,
    provider,
    source: import.meta.url,
  });
  const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
  const service = (
    entries: NonNullable<NonNullable<OpenClawConfig["transcripts"]>["autoStart"]> = [entry],
  ) =>
    createTranscriptsAutoStartService({
      stateDir,
      config: { transcripts: { autoStart: entries } },
      logger,
      caller: { kind: "operator", source: "scheduled" },
    });
  const started = async (count: number) => {
    await vi.waitFor(() => {
      expect(requests).toHaveLength(count);
      expect(activeSessions.get(requests[count - 1]!.session.sessionId)?.phase).toBe("active");
    });
    return requests[count - 1]!;
  };
  return {
    stateDir,
    provider,
    registry,
    watches,
    requests,
    unwatch,
    logger,
    entry,
    store,
    service,
    started,
  };
}

describe("occupancy-driven transcript lifecycle", () => {
  it("retains one stopped candidate across failed starts and admits synchronous initial occupancy", async () => {
    const h = harness();
    const identities: Array<{ sessionId: string; startedAt: string }> = [];
    const entered = Array.from({ length: 3 }, () => createDeferred());
    h.provider.watchOccupancy = async (request) => {
      request.onOccupied();
      return { ok: true, value: { stop: h.unwatch } };
    };
    h.provider.start = vi.fn<NonNullable<TranscriptSourceProvider["start"]>>(async (request) => {
      identities.push(request.session);
      entered[identities.length - 1]!.resolve();
      if (identities.length < 3) {
        return { ok: false, error: "not ready" };
      }
      h.requests.push(request);
      return { ok: true, session: request.session };
    });
    await withPluginRuntimeRegistryScope(h.registry, async () => {
      const service = h.service();
      try {
        service.start();
        for (let count = 1; count < 3; count++) {
          await entered[count - 1]!.promise;
          expect(identities).toHaveLength(count);
          await vi.waitFor(async () =>
            expect((await h.store.listSessionEntries())[0]?.session.stoppedAt).toBeDefined(),
          );
          await vi.advanceTimersByTimeAsync(5_000);
        }
        await entered[2]!.promise;
        await h.started(1);
        expect(
          new Set(identities.map(({ sessionId, startedAt }) => `${sessionId}/${startedAt}`)).size,
        ).toBe(1);
        expect(await h.store.listSessionEntries()).toHaveLength(1);
      } finally {
        await service.stop();
      }
    });
  });

  it("expires a failed-start candidate after an empty episode outside the reopen window", async () => {
    const h = harness();
    let failedId: string | undefined;
    h.provider.start = vi.fn<NonNullable<TranscriptSourceProvider["start"]>>(async (request) => {
      failedId = request.session.sessionId;
      return { ok: false, error: "not ready" };
    });
    await withPluginRuntimeRegistryScope(h.registry, async () => {
      const service = h.service();
      try {
        service.start();
        await vi.waitFor(() => expect(h.watches).toHaveLength(1));
        h.watches[0]!.onOccupied();
        await vi.waitFor(() => expect(failedId).toBeDefined());
        h.watches[0]!.onEmpty();
        await vi.advanceTimersByTimeAsync(11 * 60_000);
        h.provider.start = vi.fn<NonNullable<TranscriptSourceProvider["start"]>>(
          async (request) => {
            h.requests.push(request);
            return { ok: true, session: request.session };
          },
        );
        h.watches[0]!.onOccupied();
        const next = await h.started(1);
        expect(next.session.sessionId).not.toBe(failedId);
      } finally {
        await service.stop();
      }
    });
  });

  it("retains cleanup ownership when historical sources share a raw session ID", async () => {
    const h = harness();
    const entries = ["first", "second"].map((accountId) =>
      Object.assign({}, h.entry, { accountId }),
    );
    for (const [index, entry] of entries.entries()) {
      await h.store.writeSession({
        sessionId: "shared-history",
        source: {
          providerId: h.provider.id,
          accountId: entry.accountId,
          guildId: "guild",
          channelId: "voice",
        },
        startedAt: `2026-07-${30 + index}T10:00:00.000Z`,
        stoppedAt: "2026-08-01T11:59:00.000Z",
      });
    }
    await withPluginRuntimeRegistryScope(h.registry, async () => {
      const service = h.service(entries);
      try {
        service.start();
        await vi.waitFor(() => expect(h.watches).toHaveLength(2));
        for (const watch of h.watches) {
          watch.onOccupied();
        }
        await h.started(2);
        expect(new Set(h.requests.map(({ session }) => session.sessionId)).size).toBe(2);
        await service.stop();
        expect(h.provider.stop).toHaveBeenCalledTimes(2);
        expect(activeSessions.size).toBe(0);
      } finally {
        await service.stop();
      }
    });
  });

  it("captures only occupied episodes, keeps reconnects together, and persists notes after grace", async () => {
    const h = harness();
    await withPluginRuntimeRegistryScope(h.registry, async () => {
      const service = h.service();
      try {
        service.start();
        await vi.waitFor(() => expect(h.watches).toHaveLength(1));
        expect(h.requests).toHaveLength(0);
        h.watches[0]!.onOccupied();
        const capture = await h.started(1);
        expect(capture.session.sessionId).not.toBe("ignored-id");
        await capture.onUtterance({
          text: "Agreed to ship the report.",
          speaker: { label: "Alex" },
        });
        h.watches[0]!.onEmpty();
        await vi.advanceTimersByTimeAsync(29_000);
        h.watches[0]!.onOccupied();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(h.provider.stop).not.toHaveBeenCalled();
        expect(h.requests).toHaveLength(1);
        h.watches[0]!.onEmpty();
        await vi.advanceTimersByTimeAsync(30_000);
        await vi.waitFor(async () => {
          expect((await h.store.readSession(capture.session.sessionId))?.stoppedAt).toBeDefined();
          expect(await h.store.readSummary(capture.session)).toMatchObject({
            summary: { utteranceCount: 1 },
          });
        });
        expect(h.provider.stop).toHaveBeenCalledOnce();
      } finally {
        await service.stop();
      }
      expect(h.unwatch).toHaveBeenCalledOnce();
    });
  });

  it.each([60_000, 11 * 60_000])(
    "reopens only within the window after a %i ms gateway gap",
    async (gap) => {
      const h = harness();
      await withPluginRuntimeRegistryScope(h.registry, async () => {
        const first = h.service();
        let original: TranscriptStartRequest;
        try {
          first.start();
          await vi.waitFor(() => expect(h.watches).toHaveLength(1));
          h.watches[0]!.onOccupied();
          original = await h.started(1);
          await original.onUtterance({ text: "Before restart" });
        } finally {
          await first.stop();
        }
        await vi.advanceTimersByTimeAsync(gap);
        const second = h.service();
        try {
          second.start();
          await vi.waitFor(() => expect(h.watches).toHaveLength(2));
          h.watches[1]!.onOccupied();
          const reopened = await h.started(2);
          const within = gap < 10 * 60_000;
          expect(reopened.session.sessionId === original.session.sessionId).toBe(within);
          expect(reopened.session.startedAt === original.session.startedAt).toBe(within);
          expect(reopened.session.stoppedAt).toBeUndefined();
          await original.onUtterance({ text: "Stale callback" });
          await reopened.onUtterance({ text: "After restart" });
          await second.stop();
          expect(await h.store.readSummary(reopened.session)).toMatchObject({
            summary: {
              transcript: within ? ["Before restart", "After restart"] : ["After restart"],
            },
          });
          expect(h.unwatch).toHaveBeenCalledTimes(2);
        } finally {
          await second.stop();
        }
      });
    },
  );

  it("bounds disconnect restarts and waits for a new occupancy transition after exhaustion", async () => {
    const h = harness();
    await withPluginRuntimeRegistryScope(h.registry, async () => {
      const service = h.service();
      try {
        service.start();
        await vi.waitFor(() => expect(h.watches).toHaveLength(1));
        h.watches[0]!.onOccupied();
        const capture = await h.started(1);
        await capture.onUtterance({ text: "Keep this meeting" });
        await capture.onStatus?.({ active: false });
        await vi.advanceTimersByTimeAsync(5_000);
        const restarted = await h.started(2);
        expect(restarted.session.sessionId).toBe(capture.session.sessionId);
        h.provider.start = vi.fn<NonNullable<TranscriptSourceProvider["start"]>>(async () => ({
          ok: false,
          error: "capture unavailable",
        }));
        await restarted.onStatus?.({ active: false });
        for (let attempt = 0; attempt < 12; attempt++) {
          await vi.advanceTimersByTimeAsync(5_000);
          await vi.waitFor(() => expect(h.provider.start).toHaveBeenCalledTimes(attempt + 1));
        }
        await vi.waitFor(() => expect(h.logger.warn).toHaveBeenCalledOnce());
        await vi.advanceTimersByTimeAsync(60_000);
        expect(h.provider.start).toHaveBeenCalledTimes(12);
        h.provider.start = vi.fn<NonNullable<TranscriptSourceProvider["start"]>>(
          async (request) => {
            h.requests.push(request);
            return { ok: true, session: request.session };
          },
        );
        h.watches[0]!.onEmpty();
        h.watches[0]!.onOccupied();
        await h.started(3);
      } finally {
        await service.stop();
      }
    });
  });

  it("warns and skips occupancy entries when the provider cannot watch instead of capturing continuously", async () => {
    const h = harness();
    delete h.provider.watchOccupancy;
    await withPluginRuntimeRegistryScope(h.registry, async () => {
      const service = h.service();
      service.start();
      await vi.waitFor(() => expect(h.logger.warn).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.provider.start).not.toHaveBeenCalled();
      expect(h.logger.warn).toHaveBeenCalledWith(
        expect.stringMatching(/autoStart.*occupancy.*whenOccupied/),
      );
      await service.stop();
    });
  });

  it("skips later rooms sharing a resolved provider account and guild but keeps another account", async () => {
    const h = harness();
    await withPluginRuntimeRegistryScope(h.registry, async () => {
      const service = h.service([
        h.entry,
        { ...h.entry, channelId: "conflicting-room", accountId: "default" },
        { ...h.entry, channelId: "other-room", accountId: "other" },
      ]);
      try {
        service.start();
        await vi.waitFor(() => expect(h.watches).toHaveLength(2));
        expect(h.watches.map(({ source }) => source.channelId)).toEqual(["voice", "other-room"]);
        expect(h.logger.warn).toHaveBeenCalledOnce();
        expect(h.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/autoStart.*guild.*one/));
      } finally {
        await service.stop();
      }
    });
  });

  it("reopens after manual stop and a short empty transition without its stale reservation", async () => {
    const h = harness();
    await withPluginRuntimeRegistryScope(h.registry, async () => {
      const service = h.service();
      try {
        service.start();
        await vi.waitFor(() => expect(h.watches).toHaveLength(1));
        h.watches[0]!.onOccupied();
        const original = await h.started(1);
        await original.onUtterance({ text: "Before manual stop" });
        const tool = createTranscriptsTool({
          stateDir: h.stateDir,
          config: { transcripts: { enabled: true } },
          caller: { kind: "operator", source: "local" },
        });
        await tool.execute("manual-stop", {
          action: "stop",
          sessionId: original.session.sessionId,
        });
        h.watches[0]!.onEmpty();
        h.watches[0]!.onOccupied();
        const reopened = await h.started(2);
        expect(reopened.session.sessionId).toBe(original.session.sessionId);
        expect(reopened.session.startedAt).toBe(original.session.startedAt);
        await reopened.onUtterance({ text: "After manual stop" });
        await service.stop();
        expect(await h.store.readSummary(reopened.session)).toMatchObject({
          summary: { transcript: ["Before manual stop", "After manual stop"] },
        });
      } finally {
        await service.stop();
      }
    });
  });

  it("unsubscribes before stopping capture and cancels pending grace and retained callbacks", async () => {
    const h = harness();
    const order: string[] = [];
    h.unwatch.mockImplementation(() => {
      order.push("unwatch");
    });
    h.provider.stop = vi.fn<NonNullable<TranscriptSourceProvider["stop"]>>(
      async ({ sessionId }) => {
        order.push("stop");
        h.watches[0]!.onOccupied();
        return { ok: true, sessionId };
      },
    );
    await withPluginRuntimeRegistryScope(h.registry, async () => {
      const service = h.service();
      service.start();
      await vi.waitFor(() => expect(h.watches).toHaveLength(1));
      h.watches[0]!.onOccupied();
      const capture = await h.started(1);
      h.watches[0]!.onEmpty();
      await service.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(order).toEqual(["unwatch", "stop"]);
      expect(h.requests).toHaveLength(1);
      expect(await h.store.readSummary(capture.session)).toMatchObject({
        summary: { utteranceCount: 0 },
      });
    });
  });
});
