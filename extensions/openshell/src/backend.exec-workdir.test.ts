// Openshell tests cover backend-owned exec workdir validation behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspace,
  type TempWorkspace,
} from "openclaw/plugin-sdk/temp-path";
import { createSandboxTestContext } from "openclaw/plugin-sdk/test-fixtures";
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

async function createOpenShellBackendFixture(params: {
  workspaceDir: string;
  scopeKey: string;
  command?: string;
}) {
  const factory = createOpenShellSandboxBackendFactory({
    pluginConfig: resolveOpenShellPluginConfig({
      command: params.command ?? "openshell",
      mode: "mirror",
    }),
  });
  return await factory({
    sessionKey: `${params.scopeKey}:turn`,
    scopeKey: params.scopeKey,
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.workspaceDir,
    cfg: createOpenShellBackendSandboxConfig(),
  });
}

describe("openshell backend exec workdir validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cliMocks.createOpenShellSshSession.mockResolvedValue({
      command: "ssh",
      configPath: "/tmp/openclaw-openshell-test-ssh-config",
      host: "openshell-test",
    });
    cliMocks.runOpenShellCli.mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });
    sdkMocks.prepareSshSandboxExec.mockImplementation(
      async (params: { session: { command: string; configPath: string; host: string } }) => ({
        argv: [
          params.session.command,
          "-F",
          params.session.configPath,
          params.session.host,
          "'/bin/sh' '/tmp/openclaw-synthetic-staging/run.sh'",
        ],
        cleanup: async () => {},
      }),
    );
    sdkMocks.runSshSandboxCommand.mockImplementation(async ({ remoteCommand }) => ({
      stdout: String(remoteCommand).includes("openclaw-validate-workdir")
        ? Buffer.from("/workspace\n")
        : Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      code: 0,
    }));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(tempWorkspaces.splice(0).map((workspace) => workspace.cleanup()));
  });

  it("reuses validation-time workspace preparation for the following exec", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fixture");
    vi.stubEnv("ANTHROPIC_API_KEY", "fixture");
    vi.stubEnv("LANG", "en_US.UTF-8");
    vi.stubEnv("NODE_ENV", "test");
    const workspace = await tempWorkspace({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-openshell-workspace-",
    });
    tempWorkspaces.push(workspace);
    const workspaceDir = workspace.dir;
    await fs.writeFile(path.join(workspaceDir, "seed.txt"), "seed", "utf8");
    for (const protectedDirectory of [".git", "hooks", "git-hooks"]) {
      const protectedPath = path.join(workspaceDir, protectedDirectory);
      await fs.mkdir(protectedPath, { recursive: true });
      await fs.writeFile(path.join(protectedPath, "private.txt"), "host-only", "utf8");
    }
    const backend = await createOpenShellBackendFixture({
      scopeKey: "agent:somalley_alice:dashboard-8",
      workspaceDir,
    });

    await expect(backend.validateWorkdir?.("/workspace")).resolves.toBe("/workspace");
    const execSpec = await backend.buildExecSpec({
      command: "pwd",
      workdir: "/workspace",
      env: {},
      usePty: false,
    });

    const uploadCalls = cliMocks.runOpenShellCli.mock.calls.filter(
      ([params]) => params.args[0] === "sandbox" && params.args[1] === "upload",
    );
    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0]?.[0]).toMatchObject({
      args: [
        "sandbox",
        "upload",
        "--no-git-ignore",
        backend.runtimeId,
        expect.stringMatching(/\/seed\.txt$/),
        "/sandbox/",
      ],
      cwd: workspaceDir,
    });
    await backend.finalizeExec?.({
      status: "completed",
      exitCode: 0,
      timedOut: false,
      token: execSpec.finalizeToken,
    });
    const nestedFile = path.join(workspaceDir, "nested", "note.txt");
    const bridge = backend.createFsBridge?.({
      sandbox: createSandboxTestContext({
        overrides: {
          backendId: "openshell",
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
          containerWorkdir: backend.workdir,
          backend,
        },
      }),
    });
    if (!bridge) {
      throw new Error("Expected OpenShell mirror filesystem bridge");
    }
    await bridge.writeFile({ filePath: "nested/note.txt", data: "nested", mkdir: true });
    expect(cliMocks.runOpenShellCli).toHaveBeenLastCalledWith({
      context: expect.objectContaining({ sandboxName: backend.runtimeId }),
      args: [
        "sandbox",
        "upload",
        "--no-git-ignore",
        backend.runtimeId,
        nestedFile,
        "/sandbox/nested/note.txt",
      ],
      cwd: workspaceDir,
    });
    expect(backend.runtimeId).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
    expect(backend.runtimeId).toMatch(/^oc-[a-f0-9]{16}$/u);
    expect(backend.runtimeId).toHaveLength(19);
    expect(execSpec.env.OPENAI_API_KEY).toBeUndefined();
    expect(execSpec.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(execSpec.env.LANG).toBe("en_US.UTF-8");
    expect(execSpec.env.NODE_ENV).toBe("test");
    expect(execSpec.argv).toContain("openshell-test");
  });

  it("does not reuse validation-time workspace preparation after discard", async () => {
    const workspace = await tempWorkspace({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-openshell-workspace-",
    });
    tempWorkspaces.push(workspace);
    const workspaceDir = workspace.dir;
    await fs.writeFile(path.join(workspaceDir, "seed.txt"), "seed", "utf8");
    const backend = await createOpenShellBackendFixture({
      scopeKey: "agent:main",
      workspaceDir,
    });

    await expect(backend.validateWorkdir?.("/workspace")).resolves.toBe("/workspace");
    backend.discardPreparedWorkdir?.("/workspace");
    const execSpec = await backend.buildExecSpec({
      command: "pwd",
      workdir: "/workspace",
      env: {},
      usePty: false,
    });

    const uploadCalls = cliMocks.runOpenShellCli.mock.calls.filter(
      ([params]) => params.args[0] === "sandbox" && params.args[1] === "upload",
    );
    expect(uploadCalls).toHaveLength(2);
    await backend.finalizeExec?.({
      status: "completed",
      exitCode: 0,
      timedOut: false,
      token: execSpec.finalizeToken,
    });
  });

  it.each([
    {
      label: "legacy trailing exec",
      help: "Usage: openshell sandbox create [OPTIONS]\n      --no-tty\n",
      expectedEnding: ["--", "true"],
    },
    {
      label: "persistent canonical main",
      help: "Usage: openshell sandbox create [OPTIONS]\n      --detach  Start without attaching\n",
      expectedEnding: ["--detach", "--", "sleep", "infinity"],
    },
  ])("creates compatible persistent sandboxes for $label CLIs", async (scenario) => {
    const workspace = await tempWorkspace({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-openshell-create-",
    });
    tempWorkspaces.push(workspace);
    cliMocks.runOpenShellCli.mockImplementation(async ({ args }: { args: string[] }) => {
      if (args[1] === "get") {
        return { code: 1, stdout: "", stderr: "sandbox not found" };
      }
      if (args[1] === "create" && args[2] === "--help") {
        return { code: 0, stdout: scenario.help, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    for (const scopeKey of ["agent:create:first", "agent:create:second"]) {
      const backend = await createOpenShellBackendFixture({
        workspaceDir: workspace.dir,
        scopeKey,
        command: `openshell-${scenario.label.replaceAll(" ", "-")}`,
      });
      const execSpec = await backend.buildExecSpec({ command: "pwd", env: {}, usePty: false });
      await backend.finalizeExec?.({
        status: "completed",
        exitCode: 0,
        timedOut: false,
        token: execSpec.finalizeToken,
      });
    }

    const helpCalls = cliMocks.runOpenShellCli.mock.calls.filter(
      ([params]) => params.args[1] === "create" && params.args[2] === "--help",
    );
    expect(helpCalls).toHaveLength(1);
    const createCalls = cliMocks.runOpenShellCli.mock.calls.filter(
      ([params]) => params.args[1] === "create" && params.args[2] !== "--help",
    );
    expect(createCalls).toHaveLength(2);
    for (const [params] of createCalls) {
      expect(params.args.slice(-scenario.expectedEnding.length)).toEqual(scenario.expectedEnding);
    }
  });

  it.each([
    { label: "a host workspace", sharedHost: true, sharedRuntime: false },
    { label: "a remote runtime", sharedHost: false, sharedRuntime: true },
  ])("holds $label until command execution and publication finish", async (scenario) => {
    const workspaces = await Promise.all(
      ["first", "second"].map(async (label) =>
        tempWorkspace({
          rootDir: resolvePreferredOpenClawTmpDir(),
          prefix: `openclaw-openshell-${label}-`,
        }),
      ),
    );
    tempWorkspaces.push(...workspaces);
    const firstWorkspace = expectDefined(workspaces[0], "first OpenShell workspace");
    const secondWorkspace = expectDefined(workspaces[1], "second OpenShell workspace");
    const first = await createOpenShellBackendFixture({
      workspaceDir: firstWorkspace.dir,
      scopeKey: "agent:workspace:first",
    });
    const second = await createOpenShellBackendFixture({
      workspaceDir: (scenario.sharedHost ? firstWorkspace : secondWorkspace).dir,
      scopeKey: scenario.sharedRuntime ? "agent:workspace:first" : "agent:workspace:second",
    });

    const firstExec = await first.buildExecSpec({ command: "first", env: {}, usePty: false });
    const secondPreparation = second.buildExecSpec({ command: "second", env: {}, usePty: false });

    try {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(cliMocks.runOpenShellCli.mock.calls.map(([params]) => params.args[1])).toEqual([
        "get",
      ]);
    } finally {
      await first.finalizeExec?.({
        status: "completed",
        exitCode: 0,
        timedOut: false,
        token: firstExec.finalizeToken,
      });
    }

    const secondExec = await secondPreparation;
    expect(cliMocks.runOpenShellCli.mock.calls.map(([params]) => params.args[1])).toEqual([
      "get",
      "download",
      "get",
    ]);
    await second.finalizeExec?.({
      status: "completed",
      exitCode: 0,
      timedOut: false,
      token: secondExec.finalizeToken,
    });
  });

  it("keeps operations against different workspaces parallel", async () => {
    const workspaces = await Promise.all(
      ["first", "second"].map(async (label) =>
        tempWorkspace({
          rootDir: resolvePreferredOpenClawTmpDir(),
          prefix: `openclaw-openshell-${label}-`,
        }),
      ),
    );
    tempWorkspaces.push(...workspaces);
    const backends = await Promise.all(
      workspaces.map(async (workspace, index) =>
        createOpenShellBackendFixture({
          workspaceDir: workspace.dir,
          scopeKey: `agent:workspace:${index}`,
        }),
      ),
    );
    const first = expectDefined(backends[0], "first OpenShell backend");
    const second = expectDefined(backends[1], "second OpenShell backend");
    const firstExec = await first.buildExecSpec({ command: "first", env: {}, usePty: false });
    const secondPreparation = second.buildExecSpec({ command: "second", env: {}, usePty: false });
    let secondExec: Awaited<typeof secondPreparation> | undefined;
    try {
      await vi.waitFor(() => {
        const startedRuntimeIds = cliMocks.runOpenShellCli.mock.calls
          .filter(([params]) => params.args[1] === "get")
          .map(([params]) => params.args[2]);
        expect(startedRuntimeIds).toEqual([first.runtimeId, second.runtimeId]);
      });
      secondExec = await secondPreparation;
    } finally {
      await first.finalizeExec?.({
        status: "completed",
        exitCode: 0,
        timedOut: false,
        token: firstExec.finalizeToken,
      });
      secondExec ??= await secondPreparation;
      await second.finalizeExec?.({
        status: "completed",
        exitCode: 0,
        timedOut: false,
        token: secondExec.finalizeToken,
      });
    }
  });
});
