// Real Gateway proof: execute only on a machine with isolated SQLite coordination.
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, vi, type MockInstance } from "vitest";
import type { WebSocket } from "ws";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { resolveStateDir } from "../config/paths.js";
import * as devicePairing from "../infra/device-pairing.js";
import * as questionChannel from "../infra/question-channel-runtime.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createDeferredCore } from "../shared/deferred.js";
import { issueOperatorToken } from "./device-authz.test-helpers.js";
import { observeHeldGatewayWorkDrain } from "./server-held-work.test-support.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { resetTestPluginRegistry, setTestPluginRegistry } from "./test-helpers.plugin-registry.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
} from "./test-helpers.server.js";

installGatewayTestHooks({ scope: "suite" });

type GatewayHarness = Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
type ObserverGateway = Awaited<ReturnType<typeof startObserverGateway>>;

async function startObserverGateway() {
  const captured = createDeferredCore<GatewayRequestContext>();
  const registry = createEmptyPluginRegistry();
  registry.gatewayHandlers["test.observer-context"] = ({ context, respond }) => {
    captured.resolve(context);
    respond(true, { captured: true });
  };
  setTestPluginRegistry(registry);
  let gateway: GatewayHarness | undefined;
  let admin: WebSocket | undefined;
  try {
    gateway = await createGatewaySuiteHarness({ serverOptions: { bind: "loopback" } });
    await gateway.server.startupSettled;
    admin = await gateway.openWs();
    await connectOk(admin, { scopes: ["operator.admin"] });
    expect((await rpcReq(admin, "test.observer-context", {})).ok).toBe(true);
    const { questionManager, scopeUpgradeCoordinator } = await captured.promise;
    if (!questionManager || !scopeUpgradeCoordinator) {
      throw new Error("Gateway observer owners were not initialized");
    }
    return { gateway, admin, questionManager, upgrades: scopeUpgradeCoordinator };
  } catch (error) {
    admin?.terminate();
    await gateway?.server.close({ drainTimeoutMs: 0 });
    resetTestPluginRegistry();
    throw error;
  }
}

async function admitObserverRpc(
  ws: WebSocket,
  method: string,
  params: Record<string, unknown>,
  entered: Promise<void>,
): Promise<void> {
  const id = randomUUID();
  const prematureReply = onceMessage<{ type: string; id: string; error?: { code?: string } }>(
    ws,
    (frame) => frame.type === "res" && frame.id === id,
  ).then((frame) => {
    throw new Error(
      `${method} returned before observer admission: ${frame.error?.code ?? "success"}`,
    );
  });
  ws.send(JSON.stringify({ type: "req", id, method, params }));
  await Promise.race([entered, prematureReply]);
}

async function requestPendingUpgrade(started: ObserverGateway, name: string) {
  const paired = await issueOperatorToken({
    name,
    approvedScopes: ["operator.read"],
    clientId: GATEWAY_CLIENT_IDS.TEST,
    clientMode: GATEWAY_CLIENT_MODES.TEST,
  });
  const ws = await started.gateway.openWs();
  try {
    await connectOk(ws, {
      skipDefaultAuth: true,
      deviceToken: paired.token,
      deviceIdentityPath: paired.identityPath,
      scopes: ["operator.read"],
    });
    const registration = await rpcReq<{ requestId: string }>(ws, "device.scopes.requestUpgrade", {
      scopes: ["operator.read", "operator.write"],
    });
    expect(registration.ok).toBe(true);
    const requestId = registration.payload?.requestId;
    if (!requestId) {
      throw new Error("Scope upgrade did not return a request id");
    }
    return { ws, requestId, deviceId: paired.deviceId };
  } catch (error) {
    ws.terminate();
    throw error;
  }
}

describe("public Gateway close operator observer lifetime", () => {
  it("retires a never-used coordinator before a retained context can register late work", async () => {
    const started = await startObserverGateway();
    try {
      await started.gateway.server.close({ drainTimeoutMs: 0 });
      expect(
        started.upgrades.register({
          requestId: "late-unused-coordinator",
          owner: { deviceId: "synthetic-device", publicKey: "synthetic-public-key" },
          requestedScopes: ["operator.read"],
          expiresAtMs: Date.now() + 60_000,
        }),
      ).toBe(false);
    } finally {
      started.admin.terminate();
      await started.upgrades.close();
      started.questionManager.close();
      await started.gateway.server.close({ drainTimeoutMs: 0 });
      resetTestPluginRegistry();
    }
  });

  it.for(["connected", "disconnected"] as const)(
    "detaches question.waitAnswer for a %s client without publishing a question decision",
    async (connection, { signal }) => {
      const entered = createDeferredCore();
      const terminal = vi.spyOn(questionChannel, "handleQuestionChannelResolved");
      let started: ObserverGateway | undefined;
      let observation: MockInstance<ObserverGateway["questionManager"]["waitAnswer"]> | undefined;
      let observed: ReturnType<ObserverGateway["questionManager"]["waitAnswer"]> | undefined;
      let settled = false;
      let emergencyRelease = false;
      let closing: Promise<void> | undefined;
      let releaseTimer: ReturnType<typeof setTimeout> | undefined;
      const unblock = () => started?.questionManager.close();
      signal.addEventListener("abort", unblock, { once: true });
      try {
        started = await startObserverGateway();
        const registration = await rpcReq<{ id: string }>(started.admin, "question.request", {
          questions: [
            {
              questionId: "target",
              header: "Target",
              question: "Deploy where?",
              options: [{ label: "Staging" }, { label: "Production" }],
            },
          ],
        });
        expect(registration.ok).toBe(true);
        const id = registration.payload?.id;
        if (!id) {
          throw new Error("Question request did not return an id");
        }
        const originalWait = started.questionManager.waitAnswer.bind(started.questionManager);
        observation = vi
          .spyOn(started.questionManager, "waitAnswer")
          .mockImplementation((...args) => {
            const wait = originalWait(...args);
            if (args[0] === id) {
              observed = wait.then((result) => {
                settled = true;
                return result;
              });
              entered.resolve();
            }
            return wait;
          });
        await admitObserverRpc(started.admin, "question.waitAnswer", { id }, entered.promise);
        if (connection === "disconnected") {
          const disconnected = once(started.admin, "close");
          started.admin.close();
          await disconnected;
        }
        await nextTurn();
        expect(settled).toBe(false);
        expect(started.questionManager.get(id)?.status).toBe("pending");
        // Baseline cleanup uses local retirement, never a fabricated terminal answer.
        releaseTimer = setTimeout(() => {
          if (!settled) {
            emergencyRelease = true;
            unblock();
          }
        }, 5_000);
        closing = started.gateway.server.close({
          reason: "question observer lifetime proof",
          drainTimeoutMs: 0,
        });
        await closing;
        expect(emergencyRelease).toBe(false);
        expect(settled).toBe(true);
        await expect(observed).resolves.toEqual({ status: "pending" });
        expect(terminal).not.toHaveBeenCalled();
        expect(started.questionManager.get(id)).toBeNull();
      } finally {
        clearTimeout(releaseTimer);
        unblock();
        try {
          // The baseline close does not retire this observer; join its original wait on red too.
          await observed;
        } finally {
          started?.admin.terminate();
          await (closing ?? started?.gateway.server.close({ drainTimeoutMs: 0 }));
          observation?.mockRestore();
          terminal.mockRestore();
          resetTestPluginRegistry();
          signal.removeEventListener("abort", unblock);
        }
      }
    },
  );

  it.for([
    { name: "a connected pending poll", disconnected: false, read: "pending" },
    { name: "a disconnected pending poll", disconnected: true, read: "pending" },
    {
      name: "a notification queued immediately before close",
      disconnected: false,
      read: "queued-wake",
    },
    {
      name: "an in-flight pending read with a durable wake",
      disconnected: false,
      read: "held-pending",
    },
    {
      name: "an in-flight absent read before paired-device lookup",
      disconnected: false,
      read: "held-absent",
    },
  ] as const)(
    "retires $name before state release without changing the pairing decision",
    async ({ name, disconnected, read }, { signal }) => {
      const holdRead = read === "held-pending" || read === "held-absent";
      const expectHeldWork = holdRead ? await observeHeldGatewayWorkDrain() : undefined;
      const entered = createDeferredCore();
      const releaseRead = createDeferredCore();
      const readPending = devicePairing.getPendingDevicePairing;
      const readPaired = devicePairing.getPairedDevice;
      const reads: Promise<unknown>[] = [];
      let started: ObserverGateway | undefined;
      let limited: Awaited<ReturnType<typeof requestPendingUpgrade>> | undefined;
      let observation: MockInstance<ObserverGateway["upgrades"]["wait"]> | undefined;
      let pendingObservation: MockInstance<typeof readPending> | undefined;
      let pairedObservation: MockInstance<typeof readPaired> | undefined;
      let observed: ReturnType<ObserverGateway["upgrades"]["wait"]> | undefined;
      let closing: Promise<void> | undefined;
      let rejection: Promise<void> | undefined;
      let stateDir: string | undefined;
      let closeStarted = false;
      let atClose: { observerSettled: boolean; heldReadFinished: boolean } | undefined;
      let settled = false;
      let heldReadFinished = false;
      let emergencyRelease = false;
      let postCloseReads = 0;
      let pendingReads = 0;
      let releaseTimer: ReturnType<typeof setTimeout> | undefined;
      const unblock = () => {
        releaseRead.resolve();
        if (!limited || settled) {
          return;
        }
        const { requestId } = limited;
        rejection ??= (async () => {
          await devicePairing.rejectDevicePairing(requestId, stateDir);
          started?.upgrades.notify(requestId, "rejected");
        })();
        // The original rejection is awaited in finally; avoid an unhandled timer rejection.
        void rejection.catch(() => {});
      };
      signal.addEventListener("abort", unblock, { once: true });
      try {
        started = await startObserverGateway();
        stateDir = resolveStateDir();
        limited = await requestPendingUpgrade(started, `observer-${randomUUID()}`);
        const { requestId, deviceId } = limited;
        const pairedBefore = await readPaired(deviceId, stateDir);
        expect(pairedBefore).not.toBeNull();
        if (read === "held-absent") {
          // An out-of-band durable decision has no in-process notification hint.
          expect(await devicePairing.rejectDevicePairing(requestId, stateDir)).not.toBeNull();
        }
        let pendingBefore = await readPending(requestId, stateDir);
        expect(Boolean(pendingBefore)).toBe(read !== "held-absent");
        const originalWait = started.upgrades.wait.bind(started.upgrades);
        observation = vi.spyOn(started.upgrades, "wait").mockImplementation((...args) => {
          const wait = originalWait(...args);
          if (args[0] === requestId) {
            observed = wait.then((result) => {
              settled = true;
              return result;
            });
          }
          return wait;
        });
        pendingObservation = vi
          .spyOn(devicePairing, "getPendingDevicePairing")
          .mockImplementation((...args) => {
            if (args[0] !== requestId) {
              return readPending(...args);
            }
            pendingReads++;
            if (closeStarted) {
              postCloseReads++;
            }
            const firstRead = pendingReads === 1;
            const work = (async () => {
              const result = await readPending(...args);
              if (firstRead) {
                entered.resolve();
                if (holdRead) {
                  await releaseRead.promise;
                  heldReadFinished = true;
                }
              }
              return result;
            })();
            reads.push(work);
            return work;
          });
        pairedObservation = vi
          .spyOn(devicePairing, "getPairedDevice")
          .mockImplementation((...args) => {
            if (args[0] === deviceId && closeStarted) {
              postCloseReads++;
            }
            const work = readPaired(...args);
            reads.push(work);
            return work;
          });
        await admitObserverRpc(
          limited.ws,
          "device.scopes.waitUpgrade",
          { requestId },
          entered.promise,
        );
        if (disconnected) {
          const disconnectedSocket = once(limited.ws, "close");
          limited.ws.close();
          await disconnectedSocket;
        }
        if (read === "held-pending") {
          // Wake the already-captured poll promise through a real accepted mutation.
          // A leaked continuation will reread immediately, not after a timing-dependent sleep.
          expect((await rpcReq(started.admin, "device.pair.reject", { requestId })).ok).toBe(true);
          pendingBefore = await readPending(requestId, stateDir);
          expect(pendingBefore).toBeNull();
        }
        await nextTurn();
        expect(settled).toBe(false);
        if (!holdRead) {
          releaseTimer = setTimeout(() => {
            if (!settled) {
              emergencyRelease = true;
              unblock();
            }
          }, 5_000);
        }
        if (read === "queued-wake") {
          // Queue a poll continuation before the synchronous close fence. The
          // notification itself is not a durable decision; pending state stays intact.
          started.upgrades.notify(requestId, "rejected");
        }
        closeStarted = true;
        closing = started.gateway.server
          .close({ reason: `scope observer lifetime proof: ${name}`, drainTimeoutMs: 0 })
          .then(() => {
            atClose = { observerSettled: settled, heldReadFinished };
            // Early public close releases the original read on a broken owner.
            releaseRead.resolve();
          });
        if (expectHeldWork) {
          await expectHeldWork(closing);
          expect(atClose).toBeUndefined();
          expect(heldReadFinished).toBe(false);
          releaseRead.resolve();
        }
        await closing;
        expect(emergencyRelease).toBe(false);
        expect(atClose).toEqual({ observerSettled: true, heldReadFinished: holdRead });
        expect(postCloseReads).toBe(0);
        await expect(observed).resolves.toBeNull();
        if (holdRead) {
          expect(pendingReads).toBe(1);
        }
        expect(await readPending(requestId, stateDir)).toEqual(pendingBefore);
        expect(await readPaired(deviceId, stateDir)).toEqual(pairedBefore);
      } finally {
        clearTimeout(releaseTimer);
        unblock();
        try {
          await rejection;
          await observed;
          await Promise.all(reads);
        } finally {
          limited?.ws.terminate();
          started?.admin.terminate();
          await (closing ?? started?.gateway.server.close({ drainTimeoutMs: 0 }));
          observation?.mockRestore();
          pendingObservation?.mockRestore();
          pairedObservation?.mockRestore();
          resetTestPluginRegistry();
          signal.removeEventListener("abort", unblock);
        }
      }
    },
  );
});
