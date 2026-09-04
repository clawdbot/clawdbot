import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { loadWorkspaceSkills } from "../../skills/loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../../skills/loading/workspace-skill-prompt.js";
import { applySkillEnvOverridesFromSnapshot } from "../../skills/runtime/env-overrides.js";
import {
  NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES,
  parseNodeWorkerWorkspaceExecInput,
} from "../../worker/node-workspace-protocol.js";
import { createSkillResourceAllocationCoordinator } from "./skill-resource-allocation-coordinator.js";
import { createSkillResourceAllocationLedger } from "./skill-resource-allocation-ledger.js";
import { skillResourceAllocationDirectoryName } from "./skill-resource-transfer-contract.js";
import {
  SKILL_RESOURCE_RUNTIME_SCRIPT,
  transferSkillResources as transferSkillResourcesImpl,
} from "./skill-resource-transfer.js";
import type { WorkerWorkspaceTunnelHandle } from "./tunnel-contract.js";
import { WORKER_ATTACHMENT_DIRECTORY_PATTERN } from "./workspace-path-exclusions.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
type TestTunnel = Pick<WorkerWorkspaceTunnelHandle, "runWorkspaceCommand"> & {
  remoteWorkspaceDir: string;
};

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
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (bytes) => {
          stdout += bytes;
        });
        child.stderr.on("data", (bytes) => {
          stderr += bytes;
        });
        child.on("error", reject);
        child.on("close", (code) =>
          resolve({ stdout, stderr, code, termination: "exit", signal: null, killed: false }),
        );
        child.stdin.end(command.input);
      });
    },
  };
}

let tunnel: TestTunnel;
beforeEach(async () => {
  tunnel = createSpawnTunnel(await fs.realpath(temps.make("skill-resource-default-carrier-")));
});

async function createNodeCarrier() {
  const home = await fs.realpath(temps.make("skill-resource-node-"));
  const runtime = new NodeWorkerWorkspaceRuntime({
    root: home,
    env: { ...process.env, HOME: home },
  });
  const binding = {
    gatewayNamespace: "gateway",
    environmentId: "environment",
    sessionId: "session",
    generation: 1,
  };
  const initial = await runtime.exec({
    ...binding,
    argv: ["node", "-e", "process.stdout.write('ready')"],
  });
  return {
    binding,
    home,
    remoteWorkspaceDir: initial.workspaceDir,
    runtime,
    workspace: initial.workspaceDir,
    async runWorkspaceCommand(
      command: Parameters<WorkerWorkspaceTunnelHandle["runWorkspaceCommand"]>[0],
    ) {
      command.assertCurrent?.();
      return await runtime.exec(
        parseNodeWorkerWorkspaceExecInput(
          JSON.stringify({
            ...binding,
            argv: command.argv,
            input: command.input,
            timeoutMs: command.timeoutMs,
          }),
        ),
        command.signal,
      );
    },
  };
}

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

function createTestAllocationOwner(incarnationId?: string) {
  const stateDir = temps.make("skill-resource-host-ledger-control-");
  const ledger = createSkillResourceAllocationLedger({
    databaseOptions: {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
      },
    },
    ...(incarnationId ? { incarnationId } : {}),
  });
  return {
    coordinator: createSkillResourceAllocationCoordinator(ledger, {
      ownershipDatabaseOptions: {
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      },
    }),
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
    `.openclaw-skill-resource-lease-${id}`,
    skillResourceAllocationDirectoryName(id),
  );
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

async function expectRejectedResourceRequest(
  carrier: string,
  mutate: (input: string) => string,
  message = "Skill resource transfer failed",
) {
  const { snapshot } = await createSource();
  const transport = carrier === "node" ? await createNodeCarrier() : tunnel;
  let initializedRoot: string | undefined;
  let injected = false;
  try {
    await expect(
      transferSkillResources({
        snapshot,
        assertCurrent: () => {},
        tunnel: {
          remoteWorkspaceDir: transport.remoteWorkspaceDir,
          runWorkspaceCommand: async (command) => {
            const operation = JSON.parse(command.input!);
            let dispatched = command;
            if (operation.op === "write" && !injected) {
              dispatched = { ...command, input: mutate(command.input!) };
              injected = true;
            }
            const result = await transport.runWorkspaceCommand(dispatched);
            if (operation.op === "init") {
              initializedRoot = resourceRootFor(transport.remoteWorkspaceDir, operation.id);
            }
            return result;
          },
        },
      }),
    ).rejects.toThrow(message);
    expect(injected).toBe(true);
    await expect(fs.stat(initializedRoot!)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (initializedRoot) {
      await fs.rm(initializedRoot, { recursive: true, force: true });
    }
  }
}

describe("remote-exec skill resources", () => {
  it("fails closed before remote work when a real resource has no allocation owner", async () => {
    const { snapshot } = await createSource();
    const runWorkspaceCommand = vi.fn();

    await expect(
      transferSkillResourcesImpl({
        snapshot,
        tunnel: { runWorkspaceCommand },
        remoteWorkspaceDir: tunnel.remoteWorkspaceDir,
        assertCurrent: () => {},
      }),
    ).rejects.toThrow("Skill resource allocation owner is unavailable");
    expect(runWorkspaceCommand).not.toHaveBeenCalled();
  });

  it("keeps the receiver command below the Windows process limit", () => {
    const conservativeCommandLineLength =
      process.execPath.length + " -e ".length + SKILL_RESOURCE_RUNTIME_SCRIPT.length + 4;
    expect(conservativeCommandLineLength).toBeLessThan(32_767);
  });

  it("keeps the detached reaper command below the Windows process limit", async () => {
    const remoteWorkspaceDir = await fs.realpath(temps.make("skill-resource-reaper-length-"));
    const carrier = createSpawnTunnel(remoteWorkspaceDir);
    const lengthFile = path.join(remoteWorkspaceDir, "reaper-command-length");
    const { snapshot } = await createSource();
    const resources = await transferSkillResources({
      snapshot,
      remoteWorkspaceDir,
      assertCurrent: () => {},
      tunnel: {
        runWorkspaceCommand: async (command) => {
          if (JSON.parse(command.input!).op !== "init") {
            return await carrier.runWorkspaceCommand(command);
          }
          const captureLength = `(()=>{const childProcess=require('node:child_process'),fs=require('node:fs'),original=childProcess.spawn;childProcess.spawn=(file,args,options)=>{if(args[2]==='initialize')fs.writeFileSync(${JSON.stringify(lengthFile)},String(file.length+args.reduce((total,arg)=>total+arg.length+3,0)));return original(file,args,options);};})();`;
          return await carrier.runWorkspaceCommand({
            ...command,
            argv: [command.argv[0]!, command.argv[1]!, captureLength + command.argv[2]!],
          });
        },
      },
    });

    try {
      expect(Number(await fs.readFile(lengthFile, "utf8"))).toBeLessThan(32_767);
    } finally {
      await resources?.cleanup();
    }
  });

  it("uses a private placement allocation despite a project path collision", async () => {
    const { snapshot, binary } = await createSource();
    const carrier = await createNodeCarrier();
    const outside = await fs.realpath(temps.make("skill-resource-project-link-"));
    await fs.writeFile(path.join(outside, "SKILL.md"), "project marker");
    await fs.symlink(
      outside,
      path.join(carrier.workspace, "0"),
      process.platform === "win32" ? "junction" : "dir",
    );
    let initializedRoot: string | undefined;
    const requestSizes: number[] = [];
    try {
      const resources = await transferSkillResources({
        snapshot,
        assertCurrent: () => {},
        tunnel: {
          remoteWorkspaceDir: carrier.remoteWorkspaceDir,
          runWorkspaceCommand: async (command) => {
            requestSizes.push(Buffer.byteLength(command.input!));
            const result = await carrier.runWorkspaceCommand(command);
            const operation = JSON.parse(command.input!);
            if (operation.op === "init") {
              initializedRoot ??= resourceRootFor(carrier.remoteWorkspaceDir, operation.id);
            }
            return result;
          },
        },
      });
      const remote = resources!.mounts[0]!.containerPath;
      expect(remote.startsWith(`${carrier.workspace}${path.sep}`)).toBe(true);
      expect(await fs.readFile(path.join(remote, "data.bin"))).toEqual(binary);
      expect(await fs.readFile(path.join(outside, "SKILL.md"), "utf8")).toBe("project marker");
      const largestRequest = Math.max(...requestSizes);
      expect(largestRequest).toBeLessThanOrEqual(NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES);
      expect(NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES - largestRequest).toBeLessThan(4);
      await resources!.cleanup();
      await expect(fs.stat(initializedRoot!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (initializedRoot) {
        await fs.rm(initializedRoot, { recursive: true, force: true });
      }
    }
  });

  it("keeps an active node allocation in the retained generation and uses the attachment namespace", async () => {
    const { snapshot } = await createSource();
    const carrier = await createNodeCarrier();
    let initializedRoot: string | undefined;
    const resources = await transferSkillResources({
      snapshot,
      assertCurrent: () => {},
      tunnel: {
        remoteWorkspaceDir: carrier.remoteWorkspaceDir,
        runWorkspaceCommand: async (command) => {
          const operation = JSON.parse(command.input!);
          if (operation.op === "init") {
            initializedRoot = resourceRootFor(carrier.remoteWorkspaceDir, operation.id);
          }
          return await carrier.runWorkspaceCommand(command);
        },
      },
    });
    const retention = {
      version: 1 as const,
      gatewayNamespace: carrier.binding.gatewayNamespace,
      controllerId: "restarted-gateway",
      sequence: 1,
      retain: [{ ...carrier.binding, manifestRefs: null }],
    };

    expect(path.basename(initializedRoot!)).toMatch(
      new RegExp(`^${WORKER_ATTACHMENT_DIRECTORY_PATTERN}$`),
    );
    await carrier.runtime.applyRetainSnapshot(retention, () => []);
    expect((await fs.stat(initializedRoot!)).isDirectory()).toBe(true);

    await resources!.cleanup();
    await carrier.runtime.applyRetainSnapshot({ ...retention, sequence: 2, retain: [] }, () => []);
    await expect(fs.stat(initializedRoot!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects remote directory identities that collide when rounded to numbers", async () => {
    const { snapshot } = await createSource();
    const remoteWorkspaceDir = await fs.realpath(temps.make("skill-resource-identity-collision-"));
    const carrier = createSpawnTunnel(remoteWorkspaceDir);
    let initializedRoot: string | undefined;
    try {
      await expect(
        transferSkillResources({
          snapshot,
          assertCurrent: () => {},
          remoteWorkspaceDir,
          tunnel: {
            runWorkspaceCommand: async (command) => {
              const initializing = JSON.parse(command.input!).op === "init";
              // Model adjacent Windows file indexes while retaining the real filesystem flow.
              const identityShim = `{
                const fs = require('node:fs');
                for (const method of ['lstatSync', 'statSync']) {
                  const original = fs[method];
                  fs[method] = (...args) => {
                    const stat = original(...args);
                    const ino = 9007199254740992n + ${initializing ? 0 : 1}n;
                    stat.ino = typeof stat.ino === 'bigint' ? ino : Number(ino);
                    return stat;
                  };
                }
              }`;
              const result = await carrier.runWorkspaceCommand({
                ...command,
                argv: [...command.argv.slice(0, 2), identityShim + command.argv[2]],
              });
              if (initializing) {
                const operation = JSON.parse(command.input!);
                initializedRoot = resourceRootFor(remoteWorkspaceDir, operation.id);
              }
              return result;
            },
          },
        }),
      ).rejects.toThrow("Invalid skill resource allocation");
      expect(initializedRoot).toBeDefined();
      await expect(fs.stat(initializedRoot!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (initializedRoot) {
        await fs.rm(initializedRoot, { recursive: true, force: true });
      }
    }
  });

  it.each(
    ["ssh", "node"].flatMap((carrier) =>
      ["complete", "cancelled", "retired"].map((outcome) => ({ carrier, outcome })),
    ),
  )(
    "preserves complete resources in its private placement allocation and cleans up only its current owner ($carrier, $outcome)",
    async ({ carrier, outcome }) => {
      const { workspace, filePath, binary, snapshot } = await createSource();
      const controller = new AbortController();
      let current = true;
      const resources = await transferSkillResources({
        tunnel: carrier === "node" ? await createNodeCarrier() : tunnel,
        signal: controller.signal,
        assertCurrent: () => {
          if (!current) {
            throw new Error("placement retired");
          }
        },
        snapshot,
      });
      expect(resources).toBeDefined();
      const remote = resources!.mounts[0]!.containerPath;
      try {
        expect(remote.startsWith(workspace)).toBe(false);
        expect(await fs.readFile(path.join(remote, "SKILL.md"))).toEqual(
          await fs.readFile(filePath),
        );
        expect(resources!.snapshot.resolvedSkills![0]!.name).toBe("source");
        expect(await fs.readFile(path.join(remote, "data.bin"))).toEqual(binary);
        const executableMode = (await fs.stat(path.join(remote, "scripts/check.sh"))).mode;
        const dataMode = (await fs.stat(path.join(remote, "data.bin"))).mode;
        if (process.platform === "win32") {
          expect(executableMode & 0o222).toBe(0);
          expect(dataMode & 0o222).toBe(0);
        } else {
          expect(executableMode & 0o777).toBe(0o500);
          expect(dataMode & 0o777).toBe(0o400);
        }
        expect(resources!.snapshot.prompt).toContain(remote);
        expect(resources!.snapshot.resolvedSkills![0]!.filePath).toBe(filePath);
        if (outcome === "cancelled") {
          controller.abort();
        } else if (outcome === "retired") {
          current = false;
        }
        if (outcome === "retired") {
          await expect(resources!.cleanup()).rejects.toThrow("placement retired");
          expect(await fs.readFile(path.join(remote, "data.bin"))).toEqual(binary);
        } else {
          await expect(resources!.cleanup()).resolves.toBeUndefined();
          await expect(fs.stat(remote)).rejects.toMatchObject({ code: "ENOENT" });
        }
      } finally {
        current = true;
        await resources!.cleanup().catch(() => undefined);
        await fs.rm(path.dirname(remote), { recursive: true, force: true });
      }
    },
  );

  it.each([
    { name: "forged path id", patch: { id: "../outside" } },
    { name: "unallocated id", patch: { id: randomUUID().replaceAll("-", "") } },
    { name: "wrong inode", patch: { identity: "0:0" } },
    { name: "absolute root input", patch: { root: "/tmp" } },
    { name: "digest mismatch", patch: { hash: "0".repeat(64) } },
    { name: "Windows alternate data stream", patch: { name: "0/data.bin:stream" } },
    { name: "Windows trailing-space parent", patch: { name: "0/.. /marker" } },
    { name: "Windows reserved device", patch: { name: "0/NUL" } },
    { name: "Windows console input device", patch: { name: "0/conin$.txt" } },
    { name: "Windows console output device", patch: { name: "0/NESTED/CONOUT$" } },
    { name: "Windows superscript COM device", patch: { name: "0/COM¹.txt" } },
    { name: "Windows superscript LPT device", patch: { name: "0/LPT³" } },
  ])("rejects $name and cleans only the allocated resources", async ({ patch }) => {
    await expectRejectedResourceRequest("node", (input) =>
      JSON.stringify({ ...JSON.parse(input), ...patch }),
    );
  });

  it("accepts CLOCK$ and ordinary dollar filenames at both policy boundaries", async () => {
    const created = await createSource();
    const baseDir = path.dirname(created.filePath);
    await fs.writeFile(path.join(baseDir, "CLOCK$"), "clock");
    await fs.writeFile(path.join(baseDir, "normal$.js"), "normal");
    const snapshot = buildSkillSnapshot(created.workspace, {
      entries: loadWorkspaceSkills(created.workspace, { workspaceOnly: true }),
    });
    const resources = await transferSkillResources({ snapshot, assertCurrent: () => {}, tunnel });
    const remote = resources!.mounts[0]!.containerPath;
    try {
      await expect(fs.readFile(path.join(remote, "CLOCK$"), "utf8")).resolves.toBe("clock");
      await expect(fs.readFile(path.join(remote, "normal$.js"), "utf8")).resolves.toBe("normal");
    } finally {
      await resources!.cleanup();
    }
  });

  it("moves outside the allocation before recursive cleanup", async () => {
    const { snapshot } = await createSource();
    let root: string | undefined;
    const resources = await transferSkillResources({
      snapshot,
      assertCurrent: () => {},
      remoteWorkspaceDir: tunnel.remoteWorkspaceDir,
      tunnel: {
        runWorkspaceCommand: async (command) => {
          const operation = JSON.parse(command.input!);
          const cwdDeleteTrap = String.raw`(()=>{const trapFs=require('node:fs'),trapPath=require('node:path'),rm=trapFs.rmSync;trapFs.rmSync=(target,options)=>{if(trapPath.resolve(process.cwd())===trapPath.resolve(target)){const error=Error('cwd-delete refused');error.code='EPERM';throw error;}return rm(target,options);};})();`;
          const result = await tunnel.runWorkspaceCommand(
            operation.op === "cleanup"
              ? {
                  ...command,
                  argv: [command.argv[0]!, command.argv[1]!, cwdDeleteTrap + command.argv[2]!],
                }
              : command,
          );
          if (operation.op === "init") {
            root = resourceRootFor(tunnel.remoteWorkspaceDir, operation.id);
          }
          return result;
        },
      },
    });
    await expect(resources!.cleanup()).resolves.toBeUndefined();
    await expect(fs.stat(root!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains its ledger record when a stale id and forged root try to redirect cleanup", async () => {
    const firstSource = await createSource();
    const secondSource = await createSource();
    const second = await transferSkillResources({
      snapshot: secondSource.snapshot,
      assertCurrent: () => {},
      tunnel,
    });
    const secondRoot = path.dirname(second!.mounts[0]!.containerPath);
    const firstOwner = createTestAllocationOwner();
    const staleAllocationId = randomUUID().replaceAll("-", "");
    let redirected = false;
    const first = await transferSkillResourcesImpl({
      snapshot: firstSource.snapshot,
      remoteWorkspaceDir: tunnel.remoteWorkspaceDir,
      assertCurrent: () => {},
      allocationOwner: firstOwner,
      tunnel: {
        runWorkspaceCommand: async (command) => {
          const operation = JSON.parse(command.input!);
          if (operation.op === "cleanup" && !redirected) {
            redirected = true;
            return await tunnel.runWorkspaceCommand({
              ...command,
              input: JSON.stringify({
                ...operation,
                id: staleAllocationId,
                root: secondRoot,
              }),
            });
          }
          return await tunnel.runWorkspaceCommand(command);
        },
      },
    });
    const firstRoot = path.dirname(first!.mounts[0]!.containerPath);
    const [firstRecord] = await firstOwner.ledger.list();
    expect(firstRecord).toMatchObject({ phase: "allocated" });
    expect(firstRecord!.allocationId).not.toBe(staleAllocationId);
    try {
      await expect(first!.cleanup()).rejects.toThrow("Skill resource transfer failed");
      await expect(fs.stat(firstRoot)).resolves.toBeDefined();
      await expect(fs.stat(secondRoot)).resolves.toBeDefined();
      await expect(firstOwner.ledger.list()).resolves.toMatchObject([
        { allocationId: firstRecord!.allocationId, phase: "cleanup-pending" },
      ]);
      await expect(first!.cleanup()).resolves.toBeUndefined();
      await expect(firstOwner.ledger.list()).resolves.toEqual([]);
      await expect(fs.stat(secondRoot)).resolves.toBeDefined();
    } finally {
      await second!.cleanup();
    }
  });

  it("rejects resource-relative traversal without writing outside its owned directory", async () => {
    const outside = await fs.realpath(temps.make("skill-resource-escape-"));
    await expectRejectedResourceRequest("node", (input) =>
      JSON.stringify({ ...JSON.parse(input), name: `../${path.basename(outside)}/marker` }),
    );
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it.each(["ssh", "node"])(
    "rejects an oversized typed resource request over %s",
    async (carrier) => {
      await expectRejectedResourceRequest(
        carrier,
        (input) =>
          input + " ".repeat(NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES + 1 - Buffer.byteLength(input)),
        carrier === "node"
          ? "workspace command input exceeds its bound"
          : "Skill resource transfer failed",
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "omits a stale discovered skill from the transferred snapshot and prompt",
    async () => {
      const { workspace, snapshot } = await createSource();
      const staleBaseDir = path.join(workspace, "skills", "stale");
      await fs.mkdir(staleBaseDir, { recursive: true });
      await fs.writeFile(
        path.join(staleBaseDir, "SKILL.md"),
        "---\ndescription: Stale resource\n---\n# Stale\n",
      );
      const sourceSkill = snapshot.resolvedSkills?.[0];
      expect(sourceSkill).toBeDefined();
      snapshot.resolvedSkills!.push({
        ...sourceSkill!,
        name: "stale",
        filePath: path.join(staleBaseDir, "SKILL.md"),
        baseDir: staleBaseDir,
      });
      snapshot.skills.push({
        name: "stale",
        skillKey: "stale",
        primaryEnv: "STALE_SKILL_API_KEY",
      });
      snapshot.prompt += "\nstale";
      await fs.rm(staleBaseDir, { recursive: true });
      await fs.symlink(path.join(workspace, "missing-stale-target"), staleBaseDir, "dir");

      const resources = await transferSkillResources({
        tunnel,
        assertCurrent: () => {},
        snapshot,
      });
      const remoteRoot = path.dirname(resources!.mounts[0]!.containerPath);
      try {
        expect(resources!.mounts).toHaveLength(1);
        expect(resources!.snapshot.skills.map((skill) => skill.name)).toEqual(["source"]);
        expect(resources!.snapshot.resolvedSkills?.map((skill) => skill.name)).toEqual(["source"]);
        expect(resources!.snapshot.prompt).not.toContain("stale");
        const restoreEnv = applySkillEnvOverridesFromSnapshot({
          snapshot: resources!.snapshot,
          config: {
            skills: {
              entries: { stale: { apiKey: "must-not-apply" } }, // pragma: allowlist secret
            },
          },
        });
        try {
          expect(process.env.STALE_SKILL_API_KEY).toBeUndefined();
        } finally {
          restoreEnv();
        }
      } finally {
        await resources!.cleanup();
        await fs.rm(remoteRoot, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "retains a skill identity when a same-named node skill remains active",
    async () => {
      const { workspace } = await createSource();
      const staleBaseDir = path.join(workspace, "skills", "stale");
      await fs.mkdir(staleBaseDir, { recursive: true });
      await fs.writeFile(
        path.join(staleBaseDir, "SKILL.md"),
        "---\ndescription: Stale resource\n---\n# Stale\n",
      );
      const snapshot = buildSkillSnapshot(workspace, {
        entries: loadWorkspaceSkills(workspace, { workspaceOnly: true }),
      });
      const sourceSkill = snapshot.resolvedSkills?.[0];
      expect(sourceSkill).toBeDefined();
      snapshot.skills.push({ name: "stale", skillKey: "stale" });
      snapshot.resolvedSkills?.push(
        {
          ...structuredClone(sourceSkill!),
          name: "stale",
          filePath: path.join(staleBaseDir, "SKILL.md"),
          baseDir: staleBaseDir,
        },
        {
          ...structuredClone(sourceSkill!),
          name: "stale",
          filePath: "node://worker/skills/stale/SKILL.md",
          baseDir: "node://worker/skills/stale",
        },
      );
      await fs.rm(staleBaseDir, { recursive: true });
      await fs.symlink(path.join(workspace, "missing-stale-target"), staleBaseDir, "dir");

      const resources = await transferSkillResources({
        tunnel,
        assertCurrent: () => {},
        snapshot,
      });
      const remoteRoot = path.dirname(resources!.mounts[0]!.containerPath);
      try {
        expect(resources!.snapshot.skills.map((skill) => skill.name)).toEqual(["source", "stale"]);
        expect(resources!.snapshot.resolvedSkills?.map((skill) => skill.name)).toEqual([
          "source",
          "stale",
        ]);
      } finally {
        await resources!.cleanup();
        await fs.rm(remoteRoot, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "removes every stale skill from the transferred snapshot when no bundles remain",
    async () => {
      const { filePath, snapshot } = await createSource();
      const baseDir = path.dirname(filePath);
      await fs.rm(baseDir, { recursive: true });
      await fs.symlink(path.join(path.dirname(baseDir), "missing-source-target"), baseDir, "dir");

      const resources = await transferSkillResources({
        tunnel,
        assertCurrent: () => {},
        snapshot,
      });
      try {
        expect(resources?.mounts).toEqual([]);
        expect(resources?.snapshot.skills).toEqual([]);
        expect(resources?.snapshot.resolvedSkills).toEqual([]);
        expect(resources?.snapshot.prompt).not.toContain("source");
      } finally {
        await resources?.cleanup();
      }
    },
  );

  it.each(["ssh", "node"])(
    "cleans the accepted remote directory when cancellation arrives with initialization (%s)",
    async (carrier) => {
      const { snapshot } = await createSource();
      const transport = carrier === "node" ? await createNodeCarrier() : tunnel;
      const controller = new AbortController();
      let initializedRoot: string | undefined;
      try {
        await expect(
          transferSkillResources({
            snapshot,
            signal: controller.signal,
            assertCurrent: () => {},
            tunnel: {
              remoteWorkspaceDir: transport.remoteWorkspaceDir,
              runWorkspaceCommand: async (command) => {
                const result = await transport.runWorkspaceCommand(command);
                if (!initializedRoot) {
                  const operation = JSON.parse(command.input!);
                  initializedRoot = resourceRootFor(transport.remoteWorkspaceDir, operation.id);
                  controller.abort();
                }
                return result;
              },
            },
          }),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(initializedRoot).toBeDefined();
        await expect(fs.stat(initializedRoot!)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        if (initializedRoot) {
          await fs.rm(initializedRoot, { recursive: true, force: true });
        }
      }
    },
  );
});
