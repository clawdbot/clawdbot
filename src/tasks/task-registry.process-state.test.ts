// Verifies process-state persistence across fresh task registry module loads.
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";

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
});
