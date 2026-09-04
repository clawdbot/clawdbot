import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadWorkspaceSkills } from "../../skills/loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../../skills/loading/workspace-skill-prompt.js";
import { createSkillResourceAllocationCoordinator } from "./skill-resource-allocation-coordinator.js";
import { createSkillResourceAllocationLedger } from "./skill-resource-allocation-ledger.js";
import { transferSkillResources as transferSkillResourcesImpl } from "./skill-resource-transfer.js";
import type { WorkerWorkspaceTunnelHandle } from "./tunnel-contract.js";
import { WORKER_ATTACHMENT_DIRECTORY_PREFIX } from "./workspace-path-exclusions.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const resourceRegistryPrefix = ".openclaw-skill-resource-lease-";
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

describe("remote-exec skill resource lease maintenance", () => {
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

  it("renews immediately when a delayed commit reply consumes the first renewal window", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"],
    });
    const { snapshot } = await createSource();
    const commitExecuted = createDeferred();
    const releaseCommitReply = createDeferred();
    let renewCalls = 0;
    let resources: Awaited<ReturnType<typeof transferSkillResources>>;
    try {
      const transfer = transferSkillResources({
        snapshot,
        assertCurrent: () => {},
        tunnel: {
          runWorkspaceCommand: async (command) => {
            const operation = JSON.parse(command.input!);
            if (operation.op === "renew") {
              renewCalls += 1;
            }
            const result = await tunnel.runWorkspaceCommand(command);
            if (operation.op === "commit") {
              commitExecuted.resolve();
              await releaseCommitReply.promise;
            }
            return result;
          },
        },
      });
      await commitExecuted.promise;
      await vi.advanceTimersByTimeAsync(41_000);
      releaseCommitReply.resolve();
      resources = await transfer;
      expect(renewCalls).toBe(1);

      await vi.advanceTimersByTimeAsync(1_000);

      expect(renewCalls).toBe(2);
      expect(() => resources!.assertCurrent()).not.toThrow();
    } finally {
      releaseCommitReply.resolve();
      await resources?.cleanup();
      vi.useRealTimers();
    }
  });

  it("anchors the next renewal to dispatch when a successful reply is delayed", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"],
    });
    const { snapshot } = await createSource();
    const periodicRenewalExecuted = createDeferred();
    const releaseRenewalReply = createDeferred();
    let renewCalls = 0;
    let resources: Awaited<ReturnType<typeof transferSkillResources>>;
    try {
      resources = await transferSkillResources({
        snapshot,
        assertCurrent: () => {},
        tunnel: {
          runWorkspaceCommand: async (command) => {
            const operation = JSON.parse(command.input!);
            if (operation.op === "renew") {
              renewCalls += 1;
            }
            const result = await tunnel.runWorkspaceCommand(command);
            if (operation.op === "renew" && renewCalls === 2) {
              periodicRenewalExecuted.resolve();
              await releaseRenewalReply.promise;
            }
            return result;
          },
        },
      });
      await vi.advanceTimersByTimeAsync(20_000);
      await periodicRenewalExecuted.promise;
      await vi.advanceTimersByTimeAsync(25_000);
      releaseRenewalReply.resolve();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(renewCalls).toBe(3);
      expect(() => resources!.assertCurrent()).not.toThrow();
    } finally {
      releaseRenewalReply.resolve();
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
