import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { NodeWorkerLaunchStore } from "./node-worker-launch-store.js";
import {
  inspectNodeWorkerProcessIdentity,
  requireNodeWorkerProcessIdentity,
} from "./node-worker-process-identity.js";
import { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import {
  TEST_WORKER_CREDENTIAL,
  TEST_WORKER_SOURCE,
  testWorkerDescriptor,
  testWorkerLaunchInput,
  writeNodeWorkerFixture,
} from "./node-worker-supervisor.test-support.js";

type NodeWorkerSupervisor = ReturnType<typeof createNodeWorkerSupervisor>;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  resetSecretRedactionRegistryForTest();
  closeOpenClawStateDatabaseForTest();
});

function fixture() {
  const root = tempDirs.make("node-worker-supervisor-");
  const { bundleRoot, env, stateDir, workspaceDir } = writeNodeWorkerFixture(root);
  const supervisor = createNodeWorkerSupervisor({ bundleRoot, env });
  return { bundleRoot, env, root, stateDir, supervisor, workspaceDir };
}

function launchInput(workspaceDir: string, launchId: string, prompt = "success") {
  return testWorkerLaunchInput(workspaceDir, launchId, prompt);
}

async function waitForTerminal(supervisor: NodeWorkerSupervisor, launchId: string) {
  await vi.waitFor(
    () => {
      expect(supervisor.status(launchId)?.state).not.toMatch(/^(?:pending|running)$/u);
    },
    { timeout: 5_000 },
  );
  const receipt = supervisor.status(launchId);
  if (!receipt) {
    throw new Error(`missing launch receipt ${launchId}`);
  }
  return receipt;
}

describe("node worker supervisor", () => {
  it("keeps construction and close inert without resolving process identity", async () => {
    const root = tempDirs.make("node-worker-inert-");
    const { bundleRoot, env } = writeNodeWorkerFixture(root);
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    const spawnSync = vi.spyOn(childProcess, "spawnSync");
    const execFileSync = vi.spyOn(childProcess, "execFileSync");
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    try {
      const supervisor = createNodeWorkerSupervisor({ bundleRoot, env });
      await supervisor.close();
      expect(spawnSync).not.toHaveBeenCalled();
      expect(execFileSync).not.toHaveBeenCalled();
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    }
  });

  it("keeps the additive table absent until the first stateful operation", async () => {
    const { bundleRoot, env, supervisor } = fixture();
    const database = openOpenClawStateDatabase({ env });
    const findTable = () =>
      database.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("node_worker_launches");

    expect(findTable()).toBeUndefined();
    await supervisor.close();
    expect(findTable()).toBeUndefined();

    const active = createNodeWorkerSupervisor({ bundleRoot, env });
    expect(active.status("missing-launch")).toBeUndefined();
    expect(
      database.db
        .prepare("SELECT strict FROM pragma_table_list WHERE name = ?")
        .get("node_worker_launches"),
    ).toEqual({ strict: 1 });
    await active.close();
  });

  it("keeps pending and running launches owned by a live supervisor unchanged", async () => {
    const { bundleRoot, env, supervisor } = fixture();
    supervisor.status("schema-probe");
    const database = openOpenClawStateDatabase({ env }).db;
    const supervisorIdentity = requireNodeWorkerProcessIdentity(process.pid);
    const insert = database.prepare(`
      INSERT INTO node_worker_launches (
        launch_id, plan_hash, gateway_namespace, environment_id, session_id,
        owner_epoch, placement_generation, run_id, state,
        supervisor_pid, supervisor_start_time, worker_pid, worker_start_time,
        result_json, error_text, completed_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, 'gateway-1', 'environment-1', 'session-1', 3, 4, 'run-1', ?, ?, ?, ?, ?, NULL, NULL, NULL, 1, 1)
    `);
    insert.run(
      "pending-launch",
      "b".repeat(64),
      "pending",
      supervisorIdentity.pid,
      supervisorIdentity.startTime,
      null,
      null,
    );
    insert.run(
      "running-launch",
      "c".repeat(64),
      "running",
      supervisorIdentity.pid,
      supervisorIdentity.startTime,
      process.pid,
      supervisorIdentity.startTime,
    );

    const sameHandle = createNodeWorkerSupervisor({ bundleRoot, env });
    expect(sameHandle.status("pending-launch")).toMatchObject({ state: "pending", worker: null });
    expect(sameHandle.status("running-launch")).toMatchObject({
      state: "running",
      worker: supervisorIdentity,
    });
    await supervisor.close();
    await sameHandle.close();
    closeOpenClawStateDatabaseForTest();

    openOpenClawStateDatabase({ env });
    const recovered = createNodeWorkerSupervisor({ bundleRoot, env });
    expect(recovered.status("pending-launch")).toMatchObject({ state: "pending", worker: null });
    expect(recovered.status("running-launch")).toMatchObject({
      state: "running",
      worker: supervisorIdentity,
    });
    await recovered.close();
  });

  it("launches idempotently and persists only bounded non-secret facts", async () => {
    const { env, supervisor, workspaceDir } = fixture();
    const input = launchInput(workspaceDir, "success-launch");

    expect(await supervisor.launch(input)).toMatchObject({
      launchId: "success-launch",
      state: "running",
      environmentId: "environment-1",
      sessionId: "session-1",
      ownerEpoch: 3,
      placementGeneration: 4,
      runId: "run-1",
    });
    const completed = await waitForTerminal(supervisor, input.launchId);
    expect(completed).toMatchObject({ state: "completed", errorText: null });
    expect(JSON.parse(completed.resultJson ?? "null")).toEqual({
      argv: ["worker", "--internal-worker-ipc"],
      status: "completed",
    });
    expect(await supervisor.launch(input)).toEqual(completed);
    await expect(
      supervisor.launch({
        ...input,
        descriptor: testWorkerDescriptor(workspaceDir, "different-plan"),
      }),
    ).rejects.toThrow("replayed with a different plan");

    const row = openOpenClawStateDatabase({ env })
      .db.prepare("SELECT * FROM node_worker_launches WHERE launch_id = ?")
      .get(input.launchId);
    expect(JSON.stringify(row)).not.toContain(TEST_WORKER_CREDENTIAL);
    await supervisor.close();
  });

  it("bounds output and scrubs launch credentials after registry eviction", async () => {
    const { supervisor, workspaceDir } = fixture();
    const successInput = launchInput(workspaceDir, "secret-success-launch", "secret-success");
    const failureInput = launchInput(workspaceDir, "failure-launch", "secret-fail");
    const overflowInput = launchInput(workspaceDir, "overflow-launch", "overflow");

    await supervisor.launch(successInput);
    await supervisor.launch(failureInput);
    await supervisor.launch(overflowInput);
    for (let index = 0; index < 600; index += 1) {
      registerSecretValueForRedaction(`eviction-secret-${index}`);
    }
    const success = await waitForTerminal(supervisor, successInput.launchId);
    const failure = await waitForTerminal(supervisor, failureInput.launchId);
    const overflow = await waitForTerminal(supervisor, overflowInput.launchId);
    const representations = [
      TEST_WORKER_CREDENTIAL,
      encodeURIComponent(TEST_WORKER_CREDENTIAL),
      JSON.stringify(TEST_WORKER_CREDENTIAL).slice(1, -1),
    ];
    expect(success.state).toBe("completed");
    expect(JSON.parse(success.resultJson ?? "null")).toEqual({
      raw: "[REDACTED]",
      encoded: "[REDACTED]",
      status: "completed",
    });
    expect(failure.state).toBe("failed");
    expect(Buffer.byteLength(failure.errorText ?? "", "utf8")).toBeLessThanOrEqual(4 * 1024);
    for (const representation of representations) {
      expect(success.resultJson).not.toContain(representation);
      expect(failure.errorText).not.toContain(representation);
    }
    expect(overflow).toMatchObject({
      state: "failed",
      errorText: expect.stringContaining("stdout exceeded 65536 bytes"),
    });
    await supervisor.close();
  });

  it("does not open or signal a child after markRunning observes its terminal receipt", async () => {
    const { supervisor, workspaceDir } = fixture();
    const input = launchInput(workspaceDir, "fast-terminal-launch", "fast-terminal");
    vi.spyOn(NodeWorkerLaunchStore.prototype, "markRunning").mockImplementation(
      function (this: NodeWorkerLaunchStore, params) {
        return this.finish({
          launchId: params.launchId,
          planHash: params.planHash,
          supervisor: params.supervisor,
          worker: null,
          state: "completed",
          resultJson: '{"status":"completed"}',
        });
      },
    );

    expect(await supervisor.launch(input)).toMatchObject({ state: "completed" });
    const marker = path.join(workspaceDir, "fast-terminal-marker");
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
    expect(fs.existsSync(marker)).toBe(false);
    await supervisor.close();
  });

  it("records a gated child that exits before journal readiness as terminal", async () => {
    const { supervisor, workspaceDir } = fixture();
    const input = launchInput(workspaceDir, "prestart-exit-launch", "exit-before-start");
    const exitedPath = path.join(workspaceDir, "prestart-exited");

    await supervisor.launch(input);
    const terminal = await waitForTerminal(supervisor, input.launchId);

    expect(fs.existsSync(exitedPath)).toBe(true);
    expect(terminal.state).toBe("failed");
    await supervisor.close();
  });

  it.each([
    ["cancel", "cancelled"],
    ["close", "interrupted"],
  ] as const)("records %s while awaiting the owned child", async (operation, state) => {
    const { supervisor, workspaceDir } = fixture();
    const input = launchInput(workspaceDir, `${operation}-launch`, "wait");
    expect(await supervisor.launch(input)).toMatchObject({ state: "running" });

    if (operation === "cancel") {
      await supervisor.cancel(input.launchId);
    } else {
      await supervisor.close();
    }

    expect(supervisor.status(input.launchId)).toMatchObject({
      state,
      worker: { pid: expect.any(Number), startTime: expect.any(Number) },
    });
    await supervisor.close();
  });

  it.each([
    ["cancel", "cancelled"],
    ["close", "interrupted"],
  ] as const)(
    "%s during startup closes the gate before worker code runs",
    async (operation, state) => {
      const { supervisor, workspaceDir } = fixture();
      const input = launchInput(workspaceDir, `${operation}-startup-launch`, "tree");
      const originalMarkRunning = Object.getOwnPropertyDescriptor(
        NodeWorkerLaunchStore.prototype,
        "markRunning",
      )?.value as NodeWorkerLaunchStore["markRunning"];
      let stopping: Promise<unknown> | undefined;
      vi.spyOn(NodeWorkerLaunchStore.prototype, "markRunning").mockImplementation(
        function (this: NodeWorkerLaunchStore, params) {
          const receipt = Reflect.apply(originalMarkRunning, this, [params]);
          stopping =
            operation === "cancel" ? supervisor.cancel(input.launchId) : supervisor.close();
          return receipt;
        },
      );

      await supervisor.launch(input);
      await stopping;

      expect(supervisor.status(input.launchId)?.state).toBe(state);
      expect(fs.existsSync(path.join(workspaceDir, "grandchild.pid"))).toBe(false);
      await supervisor.close();
    },
  );

  it.each([
    ["cancel", "cancelled"],
    ["close", "interrupted"],
  ] as const)("%s terminates the worker-owned grandchild", async (operation, state) => {
    const { supervisor, workspaceDir } = fixture();
    const input = launchInput(workspaceDir, `${operation}-tree-launch`, "tree");
    const running = await supervisor.launch(input);
    expect(running.state).toBe("running");
    const grandchildPath = path.join(workspaceDir, "grandchild.pid");
    await vi.waitFor(() => expect(fs.existsSync(grandchildPath)).toBe(true));
    const grandchildPid = Number(fs.readFileSync(grandchildPath, "utf8"));
    const grandchild = requireNodeWorkerProcessIdentity(grandchildPid);
    expect(inspectNodeWorkerProcessIdentity(grandchild)).toBe("live");

    if (operation === "cancel") {
      await supervisor.cancel(input.launchId);
    } else {
      await supervisor.close();
    }

    const terminal = supervisor.status(input.launchId);
    expect(terminal).toMatchObject({ state, worker: running.worker });
    await vi.waitFor(() => {
      expect(inspectNodeWorkerProcessIdentity(running.worker!)).not.toBe("live");
      expect(inspectNodeWorkerProcessIdentity(grandchild)).not.toBe("live");
    });
    await supervisor.close();
  });

  it("fails closed when the bundle entry resolves outside its namespaced bundle", async () => {
    const { bundleRoot, root, supervisor, workspaceDir } = fixture();
    const escapedHash = "b".repeat(64);
    const escapedBundle = path.join(bundleRoot, "gateway-1", "bundles", escapedHash);
    const outsideEntry = path.join(root, "outside.mjs");
    fs.mkdirSync(escapedBundle, { recursive: true });
    fs.writeFileSync(outsideEntry, TEST_WORKER_SOURCE);
    fs.symlinkSync(outsideEntry, path.join(escapedBundle, "openclaw.mjs"));
    const input = launchInput(workspaceDir, "escaped-entry");
    input.bundleHash = escapedHash;
    input.descriptor.admission.handshake.bundleHash = escapedHash;

    expect(await supervisor.launch(input)).toMatchObject({
      state: "failed",
      errorText: expect.stringContaining("inside its bundle"),
    });
    await supervisor.close();
  });
});
