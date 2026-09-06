// Real Gateway proof: run only with isolated SQLite coordination.
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { createDeferredCore } from "../shared/deferred.js";
import { getOperatorApprovalDetailed } from "./operator-approval-store.js";
import * as approvalShared from "./server-methods/approval-shared.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  rpcReq,
} from "./test-helpers.server.js";

installGatewayTestHooks({ scope: "suite" });

type GatewayHarness = Awaited<ReturnType<typeof createGatewaySuiteHarness>>;

function recordCompletion(
  run: Promise<void>,
  record: (result: PromiseSettledResult<void>) => void,
): Promise<void> {
  return run.then(
    () => record({ status: "fulfilled", value: undefined }),
    (reason: unknown) => record({ status: "rejected", reason }),
  );
}

describe("public Gateway close approval lifetime", () => {
  it.for(["exec", "plugin"] as const)(
    "retires %s request and decision observers without recording a decision",
    async (kind, { signal }) => {
      const waitEntered = createDeferredCore();
      const completions: {
        request?: PromiseSettledResult<void>;
        wait?: PromiseSettledResult<void>;
      } = {};
      const ownedHandlers: Promise<void>[] = [];
      let approvalId: string | undefined;
      let releaseApproval: (() => void) | undefined;
      const originalRequest = approvalShared.handlePendingApprovalRequest;
      const originalWait = approvalShared.handleApprovalWaitDecision;
      const requestObservation = vi
        .spyOn(approvalShared, "handlePendingApprovalRequest")
        .mockImplementation((params) => {
          const run = originalRequest(params);
          if (params.approvalKind === kind) {
            approvalId = params.record.id;
            releaseApproval = () => {
              const record = params.manager.getLiveSnapshot(params.record.id);
              if (record && record.resolvedAtMs === undefined) {
                params.manager.resolve(record.id, "deny", "lifetime proof cleanup");
              }
            };
            ownedHandlers.push(
              recordCompletion(run, (result) => {
                completions.request = result;
              }),
            );
          }
          return run;
        });
      const waitObservation = vi
        .spyOn(approvalShared, "handleApprovalWaitDecision")
        .mockImplementation((params) => {
          const run = originalWait(params);
          if (params.inputId === approvalId) {
            ownedHandlers.push(
              recordCompletion(run, (result) => {
                completions.wait = result;
              }),
            );
            waitEntered.resolve();
          }
          return run;
        });
      const releasePending = () => releaseApproval?.();
      signal.addEventListener("abort", releasePending, { once: true });
      let gateway: GatewayHarness | undefined;
      let requester: WebSocket | undefined;
      let observer: WebSocket | undefined;
      let observerRpc: Promise<unknown> | undefined;
      let closing: Promise<void> | undefined;
      let releaseTimer: ReturnType<typeof setTimeout> | undefined;
      let emergencyResolution = false;
      try {
        gateway = await createGatewaySuiteHarness({
          serverOptions: { bind: "loopback", auth: { mode: "none" } },
        });
        await gateway.server.startupSettled;
        requester = await gateway.openWs();
        await connectOk(requester, { scopes: ["operator.admin"] });
        observer = await gateway.openWs();
        await connectOk(observer, {
          scopes: ["operator.admin"],
          caps: [GATEWAY_CLIENT_CAPS.APPROVALS],
        });
        const params =
          kind === "exec"
            ? {
                id: randomUUID(),
                command: "printf approval-lifetime",
                requireDeliveryRoute: false,
                suppressDelivery: true,
                twoPhase: true,
                timeoutMs: 600_000,
              }
            : {
                pluginId: "example",
                title: "Approval lifetime proof",
                description: "Synthetic operation; no action is executed.",
                twoPhase: true,
                timeoutMs: 600_000,
              };
        const accepted = await rpcReq<{ id: string; status: string }>(
          requester,
          `${kind}.approval.request`,
          params,
        );
        expect(accepted.ok).toBe(true);
        expect(accepted.payload?.status).toBe("accepted");
        const id = expectDefined(accepted.payload, "accepted approval").id;
        expect(approvalId).toBe(id);
        const beforeClose = getOperatorApprovalDetailed({ id });
        expect(beforeClose).toMatchObject({ outcome: "found", record: { status: "pending" } });

        const disconnected = once(requester, "close");
        requester.close();
        await disconnected;
        await nextTurn();
        expect(completions.request).toBeUndefined();

        observerRpc = rpcReq(observer, `${kind}.approval.waitDecision`, { id });
        void observerRpc.catch(() => {});
        await Promise.race([
          waitEntered.promise,
          observerRpc.then(() => {
            throw new Error("approval wait returned before observing the pending decision");
          }),
        ]);
        expect(completions.wait).toBeUndefined();
        // The broken join is released with a real denial, never an abandoned handler.
        releaseTimer = setTimeout(() => {
          emergencyResolution = true;
          releasePending();
        }, 5_000);
        closing = gateway.server.close({ reason: "approval lifetime proof", drainTimeoutMs: 0 });
        await closing;
        expect(emergencyResolution).toBe(false);
        expect(completions.request?.status).toBe("rejected");
        expect(completions.wait?.status).toBe("rejected");
        expect(getOperatorApprovalDetailed({ id })).toEqual(beforeClose);
      } finally {
        clearTimeout(releaseTimer);
        releasePending();
        await Promise.all(ownedHandlers);
        requester?.terminate();
        observer?.terminate();
        await observerRpc?.catch(() => {});
        await (closing ?? gateway?.server.close({ drainTimeoutMs: 0 }));
        requestObservation.mockRestore();
        waitObservation.mockRestore();
        signal.removeEventListener("abort", releasePending);
      }
    },
  );

  it.for(["allow-once", "expired"] as const)(
    "keeps a recorded %s handoff when close races its promise continuation",
    async (terminal, { signal }) => {
      const pendingId = randomUUID();
      const committedId = randomUUID();
      const handoffEntered = createDeferredCore();
      const releaseHandoff = createDeferredCore();
      const ownedHandlers: Promise<void>[] = [];
      const outcomes = new Map<string, PromiseSettledResult<void>>();
      const cleanupApprovals: Array<() => void> = [];
      const decisions: unknown[] = [];
      const observations: {
        commit?: () => boolean;
        bindingRetained?: boolean;
        consumed?: boolean;
        handoffFinished: boolean;
        closed: boolean;
      } = { handoffFinished: false, closed: false };
      const originalRequest = approvalShared.handlePendingApprovalRequest;
      const requestObservation = vi
        .spyOn(approvalShared, "handlePendingApprovalRequest")
        .mockImplementation((params) => {
          const id = params.record.id;
          if (id !== pendingId && id !== committedId) {
            return originalRequest(params);
          }
          cleanupApprovals.push(() => {
            const record = params.manager.getLiveSnapshot(id);
            if (record && record.resolvedAtMs === undefined) {
              params.manager.resolve(id, "deny", "lifetime proof cleanup");
            }
          });
          if (id === committedId) {
            observations.commit = () =>
              terminal === "allow-once"
                ? params.manager.resolve(id, "allow-once", "lifetime proof reviewer")
                : params.manager.expire(id);
          }
          const afterDecision = params.afterDecision;
          const run = originalRequest({
            ...params,
            afterDecision: async (decision, event) => {
              await afterDecision?.(decision, event);
              if (id !== committedId) {
                return;
              }
              decisions.push(decision);
              handoffEntered.resolve();
              await releaseHandoff.promise;
              observations.bindingRetained = params.manager.getLiveSnapshot(id) !== null;
              if (decision === "allow-once") {
                observations.consumed = params.manager.consumeAllowOnce(
                  id,
                  "lifetime proof handoff",
                );
              }
              observations.handoffFinished = true;
            },
          });
          ownedHandlers.push(
            recordCompletion(run, (result) => {
              outcomes.set(id, result);
            }),
          );
          return run;
        });
      const releaseOwnedWork = () => {
        for (const settle of cleanupApprovals) {
          settle();
        }
        releaseHandoff.resolve();
      };
      signal.addEventListener("abort", releaseOwnedWork, { once: true });
      let gateway: GatewayHarness | undefined;
      let ws: WebSocket | undefined;
      let closing: Promise<void> | undefined;
      let releaseTimer: ReturnType<typeof setTimeout> | undefined;
      let emergencyRelease = false;
      try {
        gateway = await createGatewaySuiteHarness({
          serverOptions: { bind: "loopback", auth: { mode: "none" } },
        });
        await gateway.server.startupSettled;
        ws = await gateway.openWs();
        await connectOk(ws, { scopes: ["operator.admin"] });
        for (const id of [pendingId, committedId]) {
          const accepted = await rpcReq<{ status: string }>(ws, "exec.approval.request", {
            id,
            command: "printf approval-handoff",
            suppressDelivery: true,
            requireDeliveryRoute: false,
            twoPhase: true,
            timeoutMs: 600_000,
          });
          expect(accepted.ok).toBe(true);
          expect(accepted.payload?.status).toBe("accepted");
        }
        releaseTimer = setTimeout(() => {
          emergencyRelease = true;
          releaseOwnedWork();
        }, 5_000);
        // Commit synchronously, then close before the fulfilled decision's microtask runs.
        expect(expectDefined(observations.commit, "recorded approval transition")()).toBe(true);
        closing = gateway.server
          .close({ reason: "committed approval handoff proof", drainTimeoutMs: 0 })
          .then(() => {
            observations.closed = true;
          });
        await handoffEntered.promise;
        await nextTurn();
        expect(decisions).toEqual([terminal === "allow-once" ? "allow-once" : null]);
        expect(outcomes.get(pendingId)?.status).toBe("rejected");
        expect(observations.handoffFinished).toBe(false);
        expect(observations.closed).toBe(false);
        releaseHandoff.resolve();
        await closing;
        expect(emergencyRelease).toBe(false);
        expect(outcomes.get(committedId)?.status).toBe("fulfilled");
        expect(observations.bindingRetained).toBe(true);
        expect(observations.handoffFinished).toBe(true);
        if (terminal === "allow-once") {
          expect(observations.consumed).toBe(true);
        }
        expect(getOperatorApprovalDetailed({ id: pendingId })).toMatchObject({
          outcome: "found",
          record: { status: "pending", decision: null, terminalReason: null },
        });
        expect(getOperatorApprovalDetailed({ id: committedId })).toMatchObject({
          outcome: "found",
          record: {
            status: terminal === "allow-once" ? "allowed" : "expired",
            decision: terminal === "allow-once" ? "allow-once" : "deny",
            terminalReason: terminal === "allow-once" ? "user" : "timeout",
          },
        });
      } finally {
        clearTimeout(releaseTimer);
        releaseOwnedWork();
        await Promise.all(ownedHandlers);
        ws?.terminate();
        await (closing ?? gateway?.server.close({ drainTimeoutMs: 0 }));
        requestObservation.mockRestore();
        signal.removeEventListener("abort", releaseOwnedWork);
      }
    },
  );
});
