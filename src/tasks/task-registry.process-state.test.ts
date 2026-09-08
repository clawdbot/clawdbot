// Verifies process-state persistence across fresh task registry module loads.
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryTaskRegistryStore } from "../test-utils/task-registry-store.js";

describe("task registry process state", () => {
  it("shares state across duplicate module instances", async () => {
    const firstModule = await importFreshModule<typeof import("./task-registry.process-state.js")>(
      import.meta.url,
      "./task-registry.process-state.js?scope=task-registry-state-a",
    );
    const secondModule = await importFreshModule<typeof import("./task-registry.process-state.js")>(
      import.meta.url,
      "./task-registry.process-state.js?scope=task-registry-state-b",
    );
    const firstState = firstModule.getTaskRegistryProcessState();
    const secondState = secondModule.getTaskRegistryProcessState();

    firstState.tasks.set("task-duplicate", {
      taskId: "task-duplicate",
      runtime: "subagent",
      taskKind: "agent-harness",
      requesterSessionKey: "agent:main:parent",
      ownerKey: "agent:main:parent",
      scopeKind: "session",
      runId: "agent-harness:child-duplicate",
      task: "Duplicate module task",
      status: "running",
      deliveryStatus: "pending",
      notifyPolicy: "silent",
      createdAt: 1,
    });

    expect(secondState.tasks.get("task-duplicate")).toEqual(
      expect.objectContaining({
        runtime: "subagent",
        taskKind: "agent-harness",
        runId: "agent-harness:child-duplicate",
      }),
    );
    firstState.tasks.clear();
  });

  it("does not duplicate task event listeners when modules are reset", async () => {
    const events = await import("../infra/agent-events.js");
    const firstStore = await import("./task-registry.store.js");
    const store = {
      ...createInMemoryTaskRegistryStore(),
      loadSnapshot: () => ({ tasks: new Map(), deliveryStates: new Map() }),
    };
    firstStore.configureTaskRegistryRuntime({ store });
    const firstRegistry = await import("./task-registry.js");
    const firstState = await import("./task-registry-state.js");
    firstState.resetTaskRegistryListenerState();
    events.resetAgentEventsForTest();
    firstRegistry.ensureTaskRegistryReady();

    vi.resetModules();

    const secondStore = await import("./task-registry.store.js");
    secondStore.configureTaskRegistryRuntime({ store });
    const secondRegistry = await import("./task-registry.js");
    const secondState = await import("./task-registry-state.js");

    try {
      secondRegistry.ensureTaskRegistryReady();
      const task = secondRegistry.createTaskRecord({
        runtime: "subagent",
        requesterSessionKey: "agent:main:main",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:main:subagent:listener-reload",
        runId: "run-task-listener-reload",
        task: "Count tool events once",
        status: "running",
        deliveryStatus: "not_applicable",
      });
      expect(task).not.toBeNull();

      for (const name of ["read", "exec"]) {
        events.emitAgentEvent({
          runId: "run-task-listener-reload",
          stream: "tool",
          data: { phase: "start", name },
        });
      }

      expect(secondRegistry.getTaskById(task!.taskId)?.toolUseCount).toBe(2);
      expect(secondRegistry.getTaskById(task!.taskId)?.lastToolName).toBe("exec");
    } finally {
      firstState.resetTaskRegistryListenerState();
      secondState.resetTaskRegistryListenerState();
      events.resetAgentEventsForTest();
      firstStore.resetTaskRegistryRuntimeForTests();
      secondStore.resetTaskRegistryRuntimeForTests();
    }
  });
});
