import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { transferSkillResources } from "./skill-resource-transfer.js";
import {
  createNodeCarrier,
  createResourceCarrier,
  createResourceSource,
  prependResourceReceiver,
  NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES,
} from "./skill-resource-transfer.test-support.js";
import type { WorkerWorkspaceTunnelHandle } from "./tunnel-contract.js";
import { WORKER_ATTACHMENT_DIRECTORY_PREFIX } from "./workspace-path-exclusions.js";
import { readActualWorkspaceManifest } from "./workspace-reconcile.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

async function createCarrier(kind = "ssh") {
  return await createResourceCarrier(temps.make(`skill-resource-${kind}-`), kind);
}

const createSource = () => createResourceSource(temps.make("remote-skill-source-"));

describe("remote-exec skill resources", () => {
  it("rejects a valid-shaped init reply advertising a different allocation", async () => {
    const { snapshot } = await createSource();
    const carrier = await createNodeCarrier(temps.make("skill-resource-node-"));
    const outside = await fs.realpath(temps.make("skill-resource-wrong-mount-"));
    let allocated: string | undefined;
    let writes = 0;
    try {
      const request = {
        snapshot,
        workspaceDir: carrier.workspace,
        generation: carrier.generation,
        assertCurrent: () => {},
        tunnel: {
          runWorkspaceCommand: async (
            command: Parameters<WorkerWorkspaceTunnelHandle["runWorkspaceCommand"]>[0],
          ) => {
            const operation = command.skillResources!.operation;
            writes += Number(operation.operation === "write");
            const result = await carrier.runWorkspaceCommand(command);
            if (operation.operation === "init") {
              allocated = JSON.parse(result.stdout).root;
              return {
                ...result,
                stdout: JSON.stringify({
                  ...JSON.parse(result.stdout),
                  root: outside,
                }),
              };
            }
            return result;
          },
        },
      };
      await expect(transferSkillResources(request)).rejects.toThrow(
        "Skill resource location does not match",
      );
      expect(writes).toBe(0);
      expect(await fs.readdir(outside)).toEqual([]);
    } finally {
      if (allocated) {
        await fs.rm(allocated, { recursive: true, force: true });
      }
    }
  });

  it.each(["malformed", "transport lost", "retired", "crashed"])(
    "reclaims uncertain init on the next turn or generation retirement (%s)",
    async (failure) => {
      const { snapshot } = await createSource();
      const carrier = await createNodeCarrier(temps.make("skill-resource-node-"));
      if (failure === "crashed") {
        prependResourceReceiver(
          "if (JSON.parse(process.argv[3]).operation === 'init') process.stdout.write=()=>process.exit(9);",
        );
      }
      let allocated: string | undefined;
      let current = true;
      try {
        const request = {
          snapshot,
          workspaceDir: carrier.workspace,
          generation: carrier.generation,
          assertCurrent: () => {
            if (!current) {
              throw new Error("placement retired");
            }
          },
          tunnel: {
            runWorkspaceCommand: async (
              command: Parameters<WorkerWorkspaceTunnelHandle["runWorkspaceCommand"]>[0],
            ) => {
              const operation = command.skillResources!.operation;
              const result = await carrier.runWorkspaceCommand(command);
              if (operation.operation === "init") {
                const directories = await fs.readdir(path.dirname(carrier.workspace));
                allocated = path.join(
                  path.dirname(carrier.workspace),
                  directories.find((name) =>
                    name.startsWith(`.${carrier.generation}.skill-resources-`),
                  )!,
                );
                if (failure === "transport lost") {
                  throw new Error("init response lost");
                }
                if (failure === "retired") {
                  current = false;
                }
                if (failure === "malformed") {
                  return { ...result, stdout: "invalid" };
                }
              }
              return result;
            },
          },
        };
        await expect(transferSkillResources(request)).rejects.toThrow();
        expect(allocated).toBeDefined();
        vi.restoreAllMocks();
        const restarted = new NodeWorkerWorkspaceRuntime({ root: carrier.home });
        const retention = {
          version: 1 as const,
          gatewayNamespace: carrier.binding.gatewayNamespace,
          controllerId: "restarted-gateway",
          sequence: 1,
          retain: [{ ...carrier.binding, manifestRefs: null }],
        };
        await restarted.applyRetainSnapshot(retention, () => []);
        expect((await fs.stat(allocated!)).isDirectory()).toBe(true);
        if (failure === "retired") {
          await restarted.applyRetainSnapshot({ ...retention, sequence: 2, retain: [] }, () => []);
          await expect(fs.stat(allocated!)).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          const next = await transferSkillResources({
            snapshot: failure === "malformed" ? snapshot : undefined,
            workspaceDir: carrier.workspace,
            generation: carrier.generation,
            assertCurrent: () => {},
            tunnel: carrier,
          });
          try {
            await expect(fs.stat(allocated!)).rejects.toMatchObject({ code: "ENOENT" });
            expect((await fs.stat(carrier.workspace)).isDirectory()).toBe(true);
          } finally {
            await next?.cleanup();
          }
        }
      } finally {
        if (allocated) {
          await fs.rm(allocated, { recursive: true, force: true });
        }
      }
    },
  );

  it("recovers lost cleanup without deleting attachments, project files, or linked markers", async () => {
    const { snapshot, binary } = await createSource();
    const carrier = await createCarrier();
    let disconnected = false;
    const resources = await transferSkillResources({
      snapshot,
      workspaceDir: carrier.workspace,
      generation: carrier.generation,
      assertCurrent: () => {},
      tunnel: {
        runWorkspaceCommand: (command) => {
          if (disconnected) {
            throw new Error("connection lost");
          }
          return carrier.runWorkspaceCommand(command);
        },
      },
    });
    const remote = resources!.mounts[0]!.containerPath;
    disconnected = true;
    await expect(resources!.cleanup()).rejects.toThrow("connection lost");
    const candidate = (generation = carrier.generation) =>
      path.join(
        path.dirname(carrier.workspace),
        `.${generation}.skill-resources-${randomUUID().replaceAll("-", "")}`,
      );
    const preserved = [
      candidate(),
      path.join(carrier.workspace, "project-inputs"),
      candidate(),
      path.join(carrier.workspace, WORKER_ATTACHMENT_DIRECTORY_PREFIX + "project-inputs"),
      candidate(carrier.generation + 1),
      path.join(carrier.workspace, WORKER_ATTACHMENT_DIRECTORY_PREFIX + randomUUID()),
    ];
    for (const directory of preserved) {
      await fs.mkdir(directory);
      await fs.writeFile(path.join(directory, "keep.txt"), "keep");
    }
    await fs.writeFile(path.join(preserved[1]!, ".gitignore"), "*\n");
    await fs.writeFile(path.join(preserved[2]!, ".gitignore"), "*\n# project-owned\n");
    await fs.writeFile(path.join(preserved[3]!, ".gitignore"), "*\n");
    await fs.writeFile(path.join(preserved[4]!, ".gitignore"), "*\n");
    const outside = await fs.realpath(temps.make("skill-resource-preserved-"));
    const externalMarker = path.join(outside, ".gitignore");
    await fs.writeFile(externalMarker, "*\n");
    await fs.writeFile(path.join(outside, "keep.txt"), "keep");
    const linkedRoot = candidate();
    await fs.symlink(outside, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    preserved.push(linkedRoot);
    for (const link of process.platform === "win32" ? ["hard"] : ["hard", "symbolic"]) {
      const directory = candidate();
      await fs.mkdir(directory);
      await fs.writeFile(path.join(directory, "keep.txt"), "keep");
      const marker = path.join(directory, ".gitignore");
      if (link === "hard") {
        await fs.link(externalMarker, marker);
      } else {
        await fs.symlink(externalMarker, marker, "file");
      }
      preserved.push(directory);
    }
    const nextTurn = {
      workspaceDir: carrier.workspace,
      generation: carrier.generation,
      tunnel: carrier,
      assertCurrent: () => {},
    };
    await expect(
      transferSkillResources({
        ...nextTurn,
        assertCurrent: () => {
          throw new Error("placement retired");
        },
      }),
    ).rejects.toThrow("placement retired");
    expect(await fs.readFile(path.join(remote, "data.bin"))).toEqual(binary);
    await transferSkillResources(nextTurn);
    await expect(fs.stat(path.dirname(remote))).rejects.toMatchObject({ code: "ENOENT" });
    for (const directory of preserved) {
      expect(await fs.readFile(path.join(directory, "keep.txt"), "utf8")).toBe("keep");
    }
    expect((await fs.lstat(linkedRoot)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(externalMarker, "utf8")).toBe("*\n");
  });

  it("preserves a replacement turn's resources when an old SSH command arrives late", async () => {
    const { snapshot, binary } = await createSource();
    const carrier = await createCarrier();
    const dispatched = createDeferred();
    const executeReceiver = createDeferred();
    let current = true;
    let firstCommand = true;
    const oldAttempt = transferSkillResources({
      workspaceDir: carrier.workspace,
      generation: carrier.generation,
      assertCurrent: () => {
        if (!current) {
          throw new Error("placement retired");
        }
      },
      tunnel: {
        runWorkspaceCommand: async (command) => {
          command.assertCurrent?.();
          if (firstCommand) {
            firstCommand = false;
            dispatched.resolve();
            await executeReceiver.promise;
          }
          // SSH already accepted this request; its receiver cannot call back into the Gateway.
          const { assertCurrent: _assertCurrent, ...received } = command;
          return carrier.runWorkspaceCommand(received);
        },
      },
    });
    const oldSettled = oldAttempt.catch(() => {});
    try {
      await dispatched.promise;
      current = false;
      const replacement = await transferSkillResources({
        snapshot,
        workspaceDir: carrier.workspace,
        generation: carrier.generation,
        assertCurrent: () => {},
        tunnel: carrier,
      });
      const remote = replacement!.mounts[0]!.containerPath;
      expect(await fs.readFile(path.join(remote, "data.bin"))).toEqual(binary);
      executeReceiver.resolve();
      await expect(oldAttempt).rejects.toThrow("placement retired");
      expect(await fs.readFile(path.join(remote, "data.bin"))).toEqual(binary);
      await replacement!.cleanup();
    } finally {
      executeReceiver.resolve();
      await oldSettled;
    }
  });

  it("keeps node resources private across a project path collision and partial cleanup", async () => {
    const { snapshot, binary } = await createSource();
    const carrier = await createNodeCarrier(temps.make("skill-resource-node-"));
    const outside = await fs.realpath(temps.make("skill-resource-project-link-"));
    await fs.writeFile(path.join(outside, "SKILL.md"), "project marker");
    await fs.symlink(
      outside,
      path.join(carrier.workspace, "0"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const git = (argv: string[]) =>
      carrier.runWorkspaceCommand({ argv: ["git", ...argv], transportRetry: "never" });
    expect((await git(["init"])).code).toBe(0);
    await fs.writeFile(path.join(carrier.workspace, "project.txt"), "project");
    expect((await git(["add", "--all"])).code).toBe(0);
    const trackedBefore = await git(["ls-files"]);
    expect(trackedBefore.code).toBe(0);
    const before = await git(["status", "--porcelain", "--untracked-files=all"]);
    expect(before.code).toBe(0);
    const expectProjectUnchanged = async () => {
      const after = await git(["status", "--porcelain", "--untracked-files=all"]);
      const added = await git(["add", "--all"]);
      const tracked = await git(["ls-files"]);
      expect.soft(after).toMatchObject({ code: 0, stdout: before.stdout });
      expect(added.code).toBe(0);
      expect.soft(tracked).toMatchObject({ code: 0, stdout: trackedBefore.stdout });
    };
    let initializedRoot: string | undefined;
    const requestSizes: number[] = [];
    try {
      const resources = await transferSkillResources({
        snapshot,
        workspaceDir: carrier.workspace,
        generation: carrier.generation,
        assertCurrent: () => {},
        tunnel: {
          runWorkspaceCommand: async (command) => {
            requestSizes.push(Buffer.byteLength(command.input ?? ""));
            const result = await carrier.runWorkspaceCommand(command);
            const operation = command.skillResources!.operation;
            if (operation.operation === "init") {
              initializedRoot = JSON.parse(result.stdout).root;
            }
            return result;
          },
        },
      });
      const remote = resources!.mounts[0]!.containerPath;
      expect(path.relative(carrier.workspace, remote)).toMatch(/^\.\.[/\\]/);
      expect(await fs.readFile(path.join(remote, "data.bin"))).toEqual(binary);
      expect(await fs.readFile(path.join(outside, "SKILL.md"), "utf8")).toBe("project marker");
      const manifest = await readActualWorkspaceManifest({
        root: carrier.workspace,
        baseCommit: null,
      });
      expect(manifest.manifest.entries.map((entry) => entry.path)).toEqual(["project.txt"]);
      await expectProjectUnchanged();
      const largestRequest = Math.max(...requestSizes);
      expect(largestRequest).toBeLessThanOrEqual(NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES);
      expect(NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES - largestRequest).toBeLessThan(4);
      prependResourceReceiver(`{
        if (JSON.parse(process.argv[3]).operation === 'cleanup') {
          const fs = require('node:fs'), remove = fs.rmSync;
          fs.rmSync = (entry, options) => {
            if (entry === '0') {
              remove('0/data.bin');
              throw Error('resource still open');
            }
            return remove(entry, options);
          };
        }
      }`);
      await expect(resources!.cleanup()).rejects.toThrow("Skill resource cleanup failed");
      vi.restoreAllMocks();
      await expect(fs.stat(path.join(remote, "data.bin"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await fs.readFile(path.join(remote, "scripts/check.sh"), "utf8")).toBe(
        "#!/bin/sh\nprintf ready\n",
      );
      await expectProjectUnchanged();
      await resources!.cleanup();
      await expect(fs.stat(initializedRoot!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (initializedRoot) {
        await fs.rm(initializedRoot, { recursive: true, force: true });
      }
    }
  });

  it("rejects remote directory identities that collide when rounded to numbers", async () => {
    const { snapshot } = await createSource();
    const carrier = await createCarrier();
    prependResourceReceiver(`{
      const fs = require('node:fs');
      for (const method of ['lstatSync', 'statSync']) {
        const original = fs[method];
        fs[method] = (...args) => {
          const stat = original(...args);
          const ino = 9007199254740992n + (JSON.parse(process.argv[3]).operation === 'init' ? 0n : 1n);
          stat.ino = typeof stat.ino === 'bigint' ? ino : Number(ino);
          return stat;
        };
      }
    }`);
    let initializedRoot: string | undefined;
    try {
      await expect(
        transferSkillResources({
          snapshot,
          workspaceDir: carrier.workspace,
          generation: carrier.generation,
          assertCurrent: () => {},
          tunnel: {
            runWorkspaceCommand: async (command) => {
              const initializing = command.skillResources!.operation.operation === "init";
              const result = await carrier.runWorkspaceCommand(command);
              if (initializing) {
                initializedRoot = JSON.parse(result.stdout).root;
              }
              return result;
            },
          },
        }),
      ).rejects.toThrow("Skill resource transfer failed");
      expect(initializedRoot).toBeDefined();
      await expect(fs.readdir(initializedRoot!)).resolves.toEqual([".gitignore"]);
    } finally {
      if (initializedRoot) {
        await fs.rm(initializedRoot, { recursive: true, force: true });
      }
    }
  });
});
