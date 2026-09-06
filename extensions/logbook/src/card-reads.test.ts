import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi, OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, expect, it, vi } from "vitest";
import plugin from "../index.js";
import { LogbookStore } from "./store.js";

const cardReads = vi.hoisted(() => ({ queries: 0, payloadRows: 0 }));

vi.mock("openclaw/plugin-sdk/sqlite-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/sqlite-runtime")>();
  return {
    ...actual,
    openNodeSqliteDatabase: (...args: Parameters<typeof actual.openNodeSqliteDatabase>) => {
      const db = actual.openNodeSqliteDatabase(...args);
      const prepare = db.prepare.bind(db);
      vi.spyOn(db, "prepare").mockImplementation((sql) => {
        const statement = prepare(sql);
        if (!/\bfrom\s+"?cards\b/i.test(sql)) {
          return statement;
        }
        const all = statement.all.bind(statement);
        vi.spyOn(statement, "all").mockImplementation((...bindings) => {
          cardReads.queries++;
          const rows = all(...bindings);
          cardReads.payloadRows += rows.filter((row) => "distractions" in row).length;
          return rows;
        });
        const iterate = statement.iterate.bind(statement);
        vi.spyOn(statement, "iterate").mockImplementation(function* (...bindings) {
          cardReads.queries++;
          for (const row of iterate(...bindings)) {
            if ("distractions" in row) {
              cardReads.payloadRows++;
            }
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

it("hydrates a timeline once and counts status without reading card payloads", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-03T12:00:00"));
  const stateDir = realpathSync(mkdtempSync(path.join(tmpdir(), "logbook-card-reads-")));
  const services: OpenClawPluginService[] = [];
  const methods = new Map<string, Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]>();
  const context = {
    stateDir,
    config: {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  };
  const store = new LogbookStore(path.join(stateDir, "logbook"));
  const day = "2026-07-03";
  const startMs = new Date(`${day}T09:00:00`).getTime();
  const drafts = Array.from({ length: 8 }, (_, index) => ({
    day,
    startMs: startMs + index * 60_000,
    endMs: startMs + (index + 1) * 60_000,
    title: `Card ${index} 🦞`,
    summary: "Summary",
    detail: "Detailed activity",
    category: "coding",
    distractions: [{ startMs: startMs + 1, endMs: startMs + 11, title: "Break" }],
  }));
  store.replaceCardsInWindow(day, 0, Number.MAX_SAFE_INTEGER, drafts);
  const cards = store.cardsForDay(day);
  store.close();

  plugin.register({
    pluginConfig: { captureEnabled: false },
    lifecycle: { registerRuntimeLifecycle() {} },
    runtime: {},
    session: { controls: { registerControlUiDescriptor() {} } },
    registerNodeInvokePolicy() {},
    registerService: (service: OpenClawPluginService) => services.push(service),
    registerGatewayMethod: (
      method: string,
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1],
    ) => methods.set(method, handler),
  } as unknown as OpenClawPluginApi);
  const service = services[0]!;
  try {
    await service.start(context);
    const call = async (method: string, params = {}) => {
      const respond = vi.fn();
      await methods.get(method)!({ params, respond } as unknown as GatewayRequestHandlerOptions);
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      return respond.mock.calls[0]?.[1];
    };
    cardReads.queries = 0;
    cardReads.payloadRows = 0;
    expect(await call("logbook.timeline", { day })).toEqual({
      day,
      cards,
      stats: {
        trackedMs: 8 * 60_000,
        distractionMs: 80,
        categories: [{ category: "coding", ms: 8 * 60_000 }],
        apps: [],
      },
    });
    expect.soft(cardReads.queries).toBe(1);
    expect.soft(cardReads.payloadRows).toBe(cards.length);

    cardReads.queries = 0;
    cardReads.payloadRows = 0;
    expect(await call("logbook.status")).toMatchObject({ today: day, todayCards: 8 });
    expect.soft(cardReads.payloadRows).toBe(0);
  } finally {
    await service.stop?.(context);
    rmSync(stateDir, { recursive: true, force: true });
  }
});
