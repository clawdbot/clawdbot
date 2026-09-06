import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasTerminalControl } from "../../../packages/terminal-core/src/safe-text.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { createPluginRegistry } from "../../plugins/registry.js";
import { disposePluginRegistryInstances } from "../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import { createPluginRecord } from "../../plugins/status.test-fixtures.js";
import { openClawStateDatabaseCache } from "../../state/openclaw-state-db-cache.js";
import {
  closeOpenClawStateDatabaseByPath,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { createTranscriptsAutoStartService } from "../../transcripts/auto-start.js";
import type {
  TranscriptOccupancyWatchRequest,
  TranscriptSourceProvider,
  TranscriptStartRequest,
  TranscriptStopRequest,
} from "../../transcripts/provider-types.js";
import { TranscriptsStore } from "../../transcripts/store.js";
import { createTranscriptsTool } from "./transcripts-tool.js";

const tempDirs = createTempDirTracker();
const capturedText = "Private captured decision: keep these notes out of operator logs.";
const obstruction = "existing file; do not overwrite\n";
const credential = "fixture-secret-value-1234567890";
const providerError = `fixture stop failure\n\u001b[31mred\u001b[0m\u0085 token=${credential} ${"🦞".repeat(2_000)}`;

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

describe("transcripts auto-start stop reporting", () => {
  it.each([
    { name: "export failure", blocked: true, outcome: "ok", manual: false },
    { name: "returned provider failure", blocked: false, outcome: "warn", manual: false },
    {
      name: "terminal receipt with export warning",
      blocked: true,
      outcome: "terminal-warning",
      manual: false,
    },
    { name: "healthy stop", blocked: false, outcome: "ok", manual: false },
    { name: "thrown provider error", blocked: false, outcome: "throw", manual: false },
    {
      name: "manual export failure then skipped auto-stop",
      blocked: true,
      outcome: "ok",
      manual: true,
    },
  ])("$name preserves state and finishes siblings", async ({ blocked, outcome, manual }) => {
    const stateDir = await fs.realpath(tempDirs.make("openclaw-transcripts-auto-stop-"));
    const options = { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = path.resolve(resolveOpenClawStateSqlitePath(options.env));
    const exportRoot = path.join(stateDir, "transcripts");
    const store = new TranscriptsStore(exportRoot, options);
    const requests = new Map<string, TranscriptStartRequest>();
    const subjectId = "subject";
    const ids = [subjectId, "healthy-sibling"];
    const gates = new Map(ids.map((id) => [id, createDeferred()]));
    const needsRetry = outcome === "warn" || outcome === "throw";
    let cleanupFails = outcome !== "ok";
    const stop = vi.fn(async ({ sessionId }: TranscriptStopRequest) => {
      if (sessionId === subjectId && cleanupFails) {
        if (outcome === "throw") {
          throw new Error(providerError);
        }
        if (outcome === "terminal-warning") {
          await requests.get(sessionId)!.onStatus?.({ active: false });
          return { ok: false as const, error: providerError };
        }
        if (outcome === "warn") {
          return { ok: false as const, error: providerError };
        }
      }
      return { ok: true as const, sessionId };
    });
    const provider: TranscriptSourceProvider = {
      id: "stop-reporting-fixture",
      name: "Stop reporting fixture",
      sourceKinds: ["live-caption"],
      async start(request) {
        requests.set(request.session.sessionId, request);
        await gates.get(request.session.sessionId)?.promise;
        return { ok: true, session: request.session };
      },
      stop,
    };
    const registry = createEmptyPluginRegistry();
    registry.transcriptSourceProviders.push({
      pluginId: provider.id,
      provider,
      source: import.meta.url,
    });
    const logger = { warn: vi.fn<(message: string) => void>() };
    const ctx = {
      config: {
        transcripts: {
          enabled: true,
          autoStart: ids.map((sessionId) => ({ providerId: provider.id, sessionId })),
        },
      },
      stateDir,
      logger,
      caller: { kind: "operator" as const, source: "local" as const },
    };
    const service = createTranscriptsAutoStartService(ctx);
    const tool = createTranscriptsTool(ctx);
    const execute = (action: string, sessionId?: string) =>
      tool.execute("stop-proof", { action, sessionId });

    await withPluginRuntimeRegistryScope(registry, async () => {
      try {
        service.start();
        for (const id of ids) {
          gates.get(id)?.resolve();
          await vi.waitFor(async () => {
            expect(await execute("status")).toMatchObject({
              details: {
                active: expect.arrayContaining([expect.objectContaining({ sessionId: id })]),
              },
            });
          });
          const request = requests.get(id)!;
          await request.onUtterance({ text: capturedText, final: true });
          await expect(store.readUtterancesForSession(request.session)).resolves.toEqual([
            expect.objectContaining({ text: capturedText }),
          ]);
        }
        const subject = requests.get(subjectId)!.session;
        const sessionDir = store.sessionDir(subject);
        const summaryPath = path.join(sessionDir, "summary.md");
        if (blocked) {
          // Fault only the optional export, after provider admission and durable capture.
          await fs.mkdir(path.dirname(sessionDir), { recursive: true });
          await fs.writeFile(sessionDir, obstruction, { flag: "wx" });
        }
        if (manual) {
          const result = await execute("stop", subject.sessionId);
          expect(result.details).toMatchObject({
            summaryExportError: expect.stringContaining("ENOTDIR"),
            intendedSummaryPath: summaryPath,
            summary: { utteranceCount: 1 },
          });
          expect(result.details).not.toHaveProperty("summaryPath");
          expect(result.details).not.toHaveProperty("providerStopError");
        }
        await expect(service.stop()).resolves.toBeUndefined();
        expect(stop.mock.calls.map(([request]) => request.sessionId)).toEqual(ids);
        const warnings = logger.warn.mock.calls.map(([message]) => message);
        const database =
          openClawStateDatabaseCache.getOpenClawStateDatabaseIfOpenAtPath(databasePath)!;
        expect(database.db.isOpen).toBe(true);
        expect(closeOpenClawStateDatabaseByPath(database.path)).toBe(true);
        expect(database.db.isOpen).toBe(false);
        const reopened = new TranscriptsStore(exportRoot, options);
        for (const id of ids) {
          const stored = (await reopened.readSession(id))!;
          const summary = await reopened.readSummary(stored);
          if (id === subject.sessionId && needsRetry) {
            expect(stored.stoppedAt).toBeUndefined();
            expect(summary).toEqual({});
            continue;
          }
          expect(stored.stoppedAt).toEqual(expect.any(String));
          expect(summary).toMatchObject({
            summary: { utteranceCount: 1, transcript: [capturedText] },
            markdown: expect.stringContaining(capturedText),
          });
          if (id === subject.sessionId && blocked) {
            expect((await fs.lstat(sessionDir)).isFile()).toBe(true);
            expect(await fs.readFile(sessionDir, "utf8")).toBe(obstruction);
            await expect(fs.readFile(summaryPath)).rejects.toMatchObject({ code: "ENOTDIR" });
          } else {
            expect(
              await fs.readFile(path.join(reopened.sessionDir(stored), "summary.md"), "utf8"),
            ).toContain(capturedText);
          }
        }
        expect(
          openClawStateDatabaseCache.getOpenClawStateDatabaseIfOpenAtPath(databasePath),
        ).not.toBe(database);
        await expect(execute("status")).resolves.toMatchObject({
          details: {
            active: needsRetry ? [expect.objectContaining({ sessionId: subject.sessionId })] : [],
          },
        });

        if (manual || (!blocked && outcome === "ok")) {
          expect(warnings).toEqual([]);
        } else {
          expect(warnings.length).toBeGreaterThan(0);
          const logged = warnings.join(" ");
          expect(logged).toContain(subject.sessionId);
          if (blocked) {
            expect(logged).toMatch(/summary saved.*export failed/i);
            expect(logged).toContain("ENOTDIR");
            expect(logged).toContain(JSON.stringify(summaryPath));
            expect(logged).toContain("openclaw transcripts path <session>");
            expect(logged).toMatch(/(?:repair|correct).*destination/i);
          }
          if (outcome !== "ok") {
            expect(logged).toContain("fixture stop failure");
            expect(logged).toMatch(/stop failed/);
          }
          for (const warning of warnings) {
            expect(warning.length).toBeLessThanOrEqual(2_200);
            expect(hasTerminalControl(warning)).toBe(false);
            expect(warning).not.toMatch(/[\uD800-\uDFFF]/u);
            expect(warning).not.toContain(credential);
            expect(warning).not.toContain(capturedText);
            expect(warning).not.toContain('"transcript":');
          }
        }
        cleanupFails = false;
        await service.stop();
        expect(stop.mock.calls.map(([request]) => request.sessionId)).toEqual(
          needsRetry ? [...ids, subjectId] : ids,
        );
        expect(logger.warn.mock.calls.map(([message]) => message)).toEqual(warnings);
        await expect(execute("status")).resolves.toMatchObject({ details: { active: [] } });
      } finally {
        cleanupFails = false;
        for (const gate of gates.values()) {
          gate.resolve();
        }
        await service.stop();
        // Provider failures retain capture ownership; recover before fixture teardown.
        for (const id of requests.keys()) {
          await execute("stop", id);
        }
      }
    });
  });
});

describe("retained transcript configuration", () => {
  it("resumes reordered providers without replacing the unaffected watcher", async ({ signal }) => {
    const stateDir = await fs.realpath(tempDirs.make("openclaw-transcript-reorder-"));
    const owner = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {} },
      runtime: createPluginRuntime(),
      activateGlobalSideEffects: false,
    });
    const providers = ["first", "sibling"].map((id) => {
      const watches: TranscriptOccupancyWatchRequest[] = [];
      const captured = createDeferred();
      const requests: TranscriptStartRequest[] = [];
      const unwatch = vi.fn();
      const stop = vi.fn<NonNullable<TranscriptSourceProvider["stop"]>>(async ({ sessionId }) => ({
        ok: true,
        sessionId,
      }));
      const provider: TranscriptSourceProvider = {
        id,
        name: id,
        sourceKinds: ["live-audio"],
        accessControl: {
          channelId: id,
          resolveAccountId: ({ source }) => ({ ok: true, value: source.accountId ?? "default" }),
          authorize: async () => ({ ok: true, value: undefined }),
        },
        watchOccupancy: async (request) => {
          watches.push(request);
          return { ok: true, value: { stop: unwatch } };
        },
        async start(request) {
          requests.push(request);
          captured.resolve();
          return { ok: true, session: request.session };
        },
        stop,
      };
      const record = createPluginRecord({ id });
      owner.registry.plugins.push(record);
      owner.createApi(record, { config: {} }).registerTranscriptSourceProvider(provider);
      return { id, watches, captured, requests, unwatch, stop };
    });
    const entries = providers.map(({ id }) => ({
      providerId: id,
      whenOccupied: true,
      guildId: "guild",
      channelId: "voice",
    }));
    const logger = { warn: vi.fn() };
    const service = createTranscriptsAutoStartService({
      stateDir,
      logger,
      config: { transcripts: { autoStart: entries } },
      caller: { kind: "operator", source: "scheduled" },
    });
    await withPluginRuntimeRegistryScope(owner.registry, async () => {
      try {
        service.start();
        await vi.waitFor(() =>
          expect(providers.map(({ watches }) => watches.length)).toEqual([1, 1]),
        );
        await service.stop(new Set(["first"]));
        expect(providers.map(({ unwatch }) => unwatch.mock.calls.length)).toEqual([1, 0]);
        service.start({ transcripts: { autoStart: entries.toReversed() } });
        await vi.waitFor(() =>
          expect(providers.map(({ watches }) => watches.length)).toEqual([2, 1]),
        );
        for (const provider of providers) {
          provider.watches.at(-1)!.onOccupied();
        }
        await Promise.all(
          providers.map(({ captured }) => racePromiseWithAbortSignal(captured.promise, signal)),
        );
        expect(providers.map(({ requests }) => requests[0]!.session.metadata?.agentId)).toEqual([
          "main",
          "main",
        ]);
        const tool = createTranscriptsTool({
          stateDir,
          agentId: "main",
          logger,
          caller: { kind: "operator", source: "local" },
        });
        await vi.waitFor(async () =>
          expect(await tool.execute("status", { action: "status" })).toMatchObject({
            details: {
              active: expect.arrayContaining(
                providers.map(({ requests }) =>
                  expect.objectContaining({ sessionId: requests[0]!.session.sessionId }),
                ),
              ),
            },
          }),
        );
        expect(providers.map(({ requests }) => requests.length)).toEqual([1, 1]);
        await service.stop();
        expect(providers.map(({ unwatch }) => unwatch.mock.calls.length)).toEqual([2, 1]);
        expect(providers.map(({ stop }) => stop.mock.calls.length)).toEqual([1, 1]);
        expect(logger.warn).not.toHaveBeenCalled();
      } finally {
        await service.stop();
        await disposePluginRegistryInstances(owner.registry);
      }
    });
  });
});

describe("continuous transcript startup ownership", () => {
  it.each(["replacement abort", "title write failure"] as const)(
    "retains cleanup and resumes after %s",
    async (fault) => {
      const stateDir = await fs.realpath(tempDirs.make("openclaw-transcripts-continuous-"));
      const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      const release = createDeferred();
      const requests: TranscriptStartRequest[] = [];
      const stop = vi.fn<NonNullable<TranscriptSourceProvider["stop"]>>(async () => ({
        ok: false,
        error: "fixture capture still owns resources",
      }));
      const provider: TranscriptSourceProvider = {
        id: "continuous-fixture",
        name: "Continuous fixture",
        sourceKinds: ["live-caption"],
        async start(request) {
          requests.push(request);
          await release.promise;
          return { ok: true, session: { ...request.session, title: "Provider title" } };
        },
        stop,
      };
      const registry = createEmptyPluginRegistry();
      registry.transcriptSourceProviders.push({
        pluginId: provider.id,
        provider,
        source: import.meta.url,
      });
      const logger = { warn: vi.fn<(message: string) => void>() };
      const ctx = {
        config: { transcripts: { autoStart: [{ providerId: provider.id }] } },
        stateDir,
        logger,
        caller: { kind: "operator" as const, source: "local" as const },
      };
      const service = createTranscriptsAutoStartService(ctx);
      const tool = createTranscriptsTool(ctx);
      const execute = (action: string, sessionId?: string) =>
        tool.execute("continuous-owner", { action, providerId: provider.id, sessionId });
      const originalWrite = store.writeSession.bind(store);
      let rejectedTitle = false;
      const writeSession = vi
        .spyOn(TranscriptsStore.prototype, "writeSession")
        .mockImplementation(async (session) => {
          if (fault === "title write failure" && session.title && !rejectedTitle) {
            rejectedTitle = true;
            throw new Error("fixture title write unavailable");
          }
          await originalWrite(session);
        });
      const affected = new Set([provider.id]);
      let pendingStop: Promise<void> | undefined;
      await withPluginRuntimeRegistryScope(registry, async () => {
        try {
          service.start();
          await vi.waitFor(() => expect(requests).toHaveLength(1));
          const original = requests[0]!;
          const sessionId = original.session.sessionId;
          if (fault === "replacement abort") {
            pendingStop = service.stop(affected);
            const stopped = pendingStop.catch((error: unknown) => error);
            expect(original.abortSignal?.aborted).toBe(true);
            release.resolve();
            expect(await stopped).toBeInstanceOf(AggregateError);
            expect(stop).toHaveBeenCalledTimes(2);
          } else {
            release.resolve();
            await vi.waitFor(() =>
              expect(logger.warn).toHaveBeenCalledWith(
                expect.stringMatching(/capture cleanup pending.*reload its plugin/),
              ),
            );
            expect(stop).toHaveBeenCalledOnce();
            expect(original.abortSignal?.aborted).toBe(false);
          }
          await expect(execute("status")).resolves.toMatchObject({
            details: { active: [expect.objectContaining({ sessionId })] },
          });
          await expect(execute("start", sessionId)).rejects.toThrow(
            "transcripts session already active",
          );
          expect(requests).toHaveLength(1);
          await original.onUtterance({ text: "late failed capture", final: true });
          await expect(store.readUtterancesForSession(original.session)).resolves.toEqual([]);

          // The same canonical stop must acknowledge cleanup before auto-start can resume.
          const previousStops = stop.mock.calls.length;
          stop.mockImplementation(async (request) => ({ ok: true, sessionId: request.sessionId }));
          await service.stop(affected);
          expect(stop).toHaveBeenCalledTimes(previousStops + 1);
          await expect(execute("status")).resolves.toMatchObject({ details: { active: [] } });
          service.start();
          await vi.waitFor(async () => {
            expect(requests).toHaveLength(2);
            expect(await execute("status")).toMatchObject({
              details: {
                active: [expect.objectContaining({ sessionId: requests[1]!.session.sessionId })],
              },
            });
          });
          await original.onUtterance({ text: "stale replaced capture", final: true });
          const current = requests[1]!;
          expect(current.session.sessionId).not.toBe(sessionId);
          await current.onUtterance({ text: "current capture", final: true });
          expect(
            (await store.readUtterancesForSession(current.session)).map((row) => row.text),
          ).toEqual(["current capture"]);
        } finally {
          release.resolve();
          writeSession.mockRestore();
          stop.mockImplementation(async ({ sessionId }) => ({ ok: true, sessionId }));
          await pendingStop?.catch(() => {});
          await service.stop();
          for (const request of requests) {
            await execute("stop", request.session.sessionId);
          }
        }
      });
    },
  );
});
