import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { resolveLogbookConfig } from "./config.js";
import { buildAskPrompt } from "./prompts.js";
import { LogbookService } from "./service.js";
import { LogbookStore } from "./store.js";

const reads = vi.hoisted(() => ({ rows: 0 }));

vi.mock("openclaw/plugin-sdk/sqlite-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/sqlite-runtime")>();
  return {
    ...actual,
    openNodeSqliteDatabase: (...args: Parameters<typeof actual.openNodeSqliteDatabase>) => {
      const db = actual.openNodeSqliteDatabase(...args);
      const prepare = db.prepare.bind(db);
      vi.spyOn(db, "prepare").mockImplementation((sql) => {
        const statement = prepare(sql);
        if (!/\bfrom\s+"?observations\b/i.test(sql)) {
          return statement;
        }
        const all = statement.all.bind(statement);
        vi.spyOn(statement, "all").mockImplementation((...bindings) => {
          const rows = all(...bindings);
          reads.rows += rows.length;
          return rows;
        });
        const iterate = statement.iterate.bind(statement);
        vi.spyOn(statement, "iterate").mockImplementation(function* (...bindings) {
          for (const row of iterate(...bindings)) {
            reads.rows++;
            yield row;
          }
          return undefined;
        });
        return statement;
      });
      return db;
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each([0, 199, 200, 201])(
  "asks with the same latest observations while reading at most 200 of %i rows",
  async (count) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T12:00:00"));
    const dataDir = mkdtempSync(path.join(tmpdir(), "logbook-observation-reads-"));
    const day = "2026-07-03";
    const store = new LogbookStore(dataDir);
    const segments = Array.from({ length: count }, (_, index) => ({
      startMs: 1 + Math.floor(index / 3) * 1000,
      endMs: 1001 + Math.floor(index / 3) * 1000,
      text: `Observation ${index} 🦞`,
    }));
    const seedBatch = (batchDay: string) => {
      const frameId = store.insertFrame({
        capturedAtMs: Date.now(),
        day: batchDay,
        path: path.join(dataDir, "synthetic.jpg"),
        screenIndex: 0,
        byteSize: 0,
        contentHash: "synthetic",
        idle: false,
      });
      return store.createBatch({
        day: batchDay,
        startMs: 1,
        endMs: Number.MAX_SAFE_INTEGER,
        frameIds: [frameId],
      });
    };
    const batchId = seedBatch(day);
    store.replaceObservations(batchId, day, [
      ...segments,
      { startMs: -10, endMs: 0, text: "Excluded end boundary" },
      {
        startMs: Number.MAX_SAFE_INTEGER,
        endMs: Number.MAX_SAFE_INTEGER,
        text: "Excluded start boundary",
      },
    ]);
    store.replaceObservations(seedBatch("2026-07-04"), "2026-07-04", [
      { startMs: 1, endMs: 2, text: "Excluded day" },
    ]);
    store.close();
    const runtime = createPluginRuntimeMock();
    const complete = vi.fn<OpenClawPluginApi["runtime"]["llm"]["complete"]>(async () => ({
      text: "Synthetic answer",
      provider: "synthetic",
      model: "synthetic",
      agentId: "main",
      usage: {},
      execution: { mode: "direct-provider", owner: { kind: "provider", id: "synthetic" } },
      audit: { caller: { kind: "plugin", id: "logbook" } },
    }));
    runtime.llm.complete = complete;
    const service = new LogbookService(resolveLogbookConfig({ captureEnabled: false }), {
      dataDir,
      runtime,
      fullConfig: {},
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    service.start();
    try {
      reads.rows = 0;
      expect(await service.ask(day, "What happened?")).toBe("Synthetic answer");
      expect(complete).toHaveBeenCalledTimes(1);
      expect(complete.mock.calls[0]?.[0].messages).toEqual([
        {
          role: "user",
          content: buildAskPrompt({
            day,
            cards: [],
            observations: segments
              .map((segment, index) => Object.assign({ id: index + 1, batchId, day }, segment))
              .slice(-200),
            question: "What happened?",
          }),
        },
      ]);
      expect(reads.rows).toBe(Math.min(count, 200));
    } finally {
      await Promise.resolve(service.stop());
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
);
