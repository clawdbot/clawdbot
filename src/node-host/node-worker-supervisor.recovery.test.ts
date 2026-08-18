import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { stableStringify } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { NodeWorkerLaunchStore, type NodeWorkerLaunchReceipt } from "./node-worker-launch-store.js";
import {
  inspectNodeWorkerProcessIdentity,
  requireNodeWorkerProcessIdentity,
  type NodeWorkerProcessIdentity,
} from "./node-worker-process-identity.js";
import { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import {
  testNodeWorkerLaunchIdentity,
  TEST_WORKER_ENDPOINT,
  testWorkerLaunchInput,
  writeNodeWorkerFixture,
} from "./node-worker-supervisor.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const spawned = new Set<ChildProcess>();
const ownedProcessGroups: NodeWorkerProcessIdentity[] = [];

afterEach(async () => {
  for (const child of spawned) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  if (process.platform !== "win32") {
    for (const identity of ownedProcessGroups) {
      if (inspectNodeWorkerProcessIdentity(identity) === "reused") {
        continue;
      }
      try {
        process.kill(-identity.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          throw error;
        }
      }
    }
  }
  spawned.clear();
  ownedProcessGroups.length = 0;
  closeOpenClawStateDatabaseForTest();
});

function fixture(label: string) {
  return writeNodeWorkerFixture(tempDirs.make(label));
}

function planHash(input: ReturnType<typeof testWorkerLaunchInput>): string {
  return createHash("sha256")
    .update(
      stableStringify({
        expectedBundleHash: input.expectedBundleHash,
        descriptor: input.descriptor,
        gatewayNamespace: input.gatewayNamespace,
        placementGeneration: input.placementGeneration,
      }),
    )
    .digest("hex");
}

function insertLaunch(params: {
  env: NodeJS.ProcessEnv;
  input: ReturnType<typeof testWorkerLaunchInput>;
  state: "pending" | "running";
  supervisor: NodeWorkerProcessIdentity;
  worker?: NodeWorkerProcessIdentity;
}) {
  const database = openOpenClawStateDatabase({ env: params.env }).db;
  database
    .prepare(
      `INSERT INTO node_worker_launches (
        launch_id, plan_hash, gateway_namespace, environment_id, session_id,
        owner_epoch, placement_generation, run_id, state,
        supervisor_pid, supervisor_start_time, worker_pid, worker_start_time,
        result_json, error_text, completed_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 1, 1)`,
    )
    .run(
      params.input.launchId,
      planHash(params.input),
      params.input.gatewayNamespace,
      params.input.descriptor.admission.environmentId,
      params.input.descriptor.admission.sessionId,
      params.input.descriptor.admission.ownerEpoch,
      params.input.placementGeneration,
      params.input.descriptor.assignment.runId,
      params.state,
      params.supervisor.pid,
      params.supervisor.startTime,
      params.worker?.pid ?? null,
      params.worker?.startTime ?? null,
    );
}

function waitForChildLine(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const onData = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const newline = stdout.indexOf("\n");
      if (newline >= 0) {
        resolve(stdout.slice(0, newline));
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      reject(new Error(`owner exited before ready (${code ?? signal}): ${stderr}`));
    });
  });
}

function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  });
}

function writeSupervisorOwnerScript(root: string): string {
  const supervisorUrl = pathToFileURL(path.resolve("src/node-host/node-worker-supervisor.ts")).href;
  const scriptPath = path.join(root, "supervisor-owner.mts");
  fs.writeFileSync(
    scriptPath,
    `
      import fs from "node:fs";
      import { createNodeWorkerSupervisor } from ${JSON.stringify(supervisorUrl)};
      const [bundleRoot, stateDir, inputPath] = process.argv.slice(2);
      const supervisor = createNodeWorkerSupervisor({
        bundleRoot,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      const shutdown = async () => {
        await supervisor.close();
        process.exit(0);
      };
      process.once("SIGTERM", () => void shutdown());
      const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
      const receipt = await supervisor.launch(input, ${JSON.stringify({ kind: "unix", socketPath: "/tmp/openclaw-worker/gateway.sock" })});
      process.stdout.write(JSON.stringify(receipt) + "\\n");
      setInterval(() => {}, 1000);
    `,
  );
  return scriptPath;
}

function spawnSupervisorOwner(params: {
  bundleRoot: string;
  env: NodeJS.ProcessEnv;
  input: ReturnType<typeof testWorkerLaunchInput>;
  root: string;
}): ChildProcess {
  const inputPath = path.join(params.root, `${params.input.launchId}.json`);
  fs.writeFileSync(inputPath, JSON.stringify(params.input));
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      writeSupervisorOwnerScript(params.root),
      params.bundleRoot,
      params.env.OPENCLAW_STATE_DIR!,
      inputPath,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  spawned.add(child);
  return child;
}

async function waitForIdentityDeath(identity: NodeWorkerProcessIdentity) {
  await vi.waitFor(() => expect(inspectNodeWorkerProcessIdentity(identity)).not.toBe("live"), {
    timeout: 5_000,
  });
}

describe("node worker supervisor recovery", () => {
  it("atomically adopts pending work only after the previous supervisor is stale", async () => {
    const { bundleRoot, env, workspaceDir } = fixture("node-worker-stale-pending-");
    const supervisor = createNodeWorkerSupervisor({ bundleRoot, env });
    await supervisor.status("schema-probe");
    const input = testWorkerLaunchInput(workspaceDir, "stale-pending-launch");
    insertLaunch({
      env,
      input,
      state: "pending",
      supervisor: { pid: 2_147_483_647, startTime: 1 },
    });

    const running = await supervisor.launch(input, TEST_WORKER_ENDPOINT);

    expect(running).toMatchObject({
      state: "running",
      supervisor: requireNodeWorkerProcessIdentity(process.pid),
      worker: { pid: expect.any(Number), startTime: expect.any(Number) },
    });
    await supervisor.close();
  });

  it("releases a stale pending slot during restart reconciliation", async () => {
    const { bundleRoot, env, workspaceDir } = fixture("node-worker-restart-pending-");
    new NodeWorkerLaunchStore({ env }).get("schema-probe");
    const input = testWorkerLaunchInput(workspaceDir, "restart-pending-launch");
    insertLaunch({
      env,
      input,
      state: "pending",
      supervisor: { pid: 2_147_483_647, startTime: 1 },
    });
    const availability: boolean[] = [];
    const supervisor = createNodeWorkerSupervisor({
      bundleRoot,
      env,
      capacity: 1,
      onAvailabilityChanged: (available) => availability.push(available),
    });

    await supervisor.initialize();

    expect(await supervisor.status(input.launchId)).toMatchObject({
      state: "interrupted",
      worker: null,
    });
    expect(availability).toEqual([false, true]);
    await supervisor.close();
  });

  it.runIf(process.platform !== "win32").each([
    { operation: "replay" as const, state: "interrupted" as const },
    { operation: "cancel" as const, state: "cancelled" as const },
  ])(
    "$operation kills the exact stale-owner worker group before terminal persistence",
    async ({ operation, state }) => {
      const { bundleRoot, env, root, workspaceDir } = fixture("node-worker-stale-running-");
      const marker = path.join(root, "recovery-grandchild.pid");
      const workerSource = `
        const { spawn } = require("node:child_process");
        const fs = require("node:fs");
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        fs.writeFileSync(process.argv[1], String(child.pid));
        setInterval(() => {}, 1000);
      `;
      const workerProcess = spawn(process.execPath, ["-e", workerSource, marker], {
        detached: true,
        stdio: "ignore",
      });
      spawned.add(workerProcess);
      const worker = requireNodeWorkerProcessIdentity(workerProcess.pid!);
      ownedProcessGroups.push(worker);
      await vi.waitFor(() => expect(fs.readFileSync(marker, "utf8")).toMatch(/^[1-9]\d*$/u));
      const grandchild = requireNodeWorkerProcessIdentity(Number(fs.readFileSync(marker, "utf8")));
      const input = testWorkerLaunchInput(workspaceDir, "stale-running-launch", "wait");
      const supervisor = createNodeWorkerSupervisor({ bundleRoot, env });
      await supervisor.status("schema-probe");
      insertLaunch({
        env,
        input,
        state: "running",
        supervisor: { pid: 2_147_483_647, startTime: 1 },
        worker,
      });

      if (operation === "cancel") {
        await expect(
          supervisor.cancel({ ...testNodeWorkerLaunchIdentity(input), runId: "run-mismatch" }),
        ).resolves.toBeUndefined();
        expect(inspectNodeWorkerProcessIdentity(worker)).toBe("live");
      }
      const recovered =
        operation === "cancel"
          ? await supervisor.cancel(testNodeWorkerLaunchIdentity(input))
          : await supervisor.launch(input, TEST_WORKER_ENDPOINT);

      expect(recovered).toMatchObject({ state, worker });
      await waitForIdentityDeath(worker);
      await waitForIdentityDeath(grandchild);
      expect((await supervisor.status(input.launchId))?.worker).toEqual(worker);
      await supervisor.close();
    },
  );

  it("returns a live foreign running receipt from a real second process without mutation", async () => {
    const { bundleRoot, env, root, workspaceDir } = fixture("node-worker-live-replay-");
    const input = testWorkerLaunchInput(workspaceDir, "live-running-launch", "wait");
    const owner = spawnSupervisorOwner({ bundleRoot, env, input, root });
    const owned = JSON.parse(await waitForChildLine(owner)) as NodeWorkerLaunchReceipt;
    if (owned.worker) {
      ownedProcessGroups.push(owned.worker);
    }
    const second = createNodeWorkerSupervisor({ bundleRoot, env });

    const unchanged = await second.cancel(testNodeWorkerLaunchIdentity(input));
    if (process.platform === "linux") {
      const originalReadFileSync = fs.readFileSync;
      const supervisorStatPath = `/proc/${owned.supervisor.pid}/stat`;
      const readFileSync = vi.spyOn(fs, "readFileSync").mockImplementation(((
        file: fs.PathOrFileDescriptor,
        ...args: unknown[]
      ) => {
        if (file === supervisorStatPath) {
          throw new Error("injected unknown process identity");
        }
        return Reflect.apply(originalReadFileSync, fs, [file, ...args]);
      }) as typeof fs.readFileSync);
      try {
        await expect(second.cancel(testNodeWorkerLaunchIdentity(input))).resolves.toEqual(owned);
        expect(inspectNodeWorkerProcessIdentity(owned.worker!)).toBe("live");
      } finally {
        readFileSync.mockRestore();
      }
    }
    const replay = await second.launch(input, TEST_WORKER_ENDPOINT);

    expect(unchanged).toEqual(owned);
    expect(replay).toEqual(owned);
    expect(inspectNodeWorkerProcessIdentity(owned.supervisor)).toBe("live");
    expect(inspectNodeWorkerProcessIdentity(owned.worker!)).toBe("live");
    owner.kill("SIGTERM");
    await waitForChildExit(owner);
    await second.close();
  });

  it.runIf(process.platform !== "win32")(
    "uses IPC disconnect after owner SIGKILL, then reconciles only after exact tree death",
    async () => {
      const { bundleRoot, env, root, workspaceDir } = fixture("node-worker-owner-kill-");
      const input = testWorkerLaunchInput(workspaceDir, "owner-kill-launch", "tree");
      const owner = spawnSupervisorOwner({ bundleRoot, env, input, root });
      const owned = JSON.parse(await waitForChildLine(owner)) as NodeWorkerLaunchReceipt;
      ownedProcessGroups.push(owned.worker!);
      const grandchildPath = path.join(workspaceDir, "grandchild.pid");
      await vi.waitFor(() =>
        expect(fs.readFileSync(grandchildPath, "utf8")).toMatch(/^[1-9]\d*$/u),
      );
      const grandchild = requireNodeWorkerProcessIdentity(
        Number(fs.readFileSync(grandchildPath, "utf8")),
      );

      owner.kill("SIGKILL");
      await waitForChildExit(owner);
      await waitForIdentityDeath(owned.supervisor);
      await waitForIdentityDeath(owned.worker!);
      await waitForIdentityDeath(grandchild);

      const restarted = createNodeWorkerSupervisor({ bundleRoot, env });
      const reconciled = await restarted.status(input.launchId);
      expect(reconciled).toMatchObject({
        state: "interrupted",
        supervisor: owned.supervisor,
        worker: owned.worker,
      });
      await restarted.close();
    },
  );

  it("keeps a live foreign pending claim unchanged across real processes", async () => {
    const { bundleRoot, env, root, workspaceDir } = fixture("node-worker-live-pending-");
    const input = testWorkerLaunchInput(workspaceDir, "live-pending-launch", "wait");
    const claim = {
      launchId: input.launchId,
      planHash: planHash(input),
      gatewayNamespace: input.gatewayNamespace,
      environmentId: input.descriptor.admission.environmentId,
      sessionId: input.descriptor.admission.sessionId,
      ownerEpoch: input.descriptor.admission.ownerEpoch,
      placementGeneration: input.placementGeneration,
      runId: input.descriptor.assignment.runId,
    };
    const storeUrl = pathToFileURL(path.resolve("src/node-host/node-worker-launch-store.ts")).href;
    const identityUrl = pathToFileURL(
      path.resolve("src/node-host/node-worker-process-identity.ts"),
    ).href;
    const claimPath = path.join(root, "claim.json");
    const scriptPath = path.join(root, "pending-owner.mts");
    fs.writeFileSync(claimPath, JSON.stringify(claim));
    fs.writeFileSync(
      scriptPath,
      `
        import fs from "node:fs";
        import { NodeWorkerLaunchStore } from ${JSON.stringify(storeUrl)};
        import { requireNodeWorkerProcessIdentity } from ${JSON.stringify(identityUrl)};
        const [stateDir, claimPath] = process.argv.slice(2);
        const store = new NodeWorkerLaunchStore({ env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } });
        const result = store.claim(
          JSON.parse(fs.readFileSync(claimPath, "utf8")),
          requireNodeWorkerProcessIdentity(process.pid),
          2,
        );
        process.stdout.write(JSON.stringify(result.receipt) + "\\n");
        setInterval(() => {}, 1000);
      `,
    );
    const owner = spawn(
      process.execPath,
      ["--import", "tsx", scriptPath, env.OPENCLAW_STATE_DIR!, claimPath],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    spawned.add(owner);
    const owned = JSON.parse(await waitForChildLine(owner)) as NodeWorkerLaunchReceipt;
    const second = createNodeWorkerSupervisor({ bundleRoot, env });

    const replay = await second.launch(input, TEST_WORKER_ENDPOINT);

    expect(replay).toEqual(owned);
    owner.kill("SIGKILL");
    await waitForChildExit(owner);
    await second.close();
  });
});
