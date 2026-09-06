import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createPluginRecord,
  createPluginRegistry,
  createPluginRuntimeMock,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { createParams } from "./run-attempt-test-harness.js";
import { createClientHarness } from "./test-support.js";
import { getCodexAppServerTurnRouter, type CodexThreadRouteReservation } from "./turn-router.js";
import { waitForResponse } from "./turn-router.test-support.js";

describe("Codex turn callback ownership", () => {
  it("restores the current registered harness attempt on a reused native transport", async () => {
    const scope = new AsyncLocalStorage<string>();
    const record = createPluginRecord({ id: "router-owner" });
    const builder = createPluginRegistry({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      runtime: createPluginRuntimeMock(),
    });
    builder.registry.plugins.push(record);
    const api = builder.createApi(record, { config: {} });
    const ready = new Map([
      ["first", createDeferred<CodexThreadRouteReservation>()],
      ["second", createDeferred<CodexThreadRouteReservation>()],
    ]);
    const finish = new Map([
      ["first", createDeferred<void>()],
      ["second", createDeferred<void>()],
    ]);
    const abort = new AbortController();
    const completed = new Error("fixture attempt completed");
    const observations: Array<{ callback: string; owner: string | undefined }> = [];
    let transport:
      | {
          harness: ReturnType<typeof createClientHarness>;
          wire: AsyncResource;
          router: ReturnType<typeof getCodexAppServerTurnRouter>;
        }
      | undefined;
    api.registerAgentHarness({
      id: "router-harness",
      label: "Router harness",
      supports: () => ({ supported: true }),
      runAttempt: async (params) =>
        scope.run(params.runId, async () => {
          if (!transport) {
            const harness = createClientHarness();
            transport = {
              harness,
              wire: new AsyncResource("reused-native-transport"),
              router: getCodexAppServerTurnRouter(harness.client),
            };
          }
          const route = transport.router.reserveThread({
            threadId: "thread-1",
            releaseOn: abort.signal,
          });
          await route.activate({
            onNotificationReceived: () => {
              observations.push({ callback: "received", owner: scope.getStore() });
            },
            onNotification: async () => {
              await Promise.resolve();
              observations.push({ callback: "notification", owner: scope.getStore() });
            },
            onRequest: async () => {
              await Promise.resolve();
              const owner = scope.getStore();
              observations.push({ callback: "request", owner });
              return {
                success: true,
                contentItems: [{ type: "inputText", text: owner ?? "missing" }],
              };
            },
          });
          route.armTurn();
          await route.bindTurn(params.runId);
          ready.get(params.runId)!.resolve(route);
          try {
            await finish.get(params.runId)!.promise;
            throw completed;
          } finally {
            route.release();
          }
        }),
    });
    const registered = builder.registry.agentHarnesses[0]!.harness;
    const runs: Array<Promise<unknown>> = [];
    const run = (runId: string) => {
      const result = expect(
        registered.runAttempt(createParams("/tmp/router-session.jsonl", "/tmp/router", { runId })),
      ).rejects.toBe(completed);
      runs.push(result);
      return result;
    };
    try {
      const first = run("first");
      await ready.get("first")!.promise;
      finish.get("first")!.resolve();
      await first;
      const second = run("second");
      await ready.get("second")!.promise;
      const { harness, wire } = transport!;
      const send = (message: unknown) => wire.runInAsyncScope(() => harness.send(message));
      const request = (id: string, turnId: string) => ({
        id,
        method: "item/tool/call",
        params: { threadId: "thread-1", turnId, callId: id, tool: "probe", arguments: {} },
      });
      send({
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", turnId: "second", itemId: "message", delta: "ready" },
      });
      send(request("current", "second"));
      expect(await waitForResponse(harness, "current")).toMatchObject({
        result: { success: true, contentItems: [{ type: "inputText", text: "second" }] },
      });
      expect(observations).toEqual([
        { callback: "received", owner: "second" },
        { callback: "notification", owner: "second" },
        { callback: "request", owner: "second" },
      ]);
      send(request("stale", "first"));
      expect(await waitForResponse(harness, "stale")).toMatchObject({ result: { success: false } });
      abort.abort("attempt closed");
      send(request("closed", "second"));
      expect(await waitForResponse(harness, "closed")).toMatchObject({
        result: { success: false },
      });
      expect(observations).toHaveLength(3);
      finish.get("second")!.resolve();
      await second;
    } finally {
      for (const deferred of finish.values()) {
        deferred.resolve();
      }
      await Promise.allSettled(runs);
      builder.rollbackPluginGlobalSideEffects(record.id, record);
      transport?.wire.emitDestroy();
      await transport?.harness.client.closeAndWait();
      scope.disable();
    }
    expect(() =>
      registered.runAttempt(createParams("/tmp/router-session.jsonl", "/tmp/router")),
    ).toThrow("reloaded or disabled");
  });
});
