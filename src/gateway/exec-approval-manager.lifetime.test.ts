import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecApprovalRequestPayload } from "../infra/exec-approvals.js";
import {
  getActiveGatewayRootWorkCount,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseByPath } from "../state/openclaw-state-db.js";
import { ApprovalObserverClosedError } from "./exec-approval-lifecycle.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import { createTestApprovalManager } from "./exec-approval-manager.test-support.js";
import { getOperatorApprovalDetailed } from "./operator-approval-store.js";

const managers: ExecApprovalManager[] = [];
const tempDirs: string[] = [];

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.drain()));
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) {
    closeOpenClawStateDatabaseByPath(path.join(dir, "state.sqlite"));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createManager(
  options: ConstructorParameters<typeof ExecApprovalManager<ExecApprovalRequestPayload>>[0],
) {
  const manager = new ExecApprovalManager(options);
  managers.push(manager);
  return manager;
}

function createPersistentManager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-lifetime-"));
  tempDirs.push(dir);
  const databaseOptions = { path: path.join(dir, "state.sqlite") };
  const onExpired = vi.fn();
  const onLifecycle = vi.fn();
  const manager = createManager({
    persistence: { runtimeEpoch: "approval-lifetime", databaseOptions },
    onExpired,
    onLifecycle,
  });
  return { manager, dir, databaseOptions, onExpired, onLifecycle };
}

describe("ExecApprovalManager lifetime", () => {
  it("closes only its observers and leaves authority and another manager pending", async (testContext) => {
    const first = createTestApprovalManager(testContext);
    const second = createTestApprovalManager(testContext);
    const firstRecord = first.create({ command: "printf first" }, 60_000, "same-id");
    const secondRecord = second.create({ command: "printf second" }, 60_000, "same-id");
    const authority = first.register(firstRecord, 60_000);
    void second.register(secondRecord, 60_000);
    let authoritySettled = false;
    void authority.then(
      () => {
        authoritySettled = true;
      },
      () => {
        authoritySettled = true;
      },
    );
    const rejected = expect(first.awaitDecision(firstRecord.id)).rejects.toBeInstanceOf(
      ApprovalObserverClosedError,
    );
    const secondWait = second.awaitDecision(secondRecord.id);
    let secondSettled = false;
    void secondWait?.then(() => {
      secondSettled = true;
    });

    first.beginClose();
    await rejected;
    expect(first.getLiveSnapshot(firstRecord.id)?.resolvedAtMs).toBeUndefined();
    expect(authoritySettled).toBe(false);
    expect(secondSettled).toBe(false);
    await first.drain();
    expect(authoritySettled).toBe(false);
    expect(second.resolve(secondRecord.id, "allow-once")).toBe(true);
    await expect(secondWait).resolves.toBe("allow-once");
  });

  it("abandons failed preparation without deciding authority or retaining its unused handoff", async (testContext) => {
    const manager = createTestApprovalManager(testContext);
    const record = manager.create({ command: "printf abandoned" }, 60_000, "abandoned-handoff");
    const authority = manager.register(record, 60_000);
    const afterDecision = vi.fn(async () => {});
    const handoff = manager.registerDecisionHandoff(record.id, afterDecision);
    const rejected = expect(handoff.observation).rejects.toBeInstanceOf(
      ApprovalObserverClosedError,
    );

    handoff.abandon();
    await rejected;
    expect(manager.getLiveSnapshot(record.id)?.resolvedAtMs).toBeUndefined();
    expect(manager.resolve(record.id, "allow-once")).toBe(true);
    await expect(authority).resolves.toBe("allow-once");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(afterDecision).not.toHaveBeenCalled();
    expect(manager.getLiveSnapshot(record.id)).toBeNull();
  });

  it("retires expiry and held store entry points without changing the durable pending row", async () => {
    const { manager, dir, databaseOptions, onExpired, onLifecycle } = createPersistentManager();
    const originalDatabaseOptions = { ...databaseOptions };
    const record = manager.create({ command: "printf untouched" }, 60_000, "pending-on-close");
    const authority = manager.register(record, 60_000);
    let authoritySettled = false;
    void authority.then(
      () => {
        authoritySettled = true;
      },
      () => {
        authoritySettled = true;
      },
    );
    const before = getOperatorApprovalDetailed({ id: record.id, databaseOptions });
    if (before.outcome !== "found") {
      throw new Error("expected the registered durable approval");
    }
    const rejected = expect(manager.awaitDecision(record.id)).rejects.toBeInstanceOf(
      ApprovalObserverClosedError,
    );
    manager.retire();
    await Promise.all([rejected, manager.drain()]);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(authoritySettled).toBe(false);
    expect(onExpired).not.toHaveBeenCalled();
    expect(onLifecycle).toHaveBeenCalledOnce();
    // A past read time inspects the stored row without letting the lookup itself expire it.
    expect(
      getOperatorApprovalDetailed({
        id: record.id,
        nowMs: record.createdAtMs,
        databaseOptions,
      }),
    ).toEqual(before);

    closeOpenClawStateDatabaseByPath(originalDatabaseOptions.path);
    databaseOptions.path = path.join(dir, "must-not-open", "state.sqlite");
    expect(manager.resolveDetailed(record.id, "deny", { kind: "system", id: "late" })).toEqual({
      outcome: "not-found",
    });
    expect(
      manager.forceDenyDetailed(record.id, "run-aborted", { kind: "system", id: "late" }),
    ).toEqual({
      outcome: "not-found",
    });
    expect(manager.expire(record.id)).toBe(false);
    expect(manager.resolveAutoReview(record.id)).toBe(false);
    expect(manager.consumeAllowOnce(record.id)).toBe(false);
    expect(manager.reconcileDurableLookup({ outcome: "found", record: before.record })).toBeNull();
    expect(manager.getSnapshot(record.id)).toBeNull();
    expect(manager.listPendingRecords()).toEqual([]);
    expect(() => manager.register(record, 60_000)).toThrow(ApprovalObserverClosedError);
    expect(() => manager.awaitDecision(record.id)).toThrow(ApprovalObserverClosedError);
    expect(() => manager.create({ command: "printf late" }, 60_000)).toThrow(
      ApprovalObserverClosedError,
    );
    expect(fs.existsSync(path.dirname(databaseOptions.path))).toBe(false);
    expect(
      getOperatorApprovalDetailed({
        id: record.id,
        nowMs: record.createdAtMs,
        databaseOptions: originalDatabaseOptions,
      }),
    ).toEqual(before);
  });

  it.for(["allow-once", "expired"] as const)(
    "joins a real %s handoff after its observer leaves and preserves the retained binding",
    async (terminal) => {
      const { manager, databaseOptions } = createPersistentManager();
      const record = manager.create({ command: "printf committed" }, 60_000, "committed-handoff");
      const release = createDeferredCore();
      const decisions: unknown[] = [];
      let consumed: boolean | undefined;
      let bindingRetained = false;
      let drained = false;
      const requester = expectDefined(
        tryBeginGatewayRootWorkAdmission(),
        "approval requester root",
      );
      const { authority, handoff } = await requester
        .run(async () => ({
          authority: manager.register(record, 60_000),
          handoff: manager.registerDecisionHandoff(record.id, async (decision) => {
            decisions.push(decision);
            await release.promise;
            bindingRetained = manager.getLiveSnapshot(record.id) !== null;
            if (decision === "allow-once") {
              consumed = manager.consumeAllowOnce(record.id, "committed-effect");
            }
          }),
        }))
        .finally(requester.release);
      const rejected = expect(handoff.observation).rejects.toBeInstanceOf(
        ApprovalObserverClosedError,
      );
      let draining: Promise<void> | undefined;
      try {
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        manager.beginClose();
        await rejected;
        // Only a real transition retains its resolver root; the pending request stays idle.
        const resolver = expectDefined(
          tryBeginGatewayRootWorkAdmission(),
          "approval resolver root",
        );
        try {
          await resolver.run(async () => {
            expect(
              terminal === "allow-once"
                ? manager.resolve(record.id, "allow-once")
                : manager.expire(record.id),
            ).toBe(true);
          });
        } finally {
          resolver.release();
        }
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        draining = manager.drain().then(() => {
          drained = true;
        });
        await vi.advanceTimersByTimeAsync(20_000);
        expect(drained).toBe(false);
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        expect(manager.consumeAllowOnce(record.id, "late-held-manager")).toBe(false);
        expect(decisions).toEqual([terminal === "allow-once" ? "allow-once" : null]);
        release.resolve();
        await draining;
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        expect(bindingRetained).toBe(true);
        if (terminal === "allow-once") {
          expect(consumed).toBe(true);
        }
        await expect(authority).resolves.toBe(terminal === "allow-once" ? "allow-once" : null);
        expect(getOperatorApprovalDetailed({ id: record.id, databaseOptions })).toMatchObject({
          outcome: "found",
          record:
            terminal === "allow-once"
              ? { status: "allowed", decision: "allow-once", consumedBy: "committed-effect" }
              : { status: "expired", decision: "deny", terminalReason: "timeout" },
        });
      } finally {
        release.resolve();
        manager.beginClose();
        await Promise.allSettled([rejected, draining ?? manager.drain()]);
      }
    },
  );
});
