import { afterEach, describe, expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { getDetachedTaskLifecycleRuntime } from "./detached-task-runtime.js";
import { getTaskById } from "./task-registry.js";
import {
  previewTaskRegistryMaintenance,
  reconcileInspectableTasks,
  resetTaskRegistryMaintenanceRuntimeForTests,
  runTaskRegistryMaintenance,
} from "./task-registry.maintenance.js";
import { createTaskFixture } from "./task-registry.test-support.js";
import {
  resetDetachedTaskLifecycleRuntimeForTests,
  setDetachedTaskLifecycleRuntime,
  resetTaskRegistryForTests,
} from "./task-runtime.test-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  resetDetachedTaskLifecycleRuntimeForTests();
  resetTaskRegistryMaintenanceRuntimeForTests();
  resetTaskRegistryForTests({ persist: false });
  await drainGlobalSingletonLifecycleState("close");
});

describe("task maintenance session metadata", () => {
  it("reconciles backing and wedged children without decoding their saved prompts", async () => {
    await withStateDirEnv("openclaw-task-maintenance-metadata-", async () => {
      resetTaskRegistryForTests({ persist: false });
      const staleAt = Date.now() - 45 * 60_000;
      for (const agentId of ["main", "worker"]) {
        for (const suffix of ["healthy", "wedged", "unrelated"]) {
          replaceSessionEntrySync(
            { agentId, sessionKey: `agent:${agentId}:subagent:${suffix}` },
            {
              sessionId: `${agentId}-${suffix}`,
              updatedAt: staleAt,
              skillsSnapshot: { prompt: "maintenance-proof-saved-prompt".repeat(1024), skills: [] },
              ...(suffix === "wedged"
                ? { subagentRecovery: { wedgedAt: staleAt, wedgedReason: "Recovery tombstoned" } }
                : {}),
            },
          );
        }
      }
      const tasks = ["healthy", "wedged", "missing"].map((suffix) =>
        createTaskFixture("subagent", {
          task: `Check ${suffix}`,
          runId: `maintenance-${suffix}`,
          childSessionKey: `agent:worker:subagent:${suffix}`,
          lastEventAt: staleAt,
          notifyPolicy: "silent",
        }),
      );
      const parse = vi.spyOn(JSON, "parse");
      expect(previewTaskRegistryMaintenance().reconciled).toBe(2);
      expect(reconcileInspectableTasks().map(({ status, error }) => ({ status, error }))).toEqual(
        expect.arrayContaining([
          { status: "running", error: undefined },
          { status: "lost", error: "Recovery tombstoned" },
          { status: "lost", error: "backing session missing" },
        ]),
      );
      expect(await runTaskRegistryMaintenance()).toMatchObject({ reconciled: 2 });
      expect(tasks.map((task) => getTaskById(task.taskId)?.status)).toEqual([
        "running",
        "lost",
        "lost",
      ]);
      expect(
        parse.mock.calls.filter(([json]) => json.includes("maintenance-proof-saved-prompt")).length,
      ).toBe(0);
    });
  });
  it("keeps warm corrupt-row handling while reconciling healthy siblings", async () => {
    await withStateDirEnv("openclaw-task-maintenance-corruption-", async () => {
      resetTaskRegistryForTests({ persist: false });
      const staleAt = Date.now() - 45 * 60_000;
      const tasks = ["healthy", "corrupt"].map((suffix) => {
        const sessionKey = `agent:main:subagent:${suffix}`;
        replaceSessionEntrySync({ sessionKey }, { sessionId: suffix, updatedAt: staleAt });
        return createTaskFixture("subagent", {
          task: `Check ${suffix}`,
          runId: `maintenance-${suffix}`,
          childSessionKey: sessionKey,
          lastEventAt: staleAt,
          notifyPolicy: "silent",
        });
      });
      expect(previewTaskRegistryMaintenance().reconciled).toBe(0);
      // Existing warm listings skip malformed rows; exact reads intentionally throw.
      openOpenClawAgentDatabase({ agentId: "main" })
        .db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
        .run("{", "agent:main:subagent:corrupt");
      expect(previewTaskRegistryMaintenance().reconciled).toBe(1);
      expect(await runTaskRegistryMaintenance()).toMatchObject({ reconciled: 1 });
      expect(tasks.map((task) => getTaskById(task.taskId)?.status)).toEqual(["running", "lost"]);
    });
  });

  it("sees backing metadata repaired by the recovery hook", async () => {
    await withStateDirEnv("openclaw-task-maintenance-recovery-", async () => {
      resetTaskRegistryForTests({ persist: false });
      const staleAt = Date.now() - 45 * 60_000;
      const scope = { sessionKey: "agent:main:subagent:recovered" };
      replaceSessionEntrySync(scope, {
        sessionId: "recovered",
        updatedAt: staleAt,
        subagentRecovery: { wedgedAt: staleAt },
      });
      const task = createTaskFixture("subagent", {
        task: "Recover child",
        runId: "maintenance-recovered",
        childSessionKey: scope.sessionKey,
        lastEventAt: staleAt,
        notifyPolicy: "silent",
      });
      setDetachedTaskLifecycleRuntime({
        ...getDetachedTaskLifecycleRuntime(),
        tryRecoverTaskBeforeMarkLost: async () => {
          await Promise.resolve();
          replaceSessionEntrySync(scope, { sessionId: "recovered", updatedAt: Date.now() });
          return { recovered: false };
        },
      });
      expect(await runTaskRegistryMaintenance()).toMatchObject({ reconciled: 0 });
      expect(getTaskById(task.taskId)?.status).toBe("running");
    });
  });
});
