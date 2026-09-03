import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadWorkspaceSkills } from "../../skills/loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../../skills/loading/workspace-skill-prompt.js";
import { createSkillResourceAllocationCoordinator } from "./skill-resource-allocation-coordinator.js";
import { createSkillResourceAllocationLedger } from "./skill-resource-allocation-ledger.js";
import { skillResourceAllocationDirectoryName } from "./skill-resource-transfer-contract.js";
import { transferSkillResources as transferSkillResourcesImpl } from "./skill-resource-transfer.js";
import type { WorkerWorkspaceTunnelHandle } from "./tunnel-contract.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const resourceRegistryPrefix = ".openclaw-skill-resource-lease-";

async function transferSkillResources(
  params: Omit<Parameters<typeof transferSkillResourcesImpl>[0], "allocationOwner">,
) {
  const databaseOptions = {
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: temps.make("skill-resource-lease-host-ledger-"),
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
  const workspace = await fs.realpath(temps.make("remote-skill-lease-source-"));
  const baseDir = path.join(workspace, "skills", "source");
  await fs.mkdir(baseDir, { recursive: true });
  await fs.writeFile(
    path.join(baseDir, "SKILL.md"),
    "---\ndescription: Resource lease test\n---\n# Resource\n",
  );
  return buildSkillSnapshot(workspace, {
    entries: loadWorkspaceSkills(workspace, { workspaceOnly: true }),
  });
}

async function expectOwnedPathsAbsent(...ownedPaths: string[]): Promise<void> {
  const present = await Promise.all(
    ownedPaths.map(async (ownedPath) =>
      fs.stat(ownedPath).then(
        () => ownedPath,
        (error: unknown) => {
          if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
            return undefined;
          }
          throw error;
        },
      ),
    ),
  );
  const remaining = present.filter((ownedPath) => ownedPath !== undefined);
  if (remaining.length > 0) {
    throw new Error(`Owned skill resource paths still present: ${remaining.join(", ")}`);
  }
}

describe("remote-exec skill resource leases", () => {
  it("expires a torn lease record without deleting another allocation", async () => {
    const remoteWorkspaceDir = await fs.realpath(temps.make("skill-resource-torn-lease-"));
    const carrier = createSpawnTunnel(remoteWorkspaceDir);
    const firstSnapshot = await createSource();
    let firstAllocation: { id: string; identity: string; root: string } | undefined;
    const first = await transferSkillResources({
      snapshot: firstSnapshot,
      remoteWorkspaceDir,
      assertCurrent: () => {},
      tunnel: {
        runWorkspaceCommand: async (command) => {
          const result = await carrier.runWorkspaceCommand(command);
          const operation = JSON.parse(command.input!);
          if (operation.op === "init") {
            firstAllocation = {
              id: operation.id,
              identity: JSON.parse(result.stdout).identity,
              root: resourceRootFor(remoteWorkspaceDir, operation.id),
            };
          }
          return result;
        },
      },
    });
    const second = await transferSkillResources({
      snapshot: await createSource(),
      remoteWorkspaceDir,
      assertCurrent: () => {},
      tunnel: carrier,
    });
    const secondRoot = path.dirname(second!.mounts[0]!.containerPath);
    const registryFile = resourceRegistryFileFor(
      firstAllocation!.root,
      firstAllocation!.id,
      firstAllocation!.identity,
    );
    try {
      await fs.writeFile(registryFile, "{");
      const expired = new Date(Date.now() - 61_000);
      await fs.utimes(registryFile, expired, expired);
      await vi.waitFor(
        async () => {
          await expect(fs.stat(firstAllocation!.root)).rejects.toMatchObject({ code: "ENOENT" });
          await expect(fs.readFile(registryFile, "utf8")).resolves.toContain(
            '"cleanupPrepared":true',
          );
        },
        { timeout: 3_000 },
      );
      await expect(fs.stat(secondRoot)).resolves.toBeDefined();
      await expect(first!.cleanup()).resolves.toBeUndefined();
      await expectOwnedPathsAbsent(firstAllocation!.root, registryFile);
    } finally {
      await second!.cleanup();
    }
  });

  it("retains malformed lease metadata without deleting a replacement root", async () => {
    const remoteWorkspaceDir = await fs.realpath(temps.make("skill-resource-quarantine-"));
    const carrier = createSpawnTunnel(remoteWorkspaceDir);
    let allocation: { id: string; identity: string; root: string } | undefined;
    const resources = await transferSkillResources({
      snapshot: await createSource(),
      remoteWorkspaceDir,
      assertCurrent: () => {},
      tunnel: {
        runWorkspaceCommand: async (command) => {
          const result = await carrier.runWorkspaceCommand(command);
          const operation = JSON.parse(command.input!);
          if (operation.op === "init") {
            allocation = {
              id: operation.id,
              identity: JSON.parse(result.stdout).identity,
              root: resourceRootFor(remoteWorkspaceDir, operation.id),
            };
          }
          return result;
        },
      },
    });
    const registryFile = resourceRegistryFileFor(
      allocation!.root,
      allocation!.id,
      allocation!.identity,
    );
    await fs.rm(allocation!.root, { recursive: true });
    await fs.mkdir(allocation!.root, { mode: 0o700 });
    const marker = path.join(allocation!.root, "replacement-marker");
    await fs.writeFile(marker, "replacement");
    await fs.writeFile(registryFile, "not-json");
    const expired = new Date(Date.now() - 61_000);
    await fs.utimes(registryFile, expired, expired);
    try {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 1_250);
      });
      await expect(fs.readFile(registryFile, "utf8")).resolves.toBe("not-json");
      await expect(fs.readFile(marker, "utf8")).resolves.toBe("replacement");
      await expect(resources!.cleanup()).rejects.toThrow("Skill resource transfer failed");
      await expect(fs.readFile(marker, "utf8")).resolves.toBe("replacement");
    } finally {
      await fs.rm(allocation!.root, { recursive: true, force: true });
    }
  });

  it.each([
    { replacement: false, expected: "resolves" },
    { replacement: true, expected: "rejects" },
  ] as const)(
    "$expected cleanup when the reaper retires the lease between validation and root inspection",
    async ({ replacement }) => {
      const remoteWorkspaceDir = await fs.realpath(temps.make("skill-resource-cleanup-race-"));
      const carrier = createSpawnTunnel(remoteWorkspaceDir);
      let allocation: { id: string; identity: string; root: string } | undefined;
      const resources = await transferSkillResources({
        snapshot: await createSource(),
        remoteWorkspaceDir,
        assertCurrent: () => {},
        tunnel: {
          runWorkspaceCommand: async (command) => {
            const operation = JSON.parse(command.input!);
            let dispatched = command;
            if (operation.op === "cleanup") {
              const registryFile = resourceRegistryFileFor(
                allocation!.root,
                allocation!.id,
                allocation!.identity,
              );
              const cleanupRace = `(()=>{const raceFs=require('node:fs'),racePath=require('node:path'),root=${JSON.stringify(allocation!.root)},registryFile=${JSON.stringify(registryFile)},registry=racePath.dirname(registryFile),id=${JSON.stringify(allocation!.id)},replacement=${JSON.stringify(replacement)},original=raceFs.lstatSync;let fired=false;raceFs.lstatSync=function(target,options){if(!fired&&racePath.resolve(String(target))===racePath.resolve(root)){fired=true;raceFs.rmSync(root,{recursive:true,force:true});for(const artifact of [racePath.join(registry,'.owner.'+id),racePath.join(registry,'.openclaw-skill-resource-stage.'+id),registryFile])try{raceFs.unlinkSync(artifact);}catch{}if(replacement){try{return original.call(raceFs,target,options);}catch(error){raceFs.mkdirSync(root,{mode:0o700});raceFs.writeFileSync(racePath.join(root,'replacement-marker'),'replacement');throw error;}}}return original.call(raceFs,target,options);};})();`;
              dispatched = {
                ...command,
                argv: [command.argv[0]!, command.argv[1]!, cleanupRace + command.argv[2]!],
              };
            }
            const result = await carrier.runWorkspaceCommand(dispatched);
            if (operation.op === "init") {
              allocation = {
                id: operation.id,
                identity: JSON.parse(result.stdout).identity,
                root: resourceRootFor(remoteWorkspaceDir, operation.id),
              };
            }
            return result;
          },
        },
      });
      if (replacement) {
        await expect(resources!.cleanup()).rejects.toThrow("Skill resource transfer failed");
        await expect(
          fs.readFile(path.join(allocation!.root, "replacement-marker"), "utf8"),
        ).resolves.toBe("replacement");
        await fs.rm(allocation!.root, { recursive: true, force: true });
      } else {
        await expect(resources!.cleanup()).resolves.toBeUndefined();
        await expect(fs.stat(allocation!.root)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it("restores but never deletes a replacement swapped in before quarantine", async () => {
    const remoteWorkspaceDir = await fs.realpath(temps.make("skill-resource-root-swap-"));
    const carrier = createSpawnTunnel(remoteWorkspaceDir);
    let root: string | undefined;
    let replaced = false;
    const resources = await transferSkillResources({
      snapshot: await createSource(),
      remoteWorkspaceDir,
      assertCurrent: () => {},
      tunnel: {
        runWorkspaceCommand: async (command) => {
          const operation = JSON.parse(command.input!);
          let dispatched = command;
          if (operation.op === "cleanup") {
            const swapBeforeRename = `(()=>{const swapFs=require('node:fs'),swapPath=require('node:path'),root=${JSON.stringify(root)},original=swapFs.renameSync;let fired=false;swapFs.renameSync=function(source,target){if(!fired&&swapPath.resolve(String(source))===swapPath.resolve(root)){fired=true;swapFs.rmSync(root,{recursive:true,force:true});swapFs.mkdirSync(root,{mode:0o700});swapFs.writeFileSync(swapPath.join(root,'replacement-marker'),'replacement');}return original.call(swapFs,source,target);};})();`;
            dispatched = {
              ...command,
              argv: [command.argv[0]!, command.argv[1]!, swapBeforeRename + command.argv[2]!],
            };
          }
          const result = await carrier.runWorkspaceCommand(dispatched);
          if (operation.op === "init") {
            root = resourceRootFor(remoteWorkspaceDir, operation.id);
          }
          if (operation.op === "cleanup") {
            replaced = true;
          }
          return result;
        },
      },
    });
    try {
      await expect(resources!.cleanup()).rejects.toThrow("Skill resource transfer failed");
      expect(replaced).toBe(true);
      await expect(fs.readFile(path.join(root!, "replacement-marker"), "utf8")).resolves.toBe(
        "replacement",
      );
    } finally {
      await fs.rm(root!, { recursive: true, force: true });
    }
  });

  it("rejects an inode-reuse lookalike with copied marker content", async () => {
    const remoteWorkspaceDir = await fs.realpath(temps.make("skill-resource-inode-reuse-"));
    const carrier = createSpawnTunnel(remoteWorkspaceDir);
    let root: string | undefined;
    const resources = await transferSkillResources({
      snapshot: await createSource(),
      remoteWorkspaceDir,
      assertCurrent: () => {},
      tunnel: {
        runWorkspaceCommand: async (command) => {
          const operation = JSON.parse(command.input!);
          let dispatched = command;
          if (operation.op === "cleanup") {
            const replaceAfterStat = `(()=>{const replaceFs=require('node:fs'),replacePath=require('node:path'),root=${JSON.stringify(root)},marker=replacePath.join(root,'.openclaw-skill-resource-owner'),original=replaceFs.lstatSync;let fired=false;replaceFs.lstatSync=function(target,options){if(!fired&&replacePath.resolve(String(target))===replacePath.resolve(root)){fired=true;const priorStat=original.call(replaceFs,target,options),markerBytes=replaceFs.readFileSync(marker);replaceFs.rmSync(root,{recursive:true,force:true});replaceFs.mkdirSync(root,{mode:0o700});replaceFs.writeFileSync(marker,markerBytes,{mode:0o600});replaceFs.writeFileSync(replacePath.join(root,'replacement-marker'),'replacement');return priorStat;}return original.call(replaceFs,target,options);};})();`;
            dispatched = {
              ...command,
              argv: [command.argv[0]!, command.argv[1]!, replaceAfterStat + command.argv[2]!],
            };
          }
          const result = await carrier.runWorkspaceCommand(dispatched);
          if (operation.op === "init") {
            root = resourceRootFor(remoteWorkspaceDir, operation.id);
          }
          return result;
        },
      },
    });
    try {
      await expect(resources!.cleanup()).rejects.toThrow("Skill resource transfer failed");
      await expect(fs.readFile(path.join(root!, "replacement-marker"), "utf8")).resolves.toBe(
        "replacement",
      );
    } finally {
      await fs.rm(root!, { recursive: true, force: true });
    }
  });

  it("serializes an expiry reaper behind a renewal that already owns the lease", async () => {
    const remoteWorkspaceDir = await fs.realpath(temps.make("skill-resource-renew-race-"));
    const carrier = createSpawnTunnel(remoteWorkspaceDir);
    let allocation: { id: string; identity: string; root: string } | undefined;
    let renewCommand: Parameters<WorkerWorkspaceTunnelHandle["runWorkspaceCommand"]>[0] | undefined;
    const resources = await transferSkillResources({
      snapshot: await createSource(),
      remoteWorkspaceDir,
      assertCurrent: () => {},
      tunnel: {
        runWorkspaceCommand: async (command) => {
          const result = await carrier.runWorkspaceCommand(command);
          const operation = JSON.parse(command.input!);
          if (operation.op === "init") {
            allocation = {
              id: operation.id,
              identity: JSON.parse(result.stdout).identity,
              root: resourceRootFor(remoteWorkspaceDir, operation.id),
            };
          } else if (operation.op === "renew") {
            renewCommand = command;
          }
          return result;
        },
      },
    });
    const registryFile = resourceRegistryFileFor(
      allocation!.root,
      allocation!.id,
      allocation!.identity,
    );
    const lease = JSON.parse(await fs.readFile(registryFile, "utf8"));
    await fs.writeFile(registryFile, JSON.stringify({ ...lease, expiresAt: Date.now() + 1_200 }));
    const delayLeaseCommit = `(()=>{const delayFs=require('node:fs'),delayPath=require('node:path'),registryFile=${JSON.stringify(registryFile)},original=delayFs.renameSync;let fired=false;delayFs.renameSync=function(source,target){if(!fired&&delayPath.resolve(String(target))===delayPath.resolve(registryFile)){fired=true;const deadline=Date.now()+3000;while(Date.now()<deadline){}}return original.call(delayFs,source,target);};})();`;
    const renewing = carrier.runWorkspaceCommand({
      ...renewCommand!,
      argv: [
        renewCommand!.argv[0]!,
        renewCommand!.argv[1]!,
        delayLeaseCommit + renewCommand!.argv[2]!,
      ],
    });
    try {
      await vi.waitFor(
        async () => {
          await expect(fs.stat(`${registryFile}.lock`)).resolves.toBeDefined();
        },
        { timeout: 1_000 },
      );
      await new Promise((resolve) => {
        setTimeout(resolve, 2_200);
      });
      await expect(fs.stat(allocation!.root)).resolves.toBeDefined();
      await expect(renewing).resolves.toMatchObject({ code: 0 });
      const renewed = JSON.parse(await fs.readFile(registryFile, "utf8"));
      expect(renewed.expiresAt).toBeGreaterThan(Date.now());
      await expect(fs.stat(allocation!.root)).resolves.toBeDefined();
    } finally {
      await resources!.cleanup();
    }
  });

  it("serializes concurrent cleanup calls and retires the allocation once", async () => {
    const remoteWorkspaceDir = await fs.realpath(temps.make("skill-resource-concurrent-cleanup-"));
    const carrier = createSpawnTunnel(remoteWorkspaceDir);
    let root: string | undefined;
    let cleanupCalls = 0;
    const resources = await transferSkillResources({
      snapshot: await createSource(),
      remoteWorkspaceDir,
      assertCurrent: () => {},
      tunnel: {
        runWorkspaceCommand: async (command) => {
          const operation = JSON.parse(command.input!);
          let dispatched = command;
          if (operation.op === "cleanup" && cleanupCalls++ === 0) {
            const slowQuarantine = `(()=>{const slowFs=require('node:fs'),slowPath=require('node:path'),root=${JSON.stringify(root)},original=slowFs.renameSync;let fired=false;slowFs.renameSync=function(source,target){if(!fired&&slowPath.resolve(String(source))===slowPath.resolve(root)){fired=true;const deadline=Date.now()+500;while(Date.now()<deadline){}}return original.call(slowFs,source,target);};})();`;
            dispatched = {
              ...command,
              argv: [command.argv[0]!, command.argv[1]!, slowQuarantine + command.argv[2]!],
            };
          }
          const result = await carrier.runWorkspaceCommand(dispatched);
          if (operation.op === "init") {
            root = resourceRootFor(remoteWorkspaceDir, operation.id);
          }
          return result;
        },
      },
    });

    await expect(Promise.all([resources!.cleanup(), resources!.cleanup()])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(cleanupCalls).toBe(1);
    await expect(fs.stat(root!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a live ownership lock and bounds a stale lock despite PID reuse", async () => {
    const remoteWorkspaceDir = await fs.realpath(temps.make("skill-resource-stale-lock-"));
    const carrier = createSpawnTunnel(remoteWorkspaceDir);
    let allocation: { attestation: string; id: string; identity: string; root: string } | undefined;
    const resources = await transferSkillResources({
      snapshot: await createSource(),
      remoteWorkspaceDir,
      assertCurrent: () => {},
      tunnel: {
        runWorkspaceCommand: async (command) => {
          const result = await carrier.runWorkspaceCommand(command);
          const operation = JSON.parse(command.input!);
          if (operation.op === "init") {
            allocation = {
              attestation: operation.attestation,
              id: operation.id,
              identity: JSON.parse(result.stdout).identity,
              root: resourceRootFor(remoteWorkspaceDir, operation.id),
            };
          }
          return result;
        },
      },
    });
    const registryFile = resourceRegistryFileFor(
      allocation!.root,
      allocation!.id,
      allocation!.identity,
    );
    const lockFile = `${registryFile}.lock`;
    const processIncarnation = "a".repeat(32);
    await fs.writeFile(
      lockFile,
      JSON.stringify({
        id: allocation!.id,
        identity: allocation!.identity,
        attestation: allocation!.attestation,
        pid: process.pid,
        processIncarnation,
        expiresAt: Date.now() + 60_000,
      }),
      { mode: 0o600 },
    );
    await expect(resources!.cleanup()).rejects.toThrow("Skill resource transfer failed");
    await expect(fs.stat(allocation!.root)).resolves.toBeDefined();
    await expect(fs.stat(lockFile)).resolves.toBeDefined();

    await fs.writeFile(
      lockFile,
      JSON.stringify({
        id: allocation!.id,
        identity: allocation!.identity,
        attestation: allocation!.attestation,
        pid: process.pid,
        processIncarnation: "b".repeat(32),
        expiresAt: 0,
      }),
    );
    await expect(resources!.cleanup()).resolves.toBeUndefined();
    await expect(fs.stat(allocation!.root)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(lockFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("finishes a crashed cleanup from its owned quarantine and dead-owner lock", async () => {
    const remoteWorkspaceDir = await fs.realpath(temps.make("skill-resource-crashed-cleanup-"));
    const carrier = createSpawnTunnel(remoteWorkspaceDir);
    let allocation: { attestation: string; id: string; identity: string; root: string } | undefined;
    const resources = await transferSkillResources({
      snapshot: await createSource(),
      remoteWorkspaceDir,
      assertCurrent: () => {},
      tunnel: {
        runWorkspaceCommand: async (command) => {
          const result = await carrier.runWorkspaceCommand(command);
          const operation = JSON.parse(command.input!);
          if (operation.op === "init") {
            allocation = {
              attestation: operation.attestation,
              id: operation.id,
              identity: JSON.parse(result.stdout).identity,
              root: resourceRootFor(remoteWorkspaceDir, operation.id),
            };
          }
          return result;
        },
      },
    });
    const registryFile = resourceRegistryFileFor(
      allocation!.root,
      allocation!.id,
      allocation!.identity,
    );
    const exited = spawn(process.execPath, ["-e", ""]);
    const deadPid = exited.pid!;
    await new Promise<void>((resolve, reject) => {
      exited.once("error", reject);
      exited.once("close", () => resolve());
    });
    await fs.writeFile(
      `${registryFile}.lock`,
      JSON.stringify({
        id: allocation!.id,
        identity: allocation!.identity,
        attestation: allocation!.attestation,
        pid: deadPid,
        processIncarnation: "b".repeat(32),
        expiresAt: Date.now() + 60_000,
      }),
      { mode: 0o600 },
    );
    const quarantine = path.join(
      path.dirname(registryFile),
      `.retired-root.${allocation!.id}.${deadPid}.${"c".repeat(32)}`,
    );
    await fs.rename(allocation!.root, quarantine);

    await vi.waitFor(
      async () => {
        await expect(fs.stat(quarantine)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.readFile(registryFile, "utf8")).resolves.toContain(
          '"cleanupPrepared":true',
        );
      },
      { timeout: 3_000 },
    );
    await expect(resources!.cleanup()).resolves.toBeUndefined();
    await expect(fs.stat(registryFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    "root",
    "root-marker-unlink",
    "marker",
    "permit",
    "before-registry",
    "after-registry",
    "after-final-lock",
    "after-final-lease",
    "before-final-rmdir",
  ] as const)("retries cleanup after a process crash at the %s retirement cut", async (cut) => {
    const remoteWorkspaceDir = await fs.realpath(temps.make("skill-resource-cleanup-cut-"));
    const carrier = createSpawnTunnel(remoteWorkspaceDir);
    let allocation: { attestation: string; id: string; identity: string; root: string } | undefined;
    let injectCrash = true;
    const resources = await transferSkillResources({
      snapshot: await createSource(),
      remoteWorkspaceDir,
      assertCurrent: () => {},
      tunnel: {
        runWorkspaceCommand: async (command) => {
          const operation = JSON.parse(command.input!);
          let dispatched = command;
          if (
            (operation.op === "cleanup" || operation.op === "cleanup-finalize") &&
            injectCrash &&
            (operation.op === "cleanup"
              ? !cut.startsWith("before-") && !cut.startsWith("after-")
              : cut.startsWith("before-") || cut.startsWith("after-"))
          ) {
            injectCrash = false;
            const registryFile = resourceRegistryFileFor(
              allocation!.root,
              allocation!.id,
              allocation!.identity,
            );
            const registryMarker = path.join(
              path.dirname(registryFile),
              `.owner.${allocation!.id}`,
            );
            const claimedPermit = path.join(
              remoteWorkspaceDir,
              `.openclaw-skill-resource-permit-${allocation!.id}.claimed`,
            );
            const registry = path.dirname(registryFile);
            const crashAtCut = `(()=>{const crashFs=require('node:fs'),crashPath=require('node:path'),cut=${JSON.stringify(cut)},registry=${JSON.stringify(registry)},registryMarker=${JSON.stringify(registryMarker)},claimedPermit=${JSON.stringify(claimedPermit)},originalRm=crashFs.rmSync,originalRename=crashFs.renameSync,originalUnlink=crashFs.unlinkSync,originalRmdir=crashFs.rmdirSync;crashFs.rmSync=function(target,...args){const result=originalRm.call(crashFs,target,...args);if(cut==='root'&&crashPath.basename(crashPath.dirname(String(target))).startsWith('.retired-root.'))process.kill(process.pid,'SIGKILL');return result;};crashFs.renameSync=function(source,target,...args){const resolved=crashPath.resolve(String(source));if(cut==='before-registry'&&resolved===crashPath.resolve(registry))process.kill(process.pid,'SIGKILL');const result=originalRename.call(crashFs,source,target,...args);if((cut==='marker'&&resolved===crashPath.resolve(registryMarker))||(cut==='permit'&&resolved===crashPath.resolve(claimedPermit))||(cut==='after-registry'&&resolved===crashPath.resolve(registry)))process.kill(process.pid,'SIGKILL');return result;};crashFs.unlinkSync=function(target,...args){const result=originalUnlink.call(crashFs,target,...args),parent=crashPath.basename(crashPath.dirname(String(target))),base=crashPath.basename(String(target));if((cut==='root-marker-unlink'&&parent.startsWith('.retired-root.')&&base==='.openclaw-skill-resource-owner')||(parent.startsWith('.retired-registry.')&&((cut==='after-final-lock'&&base.endsWith('.lock'))||(cut==='after-final-lease'&&base.endsWith('.json'))))process.kill(process.pid,'SIGKILL');return result;};crashFs.rmdirSync=function(target,...args){if(cut==='before-final-rmdir'&&crashPath.basename(String(target)).startsWith('.retired-registry.'))process.kill(process.pid,'SIGKILL');return originalRmdir.call(crashFs,target,...args);};})();`;
            dispatched = {
              ...command,
              argv: [command.argv[0]!, command.argv[1]!, crashAtCut + command.argv[2]!],
            };
          }
          const result = await carrier.runWorkspaceCommand(dispatched);
          if (operation.op === "init") {
            allocation = {
              attestation: operation.attestation,
              id: operation.id,
              identity: JSON.parse(result.stdout).identity,
              root: resourceRootFor(remoteWorkspaceDir, operation.id),
            };
          }
          return result;
        },
      },
    });
    const registryFile = resourceRegistryFileFor(
      allocation!.root,
      allocation!.id,
      allocation!.identity,
    );
    if (cut === "root") {
      await fs.writeFile(path.join(allocation!.root, "interrupted-cleanup-payload"), "payload");
    }
    if (cut === "permit") {
      const lease = JSON.parse(await fs.readFile(registryFile, "utf8"));
      await fs.writeFile(
        path.join(remoteWorkspaceDir, `.openclaw-skill-resource-permit-${allocation!.id}.claimed`),
        JSON.stringify({
          id: allocation!.id,
          pid: lease.creatorPid,
          attestation: allocation!.attestation,
          processIncarnation: lease.creatorIncarnation,
          expiresAt: 0,
        }),
        { mode: 0o600 },
      );
    }

    await expect(resources!.cleanup()).rejects.toThrow("Skill resource transfer failed");
    await expect(resources!.cleanup()).resolves.toBeUndefined();
    await expect(fs.stat(allocation!.root)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(registryFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when the registry directory is replaced during root retirement", async () => {
    const remoteWorkspaceDir = await fs.realpath(temps.make("skill-resource-registry-swap-"));
    const carrier = createSpawnTunnel(remoteWorkspaceDir);
    let allocation: { id: string; identity: string; root: string } | undefined;
    let injectSwap = true;
    const resources = await transferSkillResources({
      snapshot: await createSource(),
      remoteWorkspaceDir,
      assertCurrent: () => {},
      tunnel: {
        runWorkspaceCommand: async (command) => {
          const operation = JSON.parse(command.input!);
          let dispatched = command;
          if (operation.op === "cleanup" && injectSwap) {
            injectSwap = false;
            const registryFile = resourceRegistryFileFor(
              allocation!.root,
              allocation!.id,
              allocation!.identity,
            );
            const registry = path.dirname(registryFile);
            const savedRegistry = `${registry}.saved`;
            const swapRegistry = `(()=>{const swapFs=require('node:fs'),swapPath=require('node:path'),root=${JSON.stringify(allocation!.root)},registry=${JSON.stringify(registry)},saved=${JSON.stringify(savedRegistry)},original=swapFs.renameSync;let fired=false;swapFs.renameSync=function(source,target,...args){if(!fired&&swapPath.resolve(String(source))===swapPath.resolve(root)){fired=true;original.call(swapFs,registry,saved);swapFs.mkdirSync(registry,{mode:0o700});swapFs.writeFileSync(swapPath.join(registry,'operator-note'),'replacement');}return original.call(swapFs,source,target,...args);};})();`;
            dispatched = {
              ...command,
              argv: [command.argv[0]!, command.argv[1]!, swapRegistry + command.argv[2]!],
            };
          }
          const result = await carrier.runWorkspaceCommand(dispatched);
          if (operation.op === "init") {
            allocation = {
              id: operation.id,
              identity: JSON.parse(result.stdout).identity,
              root: resourceRootFor(remoteWorkspaceDir, operation.id),
            };
          }
          return result;
        },
      },
    });
    const registryFile = resourceRegistryFileFor(
      allocation!.root,
      allocation!.id,
      allocation!.identity,
    );
    const registry = path.dirname(registryFile);
    const savedRegistry = `${registry}.saved`;

    await expect(resources!.cleanup()).rejects.toThrow("Skill resource transfer failed");
    await expect(
      fs.stat(path.join(savedRegistry, path.basename(allocation!.root))),
    ).resolves.toBeDefined();
    await expect(fs.readFile(path.join(registry, "operator-note"), "utf8")).resolves.toBe(
      "replacement",
    );
    expect(
      (await fs.readdir(registry)).filter((name) => name.startsWith(".retired-root.")),
    ).toEqual([]);

    await fs.rm(registry, { recursive: true });
    await fs.rename(savedRegistry, registry);
    await expect(resources!.cleanup()).resolves.toBeUndefined();
  });

  it("preserves a claimed-permit replacement introduced after its ownership snapshot", async () => {
    const remoteWorkspaceDir = await fs.realpath(temps.make("skill-resource-permit-swap-"));
    const carrier = createSpawnTunnel(remoteWorkspaceDir);
    let allocation: { attestation: string; id: string; identity: string; root: string } | undefined;
    let injectSwap = true;
    const resources = await transferSkillResources({
      snapshot: await createSource(),
      remoteWorkspaceDir,
      assertCurrent: () => {},
      tunnel: {
        runWorkspaceCommand: async (command) => {
          const operation = JSON.parse(command.input!);
          let dispatched = command;
          if (operation.op === "cleanup" && injectSwap) {
            injectSwap = false;
            const claimed = path.join(
              remoteWorkspaceDir,
              `.openclaw-skill-resource-permit-${allocation!.id}.claimed`,
            );
            const saved = `${claimed}.saved`;
            const swapPermit = `(()=>{const swapFs=require('node:fs'),swapPath=require('node:path'),claimed=${JSON.stringify(claimed)},saved=${JSON.stringify(saved)},originalRead=swapFs.readFileSync;let fired=false;swapFs.readFileSync=function(target,...args){const bytes=originalRead.call(swapFs,target,...args);if(!fired&&swapPath.resolve(String(target))===swapPath.resolve(claimed)){fired=true;swapFs.renameSync(claimed,saved);swapFs.writeFileSync(claimed,'replacement',{mode:0o600});}return bytes;};})();`;
            dispatched = {
              ...command,
              argv: [command.argv[0]!, command.argv[1]!, swapPermit + command.argv[2]!],
            };
          }
          const result = await carrier.runWorkspaceCommand(dispatched);
          if (operation.op === "init") {
            allocation = {
              attestation: operation.attestation,
              id: operation.id,
              identity: JSON.parse(result.stdout).identity,
              root: resourceRootFor(remoteWorkspaceDir, operation.id),
            };
          }
          return result;
        },
      },
    });
    const registryFile = resourceRegistryFileFor(
      allocation!.root,
      allocation!.id,
      allocation!.identity,
    );
    const lease = JSON.parse(await fs.readFile(registryFile, "utf8"));
    const claimed = path.join(
      remoteWorkspaceDir,
      `.openclaw-skill-resource-permit-${allocation!.id}.claimed`,
    );
    const saved = `${claimed}.saved`;
    await fs.writeFile(
      claimed,
      JSON.stringify({
        id: allocation!.id,
        pid: lease.creatorPid,
        attestation: allocation!.attestation,
        processIncarnation: lease.creatorIncarnation,
        expiresAt: 0,
      }),
      { mode: 0o600 },
    );

    await expect(resources!.cleanup()).rejects.toThrow("Skill resource transfer failed");
    await expect(fs.readFile(claimed, "utf8")).resolves.toBe("replacement");
    await fs.rm(claimed);
    await fs.rename(saved, claimed);
    await expect(resources!.cleanup()).resolves.toBeUndefined();
  });
});
