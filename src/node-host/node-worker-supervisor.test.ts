import childProcess, { type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { NODE_WORKER_CAPACITY_EXHAUSTED_ERROR_CODE } from "../infra/node-commands.js";
import { NODE_WORKER_CAPACITY_MAX } from "../infra/node-runner-inventory.js";
import * as secretRegistry from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import * as processTree from "../process/kill-tree.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { NodeWorkerLaunchStore } from "./node-worker-launch-store.js";
import {
  inspectNodeWorkerProcessIdentity,
  requireNodeWorkerProcessIdentity,
} from "./node-worker-process-identity.js";
import {
  createNodeWorkerSupervisorFixture,
  waitForNodeWorkerTerminal as waitForTerminal,
} from "./node-worker-supervisor.fixture.test-support.js";
import { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import {
  TEST_WORKER_CREDENTIAL,
  TEST_WORKER_ENDPOINT,
  TEST_WORKER_SOURCE,
  testNodeWorkerLaunchIdentity,
  testWorkerDescriptor,
  testWorkerLaunchInput,
  writeNodeWorkerFixture,
} from "./node-worker-supervisor.test-support.js";
import { NodeWorkerTurnStore } from "./node-worker-turn-store.js";

type NodeWorkerSupervisor = ReturnType<typeof createNodeWorkerSupervisor>;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  resetSecretRedactionRegistryForTest();
  closeOpenClawStateDatabaseForTest();
});

function fixture(options: Parameters<typeof createNodeWorkerSupervisor>[0] = {}) {
  return createNodeWorkerSupervisorFixture(tempDirs.make("node-worker-supervisor-"), options);
}

function launchInput(workspaceDir: string, launchId: string, prompt = "success") {
  const input = testWorkerLaunchInput(workspaceDir, launchId, prompt);
  input.descriptor.admission.environmentId = `environment-${launchId}`;
  input.descriptor.admission.sessionId = `session-${launchId}`;
  return input;
}

function evictWorkerCredentialsOnRegistration() {
  const { registerSecretValueForRedaction } = secretRegistry;
  // Both launch paths register before sending a turn. Evict every registration so a
  // later launch cannot restore the global secret and hide a missing worker scrubber.
  return vi.spyOn(secretRegistry, "registerSecretValueForRedaction").mockImplementation((value) => {
    registerSecretValueForRedaction(value);
    for (let index = 0; index < 600; index += 1) {
      registerSecretValueForRedaction(`eviction-secret-${index}`);
    }
    expect(secretRegistry.isSecretValueRegisteredForRedaction(value)).toBe(false);
  });
}

describe("node worker supervisor", () => {
  it.each([
    { availableParallelism: 0, expected: 1 },
    { availableParallelism: 7, expected: 7 },
    { availableParallelism: NODE_WORKER_CAPACITY_MAX + 1, expected: NODE_WORKER_CAPACITY_MAX },
  ])(
    "publishes $expected default worker slots for $availableParallelism available CPUs",
    async ({ availableParallelism, expected }) => {
      vi.spyOn(os, "availableParallelism").mockReturnValue(availableParallelism);
      const capacitySnapshots: Array<{ total: number; available: number }> = [];
      const { supervisor } = fixture({
        onCapacityChanged: (capacity) => capacitySnapshots.push(capacity),
      });

      try {
        await supervisor.initialize();
        expect(capacitySnapshots.at(-1)).toEqual({ total: expected, available: expected });
      } finally {
        await supervisor.close();
      }
    },
  );

  it("uses explicit worker capacity without resolving the CPU default", async () => {
    const availableParallelism = vi.spyOn(os, "availableParallelism");
    const capacitySnapshots: Array<{ total: number; available: number }> = [];
    const { supervisor } = fixture({
      capacity: 3,
      onCapacityChanged: (capacity) => capacitySnapshots.push(capacity),
    });

    try {
      await supervisor.initialize();
      expect(capacitySnapshots.at(-1)).toEqual({ total: 3, available: 3 });
      expect(availableParallelism).not.toHaveBeenCalled();
    } finally {
      await supervisor.close();
    }
  });

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
    expect(await active.status("missing-launch")).toBeUndefined();
    expect(
      database.db
        .prepare("SELECT strict FROM pragma_table_list WHERE name = ?")
        .get("node_worker_launches"),
    ).toEqual({ strict: 1 });
    await active.close();
  });

  it("keeps pending and running launches owned by a live supervisor unchanged", async () => {
    const { bundleRoot, env, supervisor, workspaceDir } = fixture();
    await supervisor.status("schema-probe");
    const supervisorIdentity = requireNodeWorkerProcessIdentity(process.pid);
    const store = new NodeWorkerLaunchStore({ env });
    const turns = new NodeWorkerTurnStore({ env });
    for (const launchId of ["pending-launch", "running-launch"]) {
      const input = launchInput(workspaceDir, launchId, "wait");
      const claim = {
        ...testNodeWorkerLaunchIdentity(input),
        gatewayNamespace: input.gatewayNamespace,
      };
      store.claim(claim, supervisorIdentity, 2);
      turns.claim({ claim, ownerLaunchId: launchId, supervisor: supervisorIdentity });
      if (launchId === "running-launch") {
        store.markRunning({ ...claim, supervisor: supervisorIdentity, worker: supervisorIdentity });
      }
    }

    const capacitySnapshots: Array<{ total: number; available: number }> = [];
    const sameHandle = createNodeWorkerSupervisor({
      bundleRoot,
      env,
      capacity: 2,
      onCapacityChanged: (capacity) => capacitySnapshots.push(capacity),
    });
    expect(await sameHandle.status("pending-launch")).toMatchObject({
      state: "pending",
      worker: null,
    });
    expect(await sameHandle.status("running-launch")).toMatchObject({
      state: "running",
      worker: supervisorIdentity,
    });
    expect(capacitySnapshots).toEqual([
      { total: 2, available: 0 },
      { total: 2, available: 0 },
    ]);
    await supervisor.close();
    await sameHandle.close();
    closeOpenClawStateDatabaseForTest();

    openOpenClawStateDatabase({ env });
    const recovered = createNodeWorkerSupervisor({ bundleRoot, env });
    expect(await recovered.status("pending-launch")).toMatchObject({
      state: "pending",
      worker: null,
    });
    expect(await recovered.status("running-launch")).toMatchObject({
      state: "running",
      worker: supervisorIdentity,
    });
    await recovered.close();
  });

  it("rejects a mismatched launch and turn identity before durable admission", async () => {
    const { env, supervisor, workspaceDir } = fixture();
    const input = launchInput(workspaceDir, "launch-id");
    input.descriptor.assignment.turnId = "other-turn-id";

    try {
      await expect(supervisor.launch(input, TEST_WORKER_ENDPOINT)).rejects.toThrow(
        "launchId must match descriptor assignment turnId",
      );
      expect(new NodeWorkerLaunchStore({ env }).get(input.launchId)).toBeUndefined();
    } finally {
      await supervisor.close();
    }
  });

  it("releases the physical capacity claim when the first turn cannot be journaled", async () => {
    const capacities: Array<{ total: number; available: number }> = [];
    const { env, supervisor, workspaceDir } = fixture({
      capacity: 1,
      capacityWaitMs: 25,
      onCapacityChanged: (capacity) => capacities.push(capacity),
    });
    const input = launchInput(workspaceDir, "turn-claim-failure");
    const claim = vi.spyOn(NodeWorkerTurnStore.prototype, "claim").mockImplementationOnce(() => {
      throw new Error("injected turn claim failure");
    });
    try {
      await expect(supervisor.launch(input, TEST_WORKER_ENDPOINT)).rejects.toThrow(
        "injected turn claim failure",
      );
      expect(new NodeWorkerLaunchStore({ env }).get(input.launchId)).toMatchObject({
        state: "failed",
        worker: null,
      });
      expect(capacities.at(-1)).toEqual({ total: 1, available: 1 });
      expect(fs.existsSync(path.join(workspaceDir, `${input.launchId}.started.json`))).toBe(false);

      const next = launchInput(workspaceDir, "turn-claim-recovered");
      await supervisor.launch(next, TEST_WORKER_ENDPOINT);
      expect((await waitForTerminal(supervisor, next.launchId)).state).toBe("completed");
    } finally {
      claim.mockRestore();
      await supervisor.close();
    }
  });

  it("launches idempotently and persists only bounded non-secret facts", async () => {
    const { env, supervisor, workspaceDir } = fixture();
    const input = launchInput(workspaceDir, "success-launch");

    expect(await supervisor.launch(input, TEST_WORKER_ENDPOINT)).toMatchObject({
      launchId: "success-launch",
      state: "running",
      environmentId: input.descriptor.admission.environmentId,
      sessionId: input.descriptor.admission.sessionId,
      ownerEpoch: 3,
      placementGeneration: 4,
      runId: "run-1",
    });
    const completed = await waitForTerminal(supervisor, input.launchId);
    expect(completed).toMatchObject({ state: "completed", errorText: null });
    expect(JSON.parse(completed.resultJson ?? "null")).toEqual({
      status: "completed",
      transcriptLeafId: "leaf-1",
      transcriptNextSeq: 2,
    });
    expect(
      JSON.parse(fs.readFileSync(path.join(workspaceDir, `${input.launchId}.argv.json`), "utf8")),
    ).toEqual(["--internal-worker-ipc", "--internal-worker-session"]);
    expect(await supervisor.launch(input, TEST_WORKER_ENDPOINT)).toEqual(completed);
    await expect(
      supervisor.launch(
        {
          ...input,
          descriptor: testWorkerDescriptor(workspaceDir, "different-plan", input.launchId),
        },
        TEST_WORKER_ENDPOINT,
      ),
    ).rejects.toThrow("replayed with a different plan");

    const row = openOpenClawStateDatabase({ env })
      .db.prepare("SELECT * FROM node_worker_launches WHERE launch_id = ?")
      .get(input.launchId);
    expect(JSON.stringify(row)).not.toContain(TEST_WORKER_CREDENTIAL);
    await supervisor.close();
  });

  it("admits two durable launches and releases one physical slot at a time", async () => {
    const capacitySnapshots: Array<{ total: number; available: number }> = [];
    const { env, supervisor, workspaceDir } = fixture({
      capacity: 2,
      capacityWaitMs: 5_000,
      onCapacityChanged: (capacity) => capacitySnapshots.push(capacity),
    });
    const first = launchInput(workspaceDir, "capacity-a", "wait");
    const second = launchInput(workspaceDir, "capacity-b", "wait");
    const third = launchInput(workspaceDir, "capacity-c", "wait");
    const fourth = launchInput(workspaceDir, "capacity-d", "wait");
    const store = new NodeWorkerLaunchStore({ env });

    await supervisor.launch(first, TEST_WORKER_ENDPOINT);
    await supervisor.launch(second, TEST_WORKER_ENDPOINT);
    await expect(supervisor.launch(first, TEST_WORKER_ENDPOINT)).resolves.toMatchObject({
      launchId: first.launchId,
      state: "running",
    });
    expect(capacitySnapshots).toEqual([
      { total: 2, available: 0 },
      { total: 2, available: 2 },
      { total: 2, available: 1 },
      { total: 2, available: 0 },
    ]);

    const thirdAdmission = supervisor.launch(third, TEST_WORKER_ENDPOINT);
    const fourthAdmission = supervisor.launch(fourth, TEST_WORKER_ENDPOINT);
    await vi.waitFor(() => {
      expect(store.get(third.launchId)).toBeUndefined();
      expect(store.get(fourth.launchId)).toBeUndefined();
    });

    await supervisor.cancel(testNodeWorkerLaunchIdentity(first));
    await vi.waitFor(() => {
      expect([third, fourth].filter((input) => store.get(input.launchId))).toHaveLength(1);
    });
    const thirdAdmittedFirst = Boolean(store.get(third.launchId));
    await expect(thirdAdmittedFirst ? thirdAdmission : fourthAdmission).resolves.toMatchObject({
      state: "running",
    });
    expect(store.get(thirdAdmittedFirst ? fourth.launchId : third.launchId)).toBeUndefined();

    await supervisor.cancel(testNodeWorkerLaunchIdentity(second));
    await expect(thirdAdmittedFirst ? fourthAdmission : thirdAdmission).resolves.toMatchObject({
      state: "running",
    });
    expect(capacitySnapshots).toEqual([
      { total: 2, available: 0 },
      { total: 2, available: 2 },
      { total: 2, available: 1 },
      { total: 2, available: 0 },
      { total: 2, available: 1 },
      { total: 2, available: 0 },
      { total: 2, available: 1 },
      { total: 2, available: 0 },
    ]);

    await supervisor.close();
  });

  it("times out saturated admission without creating a launch row", async () => {
    const { env, supervisor, workspaceDir } = fixture({ capacity: 1, capacityWaitMs: 25 });
    const running = launchInput(workspaceDir, "capacity-running", "wait");
    const rejected = launchInput(workspaceDir, "capacity-rejected", "wait");
    await supervisor.launch(running, TEST_WORKER_ENDPOINT);

    await expect(supervisor.launch(rejected, TEST_WORKER_ENDPOINT)).rejects.toMatchObject({
      name: "NodeWorkerCapacityExhaustedError",
      code: NODE_WORKER_CAPACITY_EXHAUSTED_ERROR_CODE,
      message: "node worker capacity remained full for 25 ms",
    });
    expect(new NodeWorkerLaunchStore({ env }).get(rejected.launchId)).toBeUndefined();
    await supervisor.close();
  });

  it("abandons saturated admission when its invocation is cancelled", async () => {
    const { env, supervisor, workspaceDir } = fixture({ capacity: 1, capacityWaitMs: 5_000 });
    const running = launchInput(workspaceDir, "capacity-abort-running", "wait");
    const waiting = launchInput(workspaceDir, "capacity-abort-waiting", "wait");
    const controller = new AbortController();
    await supervisor.launch(running, TEST_WORKER_ENDPOINT);
    const admission = supervisor.launch(waiting, TEST_WORKER_ENDPOINT, controller.signal);
    const rejected = expect(admission).rejects.toThrow("invoke cancelled");

    controller.abort(new Error("invoke cancelled"));
    await rejected;
    expect(new NodeWorkerLaunchStore({ env }).get(waiting.launchId)).toBeUndefined();
    await supervisor.close();
  });

  it("aborts saturated admission when the supervisor closes", async () => {
    const { env, supervisor, workspaceDir } = fixture({ capacity: 1, capacityWaitMs: 5_000 });
    const running = launchInput(workspaceDir, "capacity-close-running", "wait");
    const waiting = launchInput(workspaceDir, "capacity-close-waiting", "wait");
    await supervisor.launch(running, TEST_WORKER_ENDPOINT);
    const admission = supervisor.launch(waiting, TEST_WORKER_ENDPOINT);
    const rejected = expect(admission).rejects.toThrow("node worker supervisor is closed");
    await vi.waitFor(() => {
      expect(new NodeWorkerLaunchStore({ env }).get(waiting.launchId)).toBeUndefined();
    });

    await supervisor.close();
    await rejected;
    expect(new NodeWorkerLaunchStore({ env }).get(waiting.launchId)).toBeUndefined();
  });

  it.each(["status", "launch", "cancel", "close"] as const)(
    "retains an observed terminal outcome when %s reconciliation keeps failing",
    async (operation) => {
      const capacitySnapshots: Array<{ total: number; available: number }> = [];
      const { env, supervisor, workspaceDir } = fixture({
        capacity: 1,
        onCapacityChanged: (capacity) => capacitySnapshots.push(capacity),
      });
      const input = launchInput(workspaceDir, `finish-failure-${operation}`);
      const store = (supervisor as unknown as { store: NodeWorkerLaunchStore }).store;
      const originalFinish = store.finish.bind(store);
      let persistenceUnavailable = true;
      const finish = vi.spyOn(store, "finish").mockImplementation((params) => {
        if (persistenceUnavailable) {
          throw new Error("injected finish failure");
        }
        return originalFinish(params);
      });
      const invoke = async () => {
        switch (operation) {
          case "status":
            return await supervisor.status(input.launchId);
          case "launch":
            return await supervisor.launch(input, TEST_WORKER_ENDPOINT);
          case "cancel":
            return await supervisor.cancel(testNodeWorkerLaunchIdentity(input));
          case "close":
            await supervisor.close();
            return new NodeWorkerLaunchStore({ env }).get(input.launchId);
          default:
            throw new Error("unsupported reconciliation operation");
        }
      };

      expect(await supervisor.launch(input, TEST_WORKER_ENDPOINT)).toMatchObject({
        state: "running",
      });
      await vi.waitFor(() => expect(finish).toHaveBeenCalled(), { timeout: 5_000 });
      expect(new NodeWorkerLaunchStore({ env }).get(input.launchId)?.state).toBe("running");
      expect(capacitySnapshots.at(-1)).toEqual({ total: 1, available: 0 });

      await expect(invoke()).rejects.toThrow("injected finish failure");
      expect(new NodeWorkerLaunchStore({ env }).get(input.launchId)?.state).toBe("running");
      expect(capacitySnapshots.at(-1)).toEqual({ total: 1, available: 0 });

      persistenceUnavailable = false;
      const completed = await invoke();
      expect(completed).toMatchObject({
        state: "completed",
        resultJson: expect.stringContaining('"status":"completed"'),
      });
      expect(new NodeWorkerLaunchStore({ env }).get(input.launchId)?.state).toBe("completed");
      expect(capacitySnapshots.at(-1)).toEqual({ total: 1, available: 1 });
      await supervisor.close();
    },
  );

  it("spawns workers with only supplied runtime essentials", async () => {
    const root = tempDirs.make("node-worker-env-");
    const { bundleRoot, env, workspaceDir } = writeNodeWorkerFixture(root);
    const suppliedPathKey = process.platform === "win32" ? "Path" : "PATH";
    const suppliedEnv: NodeJS.ProcessEnv = {
      ...env,
      [suppliedPathKey]: process.env.PATH,
      HOME: path.join(root, "worker-home"),
      LANG: "en_US.UTF-8",
      LC_TIME: "de_DE.UTF-8",
      NODE_COMPILE_CACHE: path.join(root, "host-compile-cache"),
      NODE_DISABLE_COMPILE_CACHE: "1",
      NODE_EXTRA_CA_CERTS: path.join(root, "private-ca.pem"),
      NODE_USE_SYSTEM_CA: "1",
      OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1",
      OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.node",
      OPENCLAW_SERVICE_KIND: "node",
      OPENCLAW_SUPPLIED_SECRET: "supplied-openclaw-secret",
      NODE_OPTIONS: "--title=forbidden-worker-title",
      BASH_ENV: path.join(root, "forbidden-shell-init"),
      DYLD_INSERT_LIBRARIES: path.join(root, "forbidden-runtime-injection"),
      HTTPS_PROXY: "http://supplied-proxy.invalid",
      SUPPLIED_SECRET: "supplied-secret",
    };

    await withEnvAsync(
      {
        AMBIENT_SECRET: "ambient-secret",
        OPENCLAW_AMBIENT_SECRET: "ambient-openclaw-secret",
        HTTP_PROXY: "http://ambient-proxy.invalid",
        NODE_OPTIONS: undefined,
      },
      async () => {
        const expectedWorkerEnv: NodeJS.ProcessEnv = {
          HOME: suppliedEnv.HOME,
          LANG: suppliedEnv.LANG,
          LC_TIME: suppliedEnv.LC_TIME,
          NODE_EXTRA_CA_CERTS: suppliedEnv.NODE_EXTRA_CA_CERTS,
          NODE_USE_SYSTEM_CA: suppliedEnv.NODE_USE_SYSTEM_CA,
          NODE_COMPILE_CACHE: expect.stringContaining("node-worker-compile-cache"),
          OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: suppliedEnv.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS,
          OPENCLAW_NO_RESPAWN: "1",
          [suppliedPathKey]: suppliedEnv[suppliedPathKey],
        };
        const supervisor = createNodeWorkerSupervisor({ bundleRoot, env: suppliedEnv });
        suppliedEnv.HOME = path.join(root, "mutated-home");
        suppliedEnv.LANG = "mutated-locale";
        const input = launchInput(workspaceDir, "env-launch", "env");
        await supervisor.launch(input, TEST_WORKER_ENDPOINT);
        await waitForTerminal(supervisor, input.launchId);
        const workerEnv = JSON.parse(
          fs.readFileSync(path.join(workspaceDir, `${input.launchId}.env.json`), "utf8"),
        ) as Record<string, string>;

        expect(workerEnv).toMatchObject(expectedWorkerEnv);
        expect(workerEnv).not.toHaveProperty("AMBIENT_SECRET");
        expect(workerEnv).not.toHaveProperty("OPENCLAW_AMBIENT_SECRET");
        expect(workerEnv).not.toHaveProperty("OPENCLAW_LAUNCHD_LABEL");
        expect(workerEnv).not.toHaveProperty("OPENCLAW_SERVICE_KIND");
        expect(workerEnv).not.toHaveProperty("OPENCLAW_STATE_DIR");
        expect(workerEnv).not.toHaveProperty("OPENCLAW_SUPPLIED_SECRET");
        expect(workerEnv).not.toHaveProperty("NODE_DISABLE_COMPILE_CACHE");
        expect(workerEnv).not.toHaveProperty("NODE_OPTIONS");
        expect(workerEnv).not.toHaveProperty("BASH_ENV");
        expect(workerEnv).not.toHaveProperty("DYLD_INSERT_LIBRARIES");
        expect(workerEnv).not.toHaveProperty("HTTP_PROXY");
        expect(workerEnv).not.toHaveProperty("HTTPS_PROXY");
        expect(workerEnv).not.toHaveProperty("SUPPLIED_SECRET");
        expect(JSON.stringify(workerEnv)).not.toContain(TEST_WORKER_CREDENTIAL);
        const platformInjectedKeys =
          process.platform === "darwin" ? ["__CF_USER_TEXT_ENCODING"] : [];
        expect(Object.keys(workerEnv).toSorted()).toEqual(
          [...Object.keys(expectedWorkerEnv), ...platformInjectedKeys]
            .filter(
              (key) => expectedWorkerEnv[key] !== undefined || platformInjectedKeys.includes(key),
            )
            .toSorted(),
        );
        await supervisor.close();
      },
    );
  });

  it("bounds output and scrubs launch credentials after registry eviction", async () => {
    const { supervisor, workspaceDir } = fixture();
    const successInput = launchInput(workspaceDir, "secret-success-launch", "secret-success");
    successInput.descriptor.assignment.github = {
      token: "worker-github-token",
      login: "worker-bot",
      branch: "session/worker-1",
    };
    const failureInput = launchInput(workspaceDir, "failure-launch", "secret-fail");
    const overflowInput = launchInput(workspaceDir, "overflow-launch", "overflow");

    const registrations = evictWorkerCredentialsOnRegistration();
    await supervisor.launch(successInput, TEST_WORKER_ENDPOINT);
    await supervisor.launch(failureInput, TEST_WORKER_ENDPOINT);
    await supervisor.launch(overflowInput, TEST_WORKER_ENDPOINT);
    expect(registrations).toHaveBeenCalledTimes(4);
    expect(registrations).toHaveBeenCalledWith(TEST_WORKER_CREDENTIAL);
    expect(registrations).toHaveBeenCalledWith(successInput.descriptor.assignment.github.token);
    const success = await waitForTerminal(supervisor, successInput.launchId);
    const failure = await waitForTerminal(supervisor, failureInput.launchId);
    const overflow = await waitForTerminal(supervisor, overflowInput.launchId);
    const representations = [
      TEST_WORKER_CREDENTIAL,
      encodeURIComponent(TEST_WORKER_CREDENTIAL),
      JSON.stringify(TEST_WORKER_CREDENTIAL).slice(1, -1),
      successInput.descriptor.assignment.github.token,
    ];
    expect(success.state).toBe("completed");
    expect(JSON.parse(success.resultJson ?? "null")).toEqual({
      status: "completed",
      transcriptLeafId: "raw [REDACTED] encoded [REDACTED] github [REDACTED]",
      transcriptNextSeq: 2,
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

  it.each([
    ["raw", "secret-cutoff-raw", TEST_WORKER_CREDENTIAL],
    ["URL", "secret-cutoff-url", encodeURIComponent(TEST_WORKER_CREDENTIAL)],
    ["JSON-escaped", "secret-cutoff-json", JSON.stringify(TEST_WORKER_CREDENTIAL).slice(1, -1)],
  ])(
    "redacts a %s credential representation across the stderr cutoff",
    async (_, prompt, representation) => {
      const { supervisor, workspaceDir } = fixture();
      const input = launchInput(workspaceDir, `cutoff-${prompt}`, prompt);

      await supervisor.launch(input, TEST_WORKER_ENDPOINT);
      const failure = await waitForTerminal(supervisor, input.launchId);

      expect(failure.state).toBe("failed");
      expect(Buffer.byteLength(failure.errorText ?? "", "utf8")).toBeLessThanOrEqual(4 * 1024);
      expect(failure.errorText).not.toContain(representation);
      expect(failure.errorText).not.toContain(representation.slice(-8));
      await supervisor.close();
    },
  );

  it("rotates credential scrubbing and drops prior-turn diagnostics when a worker is reused", async () => {
    const { supervisor, workspaceDir } = fixture({ capacity: 1 });
    const first = testWorkerLaunchInput(workspaceDir, "previous-diagnostic", "diagnostic-retain");
    const second = testWorkerLaunchInput(workspaceDir, "rotated-credential", "secret-success");
    second.descriptor.admission.credential = 'fresh worker/"credential\\secret?';
    second.descriptor.assignment.github = {
      token: "rotated-worker-github-token",
      login: "worker-bot",
      branch: "session/worker-1",
    };
    const last = testWorkerLaunchInput(workspaceDir, "fresh-failure", "quiet-fail");
    last.descriptor.admission.credential = "final-worker-credential";
    try {
      const original = await supervisor.launch(first, TEST_WORKER_ENDPOINT);
      await waitForTerminal(supervisor, first.launchId);
      const registrations = evictWorkerCredentialsOnRegistration();
      expect(await supervisor.launch(second, TEST_WORKER_ENDPOINT)).toMatchObject({
        worker: original.worker,
      });
      expect(registrations).toHaveBeenCalledWith(second.descriptor.admission.credential);
      expect(registrations).toHaveBeenCalledWith(second.descriptor.assignment.github.token);
      const completed = await waitForTerminal(supervisor, second.launchId);
      expect(JSON.parse(completed.resultJson ?? "null")).toEqual({
        status: "completed",
        transcriptLeafId: "raw [REDACTED] encoded [REDACTED] github [REDACTED]",
        transcriptNextSeq: 2,
      });

      registrations.mockRestore();
      await supervisor.launch(last, TEST_WORKER_ENDPOINT);
      const failed = await waitForTerminal(supervisor, last.launchId);
      expect(failed).toMatchObject({
        state: "failed",
        errorText: "node worker failed with exit code 7",
      });
      for (const input of [first, second, last]) {
        expect(JSON.stringify(failed)).not.toContain(input.descriptor.admission.credential);
      }
    } finally {
      await supervisor.close();
    }
  });

  it("does not open or signal a child after markRunning observes its terminal receipt", async () => {
    const capacities: Array<{ total: number; available: number }> = [];
    const { supervisor, workspaceDir, env } = fixture({
      capacity: 1,
      onCapacityChanged: (capacity) => capacities.push(capacity),
    });
    const input = launchInput(workspaceDir, "fast-terminal-launch", "fast-terminal");
    const captureSpawn = vi.spyOn(childProcess.ChildProcess.prototype, "emit");
    const signalTree = vi.spyOn(processTree, "signalProcessTree");
    let child: ChildProcess | undefined;
    vi.spyOn(NodeWorkerLaunchStore.prototype, "markRunning").mockImplementation(
      function (this: NodeWorkerLaunchStore, params) {
        child = captureSpawn.mock.contexts.find(
          (context): context is ChildProcess =>
            context instanceof childProcess.ChildProcess && context.pid === params.worker.pid,
        );
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

    try {
      expect(await supervisor.launch(input, TEST_WORKER_ENDPOINT)).toMatchObject({
        state: "completed",
      });
      // Capacity returns only after the real child exit and adapter settlement.
      await vi.waitFor(() => expect(capacities.at(-1)).toEqual({ total: 1, available: 1 }), {
        timeout: 5_000,
      });
      expect(child?.exitCode).toBe(0);
      expect(child?.signalCode).toBeNull();
      expect(child?.stdout?.closed).toBe(true);
      expect(child?.stderr?.closed).toBe(true);
      expect(fs.existsSync(path.join(workspaceDir, "fast-terminal-marker"))).toBe(false);
      expect(new NodeWorkerLaunchStore({ env }).get(input.launchId)?.state).toBe("completed");
      await supervisor.close();
      expect(signalTree).not.toHaveBeenCalled();
    } finally {
      await supervisor.close();
    }
  });

  it("records a gated child that exits before journal readiness as terminal", async () => {
    const { bundleRoot, supervisor, workspaceDir } = fixture();
    const input = launchInput(workspaceDir, "prestart-exit-launch");
    const exitedPath = path.join(workspaceDir, "prestart-exited");
    fs.writeFileSync(
      path.join(
        bundleRoot,
        input.gatewayNamespace,
        "bundles",
        input.expectedBundleHash,
        "worker.mjs",
      ),
      `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(exitedPath)}, "exited"); process.exit(23);`,
    );

    await supervisor.launch(input, TEST_WORKER_ENDPOINT);
    const terminal = await waitForTerminal(supervisor, input.launchId);

    expect(fs.existsSync(exitedPath)).toBe(true);
    expect(terminal.state).toBe("failed");
    await supervisor.close();
  });

  it("bounds a blocked cancellation write and stops only its physical owner", async () => {
    const capacities: Array<{ total: number; available: number }> = [];
    const { env, supervisor, workspaceDir } = fixture({
      capacity: 2,
      capacityWaitMs: 25,
      onCapacityChanged: (capacity) => capacities.push(capacity),
    });
    const input = launchInput(workspaceDir, "blocked-cancel", "wait");
    const sibling = launchInput(workspaceDir, "unrelated-worker", "wait");
    const captureSpawn = vi.spyOn(childProcess.ChildProcess.prototype, "emit");
    const signalTree = vi.spyOn(processTree, "signalProcessTree");
    let heldWrite: { data: unknown; callback?: (error?: Error | null) => void } | undefined;
    let restoreWrite: (() => void) | undefined;
    let cancellation: ReturnType<NodeWorkerSupervisor["cancel"]> | undefined;
    let cancelled: Awaited<ReturnType<NodeWorkerSupervisor["cancel"]>>;
    try {
      const running = await supervisor.launch(input, TEST_WORKER_ENDPOINT);
      const unrelated = await supervisor.launch(sibling, TEST_WORKER_ENDPOINT);
      const child = captureSpawn.mock.contexts.find(
        (context): context is ChildProcess =>
          context instanceof childProcess.ChildProcess && context.pid === running.worker!.pid,
      );
      captureSpawn.mockRestore();
      const stdin = child?.stdin;
      if (!stdin) {
        throw new Error("missing spawned worker stdin");
      }
      // Model a pipe that cannot drain: neither frame delivery nor write completion occurs.
      const write = vi.spyOn(stdin, "write").mockImplementation((data, encoding, callback) => {
        heldWrite = { data, callback: typeof encoding === "function" ? encoding : callback };
        return false;
      });
      restoreWrite = () => write.mockRestore();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      cancellation = supervisor.cancel(testNodeWorkerLaunchIdentity(input)).then((receipt) => {
        cancelled = receipt;
        return receipt;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(heldWrite?.data).toBe(
        `${JSON.stringify({ type: "cancel", turnId: input.launchId })}\n`,
      );
      expect(heldWrite?.callback).toEqual(expect.any(Function));

      await vi.advanceTimersByTimeAsync(4_999);
      expect(signalTree).not.toHaveBeenCalled();
      expect(cancelled).toBeUndefined();
      expect(new NodeWorkerLaunchStore({ env }).get(input.launchId)?.state).toBe("running");
      expect(inspectNodeWorkerProcessIdentity(running.worker!)).toBe("live");
      expect(inspectNodeWorkerProcessIdentity(unrelated.worker!)).toBe("live");
      expect(capacities.at(-1)).toEqual({ total: 2, available: 0 });

      // Fire only the blocked-write deadline. Restore real timers before its
      // rejection continuation schedules process termination and escalation.
      vi.advanceTimersByTime(1);
      vi.useRealTimers();
      await vi.waitFor(
        () => {
          expect(cancelled).toMatchObject({ state: "cancelled", worker: running.worker });
          expect(inspectNodeWorkerProcessIdentity(running.worker!)).not.toBe("live");
          expect(capacities.at(-1)).toEqual({ total: 2, available: 1 });
        },
        { timeout: 7_000, interval: 25 },
      );
      expect(new NodeWorkerLaunchStore({ env }).get(input.launchId)?.state).toBe("cancelled");
      expect(await supervisor.status(sibling.launchId)).toMatchObject({ state: "running" });
      expect(inspectNodeWorkerProcessIdentity(unrelated.worker!)).toBe("live");
      await expect(
        supervisor.launch(
          launchInput(workspaceDir, "after-blocked-cancel", "wait"),
          TEST_WORKER_ENDPOINT,
        ),
      ).resolves.toMatchObject({ state: "running" });
    } finally {
      vi.useRealTimers();
      captureSpawn.mockRestore();
      restoreWrite?.();
      // Release the injected write even on the pre-fix failure, so cleanup cannot inherit its hang.
      heldWrite?.callback?.(new Error("released blocked test stdin"));
      await cancellation?.catch(() => undefined);
      await supervisor.close();
    }
  }, 15_000);

  it.each([
    [
      "connection-failure",
      "cancelled",
      "worker could not reach gateway gateway.example:18789: certificate rejected ",
    ],
    [
      "connection-deadline",
      "failed",
      "worker admission deadline exceeded after 3 attempts to gateway.example:18789: connect failed: Opening handshake has timed out ",
    ],
  ] as const)(
    "records the child's %s diagnosis in the terminal journal",
    async (prompt, state, errorText) => {
      const { supervisor, workspaceDir } = fixture();
      const input = launchInput(workspaceDir, "connection-failure-launch", prompt);
      await supervisor.launch(input, {
        kind: "websocket",
        url: "wss://gateway.example:18789/__openclaw__/worker",
      });
      if (state === "cancelled") {
        await vi.waitFor(() =>
          expect(fs.existsSync(path.join(workspaceDir, "connection-failure-reported"))).toBe(true),
        );
        await supervisor.cancel(testNodeWorkerLaunchIdentity(input));
      }
      const terminal = await waitForTerminal(supervisor, input.launchId);
      expect(terminal).toMatchObject({ state, errorText: expect.stringContaining(errorText) });
      expect(Buffer.byteLength(terminal.errorText ?? "", "utf8")).toBeLessThanOrEqual(4 * 1024);
      expect(terminal.errorText).not.toContain(TEST_WORKER_CREDENTIAL);
      await supervisor.close();
    },
  );

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
            operation === "cancel"
              ? supervisor.cancel(testNodeWorkerLaunchIdentity(input))
              : supervisor.close();
          return receipt;
        },
      );

      await supervisor.launch(input, TEST_WORKER_ENDPOINT);
      await stopping;

      expect((await supervisor.status(input.launchId))?.state).toBe(state);
      expect(fs.existsSync(path.join(workspaceDir, "grandchild.pid"))).toBe(false);
      await supervisor.close();
    },
  );

  it("does not return stale running after the active worker disappears", async () => {
    const { supervisor, workspaceDir } = fixture();
    const input = launchInput(workspaceDir, "silent-worker-death", "wait");
    const running = await supervisor.launch(input, TEST_WORKER_ENDPOINT);
    expect(running.worker).not.toBeNull();

    process.kill(running.worker!.pid, "SIGKILL");
    await vi.waitFor(async () => {
      expect((await supervisor.status(input.launchId))?.state).not.toBe("running");
    });
    await supervisor.close();
  });

  it("never signals a running worker for a mismatched immutable cancel identity", async () => {
    const { supervisor, workspaceDir } = fixture();
    const input = launchInput(workspaceDir, "identity-cancel-launch", "wait");
    const running = await supervisor.launch(input, TEST_WORKER_ENDPOINT);
    const expected = testNodeWorkerLaunchIdentity(input);
    const mismatches = [
      { ...expected, launchId: "launch-other" },
      { ...expected, planHash: "b".repeat(64) },
      { ...expected, environmentId: "environment-other" },
      { ...expected, sessionId: "session-other" },
      { ...expected, ownerEpoch: expected.ownerEpoch + 1 },
      { ...expected, placementGeneration: expected.placementGeneration + 1 },
      { ...expected, runId: "run-other" },
    ];

    for (const mismatch of mismatches) {
      await expect(supervisor.cancel(mismatch)).resolves.toBeUndefined();
      expect(inspectNodeWorkerProcessIdentity(running.worker!)).toBe("live");
      expect((await supervisor.status(input.launchId))?.state).toBe("running");
    }

    await expect(supervisor.cancel(expected)).resolves.toMatchObject({ state: "cancelled" });
    await supervisor.close();
  });

  it.each([
    ["cancel", "cancelled"],
    ["close", "interrupted"],
  ] as const)("%s terminates the worker-owned grandchild", async (operation, state) => {
    const { supervisor, workspaceDir } = fixture();
    const input = launchInput(workspaceDir, `${operation}-tree-launch`, "tree");
    const running = await supervisor.launch(input, TEST_WORKER_ENDPOINT);
    expect(running.state).toBe("running");
    const grandchildPath = path.join(workspaceDir, "grandchild.pid");
    await vi.waitFor(() => expect(fs.readFileSync(grandchildPath, "utf8")).toMatch(/^[1-9]\d*$/u));
    const grandchildPid = Number(fs.readFileSync(grandchildPath, "utf8"));
    const grandchild = requireNodeWorkerProcessIdentity(grandchildPid);
    expect(inspectNodeWorkerProcessIdentity(grandchild)).toBe("live");

    if (operation === "cancel") {
      await supervisor.cancel(testNodeWorkerLaunchIdentity(input));
    } else {
      await supervisor.close();
    }

    const terminal = await supervisor.status(input.launchId);
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
    fs.symlinkSync(outsideEntry, path.join(escapedBundle, "worker.mjs"));
    const input = launchInput(workspaceDir, "escaped-entry");
    input.expectedBundleHash = escapedHash;
    input.descriptor.admission.handshake.bundleHash = escapedHash;

    expect(await supervisor.launch(input, TEST_WORKER_ENDPOINT)).toMatchObject({
      state: "failed",
      errorText: expect.stringContaining("inside its bundle"),
    });
    await supervisor.close();
  });
});
