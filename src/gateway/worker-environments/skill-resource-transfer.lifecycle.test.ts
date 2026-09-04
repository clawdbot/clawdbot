import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadWorkspaceSkills } from "../../skills/loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../../skills/loading/workspace-skill-prompt.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { createSkillResourceAllocationCoordinator } from "./skill-resource-allocation-coordinator.js";
import { createSkillResourceAllocationLedger } from "./skill-resource-allocation-ledger.js";
import { skillResourceAllocationDirectoryName } from "./skill-resource-transfer-contract.js";
import { transferSkillResources as transferSkillResourcesImpl } from "./skill-resource-transfer.js";
import type { WorkerWorkspaceTunnelHandle } from "./tunnel-contract.js";
import { WORKER_ATTACHMENT_DIRECTORY_PREFIX } from "./workspace-path-exclusions.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const resourcePermitPrefix = ".openclaw-skill-resource-permit-";
const resourceRegistryPrefix = ".openclaw-skill-resource-lease-";
type TestTunnel = Pick<WorkerWorkspaceTunnelHandle, "runWorkspaceCommand"> & {
  remoteWorkspaceDir: string;
};

function reaperBootstrapMutation(mutateSource: string): string {
  return String.raw`script=>{const z=require('node:zlib'),match=/^const s=("[A-Za-z0-9+/=]+");/.exec(script);if(!match)throw Error('unexpected reaper bootstrap');const source=z.inflateRawSync(Buffer.from(JSON.parse(match[1]),'base64')).toString(),changed=(${mutateSource})(source),compressed=z.deflateRawSync(changed).toString('base64');return script.replace(match[1],JSON.stringify(compressed));}`;
}

function replaceRuntimeSource(script: string, needle: string, replacement: string): string {
  const match = /Buffer\.from\(("[A-Za-z0-9+/=]+"),'base64'\)/.exec(script);
  if (!match?.[1]) {
    throw new Error("unexpected resource runtime bootstrap");
  }
  const source = inflateRawSync(Buffer.from(JSON.parse(match[1]), "base64")).toString();
  const changed = source.replace(needle, replacement);
  if (changed === source) {
    throw new Error("resource runtime mutation did not apply");
  }
  return script.replace(match[1], JSON.stringify(deflateRawSync(changed).toString("base64")));
}

function createSpawnTunnel(remoteWorkspaceDir: string): TestTunnel {
  return {
    remoteWorkspaceDir,
    runWorkspaceCommand: async (command) => {
      command.assertCurrent?.();
      return new Promise((resolve, reject) => {
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
        child.on("close", (code) => {
          resolve({ stdout, stderr, code, termination: "exit", signal: null, killed: false });
        });
        child.stdin.end(command.input);
      });
    },
  };
}

let tunnel: TestTunnel;
beforeEach(async () => {
  tunnel = createSpawnTunnel(await fs.realpath(temps.make("skill-resource-default-carrier-")));
});

type TestTransferParams = Omit<
  Parameters<typeof transferSkillResourcesImpl>[0],
  "allocationOwner" | "remoteWorkspaceDir" | "tunnel"
> & {
  remoteWorkspaceDir?: string;
  tunnel: Pick<WorkerWorkspaceTunnelHandle, "runWorkspaceCommand"> &
    Partial<Pick<TestTunnel, "remoteWorkspaceDir">>;
};

async function transferSkillResources(params: TestTransferParams) {
  const carrierWorkspace = (params.tunnel as Partial<TestTunnel>).remoteWorkspaceDir;
  const databaseOptions = {
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: temps.make("skill-resource-host-ledger-"),
    },
  };
  const coordinator = createSkillResourceAllocationCoordinator(
    createSkillResourceAllocationLedger({ databaseOptions }),
    { ownershipDatabaseOptions: databaseOptions, ownershipLeaseMs: 120_000 },
  );
  try {
    const result = await transferSkillResourcesImpl({
      ...params,
      allocationOwner: {
        coordinator,
        environmentId: "test-environment",
        ownerEpoch: 1,
      },
      remoteWorkspaceDir:
        params.remoteWorkspaceDir ?? carrierWorkspace ?? tunnel.remoteWorkspaceDir,
    });
    if (!result) {
      await coordinator.stop();
      return result;
    }
    const cleanup = result.cleanup;
    return {
      ...result,
      cleanup: async () => {
        await cleanup();
        await coordinator.stop();
      },
    };
  } catch (error) {
    await coordinator.stop();
    throw error;
  }
}

function createTestCoordinator(stateDir: string, incarnationId?: string) {
  const databaseOptions = {
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  };
  const ledger = createSkillResourceAllocationLedger({
    databaseOptions,
    ...(incarnationId ? { incarnationId } : {}),
  });
  return {
    coordinator: createSkillResourceAllocationCoordinator(ledger, {
      ownershipDatabaseOptions: databaseOptions,
    }),
    ledger,
  };
}

function createTestAllocationOwner(incarnationId?: string) {
  const stateDir = temps.make("skill-resource-host-ledger-control-");
  const { coordinator, ledger } = createTestCoordinator(stateDir, incarnationId);
  return {
    coordinator,
    environmentId: "test-environment",
    ledger,
    ownerEpoch: 1,
    stateDir,
  };
}

function resourceRootFor(remoteWorkspaceDir: string, id: string): string {
  const remotePath = path.posix.isAbsolute(remoteWorkspaceDir) ? path.posix : path.win32;
  return remotePath.join(
    remotePath.normalize(remoteWorkspaceDir),
    `${resourceRegistryPrefix}${id}`,
    skillResourceAllocationDirectoryName(id),
  );
}

function resourceRegistryFileFor(root: string, id: string, identity: string): string {
  return path.join(path.dirname(root), `${id}.${identity.replace(":", ".")}.json`);
}

async function createSource() {
  const workspace = await fs.realpath(temps.make("remote-skill-source-"));
  const baseDir = path.join(workspace, "skills", "source");
  await fs.mkdir(path.join(baseDir, "scripts"), { recursive: true });
  const filePath = path.join(baseDir, "SKILL.md");
  await fs.writeFile(
    filePath,
    "---\ndescription: Resource transfer test\n---\n# Resource\nRead data.bin and run scripts/check.sh.\n",
  );
  const binary = Buffer.alloc(150000, 129);
  await fs.writeFile(path.join(baseDir, "data.bin"), binary);
  await fs.writeFile(path.join(baseDir, "scripts/check.sh"), "#!/bin/sh\nprintf ready\n", {
    mode: 0o700,
  });
  return {
    workspace,
    filePath,
    binary,
    snapshot: buildSkillSnapshot(workspace, {
      entries: loadWorkspaceSkills(workspace, { workspaceOnly: true }),
    }),
  };
}

describe("remote-exec skill resource lifecycle", () => {
  it("rejects an ownership takeover between the precheck and ledger transaction", async () => {
    const stateDir = temps.make("skill-resource-owner-transaction-");
    const current = createTestCoordinator(stateDir, "a".repeat(32));
    const originalCreateIntent = current.ledger.createIntent.bind(current.ledger);
    vi.spyOn(current.ledger, "createIntent").mockImplementationOnce(async (intent, fence) => {
      openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      })
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
      return await originalCreateIntent(intent, fence);
    });

    await expect(
      current.coordinator.createIntent({
        allocationId: "b".repeat(32),
        environmentId: "test-environment",
        ownerEpoch: 1,
        workspace: "/remote/workspace",
        leaseToken: "c".repeat(64),
      }),
    ).rejects.toThrow(/skill resource allocation owner/iu);
    await expect(current.ledger.list()).resolves.toEqual([]);
    await current.coordinator.stop();
  });

  it("commits an intent when the transaction owner is unchanged", async () => {
    const current = createTestAllocationOwner("d".repeat(32));

    const record = await current.coordinator.createIntent({
      allocationId: "e".repeat(32),
      environmentId: current.environmentId,
      ownerEpoch: current.ownerEpoch,
      workspace: "/remote/workspace",
      leaseToken: "f".repeat(64),
    });

    await expect(current.ledger.list()).resolves.toEqual([record]);
    await current.coordinator.stop();
  });

  it("reclaims an empty intent when the receiver dies before spawning its reaper", async () => {
    const remoteWorkspaceDir = await fs.realpath(temps.make("skill-resource-before-reaper-"));
    const carrier = createSpawnTunnel(remoteWorkspaceDir);
    const { snapshot } = await createSource();
    const allocationOwner = createTestAllocationOwner();
    let allocationId: string | undefined;
    await expect(
      transferSkillResourcesImpl({
        snapshot,
        remoteWorkspaceDir,
        assertCurrent: () => {},
        allocationOwner,
        tunnel: {
          runWorkspaceCommand: async (command) => {
            const operation = JSON.parse(command.input!);
            if (operation.op !== "init") {
              return await carrier.runWorkspaceCommand(command);
            }
            allocationId = operation.id;
            const dieBeforeSpawn =
              "require('node:child_process').spawn=()=>{process.kill(process.pid,'SIGKILL')};";
            return await carrier.runWorkspaceCommand({
              ...command,
              argv: [command.argv[0]!, command.argv[1]!, dieBeforeSpawn + command.argv[2]!],
            });
          },
        },
      }),
    ).rejects.toThrow("Invalid skill resource allocation");

    expect(allocationId).toBeDefined();
    await expect(allocationOwner.ledger.list()).resolves.toEqual([]);
    await expect(fs.stat(resourceRootFor(remoteWorkspaceDir, allocationId!))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
    await expect(
      fs.stat(path.join(remoteWorkspaceDir, `${resourceRegistryPrefix}${allocationId}`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reclaims a complete temporary when permit publication is interrupted", async () => {
    const remoteWorkspaceDir = await fs.realpath(temps.make("skill-resource-permit-publish-"));
    const carrier = createSpawnTunnel(remoteWorkspaceDir);
    const { snapshot } = await createSource();
    const allocationOwner = createTestAllocationOwner();
    let allocationId: string | undefined;
    let lookalike: string | undefined;
    await expect(
      transferSkillResourcesImpl({
        snapshot,
        remoteWorkspaceDir,
        assertCurrent: () => {},
        allocationOwner,
        tunnel: {
          runWorkspaceCommand: async (command) => {
            const operation = JSON.parse(command.input!);
            if (operation.op !== "init") {
              return await carrier.runWorkspaceCommand(command);
            }
            allocationId = operation.id;
            const permit = path.join(remoteWorkspaceDir, `${resourcePermitPrefix}${operation.id}`);
            const publicationPrefix = `.openclaw-private-publish.${createHash("sha256")
              .update(path.basename(permit))
              .digest("hex")}.`;
            lookalike = path.join(
              remoteWorkspaceDir,
              `x${publicationPrefix.slice(1)}${"a".repeat(32)}.tmp`,
            );
            await fs.writeFile(lookalike, "operator-owned");
            const dieAfterPermitLink = `(()=>{const crashFs=require('node:fs'),crashPath=require('node:path'),permit=${JSON.stringify(permit)},original=crashFs.linkSync;crashFs.linkSync=function(source,target,...args){const result=original.call(crashFs,source,target,...args);if(crashPath.resolve(String(target))===crashPath.resolve(permit))process.kill(process.pid,'SIGKILL');return result;};})();`;
            return await carrier.runWorkspaceCommand({
              ...command,
              argv: [command.argv[0]!, command.argv[1]!, dieAfterPermitLink + command.argv[2]!],
            });
          },
        },
      }),
    ).rejects.toThrow("Invalid skill resource allocation");

    expect(allocationId).toBeDefined();
    await expect(allocationOwner.ledger.list()).resolves.toEqual([]);
    expect(
      (await fs.readdir(remoteWorkspaceDir)).filter((name) =>
        name.startsWith(".openclaw-private-publish."),
      ),
    ).toEqual([]);
    await expect(
      fs.stat(path.join(remoteWorkspaceDir, `${resourcePermitPrefix}${allocationId}`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(lookalike!, "utf8")).resolves.toBe("operator-owned");
  });

  it("never replaces a file raced against permit publication", async () => {
    const remoteWorkspaceDir = await fs.realpath(temps.make("skill-resource-permit-race-"));
    const carrier = createSpawnTunnel(remoteWorkspaceDir);
    const { snapshot } = await createSource();
    const allocationOwner = createTestAllocationOwner();
    let allocationId: string | undefined;
    let permit: string | undefined;
    await expect(
      transferSkillResourcesImpl({
        snapshot,
        remoteWorkspaceDir,
        assertCurrent: () => {},
        allocationOwner,
        tunnel: {
          runWorkspaceCommand: async (command) => {
            const operation = JSON.parse(command.input!);
            if (operation.op !== "init") {
              return await carrier.runWorkspaceCommand(command);
            }
            allocationId = operation.id;
            permit = path.join(remoteWorkspaceDir, `${resourcePermitPrefix}${operation.id}`);
            const racePermit = `(()=>{const raceFs=require('node:fs'),racePath=require('node:path'),permit=${JSON.stringify(permit)},original=raceFs.linkSync;let fired=false;raceFs.linkSync=function(source,target,...args){if(!fired&&racePath.resolve(String(target))===racePath.resolve(permit)){fired=true;raceFs.writeFileSync(permit,'operator-owned',{flag:'wx'});}return original.call(raceFs,source,target,...args);};})();`;
            return await carrier.runWorkspaceCommand({
              ...command,
              argv: [command.argv[0]!, command.argv[1]!, racePermit + command.argv[2]!],
            });
          },
        },
      }),
    ).rejects.toThrow("Invalid skill resource allocation");

    await expect(fs.readFile(permit!, "utf8")).resolves.toBe("operator-owned");
    await expect(allocationOwner.ledger.list()).resolves.toMatchObject([
      { allocationId, phase: "cleanup-pending" },
    ]);
    await fs.unlink(permit!);
    await allocationOwner.coordinator.recover({
      getEnvironment: () => ({ state: "attached", ownerEpoch: 1, leaseId: "lease-active" }),
      startTunnel: async () => carrier as never,
    });
    await expect(allocationOwner.ledger.list()).resolves.toEqual([]);
    await allocationOwner.coordinator.stop();
  });

  it.each([
    {
      name: "during stage-claim atomic publication",
      mutateReaper: String.raw`script=>script.replace("fs.linkSync(temporary,file);syncDirectory(parent);","if(path.basename(file)===path.basename(stageClaim))process.kill(process.pid,'SIGKILL');fs.linkSync(temporary,file);syncDirectory(parent);")`,
    },
    {
      name: "during root-marker atomic publication",
      mutateReaper: String.raw`script=>script.replace("fs.linkSync(temporary,file);syncDirectory(parent);","fs.linkSync(temporary,file);if(path.basename(file)===${JSON.stringify(".openclaw-skill-resource-owner")})process.kill(process.pid,'SIGKILL');syncDirectory(parent);")`,
    },
    {
      name: "after private root creation and before ownership marking",
      mutateReaper: String.raw`script=>script.replace("fs.mkdirSync(stagedRoot,{mode:0o700});assertClaimedPermit();","fs.mkdirSync(stagedRoot,{mode:0o700});process.kill(process.pid,'SIGKILL');assertClaimedPermit();")`,
    },
    {
      name: "after private ownership marking and before root publication",
      mutateReaper: String.raw`script=>script.replace("fs.linkSync(rootMarker,registryMarker);syncDirectory(stagedRoot);","fs.linkSync(rootMarker,registryMarker);process.kill(process.pid,'SIGKILL');syncDirectory(stagedRoot);")`,
    },
    {
      name: "after marked root publication and before lease creation",
      mutateReaper: String.raw`script=>script.replace("fs.renameSync(stagedRoot,root);syncRegistry();","fs.renameSync(stagedRoot,root);process.kill(process.pid,'SIGKILL');syncRegistry();")`,
    },
    {
      name: "after the lease record and before returning its locator",
      mutateReaper: String.raw`script=>script.replace("process.stdout.write(JSON.stringify({identity:recordIdentity,registryIdentity:expectedRegistryIdentity,workspaceIdentity:expectedWorkspaceIdentity}),()=>process.stdout.end());","process.kill(process.pid,'SIGKILL');")`,
    },
  ])("reclaims an allocation when its reaper dies $name", async ({ mutateReaper }) => {
    const remoteWorkspaceDir = await fs.realpath(temps.make("skill-resource-reaper-crash-"));
    const carrier = createSpawnTunnel(remoteWorkspaceDir);
    const { snapshot } = await createSource();
    const allocationOwner = createTestAllocationOwner();
    let allocationId: string | undefined;
    await expect(
      transferSkillResourcesImpl({
        snapshot,
        remoteWorkspaceDir,
        assertCurrent: () => {},
        allocationOwner,
        tunnel: {
          runWorkspaceCommand: async (command) => {
            const operation = JSON.parse(command.input!);
            if (operation.op !== "init") {
              return await carrier.runWorkspaceCommand(command);
            }
            allocationId = operation.id;
            const crashReaper = String.raw`(()=>{const childProcess=require('node:child_process'),original=childProcess.spawn;childProcess.spawn=(file,args,options)=>{const adjusted=[...args];if(adjusted[2]==='initialize')adjusted[1]=(${reaperBootstrapMutation(mutateReaper)})(adjusted[1]);return original(file,adjusted,options);};})();`;
            return await carrier.runWorkspaceCommand({
              ...command,
              argv: [command.argv[0]!, command.argv[1]!, crashReaper + command.argv[2]!],
            });
          },
        },
      }),
    ).rejects.toThrow("Invalid skill resource allocation");

    expect(allocationId).toBeDefined();
    await expect(allocationOwner.ledger.list()).resolves.toEqual([]);
    for (const prefix of [resourcePermitPrefix, resourceRegistryPrefix]) {
      await expect(
        fs.stat(path.join(remoteWorkspaceDir, `${prefix}${allocationId}`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(fs.stat(resourceRootFor(remoteWorkspaceDir, allocationId!))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
    await allocationOwner.coordinator.stop();
  });

  it("retries staged-root cleanup after interruption removes its in-root marker", async () => {
    const remoteWorkspaceDir = await fs.realpath(temps.make("skill-resource-staged-cleanup-cut-"));
    const carrier = createSpawnTunnel(remoteWorkspaceDir);
    const { snapshot } = await createSource();
    const allocationOwner = createTestAllocationOwner();
    let allocationId: string | undefined;
    let interruptCleanup = true;
    let interruptedCleanupResult:
      | { code: number | null; signal: NodeJS.Signals | null }
      | undefined;
    let cleanupEntriesBefore: string[] | undefined;
    const operations: string[] = [];

    await expect(
      transferSkillResourcesImpl({
        snapshot,
        remoteWorkspaceDir,
        assertCurrent: () => {},
        allocationOwner,
        tunnel: {
          runWorkspaceCommand: async (command) => {
            const operation = JSON.parse(command.input!);
            operations.push(operation.op);
            let script = command.argv[2]!;
            if (operation.op === "init") {
              allocationId = operation.id;
              const stopAfterMarkerAttestation = String.raw`script=>script.replace("fs.linkSync(rootMarker,registryMarker);syncDirectory(stagedRoot);","fs.linkSync(rootMarker,registryMarker);process.kill(process.pid,'SIGKILL');syncDirectory(stagedRoot);")`;
              const crashReaper = String.raw`(()=>{const childProcess=require('node:child_process'),original=childProcess.spawn;childProcess.spawn=(file,args,options)=>{const adjusted=[...args];if(adjusted[2]==='initialize')adjusted[1]=(${reaperBootstrapMutation(stopAfterMarkerAttestation)})(adjusted[1]);return original(file,adjusted,options);};})();`;
              script = crashReaper + script;
            } else if (operation.op === "cleanup-intent" && interruptCleanup) {
              interruptCleanup = false;
              cleanupEntriesBefore = await fs.readdir(
                path.join(remoteWorkspaceDir, `${resourceRegistryPrefix}${operation.id}`),
              );
              script = replaceRuntimeSource(
                script,
                "fs.unlinkSync(rootMarker);syncDirectory(retired);",
                "fs.unlinkSync(rootMarker);process.kill(process.pid,'SIGKILL');syncDirectory(retired);",
              );
            }
            const result = await carrier.runWorkspaceCommand({
              ...command,
              argv: [command.argv[0]!, command.argv[1]!, script],
            });
            if (operation.op === "cleanup-intent" && !interruptCleanup) {
              interruptedCleanupResult = result;
            }
            return result;
          },
        },
      }),
    ).rejects.toThrow("Invalid skill resource allocation");

    expect(operations).toContain("cleanup-intent");
    expect(cleanupEntriesBefore).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^\.openclaw-skill-resource-stage\./u),
        expect.stringMatching(/^\.staged-root\./u),
      ]),
    );
    expect(interruptedCleanupResult).toMatchObject({ code: null });
    await expect(allocationOwner.ledger.list()).resolves.toMatchObject([
      { allocationId, phase: "cleanup-pending" },
    ]);
    await allocationOwner.coordinator.recover({
      getEnvironment: () => ({ state: "attached", ownerEpoch: 1, leaseId: "lease-active" }),
      startTunnel: async () => carrier as never,
    });
    await expect(allocationOwner.ledger.list()).resolves.toEqual([]);
    await expect(
      fs.stat(path.join(remoteWorkspaceDir, `${resourceRegistryPrefix}${allocationId}`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await allocationOwner.coordinator.stop();
  });

  it("never deletes a public-path directory raced against its exclusive claim", async () => {
    const remoteWorkspaceDir = await fs.realpath(temps.make("skill-resource-unmarked-root-"));
    const carrier = createSpawnTunnel(remoteWorkspaceDir);
    const { snapshot } = await createSource();
    const allocationOwner = createTestAllocationOwner();
    let allocationId: string | undefined;
    let replacementRoot: string | undefined;

    await expect(
      transferSkillResourcesImpl({
        snapshot,
        remoteWorkspaceDir,
        assertCurrent: () => {},
        allocationOwner,
        tunnel: {
          runWorkspaceCommand: async (command) => {
            const operation = JSON.parse(command.input!);
            if (operation.op !== "init") {
              return await carrier.runWorkspaceCommand(command);
            }
            allocationId = operation.id;
            replacementRoot = resourceRootFor(remoteWorkspaceDir, operation.id);
            const raceRootClaim = String.raw`script=>script.replace("assertClaimedPermit();fs.renameSync(stagedRoot,root);","assertClaimedPermit();fs.mkdirSync(root,{mode:0o700});fs.writeFileSync(path.join(root,'replacement-marker'),'replacement');fs.renameSync(stagedRoot,root);")`;
            const crashReaper = String.raw`(()=>{const childProcess=require('node:child_process'),original=childProcess.spawn;childProcess.spawn=(file,args,options)=>{const adjusted=[...args];if(adjusted[2]==='initialize')adjusted[1]=(${reaperBootstrapMutation(raceRootClaim)})(adjusted[1]);return original(file,adjusted,options);};})();`;
            return await carrier.runWorkspaceCommand({
              ...command,
              argv: [command.argv[0]!, command.argv[1]!, crashReaper + command.argv[2]!],
            });
          },
        },
      }),
    ).rejects.toThrow("Invalid skill resource allocation");

    await expect(
      fs.readFile(path.join(replacementRoot!, "replacement-marker"), "utf8"),
    ).resolves.toBe("replacement");
    await expect(allocationOwner.ledger.list()).resolves.toMatchObject([
      { allocationId, phase: "cleanup-pending" },
    ]);

    await fs.rm(replacementRoot!, { recursive: true });
    await allocationOwner.coordinator.recover({
      getEnvironment: () => ({ state: "attached", ownerEpoch: 1, leaseId: "lease-active" }),
      startTunnel: async () => carrier as never,
    });
    await expect(allocationOwner.ledger.list()).resolves.toEqual([]);
    await allocationOwner.coordinator.stop();
  });

  it("revokes a delayed reaper before a replacement Gateway retires its intent", async () => {
    const remoteWorkspaceDir = await fs.realpath(temps.make("skill-resource-delayed-reaper-"));
    const carrier = createSpawnTunnel(remoteWorkspaceDir);
    const { snapshot } = await createSource();
    const allocationOwner = createTestAllocationOwner("5".repeat(32));
    let allocationId: string | undefined;
    await expect(
      transferSkillResourcesImpl({
        snapshot,
        remoteWorkspaceDir,
        assertCurrent: () => {},
        allocationOwner,
        tunnel: {
          runWorkspaceCommand: async (command) => {
            const operation = JSON.parse(command.input!);
            if (operation.op !== "init") {
              return await carrier.runWorkspaceCommand(command);
            }
            allocationId = operation.id;
            const dieAfterSpawn = String.raw`(()=>{const childProcess=require('node:child_process'),original=childProcess.spawn;childProcess.spawn=(file,args,options)=>{const adjusted=[...args];if(adjusted[2]==='initialize')adjusted[1]='Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500);'+adjusted[1];const child=original(file,adjusted,options);process.kill(process.pid,'SIGKILL');return child;};})();`;
            return await carrier.runWorkspaceCommand({
              ...command,
              argv: [command.argv[0]!, command.argv[1]!, dieAfterSpawn + command.argv[2]!],
            });
          },
        },
      }),
    ).rejects.toThrow("Invalid skill resource allocation");

    expect(allocationId).toBeDefined();
    await expect(allocationOwner.ledger.list()).resolves.toEqual([]);
    await allocationOwner.coordinator.stop();
    const restarted = createTestCoordinator(allocationOwner.stateDir, "6".repeat(32)).coordinator;
    await restarted.recover({
      getEnvironment: () => ({ state: "attached", ownerEpoch: 1, leaseId: "lease-active" }),
      startTunnel: async () => carrier as never,
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 750);
    });
    await expect(restarted.ledger.list()).resolves.toEqual([]);
    for (const prefix of [resourcePermitPrefix, resourceRegistryPrefix]) {
      await expect(
        fs.stat(path.join(remoteWorkspaceDir, `${prefix}${allocationId}`)),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    await expect(fs.stat(resourceRootFor(remoteWorkspaceDir, allocationId!))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
    await restarted.stop();
  });

  it("lets the reaper retire a root when the receiver dies before host location commit", async () => {
    const remoteWorkspaceDir = await fs.realpath(temps.make("skill-resource-before-commit-"));
    const carrier = createSpawnTunnel(remoteWorkspaceDir);
    const { snapshot } = await createSource();
    const allocationOwner = createTestAllocationOwner("1".repeat(32));
    const reaperPidFile = path.join(remoteWorkspaceDir, ".test-uncommitted-reaper-pid");
    let allocationId: string | undefined;
    await expect(
      transferSkillResourcesImpl({
        snapshot,
        remoteWorkspaceDir,
        assertCurrent: () => {},
        allocationOwner,
        tunnel: {
          runWorkspaceCommand: async (command) => {
            const operation = JSON.parse(command.input!);
            if (operation.op !== "init") {
              return await carrier.runWorkspaceCommand(command);
            }
            allocationId = operation.id;
            const dieBeforeReply = String.raw`(()=>{const childProcess=require('node:child_process'),original=childProcess.spawn;childProcess.spawn=(file,args,options)=>{const adjusted=[...args];if(adjusted[2]==='initialize'){adjusted[1]=${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(reaperPidFile)},String(process.pid));`)}+adjusted[1];adjusted[5]='250';}return original(file,adjusted,options);};process.stdout.write=()=>{process.kill(process.pid,'SIGKILL');return false;};})();`;
            return await carrier.runWorkspaceCommand({
              ...command,
              argv: [command.argv[0]!, command.argv[1]!, dieBeforeReply + command.argv[2]!],
            });
          },
        },
      }),
    ).rejects.toThrow("Invalid skill resource allocation");

    expect(allocationId).toBeDefined();
    await expect(allocationOwner.ledger.list()).resolves.toMatchObject([
      { allocationId, phase: "cleanup-pending" },
    ]);
    await vi.waitFor(
      async () => {
        await expect(
          fs.stat(resourceRootFor(remoteWorkspaceDir, allocationId!)),
        ).rejects.toMatchObject({ code: "ENOENT" });
      },
      { timeout: 3_000 },
    );
    const reaperPid = Number(await fs.readFile(reaperPidFile, "utf8"));
    await vi.waitFor(
      () => {
        expect(() => process.kill(reaperPid, 0)).toThrow();
      },
      { timeout: 3_000 },
    );
    await allocationOwner.coordinator.stop();
    const restarted = createTestCoordinator(allocationOwner.stateDir, "2".repeat(32)).coordinator;
    await restarted.recover({
      getEnvironment: () => ({ state: "attached", ownerEpoch: 1, leaseId: "lease-active" }),
      startTunnel: async () => carrier as never,
    });
    await expect(allocationOwner.ledger.list()).resolves.toEqual([]);
    await restarted.stop();
  });

  it("extends uncommitted authority while the host persists the allocation locator", async () => {
    const remoteWorkspaceDir = await fs.realpath(temps.make("skill-resource-slow-commit-"));
    const carrier = createSpawnTunnel(remoteWorkspaceDir);
    const { snapshot } = await createSource();
    const allocationOwner = createTestAllocationOwner();
    const originalMarkAllocated = allocationOwner.coordinator.markAllocated.bind(
      allocationOwner.coordinator,
    );
    vi.spyOn(allocationOwner.coordinator, "markAllocated").mockImplementation(
      async (record, location) => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 500);
        });
        return await originalMarkAllocated(record, location);
      },
    );
    try {
      const resources = await transferSkillResourcesImpl({
        snapshot,
        remoteWorkspaceDir,
        assertCurrent: () => {},
        allocationOwner,
        tunnel: {
          runWorkspaceCommand: async (command) => {
            if (JSON.parse(command.input!).op !== "init") {
              return await carrier.runWorkspaceCommand(command);
            }
            const shortenUncommittedWindow = String.raw`(()=>{const childProcess=require('node:child_process'),original=childProcess.spawn;childProcess.spawn=(file,args,options)=>{const adjusted=[...args];if(adjusted[2]==='initialize'){adjusted[4]='25';adjusted[5]='250';}return original(file,adjusted,options);};})();`;
            return await carrier.runWorkspaceCommand({
              ...command,
              argv: [
                command.argv[0]!,
                command.argv[1]!,
                shortenUncommittedWindow + command.argv[2]!,
              ],
            });
          },
        },
      });
      await expect(
        fs.stat(path.dirname(resources!.mounts[0]!.containerPath)),
      ).resolves.toBeDefined();
      await resources!.cleanup();
    } finally {
      await allocationOwner.coordinator.stop();
    }
  });

  it("recovers an old-epoch allocation through the environment's current placement", async () => {
    const remoteWorkspaceDir = await fs.realpath(temps.make("skill-resource-gateway-restart-"));
    const carrier = createSpawnTunnel(remoteWorkspaceDir);
    const { snapshot } = await createSource();
    const allocationOwner = createTestAllocationOwner("3".repeat(32));
    const reaperPidFile = path.join(remoteWorkspaceDir, ".test-reaper-pid");
    let allocationId: string | undefined;
    let commandCalls = 0;
    const instrumented = {
      runWorkspaceCommand: async (
        command: Parameters<WorkerWorkspaceTunnelHandle["runWorkspaceCommand"]>[0],
      ) => {
        commandCalls += 1;
        const operation = JSON.parse(command.input!);
        if (operation.op !== "init") {
          return await carrier.runWorkspaceCommand(command);
        }
        allocationId = operation.id;
        const recordReaperPid = `(()=>{const childProcess=require('node:child_process'),original=childProcess.spawn;childProcess.spawn=(file,args,options)=>{const adjusted=[...args];if(adjusted[2]==='initialize')adjusted[1]=${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(reaperPidFile)},String(process.pid));`)}+adjusted[1];return original(file,adjusted,options);};})();`;
        return await carrier.runWorkspaceCommand({
          ...command,
          argv: [command.argv[0]!, command.argv[1]!, recordReaperPid + command.argv[2]!],
        });
      },
    };
    const resources = await transferSkillResourcesImpl({
      snapshot,
      remoteWorkspaceDir,
      assertCurrent: () => {},
      allocationOwner,
      tunnel: instrumented,
    });
    expect(allocationId).toBeDefined();
    const root = path.dirname(resources!.mounts[0]!.containerPath);
    const currentStart = vi.fn(async () => carrier as never);
    await allocationOwner.coordinator.recover({
      getEnvironment: () => ({ state: "attached", ownerEpoch: 1, leaseId: "lease-active" }),
      startTunnel: currentStart,
    });
    expect(currentStart).not.toHaveBeenCalled();
    await expect(fs.stat(root)).resolves.toBeDefined();

    const reaperPid = Number(await fs.readFile(reaperPidFile, "utf8"));
    expect(Number.isSafeInteger(reaperPid)).toBe(true);
    process.kill(reaperPid, "SIGKILL");
    await vi.waitFor(() => {
      expect(() => process.kill(reaperPid, 0)).toThrow();
    });

    await allocationOwner.coordinator.stop();
    const restarted = createTestCoordinator(allocationOwner.stateDir, "4".repeat(32)).coordinator;
    const callsBeforeUnavailable = commandCalls;
    const cleanupDeferred = vi.fn();
    await restarted.recover({
      getEnvironment: () => ({ state: "attached", ownerEpoch: 1, leaseId: "lease-active" }),
      startTunnel: async () => {
        throw new Error("placement unavailable");
      },
      onEnvironmentCleanupDeferred: cleanupDeferred,
    });
    expect(commandCalls).toBe(callsBeforeUnavailable);
    expect(cleanupDeferred).toHaveBeenCalledWith("test-environment");
    await expect(restarted.ledger.list()).resolves.toMatchObject([
      { allocationId, phase: "allocated" },
    ]);

    const replacementOwnerStart = vi.fn(async () => carrier as never);
    await restarted.recover({
      getEnvironment: () => ({ state: "attached", ownerEpoch: 2, leaseId: "lease-active" }),
      startTunnel: replacementOwnerStart,
    });
    expect(replacementOwnerStart).toHaveBeenCalledWith({
      environmentId: "test-environment",
      ownerEpoch: 2,
    });
    await expect(restarted.ledger.list()).resolves.toEqual([]);
    await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
    await resources!.cleanup().catch(() => undefined);
    await restarted.stop();
  });

  it("keeps a live Gateway allocation fenced from a replacement Gateway", async () => {
    const remoteWorkspaceDir = await fs.realpath(temps.make("skill-resource-live-gateway-"));
    const carrier = createSpawnTunnel(remoteWorkspaceDir);
    const { snapshot } = await createSource();
    const current = createTestAllocationOwner("7".repeat(32));
    const resources = await transferSkillResourcesImpl({
      snapshot,
      remoteWorkspaceDir,
      assertCurrent: () => {},
      allocationOwner: current,
      tunnel: carrier,
    });
    const root = path.dirname(resources!.mounts[0]!.containerPath);
    const replacement = createTestCoordinator(current.stateDir, "8".repeat(32)).coordinator;
    const replacementStart = vi.fn(async () => carrier as never);

    await expect(
      replacement.recover({
        getEnvironment: () => ({ state: "attached", ownerEpoch: 1, leaseId: "lease-active" }),
        startTunnel: replacementStart,
      }),
    ).rejects.toThrow(/skill resource allocation owner/iu);
    expect(replacementStart).not.toHaveBeenCalled();
    await expect(fs.stat(root)).resolves.toBeDefined();
    await expect(current.ledger.list()).resolves.toHaveLength(1);

    await current.coordinator.stop();
    await replacement.recover({
      getEnvironment: () => ({ state: "attached", ownerEpoch: 1, leaseId: "lease-active" }),
      startTunnel: async () => carrier as never,
    });
    await expect(replacement.ledger.list()).resolves.toEqual([]);
    await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
    await replacement.stop();
  });

  it("retires the detached reaper after normal cleanup", async () => {
    const remoteWorkspaceDir = await fs.realpath(temps.make("skill-resource-reaper-exit-"));
    const carrier = createSpawnTunnel(remoteWorkspaceDir);
    const { snapshot } = await createSource();
    const reaperPidFile = path.join(remoteWorkspaceDir, ".test-reaper-exit-pid");
    const resources = await transferSkillResourcesImpl({
      snapshot,
      remoteWorkspaceDir,
      assertCurrent: () => {},
      allocationOwner: createTestAllocationOwner(),
      tunnel: {
        runWorkspaceCommand: async (command) => {
          if (JSON.parse(command.input!).op !== "init") {
            return await carrier.runWorkspaceCommand(command);
          }
          const recordReaperPid = `(()=>{const childProcess=require('node:child_process'),original=childProcess.spawn;childProcess.spawn=(file,args,options)=>{const adjusted=[...args];if(adjusted[2]==='initialize')adjusted[1]=${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(reaperPidFile)},String(process.pid));`)}+adjusted[1];return original(file,adjusted,options);};})();`;
          return await carrier.runWorkspaceCommand({
            ...command,
            argv: [command.argv[0]!, command.argv[1]!, recordReaperPid + command.argv[2]!],
          });
        },
      },
    });
    const reaperPid = Number(await fs.readFile(reaperPidFile, "utf8"));

    await resources!.cleanup();
    await vi.waitFor(
      () => {
        expect(() => process.kill(reaperPid, 0)).toThrow();
      },
      { timeout: 3_000 },
    );
  });

  it("bounds a detached reaper when worker-owned evidence is corrupted", async () => {
    const remoteWorkspaceDir = await fs.realpath(temps.make("skill-resource-reaper-corrupt-"));
    const carrier = createSpawnTunnel(remoteWorkspaceDir);
    const { snapshot } = await createSource();
    const allocationOwner = createTestAllocationOwner();
    const reaperPidFile = path.join(remoteWorkspaceDir, ".test-corrupt-reaper-pid");
    let allocationId: string | undefined;
    const resources = await transferSkillResourcesImpl({
      snapshot,
      remoteWorkspaceDir,
      assertCurrent: () => {},
      allocationOwner,
      tunnel: {
        runWorkspaceCommand: async (command) => {
          const operation = JSON.parse(command.input!);
          if (operation.op !== "init") {
            return await carrier.runWorkspaceCommand(command);
          }
          allocationId = operation.id;
          const shortenReaperMaximum = reaperBootstrapMutation(
            String.raw`script=>script.replace("const maxLeaseMs=60000","const maxLeaseMs=3000")`,
          );
          const recordReaperPid = `(()=>{const childProcess=require('node:child_process'),original=childProcess.spawn;childProcess.spawn=(file,args,options)=>{const adjusted=[...args];if(adjusted[2]==='initialize')adjusted[1]=${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(reaperPidFile)},String(process.pid));`)}+(${shortenReaperMaximum})(adjusted[1]);return original(file,adjusted,options);};})();`;
          const shortLeaseRuntime = replaceRuntimeSource(
            command.argv[2]!,
            "leaseMs=60000,sweepMs=1000",
            "leaseMs=3000,sweepMs=20",
          );
          return await carrier.runWorkspaceCommand({
            ...command,
            argv: [command.argv[0]!, command.argv[1]!, recordReaperPid + shortLeaseRuntime],
          });
        },
      },
    });
    const reaperPid = Number(await fs.readFile(reaperPidFile, "utf8"));
    const rootMarker = path.join(
      resourceRootFor(remoteWorkspaceDir, allocationId!),
      ".openclaw-skill-resource-owner",
    );

    await fs.writeFile(rootMarker, "worker-corruption");
    await vi.waitFor(
      () => {
        expect(() => process.kill(reaperPid, 0)).toThrow();
      },
      { timeout: 10_000 },
    );
    await expect(resources!.cleanup()).rejects.toThrow("Skill resource transfer failed");
    await expect(fs.readFile(rootMarker, "utf8")).resolves.toBe("worker-corruption");
    await expect(allocationOwner.ledger.list()).resolves.toMatchObject([
      { phase: "cleanup-pending" },
    ]);
    await allocationOwner.coordinator.stop();
  });

  it("rejects a forged returned root even when the forger knows every child-visible value", async () => {
    const remoteWorkspaceDir = await fs.realpath(temps.make("skill-resource-forged-root-"));
    const carrier = createSpawnTunnel(remoteWorkspaceDir);
    const { snapshot } = await createSource();
    const forgedRoot = path.join(os.tmpdir(), `openclaw-forged-resource-${randomUUID()}`);
    await fs.mkdir(forgedRoot);
    await fs.writeFile(path.join(forgedRoot, "operator-marker"), "untouched");
    let allocation: { id: string; identity: string; root: string } | undefined;
    let writes = 0;
    await expect(
      transferSkillResources({
        snapshot,
        assertCurrent: () => {},
        remoteWorkspaceDir,
        tunnel: {
          runWorkspaceCommand: async (command) => {
            const result = await carrier.runWorkspaceCommand(command);
            const operation = JSON.parse(command.input!);
            writes += Number(operation.op === "write");
            if (operation.op !== "init") {
              return result;
            }
            const actualAllocation = {
              ...operation,
              ...JSON.parse(result.stdout),
              root: resourceRootFor(remoteWorkspaceDir, operation.id),
            };
            allocation = actualAllocation;
            return {
              ...result,
              stdout: JSON.stringify({ ...actualAllocation, root: forgedRoot }),
            };
          },
        },
      }),
    ).rejects.toThrow("Invalid skill resource allocation");

    expect(allocation).toBeDefined();
    expect(writes).toBe(0);
    await expect(fs.stat(allocation!.root)).resolves.toBeDefined();
    const registryFile = resourceRegistryFileFor(
      allocation!.root,
      allocation!.id,
      allocation!.identity,
    );
    const lease = JSON.parse(await fs.readFile(registryFile, "utf8"));
    await fs.writeFile(registryFile, JSON.stringify({ ...lease, expiresAt: 0 }));
    await vi.waitFor(
      async () => {
        await expect(fs.stat(allocation!.root)).rejects.toMatchObject({ code: "ENOENT" });
      },
      { timeout: 3_000 },
    );
    await expect(fs.readFile(path.join(forgedRoot, "operator-marker"), "utf8")).resolves.toBe(
      "untouched",
    );
  });

  it("refuses an exact registry collision without adopting marker-shaped user content", async () => {
    const remoteWorkspaceDir = await fs.realpath(temps.make("skill-resource-registry-collision-"));
    const carrier = createSpawnTunnel(remoteWorkspaceDir);
    let registry: string | undefined;
    let root: string | undefined;
    const { snapshot } = await createSource();
    await expect(
      transferSkillResources({
        snapshot,
        remoteWorkspaceDir,
        assertCurrent: () => {},
        tunnel: {
          runWorkspaceCommand: async (command) => {
            const operation = JSON.parse(command.input!);
            if (operation.op === "init") {
              registry = path.join(remoteWorkspaceDir, `${resourceRegistryPrefix}${operation.id}`);
              root = resourceRootFor(remoteWorkspaceDir, operation.id);
              await fs.mkdir(registry, { mode: 0o755 });
              await fs.writeFile(
                path.join(registry, ".owner.json"),
                JSON.stringify({ version: 1, id: operation.id, identity: "1:1" }),
              );
              await fs.writeFile(path.join(registry, `${operation.id}.1.1.json`), "user lease");
              await fs.writeFile(path.join(registry, "operator-note"), "keep");
            }
            return await carrier.runWorkspaceCommand(command);
          },
        },
      }),
    ).rejects.toThrow("Invalid skill resource allocation");
    await expect(fs.readFile(path.join(registry!, "operator-note"), "utf8")).resolves.toBe("keep");
    await expect(
      fs.readFile(path.join(registry!, `${path.basename(registry!).slice(-32)}.1.1.json`), "utf8"),
    ).resolves.toBe("user lease");
    if (process.platform !== "win32") {
      expect((await fs.stat(registry!)).mode & 0o777).toBe(0o755);
    }
    await expect(fs.stat(root!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retires only stale crash-left lease temporaries in its owned registry", async () => {
    const remoteWorkspaceDir = await fs.realpath(temps.make("skill-resource-temp-sweep-"));
    const carrier = createSpawnTunnel(remoteWorkspaceDir);
    const { snapshot } = await createSource();
    let registry: string | undefined;
    let renewCommand: Parameters<WorkerWorkspaceTunnelHandle["runWorkspaceCommand"]>[0] | undefined;
    const resources = await transferSkillResources({
      snapshot,
      remoteWorkspaceDir,
      assertCurrent: () => {},
      tunnel: {
        runWorkspaceCommand: async (command) => {
          const result = await carrier.runWorkspaceCommand(command);
          const operation = JSON.parse(command.input!);
          if (operation.op === "init") {
            registry = path.join(remoteWorkspaceDir, `${resourceRegistryPrefix}${operation.id}`);
          } else if (operation.op === "renew") {
            renewCommand = command;
          }
          return result;
        },
      },
    });
    const exited = spawn(process.execPath, ["-e", ""]);
    const deadPid = exited.pid!;
    await new Promise<void>((resolve, reject) => {
      exited.once("error", reject);
      exited.once("close", () => resolve());
    });
    const stale = `.${"a".repeat(32)}.${deadPid}.${"b".repeat(32)}.tmp`;
    const fresh = `.${"c".repeat(32)}.${deadPid}.${"d".repeat(32)}.tmp`;
    const reusedPid = `.${"e".repeat(32)}.${process.pid}.${"f".repeat(32)}.tmp`;
    const unrelated = "operator-note.tmp";
    for (const name of [stale, fresh, reusedPid, unrelated]) {
      await fs.writeFile(path.join(registry!, name), name, { mode: 0o600 });
    }
    const expired = new Date(Date.now() - 61_000);
    await fs.utimes(path.join(registry!, stale), expired, expired);
    await fs.utimes(path.join(registry!, reusedPid), expired, expired);
    await carrier.runWorkspaceCommand(renewCommand!);
    try {
      await expect(fs.stat(path.join(registry!, stale))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readFile(path.join(registry!, fresh), "utf8")).resolves.toBe(fresh);
      await expect(fs.stat(path.join(registry!, reusedPid))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.readFile(path.join(registry!, unrelated), "utf8")).resolves.toBe(unrelated);
    } finally {
      await fs.rm(path.join(registry!, fresh), { force: true });
      await fs.rm(path.join(registry!, unrelated), { force: true });
      await resources!.cleanup();
    }
  });

  it.runIf(process.platform !== "win32")(
    "rejects a symlink placement alias before allocating resources",
    async () => {
      const realWorkspace = await fs.realpath(temps.make("skill-resource-real-workspace-"));
      const alias = temps.make("skill-resource-workspace-alias-");
      await fs.rm(alias, { recursive: true });
      await fs.symlink(realWorkspace, alias, "dir");
      const carrier = createSpawnTunnel(realWorkspace);
      const { snapshot } = await createSource();

      await expect(
        transferSkillResources({
          snapshot,
          remoteWorkspaceDir: alias,
          assertCurrent: () => {},
          tunnel: carrier,
        }),
      ).rejects.toThrow("Invalid skill resource allocation");
      expect(
        (await fs.readdir(realWorkspace)).filter((name) =>
          name.startsWith(WORKER_ATTACHMENT_DIRECTORY_PREFIX),
        ),
      ).toEqual([]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "uses the writable placement workspace when its parent is not writable",
    async () => {
      const parent = await fs.realpath(temps.make("skill-resource-readonly-parent-"));
      const remoteWorkspaceDir = path.join(parent, "workspace");
      await fs.mkdir(remoteWorkspaceDir, { mode: 0o700 });
      await fs.chmod(parent, 0o500);
      const { snapshot } = await createSource();
      let resources: Awaited<ReturnType<typeof transferSkillResources>>;
      try {
        resources = await transferSkillResources({
          snapshot,
          remoteWorkspaceDir,
          assertCurrent: () => {},
          tunnel: createSpawnTunnel(remoteWorkspaceDir),
        });
        await expect(fs.stat(resources!.mounts[0]!.containerPath)).resolves.toBeDefined();
        await resources!.cleanup();
        expect(
          (await fs.readdir(remoteWorkspaceDir)).filter((name) =>
            name.startsWith(resourceRegistryPrefix),
          ),
        ).toEqual([]);
        resources = undefined;
      } finally {
        await resources?.cleanup();
        await fs.chmod(parent, 0o700);
      }
    },
  );

  it("retries a transient lease renewal and keeps the active resource usable", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"],
    });
    const { snapshot } = await createSource();
    let renewCalls = 0;
    let resources: Awaited<ReturnType<typeof transferSkillResources>>;
    try {
      resources = await transferSkillResources({
        snapshot,
        assertCurrent: () => {},
        tunnel: {
          runWorkspaceCommand: async (command) => {
            const operation = JSON.parse(command.input!);
            if (operation.op === "renew" && ++renewCalls === 2) {
              throw new Error("transient tunnel rejection");
            }
            return await tunnel.runWorkspaceCommand(command);
          },
        },
      });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(() => resources!.assertCurrent()).not.toThrow();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(renewCalls).toBe(3);
      expect(() => resources!.assertCurrent()).not.toThrow();
    } finally {
      await resources?.cleanup();
      vi.useRealTimers();
    }
  });

  it("blocks resource use after sustained renewal failure and still cleans its allocation", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"],
    });
    const { snapshot } = await createSource();
    let rejectRenewals = false;
    let rejectedRenewals = 0;
    let resources: Awaited<ReturnType<typeof transferSkillResources>>;
    let root: string | undefined;
    try {
      resources = await transferSkillResources({
        snapshot,
        assertCurrent: () => {},
        tunnel: {
          runWorkspaceCommand: async (command) => {
            const operation = JSON.parse(command.input!);
            if (operation.op === "renew" && rejectRenewals) {
              rejectedRenewals += 1;
              throw new Error("tunnel unavailable");
            }
            return await tunnel.runWorkspaceCommand(command);
          },
        },
      });
      root = path.dirname(resources!.mounts[0]!.containerPath);
      rejectRenewals = true;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(rejectedRenewals).toBeGreaterThan(1);
      expect(() => resources!.assertCurrent()).toThrow(
        "Skill resource lease could not be renewed before expiry",
      );
      await resources!.cleanup();
      await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
      resources = undefined;
    } finally {
      await resources?.cleanup();
      vi.useRealTimers();
      if (root) {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  });

  it("expires a hung renewal locally and cleans without awaiting its transport", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"],
    });
    const { snapshot } = await createSource();
    let hangRenewals = false;
    let resources: Awaited<ReturnType<typeof transferSkillResources>>;
    let root: string | undefined;
    try {
      resources = await transferSkillResources({
        snapshot,
        assertCurrent: () => {},
        tunnel: {
          runWorkspaceCommand: async (command) => {
            if (JSON.parse(command.input!).op === "renew" && hangRenewals) {
              return await new Promise<never>(() => {
                // Model a transport that ignores both its timeout and abort signal.
              });
            }
            return await tunnel.runWorkspaceCommand(command);
          },
        },
      });
      root = path.dirname(resources!.mounts[0]!.containerPath);
      hangRenewals = true;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(() => resources!.assertCurrent()).toThrow(/lease.*expir/iu);
      await resources!.cleanup();
      await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
      resources = undefined;
    } finally {
      await resources?.cleanup();
      vi.useRealTimers();
      if (root) {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  });

  it("retires renewal immediately on authority loss and blocks later resource use", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"],
    });
    const { snapshot } = await createSource();
    let current = true;
    let dispatchedRenewals = 0;
    let resources: Awaited<ReturnType<typeof transferSkillResources>>;
    let root: string | undefined;
    try {
      resources = await transferSkillResources({
        snapshot,
        assertCurrent: () => {
          if (!current) {
            throw new Error("placement retired");
          }
        },
        tunnel: {
          runWorkspaceCommand: async (command) => {
            if (JSON.parse(command.input!).op === "renew") {
              dispatchedRenewals += 1;
            }
            return await tunnel.runWorkspaceCommand(command);
          },
        },
      });
      root = path.dirname(resources!.mounts[0]!.containerPath);
      current = false;
      await vi.advanceTimersByTimeAsync(20_000);
      current = true;
      expect(dispatchedRenewals).toBe(1);
      expect(() => resources!.assertCurrent()).toThrow("placement retired");
      await resources!.cleanup();
      await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
      resources = undefined;
    } finally {
      current = true;
      await resources?.cleanup();
      vi.useRealTimers();
      if (root) {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  });
});
