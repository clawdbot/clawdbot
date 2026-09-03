// Covers the remote-mode seed obligation across a gateway restart: adopting an
// existing sandbox must probe the managed roots instead of trusting process
// memory, and must never re-seed roots that already hold content.
import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { SandboxBackendHandle } from "openclaw/plugin-sdk/sandbox";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspace,
  type TempWorkspace,
} from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenShellSandboxBackendFactory } from "./backend.js";
import { resolveOpenShellPluginConfig } from "./config.js";
import { createOpenShellBackendSandboxConfig } from "./openshell.test-support.js";

const sdkMocks = vi.hoisted(() => ({
  runSshSandboxCommand: vi.fn(),
  disposeSshSandboxSession: vi.fn(),
  prepareSshSandboxExec: vi.fn(),
}));

const cliMocks = vi.hoisted(() => ({
  runOpenShellCli: vi.fn(),
  createOpenShellSshSession: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/sandbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/sandbox")>();
  return {
    ...actual,
    runSshSandboxCommand: sdkMocks.runSshSandboxCommand,
    disposeSshSandboxSession: sdkMocks.disposeSshSandboxSession,
    prepareSshSandboxExec: sdkMocks.prepareSshSandboxExec,
  };
});

vi.mock("./cli.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cli.js")>();
  return {
    ...actual,
    runOpenShellCli: cliMocks.runOpenShellCli,
    createOpenShellSshSession: cliMocks.createOpenShellSshSession,
  };
});

const tempWorkspaces: TempWorkspace[] = [];

async function createAdoptedRemoteBackend(params: {
  probeStdout: string;
  skillsWorkspaceDir?: string;
}) {
  const workspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-openshell-remote-seed-",
  });
  tempWorkspaces.push(workspace);
  await fs.writeFile(path.join(workspace.dir, "seed.txt"), "seed", "utf8");
  cliMocks.createOpenShellSshSession.mockResolvedValue({
    command: "ssh",
    configPath: "/tmp/openclaw-openshell-test-ssh-config",
    host: "openshell-test",
  });
  // `sandbox get` succeeds: the sandbox was created by a previous gateway
  // process that died before the first exec could run the one-time seed.
  cliMocks.runOpenShellCli.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  sdkMocks.prepareSshSandboxExec.mockResolvedValue({
    argv: ["ssh", "openshell-test"],
    cleanup: vi.fn(),
  });
  sdkMocks.runSshSandboxCommand.mockImplementation(async ({ remoteCommand }) => ({
    stdout: String(remoteCommand).includes("ls -A")
      ? Buffer.from(params.probeStdout)
      : Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    code: 0,
  }));
  const backendFactory = createOpenShellSandboxBackendFactory({
    pluginConfig: resolveOpenShellPluginConfig({
      command: "openshell",
      mode: "remote",
    }),
  });
  return await backendFactory({
    sessionKey: "agent:main:turn",
    scopeKey: "agent:main",
    workspaceDir: workspace.dir,
    agentWorkspaceDir: workspace.dir,
    skillsWorkspaceDir: params.skillsWorkspaceDir,
    cfg: createOpenShellBackendSandboxConfig(),
  });
}

async function finalize(backend: SandboxBackendHandle, token: unknown) {
  await backend.finalizeExec?.({ status: "completed", exitCode: 0, timedOut: false, token });
}

function seedUploadCalls() {
  return cliMocks.runOpenShellCli.mock.calls.filter(
    ([params]) => params.args[0] === "sandbox" && params.args[1] === "upload",
  );
}

describe("openshell remote-mode seed across gateway restart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await Promise.all(tempWorkspaces.splice(0).map((workspace) => workspace.cleanup()));
  });

  it("seeds an adopted sandbox whose managed roots are empty", async () => {
    const backend = await createAdoptedRemoteBackend({ probeStdout: "0\n" });

    const execSpec = await backend.buildExecSpec({ command: "pwd", env: {}, usePty: false });

    try {
      const uploads = seedUploadCalls();
      expect(uploads.length).toBeGreaterThan(0);
      expect(uploads[0]?.[0]).toMatchObject({
        args: expect.arrayContaining([expect.stringMatching(/\/seed\.txt$/), "/sandbox/"]),
      });
    } finally {
      await finalize(backend, execSpec.finalizeToken);
    }
  });

  it("never re-seeds when a managed root already holds content", async () => {
    const backend = await createAdoptedRemoteBackend({ probeStdout: "1\n" });

    const execSpec = await backend.buildExecSpec({ command: "pwd", env: {}, usePty: false });

    try {
      expect(seedUploadCalls()).toHaveLength(0);
      const wipeCalls = sdkMocks.runSshSandboxCommand.mock.calls.filter(([params]) =>
        String(params.remoteCommand).includes("rm -rf"),
      );
      expect(wipeCalls).toHaveLength(0);
    } finally {
      await finalize(backend, execSpec.finalizeToken);
    }
  });

  it.each(["same handle", "another handle"])(
    "starts remote operations on %s while an earlier command is still running",
    async (handleKind) => {
      const first = await createAdoptedRemoteBackend({ probeStdout: "1\n" });
      const second =
        handleKind === "same handle"
          ? first
          : await createAdoptedRemoteBackend({ probeStdout: "1\n" });
      const firstExec = await first.buildExecSpec({
        command: "wait-for-file",
        env: {},
        usePty: false,
      });
      const secondPreparation = second.buildExecSpec({
        command: "write-file",
        env: {},
        usePty: false,
      });
      try {
        await secondPreparation;
        expect(seedUploadCalls()).toHaveLength(0);
      } finally {
        try {
          await finalize(first, firstExec.finalizeToken);
        } finally {
          const prepared = await secondPreparation;
          await finalize(second, prepared.finalizeToken);
        }
      }
    },
  );

  it("refreshes materialized skills once per handle, not between remote operations", async () => {
    const skillsWorkspace = await tempWorkspace({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-openshell-remote-skills-",
    });
    tempWorkspaces.push(skillsWorkspace);
    await fs.mkdir(path.join(skillsWorkspace.dir, "skills", "demo"), { recursive: true });
    await fs.writeFile(path.join(skillsWorkspace.dir, "skills", "demo", "SKILL.md"), "# Demo\n");
    const backend = await createAdoptedRemoteBackend({
      probeStdout: "1\n",
      skillsWorkspaceDir: skillsWorkspace.dir,
    });
    const firstExec = await backend.buildExecSpec({ command: "first", env: {}, usePty: false });
    await finalize(backend, firstExec.finalizeToken);
    const initialUploads = seedUploadCalls().length;
    expect(initialUploads).toBeGreaterThan(0);
    const initialClears = sdkMocks.runSshSandboxCommand.mock.calls.filter(([params]) =>
      String(params.remoteCommand).includes("rm -rf"),
    ).length;
    expect(initialClears).toBeGreaterThan(0);
    await backend.runShellCommand?.({ script: "printf file-operation", args: [] });
    const secondExec = await backend.buildExecSpec({ command: "second", env: {}, usePty: false });
    try {
      expect(seedUploadCalls()).toHaveLength(initialUploads);
      expect(
        sdkMocks.runSshSandboxCommand.mock.calls.filter(([params]) =>
          String(params.remoteCommand).includes("rm -rf"),
        ),
      ).toHaveLength(initialClears);
    } finally {
      await finalize(backend, secondExec.finalizeToken);
    }
  });

  it("serializes initial seed publication across handles without serializing later commands", async () => {
    const first = await createAdoptedRemoteBackend({ probeStdout: "0\n" });
    const second = await createAdoptedRemoteBackend({ probeStdout: "1\n" });
    const seedStarted = createDeferred<void>();
    const releaseSeed = createDeferred<void>();
    let seeded = false;
    sdkMocks.runSshSandboxCommand.mockImplementation(async ({ remoteCommand }) => ({
      stdout: String(remoteCommand).includes("ls -A")
        ? Buffer.from(seeded ? "1\n" : "0\n")
        : Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      code: 0,
    }));
    cliMocks.runOpenShellCli.mockImplementation(async ({ args }: { args: string[] }) => {
      if (args[1] === "upload") {
        seedStarted.resolve();
        await releaseSeed.promise;
        seeded = true;
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const firstPreparation = first.buildExecSpec({ command: "first", env: {}, usePty: false });
    let secondPreparation: typeof firstPreparation | undefined;
    let preparationsSettled: Promise<PromiseSettledResult<Awaited<typeof firstPreparation>>[]> =
      Promise.allSettled([firstPreparation]);
    try {
      await Promise.race([seedStarted.promise, firstPreparation]);
      let secondStarted = false;
      secondPreparation = second
        .buildExecSpec({ command: "second", env: {}, usePty: false })
        .then((prepared) => {
          secondStarted = true;
          return prepared;
        });
      preparationsSettled = Promise.allSettled([firstPreparation, secondPreparation]);
      try {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(
          cliMocks.runOpenShellCli.mock.calls.filter(([params]) => params.args[1] === "get"),
        ).toHaveLength(1);
        expect(secondStarted).toBe(false);
      } finally {
        releaseSeed.resolve();
      }
      await firstPreparation;
      await secondPreparation;
      expect(seedUploadCalls()).toHaveLength(1);
    } finally {
      // An assertion or preparation failure must not leave work using a deleted workspace.
      releaseSeed.resolve();
      try {
        const firstExec = await firstPreparation;
        await finalize(first, firstExec.finalizeToken);
      } finally {
        await preparationsSettled;
        const secondExec = await secondPreparation;
        if (secondExec) {
          await finalize(second, secondExec.finalizeToken);
        }
      }
    }
  });
});
