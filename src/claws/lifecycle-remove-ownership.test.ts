import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { readSourceConfigBestEffort, resetConfigRuntimeState } from "../config/config.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { readAgentDeletionJournal } from "../state/agent-deletion-journal.js";
import { listOpenClawRegisteredAgentDatabases } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabases,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { applyClawAddPlan } from "./add.js";
import type { ClawRemoveApplyOptions, ClawRemoveResult } from "./lifecycle-remove-contract.js";
import {
  buildClawRemovalFixture,
  quiescentClawMonitorGateway,
} from "./lifecycle-remove.test-support.js";
import { applyClawRemovePlan, buildClawRemovePlan } from "./lifecycle-state.js";
import { readClawInstallRecord } from "./provenance.js";
import { readClawWorkspaceFiles } from "./workspace.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

async function fixture(withFile = false) {
  const state = await createOpenClawTestState({ prefix: "claw-removal-owner-" });
  cleanups.push(() => state.cleanup());
  await state.writeConfig({});
  const install = async (name: string) => {
    const root = state.path(name);
    await fs.mkdir(root);
    const added = await buildClawRemovalFixture(root, { withFile, name: `@synthetic/${name}` });
    expect(
      await applyClawAddPlan(added.plan, {
        consentPlanIntegrity: added.plan.planIntegrity,
        commitConfig: async (transform) => {
          await state.writeConfig(transform(await readSourceConfigBestEffort()));
          resetConfigRuntimeState();
        },
      }),
    ).toMatchObject({ status: "complete" });
    return added.plan.agent.workspace;
  };
  const workspace = await install("initial");
  const trashPath: NonNullable<ClawRemoveApplyOptions["trashPath"]> = async (pathname) => {
    await fs.rm(pathname, { recursive: true, force: true });
    return true;
  };
  const remove = async (overrides: Partial<ClawRemoveApplyOptions> = {}) => {
    const config = await readSourceConfigBestEffort();
    const plan = await buildClawRemovePlan("worker", { config });
    expect(plan.blockers).toEqual([]);
    return await applyClawRemovePlan(plan, {
      config,
      monitorGateway: quiescentClawMonitorGateway,
      consentPlanIntegrity: plan.planIntegrity,
      trashPath,
      ...overrides,
    });
  };
  return { state, workspace, install, remove, trashPath };
}

function expireDeletionLease(): void {
  // A live deletion serializes successors; expiry models the recovery boundary.
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<Pick<DB, "state_leases">>(db)
        .updateTable("state_leases")
        .set({ expires_at: 0 })
        .where("scope", "=", "core:agent-deletion")
        .where("lease_key", "=", "worker"),
    );
  });
}

describe("Claw removal operation ownership", () => {
  it.each([
    { successor: "removing", reject: false },
    { successor: "removing", reject: true },
    { successor: "reinstalled", reject: false },
    { successor: "reinstalled", reject: true },
    { successor: "removed", reject: false },
    { successor: "removed", reject: true },
  ])("does not mark $successor partial after stale quiescence (reject=$reject)", async (test) => {
    const current = await fixture();
    const entered = createDeferred<string>();
    const release = createDeferred();
    const enteredNext = createDeferred<string>();
    const releaseNext = createDeferred();
    let next: Promise<ClawRemoveResult> | undefined;
    const stale = current.remove({
      monitorGateway: {
        ...quiescentClawMonitorGateway,
        quiesce: async (_agentId, operationId) => {
          entered.resolve(operationId);
          await release.promise;
          if (test.reject) {
            throw new Error("original quiescence failure");
          }
        },
      },
    });
    try {
      const originalOperation = await entered.promise;
      expireDeletionLease();
      next = current.remove({
        monitorGateway: {
          ...quiescentClawMonitorGateway,
          quiesce: async (_agentId, operationId) => {
            enteredNext.resolve(operationId);
            if (test.successor === "removing") {
              await releaseNext.promise;
            }
          },
        },
      });
      expect(await enteredNext.promise).not.toBe(originalOperation);
      if (test.successor !== "removing") {
        expect(await next).toMatchObject({ status: "complete" });
        if (test.successor === "reinstalled") {
          await current.install("replacement");
        }
      }
      const before = readClawInstallRecord("worker");
      const journal = readAgentDeletionJournal("worker");
      expect(before?.status).toBe(test.successor === "removed" ? undefined : "complete");
      release.resolve();
      expect(await stale).toMatchObject({
        status: "partial",
        error: {
          code: "monitor_cleanup_failed",
          message: expect.stringMatching(
            test.reject
              ? /original quiescence failure|agent deletion core:agent-deletion\/worker was lost/
              : /no longer owns|agent deletion core:agent-deletion\/worker was lost/,
          ),
        },
      });
      expect(readClawInstallRecord("worker")).toEqual(before);
      expect(readAgentDeletionJournal("worker")).toEqual(journal);
      releaseNext.resolve();
      expect(await next).toMatchObject({ status: "complete" });
    } finally {
      release.resolve();
      releaseNext.resolve();
      await Promise.allSettled([stale, next]);
    }
  });

  it("preserves a late partial result without publishing into the successor's install", async () => {
    const current = await fixture();
    const entered = createDeferred();
    const release = createDeferred();
    const enteredNext = createDeferred();
    const releaseNext = createDeferred();
    let next: Promise<ClawRemoveResult> | undefined;
    const stale = current.remove({
      purgeSessions: async () => {
        entered.resolve();
        await release.promise;
        return true;
      },
    });
    try {
      await entered.promise;
      expireDeletionLease();
      next = current.remove({
        monitorGateway: {
          ...quiescentClawMonitorGateway,
          quiesce: async () => {
            enteredNext.resolve();
            await releaseNext.promise;
          },
        },
      });
      await enteredNext.promise;
      const before = readClawInstallRecord("worker");
      const journal = readAgentDeletionJournal("worker");
      release.resolve();
      expect(await stale).toMatchObject({
        status: "partial",
        agentRemoved: true,
        error: {
          code: "monitor_cleanup_failed",
          message: expect.stringMatching(
            /no longer owns|agent deletion core:agent-deletion\/worker was lost/,
          ),
        },
      });
      expect(readClawInstallRecord("worker")).toEqual(before);
      expect(readAgentDeletionJournal("worker")).toEqual(journal);
      releaseNext.resolve();
      expect(await next).toMatchObject({ status: "complete" });
    } finally {
      release.resolve();
      releaseNext.resolve();
      await Promise.allSettled([stale, next]);
    }
  });

  it.each([true, false])(
    "keeps terminal registry and provenance writes with their owner (complete=%s)",
    async (complete) => {
      const current = await fixture(true);
      await fs.writeFile(
        path.join(current.workspace, "operator-note.txt"),
        "retain this untracked file",
      );
      openOpenClawAgentDatabase({ agentId: "worker" });
      closeOpenClawAgentDatabases();
      const entered = createDeferred();
      const release = createDeferred();
      const enteredNext = createDeferred();
      const releaseNext = createDeferred();
      let next: Promise<ClawRemoveResult> | undefined;
      const stale = current.remove({
        trashPath: async (pathname, runtime) => {
          await current.trashPath(pathname, runtime);
          if (pathname === current.state.sessionsDir("worker")) {
            entered.resolve();
            await release.promise;
            return complete;
          }
          return true;
        },
      });
      try {
        await entered.promise;
        expireDeletionLease();
        next = current.remove({
          monitorGateway: {
            ...quiescentClawMonitorGateway,
            quiesce: async () => {
              enteredNext.resolve();
              await releaseNext.promise;
            },
          },
        });
        await enteredNext.promise;
        const registry = listOpenClawRegisteredAgentDatabases();
        const install = readClawInstallRecord("worker");
        const files = readClawWorkspaceFiles("worker");
        const journal = readAgentDeletionJournal("worker");
        expect(registry.some((entry) => entry.agentId === "worker")).toBe(true);
        expect(files).toHaveLength(1);
        release.resolve();
        expect(await stale).toMatchObject({
          status: "partial",
          agentRemoved: true,
          error: {
            code: "monitor_cleanup_failed",
            message: expect.stringMatching(
              /no longer owns|agent deletion core:agent-deletion\/worker was lost/,
            ),
          },
        });
        expect(listOpenClawRegisteredAgentDatabases()).toEqual(registry);
        expect(readClawWorkspaceFiles("worker")).toEqual(files);
        expect(readClawInstallRecord("worker")).toEqual(install);
        expect(readAgentDeletionJournal("worker")).toEqual(journal);
        releaseNext.resolve();
        expect(await next).toMatchObject({ status: "complete" });
      } finally {
        release.resolve();
        releaseNext.resolve();
        await Promise.allSettled([stale, next]);
      }
    },
  );
});
