import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawPluginApi, OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import {
  createCapturedPluginRegistration,
  createPluginRuntimeMock,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import { resolveLogbookConfig } from "./config.js";
import { LogbookService } from "./service.js";
import { dayKeyFor, LogbookStore } from "./store.js";

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };
const snapshot = { payload: { base64: Buffer.from("synthetic image").toString("base64") } };

function completion(
  text: string,
): Awaited<ReturnType<OpenClawPluginApi["runtime"]["llm"]["complete"]>> {
  return {
    text,
    provider: "synthetic",
    model: "synthetic",
    agentId: "main",
    usage: {},
    execution: { mode: "direct-provider", owner: { kind: "provider", id: "synthetic" } },
    audit: { caller: { kind: "plugin", id: "logbook" } },
  };
}

describe("Logbook service disposal", () => {
  it.each(["capture-list", "capture-invoke", "vision-success", "vision-error", "standup"])(
    "drains %s before closing SQLite",
    async (kind) => {
      const dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), "logbook-service-drain-")));
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const runtime = createPluginRuntimeMock();
      const day = dayKeyFor(Date.now());
      const startMs = new Date(`${day}T10:00:00`).getTime();
      const logger = { ...quietLogger, error: vi.fn(), warn: vi.fn() };
      const nodes = { nodes: [{ nodeId: "synthetic-node", commands: ["screen.snapshot"] }] };
      runtime.nodes.list = vi.fn(async () => {
        if (kind === "capture-list") {
          entered.resolve();
          await release.promise;
        }
        return nodes;
      });
      runtime.nodes.invoke = vi.fn(async () => {
        if (kind === "capture-invoke") {
          entered.resolve();
          await release.promise;
        }
        return snapshot;
      });
      runtime.mediaUnderstanding.extractStructuredWithModel = vi.fn(async () => {
        entered.resolve();
        await release.promise;
        if (kind === "vision-error") {
          throw new Error("synthetic vision failure");
        }
        return {
          text: JSON.stringify([
            { start: "10:00:00", end: "10:01:00", description: "Synthetic activity" },
          ]),
        };
      });
      runtime.llm.complete = vi.fn(async () => {
        if (kind === "standup") {
          entered.resolve();
          await release.promise;
          return completion("Synthetic standup");
        }
        return completion(
          JSON.stringify([
            {
              startTime: "10:00:00",
              endTime: "10:01:00",
              title: "Synthetic activity",
              summary: "Completed before shutdown",
              category: "coding",
            },
          ]),
        );
      });
      if (kind.startsWith("vision")) {
        const seed = new LogbookStore(dataDir);
        try {
          for (let index = 0; index < 2; index++) {
            const time = startMs + index * 120_000;
            const framePath = seed.frameFilePath(day, time);
            mkdirSync(path.dirname(framePath), { recursive: true });
            writeFileSync(framePath, "synthetic image");
            const frameId = seed.insertFrame({
              capturedAtMs: time,
              day,
              path: framePath,
              screenIndex: 0,
              byteSize: 15,
              contentHash: `synthetic-${index}`,
              idle: false,
            });
            seed.createBatch({ day, startMs: time, endMs: time + 60_000, frameIds: [frameId] });
          }
        } finally {
          seed.close();
        }
      }
      const service = new LogbookService(
        resolveLogbookConfig({
          captureEnabled: true,
          captureIntervalSeconds: 600,
          visionModel: "synthetic/vision",
        }),
        { runtime, fullConfig: {}, logger, dataDir },
      );
      service.start();
      const ticks = service as unknown as {
        captureTick(): Promise<void>;
        analysisTick(): Promise<void>;
      };
      const active = kind.startsWith("capture")
        ? ticks.captureTick()
        : kind.startsWith("vision")
          ? ticks.analysisTick()
          : service.standup(day, true);
      void active.catch(() => {});
      await entered.promise;
      const stopped = vi.fn();
      const stopping = service.stop();
      const settled = Promise.resolve(stopping).then(stopped);
      try {
        expect(service.stop()).toBe(stopping);
        await setImmediate();
        expect.soft(stopped).not.toHaveBeenCalled();
        await expect(service.standup(day, true)).rejects.toThrow("not running");
        await expect(service.analyzeNow()).rejects.toThrow("not running");
        release.resolve();
        await active;
        await settled;
        expect(logger.error).not.toHaveBeenCalled();
        const reopened = new LogbookStore(dataDir);
        try {
          if (kind.startsWith("capture")) {
            expect(reopened.countUnbatchedActiveFrames()).toBe(1);
            expect(runtime.nodes.invoke).toHaveBeenCalledTimes(1);
          } else if (kind === "standup") {
            expect(reopened.getStandup(day)?.text).toBe("Synthetic standup");
          } else {
            const db = new DatabaseSync(path.join(dataDir, "logbook.sqlite"), { readOnly: true });
            try {
              expect(db.prepare("SELECT status, error FROM batches ORDER BY id").all()).toEqual([
                {
                  status: kind === "vision-success" ? "done" : "error",
                  error: kind === "vision-success" ? null : "synthetic vision failure",
                },
                { status: "pending", error: null },
              ]);
              expect(runtime.mediaUnderstanding.extractStructuredWithModel).toHaveBeenCalledTimes(
                1,
              );
            } finally {
              db.close();
            }
          }
        } finally {
          reopened.close();
        }
      } finally {
        release.resolve();
        await active.catch(() => {});
        await settled;
        await service.stop();
        rmSync(dataDir, { recursive: true, force: true });
      }
    },
  );

  it.each(["restart", "disable"] as const)(
    "joins service stop and whole-plugin %s cleanup without stopping sessions",
    async (reason) => {
      const stateDir = realpathSync(mkdtempSync(path.join(tmpdir(), "logbook-runtime-drain-")));
      const captured = createCapturedPluginRegistration({ id: "logbook" });
      captured.api.pluginConfig = { captureEnabled: false };
      const services: OpenClawPluginService[] = [];
      captured.api.registerService = (service) => services.push(service);
      const handlers = new Map<string, Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]>();
      captured.api.registerGatewayMethod = (name, handler) => handlers.set(name, handler);
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      captured.api.runtime.llm.complete = async () => {
        entered.resolve();
        await release.promise;
        return completion("Accepted standup");
      };
      plugin.register(captured.api);
      const service = services[0]!;
      const context = { config: {}, stateDir, logger: quietLogger };
      await service.start(context);
      const call = async (name: string, params = {}) => {
        const respond = vi.fn();
        await handlers.get(name)!({ params, respond } as never);
        return respond.mock.calls[0];
      };
      const cleanup = async (scope: {
        reason: typeof reason | "reset" | "delete";
        sessionKey?: string;
        runId?: string;
      }) => {
        for (const lifecycle of captured.runtimeLifecycles) {
          await lifecycle.cleanup?.(scope);
        }
      };
      try {
        for (const scope of [
          { reason: "reset" as const },
          { reason: "delete" as const },
          { reason, sessionKey: "" },
          { reason, runId: "" },
        ]) {
          await cleanup(scope);
          expect((await call("logbook.status"))?.[0]).toBe(true);
        }
        const standup = call("logbook.standup");
        await entered.promise;
        const retired = vi.fn();
        const retiring = cleanup({ reason }).then(retired);
        await setImmediate();
        expect.soft(retired).not.toHaveBeenCalled();
        expect.soft((await call("logbook.status"))?.[0]).toBe(false);
        const stopping = Promise.resolve(service.stop?.(context));
        release.resolve();
        expect((await standup)?.[0]).toBe(true);
        await Promise.all([retiring, stopping, cleanup({ reason })]);
        const reopened = new LogbookStore(path.join(stateDir, "logbook"));
        try {
          expect(reopened.getStandup(dayKeyFor(Date.now()))?.text).toBe("Accepted standup");
        } finally {
          reopened.close();
        }
      } finally {
        release.resolve();
        await service.stop?.(context);
        rmSync(stateDir, { recursive: true, force: true });
      }
    },
  );

  it("does not start a service after its registered runtime has retired", async () => {
    const stateDir = realpathSync(mkdtempSync(path.join(tmpdir(), "logbook-retired-start-")));
    const captured = createCapturedPluginRegistration({ id: "logbook" });
    captured.api.pluginConfig = { captureEnabled: false };
    const services: OpenClawPluginService[] = [];
    captured.api.registerService = (service) => services.push(service);
    plugin.register(captured.api);
    const context = { config: {}, stateDir, logger: quietLogger };
    try {
      for (const lifecycle of captured.runtimeLifecycles) {
        await lifecycle.cleanup?.({ reason: "restart" });
      }
      expect(() => services[0]!.start(context)).toThrow("runtime has been retired");
      expect(existsSync(path.join(stateDir, "logbook", "logbook.sqlite"))).toBe(false);
    } finally {
      await services[0]!.stop?.(context);
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
