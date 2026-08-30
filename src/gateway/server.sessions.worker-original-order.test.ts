import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { WorkerProvider, WorkerSshEndpoint } from "../plugins/types.js";
import { runCommandWithTimeout, type CommandOptions, type SpawnResult } from "../process/exec.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { loadSessionEntry } from "./session-utils.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  bundleMcpRuntimeMocks,
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";
import { bootstrapWorker } from "./worker-environments/bootstrap.js";
import type { WorkerInstallationArtifact } from "./worker-environments/bundle.js";
import { createWorkerPlacementDispatchService } from "./worker-environments/placement-dispatch.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { deriveEnvironmentIntent } from "./worker-environments/service-contract.js";
import {
  createWorkerEnvironmentService,
  type WorkerEnvironmentService,
} from "./worker-environments/service.js";
import { createWorkerEnvironmentStore } from "./worker-environments/store.js";
import type { WorkerSshRunner } from "./worker-environments/tunnel-ssh-runner.js";
import { createWorkerTunnelManager } from "./worker-environments/tunnel.js";
import { prepareLocalWorkspaceRsyncBoundary } from "./worker-environments/tunnel.test-support.js";
import { rsyncArgvPort, sshArgvPort } from "./worker-environments/worker-ssh-argv.test-support.js";
import { createWorkerWorkspaceOperationCoordinator } from "./worker-environments/workspace-operation-coordinator.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
const PRIMARY_PORT = 2222;
const FALLBACK_PORT = 22;
const SESSION_ID = "session-original-order";
const SESSION_KEY = "agent:main:original-order";
const PROFILE_ID = "development";
const ENVIRONMENT_ID = deriveEnvironmentIntent(`session-dispatch:${SESSION_ID}:1`).environmentId;
const BUNDLE_HASH = "a".repeat(64);
const RECEIPT = {
  bundleHash: BUNDLE_HASH,
  openclawVersion: "2026.8.1",
  protocolFeatures: [WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE],
};
const INSTALLATION: WorkerInstallationArtifact = {
  install: "bundle",
  ...RECEIPT,
  tarballBytes: 1,
  tarballSha256: "b".repeat(64),
  tarballPath: "/gateway/worker-bundle.tgz",
};
const SSH_ENDPOINT: WorkerSshEndpoint = {
  host: "worker.example.test",
  port: PRIMARY_PORT,
  fallbackPorts: [FALLBACK_PORT],
  user: "openclaw",
  hostKey: "ssh-ed25519 AAAA",
  keyRef: { source: "file", provider: "worker-fixture", id: "/identity" },
};

function success(stdout = ""): SpawnResult {
  return {
    stdout,
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
  };
}

function transportFailure(): SpawnResult {
  return {
    ...success(),
    code: 255,
    stderr: "primary transport unavailable",
  };
}

function expectOrdered(actual: readonly string[], expected: readonly string[]): void {
  let previousIndex = -1;
  for (const event of expected) {
    const index = actual.indexOf(event, previousIndex + 1);
    expect(index, `missing ordered event ${event}\n${actual.join("\n")}`).toBeGreaterThan(
      previousIndex,
    );
    previousIndex = index;
  }
}

function argvPort(argv: readonly string[]): number {
  const port =
    argv[0] === "ssh"
      ? sshArgvPort(argv)
      : argv[0] === "rsync"
        ? rsyncArgvPort(argv)
        : Number(argv[argv.indexOf("-P") + 1]);
  if (!Number.isInteger(port)) {
    throw new Error(`missing SSH port for ${argv[0] ?? "command"}`);
  }
  return port!;
}

class OriginalOrderSshRunner implements WorkerSshRunner {
  readonly events: string[] = [];
  private bootstrapOperationToken: string | undefined;

  constructor(private readonly remoteHome: string) {}

  setBootstrapOperationId(operationId: string): void {
    this.bootstrapOperationToken = createHash("sha256").update(operationId).digest("hex");
  }

  get bootstrapUploadPath(): string {
    if (!this.bootstrapOperationToken) {
      throw new Error("bootstrap operation id is not configured");
    }
    return path.join(
      this.remoteHome,
      ".openclaw-worker",
      ".incoming",
      `openclaw-upload-${BUNDLE_HASH}.tgz.${this.bootstrapOperationToken}`,
    );
  }

  get bootstrapReceiptPath(): string {
    return path.join(this.remoteHome, ".openclaw-worker", BUNDLE_HASH, "bootstrap-receipt.json");
  }

  start(): never {
    throw new Error("remote-exec workspace transport must not start a persistent SSH process");
  }

  async run(argv: string[], options: CommandOptions): Promise<SpawnResult> {
    if (argv[0] === "git") {
      return await runCommandWithTimeout(argv, options);
    }
    const port = argvPort(argv);
    const input = typeof options.input === "string" ? options.input : "";
    if (argv[0] === "ssh" && input.includes("expected_receipt=$2")) {
      this.events.push(`bootstrap:preflight:${port}`);
      if (port === PRIMARY_PORT) {
        return transportFailure();
      }
      await fs.mkdir(path.dirname(this.bootstrapUploadPath), { recursive: true });
      await fs.writeFile(this.bootstrapUploadPath, "");
      return success(`OPENCLAW_WORKER_BOOTSTRAP_V1\tinstall\t${this.bootstrapUploadPath}\n`);
    }
    if (argv[0] === "scp") {
      this.events.push(`bootstrap:transfer:${port}`);
      await fs.writeFile(this.bootstrapUploadPath, "worker bundle");
      return success();
    }
    if (argv[0] === "ssh" && input.includes("receipt_matches()")) {
      this.events.push(`bootstrap:install:${port}`);
      await fs.mkdir(path.dirname(this.bootstrapReceiptPath), { recursive: true });
      await fs.writeFile(this.bootstrapReceiptPath, `${JSON.stringify(RECEIPT)}\n`);
      await fs.rm(this.bootstrapUploadPath, { force: true });
      return success(`OPENCLAW_WORKER_BOOTSTRAP_V1\treceipt\t${JSON.stringify(RECEIPT)}\n`);
    }
    if (argv[0] === "ssh" && input.includes("operation_token=$2")) {
      this.events.push(`bootstrap:cleanup:${port}`);
      return success();
    }
    if (argv[0] === "rsync") {
      this.events.push(`workspace:transfer:${port}`);
      if (argv.some((arg) => arg.startsWith("--rsync-path="))) {
        const boundary = await prepareLocalWorkspaceRsyncBoundary(this.remoteHome, argv);
        return await runCommandWithTimeout(boundary.argv, {
          ...options,
          baseEnv: { ...options.baseEnv, HOME: this.remoteHome },
        });
      }
      const localArgv = [...argv];
      const remoteShellIndex = localArgv.indexOf("-e");
      if (remoteShellIndex >= 0) {
        localArgv.splice(remoteShellIndex, 2);
      }
      for (let index = 1; index < localArgv.length; index += 1) {
        const candidate = localArgv[index];
        const separator = candidate?.indexOf(":") ?? -1;
        if (!candidate || separator < 0) {
          continue;
        }
        const remotePath = candidate.slice(separator + 1);
        localArgv[index] = path.isAbsolute(remotePath)
          ? remotePath
          : path.join(this.remoteHome, remotePath);
      }
      const destination = localArgv.at(-1);
      if (!destination) {
        throw new Error("workspace transfer has no destination");
      }
      await fs.mkdir(destination.endsWith("/") ? destination : path.dirname(destination), {
        recursive: true,
      });
      return await runCommandWithTimeout(localArgv, options);
    }
    if (argv[0] === "ssh") {
      this.events.push(`workspace:command:${port}`);
      const remoteCommand = argv.at(-1);
      if (!remoteCommand) {
        throw new Error("workspace command is missing its remote command");
      }
      return await runCommandWithTimeout(["sh", "-c", remoteCommand], {
        ...options,
        baseEnv: {
          ...options.baseEnv,
          HOME: this.remoteHome,
          PATH: `${path.join(this.remoteHome, "fixture-bin")}:${options.baseEnv?.PATH ?? ""}`,
        },
      });
    }
    throw new Error(`unexpected command: ${argv[0] ?? "missing"}`);
  }
}

async function installRemoteProcessFixture(remoteHome: string): Promise<void> {
  const bin = path.join(remoteHome, "fixture-bin");
  await fs.mkdir(bin, { recursive: true });
  // A real worker host has a dedicated UID. Keep the production quiescence script intact while
  // presenting only its own control process, so it never signals unrelated host-user processes.
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2).join(" ");
const started = "Sat Aug  8 00:00:00 2026";
if (args.includes("-axo")) {
  process.stdout.write(String(process.ppid) + " 0 " + String(process.getuid()) + " S " + started + "\\n");
} else if (args.includes("stat=,lstart=")) {
  process.stdout.write("S " + started + "\\n");
} else {
  process.stdout.write(started + "\\n");
}
`;
  const psPath = path.join(bin, "ps");
  await fs.writeFile(psPath, script, { mode: 0o700 });
  await fs.chmod(psPath, 0o700);
}

async function destroyRemoteProcessFixture(remoteHome: string): Promise<void> {
  const leaseDirectory = path.join(remoteHome, ".openclaw-worker", "quiescence");
  const leases = await fs.readdir(leaseDirectory).catch(() => []);
  for (const name of leases) {
    const leasePath = path.join(leaseDirectory, name);
    const lease = JSON.parse(await fs.readFile(leasePath, "utf8")) as {
      watchdog?: { pid?: number } | null;
    };
    const watchdogPid = lease.watchdog?.pid;
    if (typeof watchdogPid === "number" && Number.isSafeInteger(watchdogPid) && watchdogPid > 0) {
      try {
        process.kill(watchdogPid, "SIGTERM");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
          throw error;
        }
      }
    }
    await fs.rm(leasePath, { force: true });
  }
}

async function runGit(workspace: string, ...args: string[]): Promise<void> {
  const result = await runCommandWithTimeout(["git", "-C", workspace, ...args], {
    timeoutMs: 30_000,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args[0] ?? "command"} failed`);
  }
}

let database: OpenClawStateDatabase | undefined;
let root: string | undefined;
let tunnelManager: ReturnType<typeof createWorkerTunnelManager> | undefined;
let workerService: WorkerEnvironmentService | undefined;

afterEach(async () => {
  await workerService?.stop();
  workerService = undefined;
  await tunnelManager?.stopAll();
  tunnelManager = undefined;
  closeOpenClawStateDatabaseForTest();
  database = undefined;
  if (root) {
    await fs.rm(root, { recursive: true, force: true });
    root = undefined;
  }
});

test("preserves ordered fallback through restart, workspace sync, and safe session retirement", async () => {
  root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-worker-order-"));
  const stateDir = path.join(root, "state");
  const remoteHome = path.join(root, "remote-home");
  const localWorkspace = path.join(root, "workspace");
  await Promise.all([
    fs.mkdir(remoteHome, { recursive: true }),
    fs.mkdir(localWorkspace, { recursive: true }),
  ]);
  await installRemoteProcessFixture(remoteHome);
  await fs.writeFile(path.join(localWorkspace, "current.txt"), "current\n");
  await runGit(localWorkspace, "init");
  await runGit(localWorkspace, "config", "user.name", "Worker Boundary Test");
  await runGit(localWorkspace, "config", "user.email", "worker-boundary@example.test");
  await runGit(localWorkspace, "add", "current.txt");
  await runGit(localWorkspace, "commit", "-m", "initialize managed workspace");
  const runner = new OriginalOrderSshRunner(remoteHome);
  const events = runner.events;
  const provider: WorkerProvider = {
    id: "ordered-fallback",
    resolveAllocation: async () => ({ leaseId: "lease-original-order", sharedHost: false }),
    supportedExecutionModes: ["remote-exec"],
    provision: async () => {
      events.push("provider:provision");
      return { leaseId: "lease-original-order", ssh: SSH_ENDPOINT };
    },
    inspect: async () => ({ status: "active" }),
    destroy: async () => {
      await destroyRemoteProcessFixture(remoteHome);
      events.push("provider:destroy");
    },
  };

  database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
  const environmentStore = createWorkerEnvironmentStore({ database, now: () => 2_000 });
  const placements = createWorkerSessionPlacementStore({ database, now: () => 3_000 });
  tunnelManager = createWorkerTunnelManager({ runner });
  const environmentService = createWorkerEnvironmentService({
    store: environmentStore,
    getConfig: () => ({
      cloudWorkers: {
        profiles: {
          [PROFILE_ID]: { provider: provider.id, settings: {} },
        },
      },
    }),
    resolveProvider: (providerId) => (providerId === provider.id ? provider : undefined),
    prepareInstallation: async () => INSTALLATION,
    bootstrapWorker: async ({
      operationId,
      sshEndpoint,
      installation,
      resolveIdentity,
      signal,
    }) => {
      runner.setBootstrapOperationId(operationId);
      expect(environmentStore.get(ENVIRONMENT_ID)).toMatchObject({
        state: "bootstrapping",
        sshEndpoint: SSH_ENDPOINT,
      });
      closeOpenClawStateDatabaseForTest();
      events.push("gateway:reopen");
      database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
      expect(
        createWorkerEnvironmentStore({ database, now: () => 2_000 }).get(ENVIRONMENT_ID),
      ).toMatchObject({ state: "bootstrapping", sshEndpoint: SSH_ENDPOINT });
      return await bootstrapWorker(
        {
          operationId,
          ssh: sshEndpoint,
          artifact: installation,
          pinnedHostKey: sshEndpoint.hostKey,
        },
        {
          resolveIdentity,
          runCommand: (argv, options) => runner.run(argv, options),
          signal,
        },
      );
    },
    resolveSshIdentity: async () => ({ kind: "path", path: "/keys/worker" }),
    tunnelManager,
    generateWorkerCredential: () => "original-order-credential",
    liveEvents: {
      apply: () => ({ ok: true, result: { ackedSeq: 1 } }),
      bindSession: () => true,
      clear: () => {},
      clearEnvironment: () => {},
      rotateCredential: () => true,
      start: () => {},
    },
    executeInference: async () => ({
      type: "error",
      reason: "cancelled",
      message: "cancelled by boundary fixture",
    }),
  });
  workerService = environmentService;
  const dispatch = createWorkerPlacementDispatchService({
    placements,
    environments: {
      ...environmentService,
      startTunnel: async (request) => {
        const handle = await environmentService.startTunnel(request);
        return {
          ...handle,
          quiesceWorkspace: async (remoteWorkspaceDir) => {
            const quiescence = await handle.quiesceWorkspace(remoteWorkspaceDir);
            events.push("workspace:quiesce");
            return {
              assertActive: async () => {
                await quiescence.assertActive();
                events.push("workspace:renew-quiescence");
              },
              resume: async () => await quiescence.resume(),
            };
          },
        };
      },
    },
    runnerAvailability: { read: () => undefined, version: () => 0 },
    workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
    runLocalBarrier: async ({ startDispatch }) => startDispatch(),
    runRecoveryBarrier: async ({ run }) => await run(localWorkspace),
    runActivationBarrier: async ({ activate }) => activate(),
    runMoveBarrier: async ({ begin }) => begin(),
    resolveMoveDestination: async () => undefined,
    runReclaimBarrier: async ({ begin, reclaim }) => await reclaim(localWorkspace, begin()),
    runFailedReclaimBarrier: async ({ reclaim }) => await reclaim(),
    resolveWorkspacePath: async () => localWorkspace,
    reportWorkspaceResultConflict: async () => {},
    resolveWorkspaceResultConflict: async () => undefined,
  });

  const active = await dispatch.dispatch({
    sessionId: SESSION_ID,
    sessionKey: SESSION_KEY,
    agentId: "main",
    profileId: PROFILE_ID,
    executionMode: "remote-exec",
  });
  expect(active).toMatchObject({ state: "active", environmentId: ENVIRONMENT_ID });
  await expect(fs.stat(runner.bootstrapUploadPath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.readFile(runner.bootstrapReceiptPath, "utf8")).resolves.toBe(
    `${JSON.stringify(RECEIPT)}\n`,
  );
  expect(events).toContain(`bootstrap:cleanup:${FALLBACK_PORT}`);
  events.push("placement:active");
  await expect(
    dispatch.reclaim({ sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main" }),
  ).resolves.toMatchObject({ state: "reclaimed", environmentId: ENVIRONMENT_ID });
  expect(workerService.get(ENVIRONMENT_ID)).toMatchObject({ state: "destroyed" });
  expect(placements.get(SESSION_ID)).toMatchObject({ state: "reclaimed" });
  events.push("placement:reclaimed");

  await createSessionStoreDir();
  await writeSessionStore({ entries: { [SESSION_KEY]: sessionStoreEntry(SESSION_ID) } });
  bundleMcpRuntimeMocks.retireSessionMcpRuntime.mockImplementationOnce(async ({ sessionId }) => {
    expect(sessionId).toBe(SESSION_ID);
    expect(loadSessionEntry(SESSION_KEY).entry?.sessionId).toBe(SESSION_ID);
    expect(placements.get(SESSION_ID)?.state).toBe("reclaimed");
    events.push("session:cleanup");
    return true;
  });
  const deleted = await directSessionReq(
    "sessions.delete",
    { key: SESSION_KEY },
    {
      context: {
        workerSessionPlacementService: {
          getMany: (sessionIds: readonly string[]) => placements.getMany(sessionIds),
          retireSessionPlacement: (
            retirement: Parameters<typeof placements.retireSessionPlacement>[0],
          ) => {
            expect(loadSessionEntry(SESSION_KEY).entry).toBeUndefined();
            expect(placements.get(SESSION_ID)?.state).toBe("reclaimed");
            events.push("placement:retire");
            placements.retireSessionPlacement(retirement);
          },
        },
      },
    },
  );
  events.push("session:deleted");

  expect(deleted.ok).toBe(true);
  expect(placements.get(SESSION_ID)).toBeUndefined();
  expect(loadSessionEntry(SESSION_KEY).entry).toBeUndefined();
  expectOrdered(events, [
    "provider:provision",
    "gateway:reopen",
    `bootstrap:preflight:${PRIMARY_PORT}`,
    `bootstrap:preflight:${FALLBACK_PORT}`,
    `bootstrap:transfer:${FALLBACK_PORT}`,
    `bootstrap:install:${FALLBACK_PORT}`,
    `bootstrap:cleanup:${FALLBACK_PORT}`,
    `workspace:transfer:${PRIMARY_PORT}`,
    "placement:active",
    "workspace:quiesce",
    "workspace:renew-quiescence",
    "provider:destroy",
    "placement:reclaimed",
    "session:cleanup",
    "placement:retire",
    "session:deleted",
  ]);
});
