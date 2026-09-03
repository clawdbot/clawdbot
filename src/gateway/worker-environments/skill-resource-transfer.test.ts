import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { loadWorkspaceSkills } from "../../skills/loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../../skills/loading/workspace-skill-prompt.js";
import { applySkillEnvOverridesFromSnapshot } from "../../skills/runtime/env-overrides.js";
import { transferSkillResources } from "./skill-resource-transfer.js";
import {
  createNodeCarrier,
  NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES,
} from "./skill-resource-transfer.test-support.js";
import type { WorkerWorkspaceTunnelHandle } from "./tunnel-contract.js";
import { WORKER_ATTACHMENT_DIRECTORY_PREFIX } from "./workspace-path-exclusions.js";
import { readActualWorkspaceManifest } from "./workspace-reconcile.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const tunnel: Pick<WorkerWorkspaceTunnelHandle, "runWorkspaceCommand"> = {
  runWorkspaceCommand: async (command) => {
    command.assertCurrent?.();
    return new Promise((resolve, reject) => {
      const child = spawn(command.argv[0]!, command.argv.slice(1), {
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

async function createCarrier(kind = "ssh") {
  return kind === "node"
    ? await createNodeCarrier(temps.make("skill-resource-node-"))
    : { ...tunnel, workspace: await fs.realpath(temps.make("skill-resource-ssh-")) };
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
  const transport = await createCarrier(carrier);
  let initializedRoot: string | undefined;
  let injected = false;
  try {
    await expect(
      transferSkillResources({
        snapshot,
        remoteWorkspaceDir: transport.workspace,
        assertCurrent: () => {},
        tunnel: {
          runWorkspaceCommand: async (command) => {
            const operation = JSON.parse(command.input!);
            let dispatched = command;
            if (operation.op === "write" && !injected) {
              dispatched = { ...command, input: mutate(command.input!) };
              injected = true;
            }
            const result = await transport.runWorkspaceCommand(dispatched);
            if (operation.op === "init") {
              initializedRoot = path.join(transport.workspace, operation.directory);
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
  it("rejects a valid-shaped init reply advertising a different allocation", async () => {
    const { snapshot } = await createSource();
    const carrier = await createNodeCarrier(temps.make("skill-resource-node-"));
    const outside = await fs.realpath(temps.make("skill-resource-wrong-mount-"));
    let allocated: string | undefined;
    let writes = 0;
    try {
      const request = {
        snapshot,
        remoteWorkspaceDir: carrier.workspace,
        assertCurrent: () => {},
        tunnel: {
          runWorkspaceCommand: async (
            command: Parameters<WorkerWorkspaceTunnelHandle["runWorkspaceCommand"]>[0],
          ) => {
            const operation = JSON.parse(command.input!);
            writes += Number(operation.op === "write");
            const result = await carrier.runWorkspaceCommand(command);
            if (operation.op === "init") {
              allocated = path.join(carrier.workspace, operation.directory);
              return {
                ...result,
                stdout: JSON.stringify({
                  id: randomUUID().replaceAll("-", ""),
                  identity: result.stdout,
                  root: outside,
                }),
              };
            }
            return result;
          },
        },
      };
      await expect(transferSkillResources(request)).rejects.toThrow("Invalid skill resource");
      expect(writes).toBe(0);
      expect(await fs.readdir(outside)).toEqual([]);
    } finally {
      if (allocated) {
        await fs.rm(allocated, { recursive: true, force: true });
      }
    }
  });

  it.each(["malformed", "transport lost", "retired", "crashed"])(
    "retains uncertain init with its generation and reclaims it after restart and exclusion (%s)",
    async (failure) => {
      const { snapshot } = await createSource();
      const carrier = await createNodeCarrier(temps.make("skill-resource-node-"));
      let allocated: string | undefined;
      let current = true;
      try {
        const request = {
          snapshot,
          remoteWorkspaceDir: carrier.workspace,
          assertCurrent: () => {
            if (!current) {
              throw new Error("placement retired");
            }
          },
          tunnel: {
            runWorkspaceCommand: async (
              command: Parameters<WorkerWorkspaceTunnelHandle["runWorkspaceCommand"]>[0],
            ) => {
              const operation = JSON.parse(command.input!);
              const dispatched =
                failure === "crashed" && operation.op === "init"
                  ? {
                      ...command,
                      argv: [
                        ...command.argv.slice(0, 2),
                        "process.stdout.write=()=>process.exit(9);" + command.argv[2],
                        ...command.argv.slice(3),
                      ],
                    }
                  : command;
              const result = await carrier.runWorkspaceCommand(dispatched);
              if (operation.op === "init") {
                allocated = path.join(carrier.workspace, operation.directory);
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
        await restarted.applyRetainSnapshot({ ...retention, sequence: 2, retain: [] }, () => []);
        await expect(fs.stat(allocated!)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        if (allocated) {
          await fs.rm(allocated, { recursive: true, force: true });
        }
      }
    },
  );

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
    let failCleanup = true;
    const requestSizes: number[] = [];
    try {
      const resources = await transferSkillResources({
        snapshot,
        remoteWorkspaceDir: carrier.workspace,
        assertCurrent: () => {},
        tunnel: {
          runWorkspaceCommand: async (command) => {
            requestSizes.push(Buffer.byteLength(command.input!));
            let dispatched = command;
            if (JSON.parse(command.input!).op === "cleanup" && failCleanup) {
              failCleanup = false;
              // Fail after deleting one payload, as when another resource is still open.
              const partialCleanup = `{
                const fs = require('node:fs'), remove = fs.rmSync;
                fs.rmSync = (entry, options) => {
                  if (entry === '0') {
                    remove('0/data.bin');
                    throw Error('resource still open');
                  }
                  return remove(entry, options);
                };
              }`;
              dispatched = {
                ...command,
                argv: [
                  ...command.argv.slice(0, 2),
                  partialCleanup + command.argv[2],
                  ...command.argv.slice(3),
                ],
              };
            }
            const result = await carrier.runWorkspaceCommand(dispatched);
            initializedRoot ??= path.join(carrier.workspace, JSON.parse(command.input!).directory);
            return result;
          },
        },
      });
      const remote = resources!.mounts[0]!.containerPath;
      expect(remote.startsWith(carrier.workspace)).toBe(true);
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
      await expect(resources!.cleanup()).rejects.toThrow("Skill resource cleanup failed");
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
    let initializedRoot: string | undefined;
    try {
      await expect(
        transferSkillResources({
          snapshot,
          remoteWorkspaceDir: carrier.workspace,
          assertCurrent: () => {},
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
                argv: [
                  ...command.argv.slice(0, 2),
                  identityShim + command.argv[2],
                  ...command.argv.slice(3),
                ],
              });
              if (initializing) {
                initializedRoot = path.join(
                  carrier.workspace,
                  JSON.parse(command.input!).directory,
                );
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

  it.each(
    ["ssh", "node"].flatMap((carrier) =>
      ["complete", "cancelled", "retired"].map((outcome) => ({ carrier, outcome })),
    ),
  )(
    "preserves private resources and cleans up only its current owner ($carrier, $outcome)",
    async ({ carrier, outcome }) => {
      const { workspace, filePath, binary, snapshot } = await createSource();
      const controller = new AbortController();
      const transport = await createCarrier(carrier);
      let current = true;
      const resources = await transferSkillResources({
        tunnel: transport,
        remoteWorkspaceDir: transport.workspace,
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
        await fs.rm(path.dirname(remote), { recursive: true, force: true });
      }
    },
  );

  it.each([
    { name: "forged directory", patch: { directory: "../outside" } },
    {
      name: "unallocated directory",
      patch: { directory: WORKER_ATTACHMENT_DIRECTORY_PREFIX + randomUUID() },
    },
    { name: "wrong inode", patch: { identity: "0:0" } },
    { name: "absolute root input", patch: { root: "/tmp" } },
    { name: "digest mismatch", patch: { hash: "0".repeat(64) } },
    { name: "Windows alternate data stream", patch: { name: "0/data.bin:stream" } },
    { name: "Windows trailing-space parent", patch: { name: "0/.. /marker" } },
    { name: "Windows reserved device", patch: { name: "0/NUL" } },
    { name: "Windows console input", patch: { name: "0/CONIN$" } },
    { name: "Windows console output", patch: { name: "0/CONOUT$" } },
    { name: "Windows superscript COM device", patch: { name: "0/COM¹.txt" } },
    { name: "Windows superscript LPT device", patch: { name: "0/LPT³" } },
  ])("rejects $name and cleans only the allocated resources", async ({ patch }) => {
    await expectRejectedResourceRequest("node", (input) =>
      JSON.stringify({ ...JSON.parse(input), ...patch }),
    );
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

      const carrier = await createCarrier();
      const resources = await transferSkillResources({
        tunnel: carrier,
        remoteWorkspaceDir: carrier.workspace,
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

      const carrier = await createCarrier();
      const resources = await transferSkillResources({
        tunnel: carrier,
        remoteWorkspaceDir: carrier.workspace,
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

      const carrier = await createCarrier();
      const resources = await transferSkillResources({
        tunnel: carrier,
        remoteWorkspaceDir: carrier.workspace,
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
      const transport = await createCarrier(carrier);
      const controller = new AbortController();
      let initializedRoot: string | undefined;
      try {
        await expect(
          transferSkillResources({
            snapshot,
            remoteWorkspaceDir: transport.workspace,
            signal: controller.signal,
            assertCurrent: () => {},
            tunnel: {
              runWorkspaceCommand: async (command) => {
                const result = await transport.runWorkspaceCommand(command);
                if (!initializedRoot) {
                  initializedRoot = path.join(
                    transport.workspace,
                    JSON.parse(command.input!).directory,
                  );
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
