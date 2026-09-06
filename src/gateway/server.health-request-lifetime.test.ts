// Real Gateway proof: run only with isolated SQLite coordination.
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { resolveStateDir } from "../config/paths.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { HealthSummary } from "./health/types.js";
import { observeHeldGatewayWorkDrain } from "./server-held-work.test-support.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  onceMessage,
} from "./test-helpers.server.js";

installGatewayTestHooks({ scope: "suite" });

type GatewayHarness = Awaited<ReturnType<typeof createGatewaySuiteHarness>>;

describe("public Gateway close health lifetime", () => {
  it("joins coalesced post-connect health before concurrent closes restore fixture selectors", async ({
    signal,
  }) => {
    const { collectGatewayHealthSnapshot } = await import("./health/collector.js");
    const collect = vi.mocked(collectGatewayHealthSnapshot);
    const originalCollect = expectDefined(collect.getMockImplementation(), "health collector mock");
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const initialRoot = path.join(os.tmpdir(), "gateway-health-lifetime", "fixture");
    const selection = { OPENCLAW_STATE_DIR: initialRoot };
    const selectedRoots: string[] = [];
    const collections: Promise<HealthSummary>[] = [];
    let healthSignal: AbortSignal | undefined;
    const expectHeldWork = await observeHeldGatewayWorkDrain(() => healthSignal);
    collect.mockClear();
    collect.mockImplementation((params) => {
      const collection = (async () => {
        healthSignal = getAsyncWorkSignal();
        entered.resolve();
        await release.promise;
        selectedRoots.push(resolveStateDir(selection));
        return await originalCollect(params);
      })();
      collections.push(collection);
      return collection;
    });
    let gateway: GatewayHarness | undefined;
    const clients: WebSocket[] = [];
    const closing: Promise<void>[] = [];
    const finishedAtClose: number[] = [];
    const unblock = () => release.resolve();
    signal.addEventListener("abort", unblock, { once: true });
    try {
      gateway = await createGatewaySuiteHarness({
        serverOptions: { bind: "loopback", auth: { mode: "none" } },
      });
      for (let index = 0; index < 2; index++) {
        const ws = await gateway.openWs();
        clients.push(ws);
        await connectOk(ws, { scopes: ["operator.read"] });
      }
      await entered.promise;
      expect(collect).toHaveBeenCalledTimes(1);
      expect(collect).toHaveBeenCalledWith(expect.objectContaining({ probe: false }));

      const first = expectDefined(clients[0], "first health client");
      const disconnected = new Promise<void>((resolve) => {
        first.once("close", () => resolve());
      });
      first.close();
      await disconnected;
      expect(healthSignal?.aborted).toBe(false);
      expect(selectedRoots).toEqual([]);

      const second = expectDefined(clients[1], "second health client");
      const shutdown = onceMessage<{ type: string; event: string; payload: { reason: string } }>(
        second,
        (frame) => frame.type === "event" && frame.event === "shutdown",
      );
      for (let index = 0; index < 2; index++) {
        closing.push(
          gateway.server.close({ reason: "health lifetime proof" }).then(() => {
            finishedAtClose.push(selectedRoots.length);
            selection.OPENCLAW_STATE_DIR = path.join(
              os.tmpdir(),
              "gateway-health-lifetime",
              "restored",
            );
            unblock();
          }),
        );
      }
      expect((await shutdown).payload.reason).toBe("health lifetime proof");
      await expectHeldWork(Promise.all(closing));
      unblock();
      await Promise.all(closing);
      await Promise.all(collections);
      expect(finishedAtClose).toEqual([1, 1]);
      expect(selectedRoots).toEqual([initialRoot]);
    } finally {
      unblock();
      // Join the original producer even when the baseline public close returns early.
      await Promise.allSettled(collections);
      for (const ws of clients) {
        ws.terminate();
      }
      await Promise.all(closing.length ? closing : gateway ? [gateway.server.close()] : []);
      collect.mockImplementation(originalCollect);
      signal.removeEventListener("abort", unblock);
    }
  });
});
