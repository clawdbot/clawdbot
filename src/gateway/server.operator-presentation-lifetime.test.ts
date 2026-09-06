// Real Gateway proof: execute only on a machine with isolated SQLite coordination.
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import * as approvalWebPush from "./approval-web-push.js";
import { createGatewaySuiteHarness, installGatewayTestHooks } from "./test-helpers.server.js";

installGatewayTestHooks({ scope: "suite" });

type GatewayHarness = Awaited<ReturnType<typeof createGatewaySuiteHarness>>;

describe("public Gateway close startup presentation lifetime", () => {
  it("starts without waiting for approval recovery but joins it before close returns", async ({
    signal,
  }) => {
    const release = createDeferredCore();
    const recoveries: Promise<void>[] = [];
    const restoreRecoveries: Array<() => void> = [];
    const createDelivery = approvalWebPush.createApprovalWebPushDelivery;
    let recoveryFinished = false;
    const factory = vi
      .spyOn(approvalWebPush, "createApprovalWebPushDelivery")
      .mockImplementation((params) => {
        const delivery = createDelivery(params);
        const recover = delivery.recoverTerminalDeliveries.bind(delivery);
        const observation = vi
          .spyOn(delivery, "recoverTerminalDeliveries")
          .mockImplementation(() => {
            const work = (async () => {
              await release.promise;
              await recover();
              recoveryFinished = true;
            })();
            recoveries.push(work);
            return work;
          });
        restoreRecoveries.push(() => observation.mockRestore());
        return delivery;
      });
    const unblock = () => release.resolve();
    signal.addEventListener("abort", unblock, { once: true });
    let startup: Promise<GatewayHarness> | undefined;
    let closing: Promise<void> | undefined;
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    let finishedAtClose: boolean | undefined;
    try {
      startup = createGatewaySuiteHarness({
        serverOptions: { bind: "loopback", auth: { mode: "none" } },
      });
      const gateway = await startup;
      // No RPC admits this work, and the held recovery must not delay public startup.
      expect(recoveries).toHaveLength(1);
      expect(recoveryFinished).toBe(false);

      // A repaired close waits for the bounded release. A broken early close releases
      // immediately, but cannot turn its captured completion ordering into a pass.
      releaseTimer = setTimeout(unblock, 5_000);
      closing = gateway.server
        .close({ reason: "startup approval recovery lifetime proof" })
        .then(() => {
          finishedAtClose = recoveryFinished;
          unblock();
        });
      await closing;
      await Promise.all(recoveries);
      expect(finishedAtClose).toBe(true);
      expect(recoveryFinished).toBe(true);
    } finally {
      clearTimeout(releaseTimer);
      unblock();
      const [started] = await Promise.allSettled([startup]);
      try {
        // Baseline public close leaves recovery detached. Join the original operation
        // while the fixture still owns its synthetic state, even on the red path.
        await Promise.all(recoveries);
      } finally {
        try {
          await (closing ??
            (started.status === "fulfilled" ? started.value?.server.close() : undefined));
        } finally {
          for (const restore of restoreRecoveries) {
            restore();
          }
          factory.mockRestore();
          signal.removeEventListener("abort", unblock);
        }
      }
    }
  });
});
