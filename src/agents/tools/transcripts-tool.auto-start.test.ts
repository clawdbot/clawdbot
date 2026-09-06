import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasTerminalControl } from "../../../packages/terminal-core/src/safe-text.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { openClawStateDatabaseCache } from "../../state/openclaw-state-db-cache.js";
import {
  closeOpenClawStateDatabaseByPath,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { createTranscriptsAutoStartService } from "../../transcripts/auto-start.js";
import type {
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
