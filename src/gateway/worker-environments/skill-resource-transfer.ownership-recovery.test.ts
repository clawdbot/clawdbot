import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadWorkspaceSkills } from "../../skills/loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../../skills/loading/workspace-skill-prompt.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { createSkillResourceAllocationCoordinator } from "./skill-resource-allocation-coordinator.js";
import { createSkillResourceAllocationLedger } from "./skill-resource-allocation-ledger.js";
import { skillResourceAllocationDirectoryName } from "./skill-resource-transfer-contract.js";
import { transferSkillResources } from "./skill-resource-transfer.js";
import type { WorkerWorkspaceTunnelHandle } from "./tunnel-contract.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const permitPrefix = ".openclaw-skill-resource-permit-";
const registryPrefix = ".openclaw-skill-resource-lease-";

function reaperBootstrapMutation(mutateSource: string): string {
  return String.raw`script=>{const z=require('node:zlib'),match=/^const s=("[A-Za-z0-9+/=]+");/.exec(script);if(!match)throw Error('unexpected reaper bootstrap');const source=z.inflateRawSync(Buffer.from(JSON.parse(match[1]),'base64')).toString(),changed=(${mutateSource})(source),compressed=z.deflateRawSync(changed).toString('base64');return script.replace(match[1],JSON.stringify(compressed));}`;
}

function createSpawnTunnel(remoteWorkspaceDir: string) {
  return {
    remoteWorkspaceDir,
    runWorkspaceCommand: async (
      command: Parameters<WorkerWorkspaceTunnelHandle["runWorkspaceCommand"]>[0],
    ) => {
      command.assertCurrent?.();
      return await new Promise<{
        stdout: string;
        stderr: string;
        code: number | null;
        termination: "exit";
        signal: NodeJS.Signals | null;
        killed: false;
      }>((resolve, reject) => {
        const child = spawn(command.argv[0]!, command.argv.slice(1), {
          cwd: remoteWorkspaceDir,
          stdio: "pipe",
          signal: command.signal,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (bytes) => {
          stdout += bytes;
        });
        child.stderr.on("data", (bytes) => {
          stderr += bytes;
        });
        child.on("error", reject);
        child.on("close", (code, signal) => {
          resolve({ stdout, stderr, code, signal, termination: "exit", killed: false });
        });
        child.stdin.end(command.input);
      });
    },
  };
}

function createCoordinator(stateDir: string, incarnationId: string) {
  const databaseOptions = { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
  const ledger = createSkillResourceAllocationLedger({ databaseOptions, incarnationId });
  return {
    coordinator: createSkillResourceAllocationCoordinator(ledger, {
      ownershipDatabaseOptions: databaseOptions,
      ownershipLeaseMs: 120_000,
    }),
    ledger,
  };
}

async function createSnapshot() {
  const workspace = await fs.realpath(temps.make("resource-ownership-source-"));
  const baseDir = path.join(workspace, "skills", "source");
  await fs.mkdir(baseDir, { recursive: true });
  await fs.writeFile(
    path.join(baseDir, "SKILL.md"),
    "---\ndescription: Resource ownership recovery test\n---\n# Resource\n",
  );
  return buildSkillSnapshot(workspace, {
    entries: loadWorkspaceSkills(workspace, { workspaceOnly: true }),
  });
}

describe("remote-exec skill resource ownership recovery", () => {
  it("reserves a durable intent before concurrent recovery can observe it", async () => {
    const remoteWorkspaceDir = await fs.realpath(temps.make("resource-intent-publication-"));
    const stateDir = temps.make("resource-intent-publication-state-");
    const allocation = createCoordinator(stateDir, "2".repeat(32));
    const createIntent = allocation.ledger.createIntent.bind(allocation.ledger);
    let releaseInsert!: () => void;
    const insertHeld = new Promise<void>((resolve) => {
      releaseInsert = resolve;
    });
    let reportPersisted!: () => void;
    const persisted = new Promise<void>((resolve) => {
      reportPersisted = resolve;
    });
    vi.spyOn(allocation.ledger, "createIntent").mockImplementation(async (...args) => {
      const record = await createIntent(...args);
      reportPersisted();
      await insertHeld;
      return record;
    });
    const allocationId = "3".repeat(32);
    const creating = allocation.coordinator.createIntent({
      allocationId,
      environmentId: "intent-publication-environment",
      ownerEpoch: 1,
      workspace: remoteWorkspaceDir,
      leaseToken: "4".repeat(64),
    });
    await persisted;
    const deferred = vi.fn();

    await allocation.coordinator.recover({
      getEnvironment: () => ({ state: "destroyed", ownerEpoch: 1 }),
      startTunnel: vi.fn(),
      onEnvironmentCleanupDeferred: deferred,
    });

    expect(deferred).toHaveBeenCalledWith("intent-publication-environment");
    await expect(allocation.ledger.list()).resolves.toHaveLength(1);
    releaseInsert();
    await expect(creating).resolves.toMatchObject({ allocationId, phase: "intent" });
    allocation.coordinator.abandon(allocationId);
    await allocation.coordinator.stop();
  });

  it("retains terminal environment evidence while its live turn owns cleanup", async () => {
    const remoteWorkspaceDir = await fs.realpath(temps.make("resource-active-terminal-"));
    const stateDir = temps.make("resource-active-terminal-state-");
    const allocation = createCoordinator(stateDir, "3".repeat(32));
    await allocation.coordinator.createIntent({
      allocationId: "4".repeat(32),
      environmentId: "active-terminal-environment",
      ownerEpoch: 1,
      workspace: remoteWorkspaceDir,
      leaseToken: "5".repeat(64),
    });
    const deferred = vi.fn();

    await allocation.coordinator.recover({
      getEnvironment: () => ({ state: "destroyed", ownerEpoch: 1 }),
      startTunnel: vi.fn(),
      onEnvironmentCleanupDeferred: deferred,
    });

    expect(deferred).toHaveBeenCalledWith("active-terminal-environment");
    await expect(allocation.ledger.list()).resolves.toMatchObject([
      { allocationId: "4".repeat(32), phase: "intent" },
    ]);
    allocation.coordinator.abandon("4".repeat(32));
    await allocation.coordinator.stop();
  });

  it("preserves each caller's deferral guard across concurrent recovery requests", async () => {
    const remoteWorkspaceDir = await fs.realpath(temps.make("resource-recovery-queue-"));
    const stateDir = temps.make("resource-recovery-queue-state-");
    const allocation = createCoordinator(stateDir, "4".repeat(32));
    await allocation.ledger.createIntent({
      allocationId: "5".repeat(32),
      environmentId: "failed-environment",
      ownerEpoch: 1,
      workspace: remoteWorkspaceDir,
      leaseToken: "6".repeat(64),
    });
    const deferred = vi.fn();
    const getEnvironment = () => ({ state: "failed", ownerEpoch: 1 });

    const reconnectRecovery = allocation.coordinator.recover({
      getEnvironment,
      startTunnel: vi.fn(),
    });
    const fullSweepRecovery = allocation.coordinator.recover({
      getEnvironment,
      startTunnel: vi.fn(),
      onEnvironmentCleanupDeferred: deferred,
    });
    await Promise.all([reconnectRecovery, fullSweepRecovery]);

    expect(deferred).toHaveBeenCalledOnce();
    expect(deferred).toHaveBeenCalledWith("failed-environment");
    await expect(allocation.ledger.list()).resolves.toHaveLength(1);
    await allocation.coordinator.stop();
  });

  it("retires host intent only after provider-confirmed environment destruction", async () => {
    const remoteWorkspaceDir = await fs.realpath(temps.make("resource-destroyed-workspace-"));
    const stateDir = temps.make("resource-destroyed-state-");
    const original = createCoordinator(stateDir, "5".repeat(32));
    const record = await original.ledger.createIntent({
      allocationId: "6".repeat(32),
      environmentId: "destroyed-environment",
      ownerEpoch: 1,
      workspace: remoteWorkspaceDir,
      leaseToken: "7".repeat(64),
    });
    const replacement = createCoordinator(stateDir, "8".repeat(32));
    const startTunnel = vi.fn();

    await replacement.coordinator.recover({
      getEnvironment: () => ({ state: "destroyed", ownerEpoch: 2 }),
      startTunnel,
    });

    expect(startTunnel).not.toHaveBeenCalled();
    await expect(replacement.ledger.list()).resolves.toEqual([]);
    expect(record.phase).toBe("intent");
    await replacement.coordinator.stop();
  });

  it.each([
    { cut: "after remote prepare", operation: "cleanup", phase: "cleanup-pending" },
    { cut: "after durable receipt", operation: "cleanup-finalize", phase: "cleanup-complete" },
  ] as const)(
    "lets a replacement Gateway finish cleanup after ownership loss $cut",
    async ({ operation: takeoverOperation, phase }) => {
      const remoteWorkspaceDir = await fs.realpath(temps.make("resource-cleanup-takeover-"));
      const carrier = createSpawnTunnel(remoteWorkspaceDir);
      const stateDir = temps.make("resource-cleanup-takeover-state-");
      const current = createCoordinator(stateDir, "7".repeat(32));
      let allocationId: string | undefined;
      let root: string | undefined;
      let takeoverInjected = false;
      const replaceOwner = () => {
        openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } })
          .db.prepare(
            "UPDATE state_leases SET owner = ?, expires_at = ?, updated_at = ? WHERE scope = ? AND lease_key = ?",
          )
          .run(
            "replacement-owner",
            Date.now() + 60_000,
            Date.now(),
            "worker.skill-resource-allocation-owner.v1",
            "gateway",
          );
      };
      const instrumented = {
        runWorkspaceCommand: async (
          command: Parameters<WorkerWorkspaceTunnelHandle["runWorkspaceCommand"]>[0],
        ) => {
          const operation = JSON.parse(command.input!);
          if (operation.op === takeoverOperation && !takeoverInjected) {
            takeoverInjected = true;
            if (operation.op === "cleanup") {
              const result = await carrier.runWorkspaceCommand(command);
              replaceOwner();
              return result;
            }
            replaceOwner();
            return {
              stdout: "",
              stderr: "ownership replaced before finalize",
              code: 1,
              termination: "exit" as const,
              signal: null,
              killed: false,
            };
          }
          const result = await carrier.runWorkspaceCommand(command);
          if (operation.op === "init") {
            allocationId = operation.id;
            root = path.join(
              remoteWorkspaceDir,
              `${registryPrefix}${operation.id}`,
              skillResourceAllocationDirectoryName(operation.id),
            );
          }
          return result;
        },
      };
      const resources = await transferSkillResources({
        snapshot: await createSnapshot(),
        remoteWorkspaceDir,
        assertCurrent: () => {},
        allocationOwner: {
          coordinator: current.coordinator,
          environmentId: "test-environment",
          ownerEpoch: 1,
        },
        tunnel: instrumented,
      });

      await expect(resources!.cleanup()).rejects.toThrow(/skill resource allocation owner/iu);
      await expect(current.ledger.list()).resolves.toMatchObject([{ allocationId, phase }]);
      await expect(fs.stat(root!)).rejects.toMatchObject({ code: "ENOENT" });
      await current.coordinator.stop();
      openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } })
        .db.prepare("DELETE FROM state_leases WHERE scope = ? AND lease_key = ?")
        .run("worker.skill-resource-allocation-owner.v1", "gateway");

      const replacement = createCoordinator(stateDir, "8".repeat(32));
      let recoveryOwnerEpoch: number | undefined;
      await replacement.coordinator.recover({
        getEnvironment: () => ({ state: "attached", ownerEpoch: 2 }),
        startTunnel: async (request) => {
          recoveryOwnerEpoch = request.ownerEpoch;
          return carrier as never;
        },
      });
      expect(recoveryOwnerEpoch).toBe(2);
      await expect(replacement.ledger.list()).resolves.toEqual([]);
      await expect(
        fs.stat(path.join(remoteWorkspaceDir, `${registryPrefix}${allocationId}`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await replacement.coordinator.stop();
    },
  );

  it.each([
    {
      cut: "before lease creation",
      needle: "assertClaimedPermit();writeInitialLease();",
      replacement: "fs.unlinkSync(claimedPermit);assertClaimedPermit();writeInitialLease();",
    },
    {
      cut: "before public root publication",
      needle: "assertClaimedPermit();fs.renameSync(stagedRoot,root);",
      replacement:
        "fs.unlinkSync(claimedPermit);assertClaimedPermit();fs.renameSync(stagedRoot,root);",
    },
  ])("publishes nothing after permit revocation $cut", async ({ needle, replacement }) => {
    const remoteWorkspaceDir = await fs.realpath(temps.make("resource-permit-revoked-"));
    const carrier = createSpawnTunnel(remoteWorkspaceDir);
    const stateDir = temps.make("resource-permit-revoked-state-");
    const allocationOwner = createCoordinator(stateDir, "9".repeat(32));
    let allocationId: string | undefined;
    await expect(
      transferSkillResources({
        snapshot: await createSnapshot(),
        remoteWorkspaceDir,
        assertCurrent: () => {},
        allocationOwner: {
          coordinator: allocationOwner.coordinator,
          environmentId: "test-environment",
          ownerEpoch: 1,
        },
        tunnel: {
          runWorkspaceCommand: async (command) => {
            const operation = JSON.parse(command.input!);
            if (operation.op !== "init") {
              return await carrier.runWorkspaceCommand(command);
            }
            allocationId = operation.id;
            const mutateReaper = `script=>script.replace(${JSON.stringify(needle)},${JSON.stringify(replacement)})`;
            const revoke = `(()=>{const childProcess=require('node:child_process'),original=childProcess.spawn;childProcess.spawn=(file,args,options)=>{const adjusted=[...args];if(adjusted[2]==='initialize')adjusted[1]=(${reaperBootstrapMutation(mutateReaper)})(adjusted[1]);return original(file,adjusted,options);};})();`;
            return await carrier.runWorkspaceCommand({
              ...command,
              argv: [command.argv[0]!, command.argv[1]!, revoke + command.argv[2]!],
            });
          },
        },
      }),
    ).rejects.toThrow("Invalid skill resource allocation");

    await expect(allocationOwner.ledger.list()).resolves.toEqual([]);
    for (const prefix of [permitPrefix, registryPrefix]) {
      await expect(
        fs.stat(path.join(remoteWorkspaceDir, `${prefix}${allocationId}`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(
      fs.stat(
        path.join(
          remoteWorkspaceDir,
          `${registryPrefix}${allocationId}`,
          skillResourceAllocationDirectoryName(allocationId!),
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await allocationOwner.coordinator.stop();
  });
});
