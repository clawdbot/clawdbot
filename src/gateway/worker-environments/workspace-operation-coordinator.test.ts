import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../shared/deferred.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";

describe("worker workspace operation coordinator", () => {
  it("drains local reconciliation before forced teardown for the same environment", async () => {
    const coordinator = createWorkerWorkspaceOperationCoordinator();
    const release = createDeferred();
    const log: string[] = [];
    const reconciliation = coordinator.run("worker-1", async () => {
      log.push("reconcile:start");
      await release.promise;
      log.push("reconcile:done");
    });
    await vi.waitFor(() => expect(log).toEqual(["reconcile:start"]));

    const teardown = coordinator.run("worker-1", async () => {
      log.push("teardown");
    });
    await Promise.resolve();
    expect(log).toEqual(["reconcile:start"]);

    release.resolve();
    await Promise.all([reconciliation, teardown]);
    expect(log).toEqual(["reconcile:start", "reconcile:done", "teardown"]);
  });
});
