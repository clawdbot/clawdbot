// Real Gateway proof: execute only on a machine with isolated SQLite coordination.
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { resolveStateDir } from "../config/paths.js";
import { initializeGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as agentJobs from "./agent-turn/agent-job.js";
import {
  getTestPluginRegistry,
  resetTestPluginRegistry,
  setTestPluginRegistry,
} from "./test-helpers.plugin-registry.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  onceMessage,
} from "./test-helpers.server.js";

installGatewayTestHooks({ scope: "suite" });

type GatewayHarness = Awaited<ReturnType<typeof createGatewaySuiteHarness>>;

describe("public Gateway close request lifetime", () => {
  it.for(["connected", "disconnected"] as const)(
    "retires agent.wait for a %s client before zero-budget close joins it",
    async (connection, { signal }) => {
      const runId = randomUUID();
      const entered = createDeferredCore();
      const originalWait = agentJobs.waitForAgentJob;
      let observed: ReturnType<typeof originalWait> | undefined;
      let requestSent = false;
      let settled = false;
      let emergencyRelease = false;
      const observation = vi.spyOn(agentJobs, "waitForAgentJob").mockImplementation((params) => {
        const wait = originalWait(params);
        if (params.runId === runId) {
          observed = wait.then((result) => {
            settled = true;
            return result;
          });
          entered.resolve();
        }
        return wait;
      });
      const releaseWait = () => {
        if (requestSent && !settled) {
          agentJobs.setGatewayDedupeEntry({
            dedupe: new Map(),
            key: `agent:${runId}`,
            entry: {
              ts: Date.now(),
              ok: true,
              payload: { runId, status: "ok", startedAt: 100, endedAt: 200 },
            },
          });
        }
      };
      let phase = "server acquisition";
      const abort = () => {
        console.error(`agent.wait lifetime proof aborted during ${phase}`);
        releaseWait();
      };
      signal.addEventListener("abort", abort, { once: true });
      let gateway: GatewayHarness | undefined;
      let ws: WebSocket | undefined;
      let closing: Promise<void> | undefined;
      let releaseTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        gateway = await createGatewaySuiteHarness({
          serverOptions: { bind: "loopback", auth: { mode: "none" } },
        });
        phase = "startup settlement";
        await gateway.server.startupSettled;
        phase = "WebSocket connection";
        ws = await gateway.openWs();
        await connectOk(ws, { scopes: ["operator.admin"] });
        const prematureReply = onceMessage<{ type: string; id: string; error?: { code?: string } }>(
          ws,
          (frame) => frame.type === "res" && frame.id === "wait-for-shutdown",
        ).then((frame) => {
          throw new Error(
            `agent.wait returned before waiter registration: ${frame.error?.code ?? "success"}`,
          );
        });
        ws.send(
          JSON.stringify({
            type: "req",
            id: "wait-for-shutdown",
            method: "agent.wait",
            params: { runId, timeoutMs: 600_000 },
          }),
        );
        requestSent = true;
        phase = "waiter admission";
        await Promise.race([entered.promise, prematureReply]);
        if (connection === "disconnected") {
          const disconnected = once(ws, "close");
          ws.close();
          await disconnected;
        }
        await nextTurn();
        expect(settled).toBe(false);
        // A failing owner is released through the real terminal registry, not an abandoned wait.
        releaseTimer = setTimeout(() => {
          emergencyRelease = true;
          releaseWait();
        }, 5_000);
        phase = "zero-budget close";
        const finishedAtClose: boolean[] = [];
        const firstClose = gateway.server
          .close({ reason: "wait lifetime proof", drainTimeoutMs: 0 })
          .then(() => {
            finishedAtClose.push(settled);
          });
        const concurrentClose = gateway.server.close({ drainTimeoutMs: 0 }).then(() => {
          finishedAtClose.push(settled);
        });
        closing = Promise.all([firstClose, concurrentClose]).then(() => undefined);
        await closing;
        expect(emergencyRelease).toBe(false);
        expect(finishedAtClose).toEqual([true, true]);
        expect(settled).toBe(true);
        await expect(observed).resolves.toBeNull();
      } finally {
        clearTimeout(releaseTimer);
        releaseWait();
        await observed;
        ws?.terminate();
        await (closing ?? gateway?.server.close({ drainTimeoutMs: 0 }));
        observation.mockRestore();
        signal.removeEventListener("abort", abort);
      }
    },
  );

  it("joins both handlers and concurrent close callers before fixture restoration", async ({
    signal,
  }) => {
    const bothEntered = createDeferredCore();
    const release = createDeferredCore();
    const initialRoot = path.join(os.tmpdir(), "gateway-lifetime", "fixture");
    const selection = { OPENCLAW_STATE_DIR: initialRoot };
    const selectedRoots: string[] = [];
    const handlerRuns: Promise<void>[] = [];
    let enteredCount = 0;
    const registry = createEmptyPluginRegistry();
    registry.gatewayHandlers["test.lifetime"] = ({ respond }) => {
      const work = (async () => {
        if (++enteredCount === 2) {
          bothEntered.resolve();
        }
        // An accepted response is not completion of the handler's remaining work.
        respond(true, { accepted: true });
        await release.promise;
        selectedRoots.push(resolveStateDir(selection));
      })();
      handlerRuns.push(work);
      return work;
    };
    setTestPluginRegistry(registry);
    let gateway: GatewayHarness | undefined;
    let ws: WebSocket | undefined;
    const closing: Promise<void>[] = [];
    const finishedAtClose: number[] = [];
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    const unblock = () => release.resolve();
    signal.addEventListener("abort", unblock, { once: true });
    try {
      gateway = await createGatewaySuiteHarness({
        serverOptions: { bind: "loopback", auth: { mode: "none" } },
      });
      ws = await gateway.openWs();
      await connectOk(ws, { scopes: ["operator.admin"] });
      const socket = ws;
      const accepted = ["first", "second"].map((id) => {
        const response = onceMessage<{ type: string; id: string; ok: boolean }>(
          socket,
          (frame) => frame.type === "res" && frame.id === id,
        );
        socket.send(JSON.stringify({ type: "req", id, method: "test.lifetime", params: {} }));
        return response;
      });
      expect(await Promise.all(accepted)).toEqual([
        expect.objectContaining({ ok: true }),
        expect.objectContaining({ ok: true }),
      ]);
      await bothEntered.promise;
      const shutdown = onceMessage<{ type: string; event: string; payload: { reason: string } }>(
        socket,
        (frame) => frame.type === "event" && frame.event === "shutdown",
      );

      // The bounded release also lets the repaired join finish. Early close releases
      // immediately, reproducing teardown -> late continuation on the broken owner.
      releaseTimer = setTimeout(unblock, 5_000);
      for (let index = 0; index < 2; index++) {
        closing.push(
          gateway.server.close({ reason: "request lifetime proof" }).then(() => {
            finishedAtClose.push(selectedRoots.length);
            // Model fixture restoration with an explicit synthetic selector only.
            selection.OPENCLAW_STATE_DIR = path.join(os.tmpdir(), "gateway-lifetime", "restored");
            unblock();
          }),
        );
      }
      expect((await shutdown).payload.reason).toBe("request lifetime proof");
      await Promise.all(closing);
      await Promise.all(handlerRuns);
      expect(finishedAtClose).toEqual([2, 2]);
      expect(selectedRoots).toEqual([initialRoot, initialRoot]);
    } finally {
      clearTimeout(releaseTimer);
      unblock();
      // Public close is deliberately insufficient on the baseline. Join our own
      // continuations before the Gateway fixture can restore process state.
      await Promise.all(handlerRuns);
      ws?.terminate();
      await Promise.all(closing.length ? closing : gateway ? [gateway.server.close()] : []);
      resetTestPluginRegistry();
      signal.removeEventListener("abort", unblock);
    }
  });

  it("fences incoming RPCs while an asynchronous shutdown owner is still stopping", async ({
    signal,
  }) => {
    const stopping = createDeferredCore();
    const release = createDeferredCore();
    const registry = createEmptyPluginRegistry();
    let invoked = 0;
    registry.gatewayHandlers["test.lifetime"] = ({ respond }) => {
      invoked++;
      respond(true, { executed: true });
    };
    registry.typedHooks.push({
      pluginId: "lifetime-proof",
      hookName: "gateway_stop",
      source: "test",
      handler: async () => {
        stopping.resolve();
        await release.promise;
      },
    });
    setTestPluginRegistry(registry);
    let gateway: GatewayHarness | undefined;
    let ws: WebSocket | undefined;
    let closing: Promise<void> | undefined;
    const unblock = () => release.resolve();
    signal.addEventListener("abort", unblock, { once: true });
    try {
      gateway = await createGatewaySuiteHarness({
        serverOptions: { bind: "loopback", auth: { mode: "none" } },
      });
      ws = await gateway.openWs();
      await connectOk(ws, { scopes: ["operator.admin"] });
      initializeGlobalHookRunner(getTestPluginRegistry());
      closing = gateway.server.close({ reason: "incoming work fence proof" });
      await stopping.promise;
      if (ws.readyState === WebSocket.OPEN) {
        const response = onceMessage<{ type: string; id: string; ok: boolean }>(
          ws,
          (frame) => frame.type === "res" && frame.id === "late",
        ).catch((error: unknown) => {
          if (ws?.readyState === WebSocket.CLOSED) {
            return { type: "closed", id: "late", ok: false };
          }
          throw error;
        });
        ws.send(JSON.stringify({ type: "req", id: "late", method: "test.lifetime", params: {} }));
        expect((await response).ok).toBe(false);
      }
      expect(invoked).toBe(0);
    } finally {
      unblock();
      ws?.terminate();
      await (closing ?? gateway?.server.close());
      resetTestPluginRegistry();
      signal.removeEventListener("abort", unblock);
    }
  });
});
