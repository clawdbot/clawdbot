// Openshell tests cover backend-owned exec workdir validation behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { SandboxBackendHandle } from "openclaw/plugin-sdk/sandbox";
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
const createdBackends: SandboxBackendHandle[] = [];

async function createOpenShellBackendFixture(params: {
  workspaceDir: string;
  scopeKey: string;
  command?: string;
  agentWorkspaceDir?: string;
  skillsWorkspaceDir?: string;
  workspaceAccess?: "rw" | "ro" | "none";
  remoteWorkspaceDir?: string;
  remoteAgentWorkspaceDir?: string;
}) {
  const factory = createOpenShellSandboxBackendFactory({
    pluginConfig: resolveOpenShellPluginConfig({
      command: params.command ?? "openshell",
      mode: "mirror",
      remoteWorkspaceDir: params.remoteWorkspaceDir,
      remoteAgentWorkspaceDir: params.remoteAgentWorkspaceDir,
    }),
  });
  const backend = await factory({
    sessionKey: `${params.scopeKey}:turn`,
    scopeKey: params.scopeKey,
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir ?? params.workspaceDir,
    skillsWorkspaceDir: params.skillsWorkspaceDir,
    cfg: {
      ...createOpenShellBackendSandboxConfig(),
      workspaceAccess: params.workspaceAccess ?? "rw",
    },
  });
  createdBackends.push(backend);
  return backend;
}

async function createWorkspace(prefix = "workspace") {
  const workspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: `openclaw-openshell-${prefix}-`,
  });
  tempWorkspaces.push(workspace);
  return await fs.realpath(workspace.dir);
}

async function finalize(backend: SandboxBackendHandle, token: unknown) {
  await backend.finalizeExec?.({ status: "completed", exitCode: 0, timedOut: false, token });
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
        ? Buffer.from("/sandbox\n")
        : Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      code: 0,
    }));
  });

  afterEach(async () => {
    for (const backend of createdBackends.splice(0)) {
      backend.discardPreparedWorkdir?.("/sandbox");
    }
    vi.unstubAllEnvs();
    await Promise.all(tempWorkspaces.splice(0).map((workspace) => workspace.cleanup()));
  });

  it("validates locally and uploads the workspace once when exec begins", async () => {
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

    await expect(backend.validateWorkdir?.("/sandbox")).resolves.toBe("/sandbox");
    expect(cliMocks.runOpenShellCli).not.toHaveBeenCalled();
    expect(cliMocks.createOpenShellSshSession).not.toHaveBeenCalled();
    const execSpec = await backend.buildExecSpec({
      command: "pwd",
      workdir: "/sandbox",
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

  it("does not retain an abandoned validation lease before a file write or exec", async () => {
    const workspaceDir = await createWorkspace();
    const backend = await createOpenShellBackendFixture({
      scopeKey: "agent:abandoned-validation",
      workspaceDir,
    });
    await expect(backend.validateWorkdir?.("/sandbox")).resolves.toBe("/sandbox");
    const bridge = expectDefined(
      backend.createFsBridge?.({
        sandbox: createSandboxTestContext({
          overrides: {
            backendId: "openshell",
            workspaceDir,
            agentWorkspaceDir: workspaceDir,
            containerWorkdir: backend.workdir,
            backend,
          },
        }),
      }),
      "OpenShell mirror bridge",
    );
    let wrote = false;
    const write = bridge.writeFile({ filePath: "note.txt", data: "after validation" }).then(() => {
      wrote = true;
    });
    try {
      await vi.waitFor(() => expect(wrote).toBe(true));
    } finally {
      backend.discardPreparedWorkdir?.("/sandbox");
      await write;
    }
    await expect(fs.readFile(path.join(workspaceDir, "note.txt"), "utf8")).resolves.toBe(
      "after validation",
    );
    const execSpec = await backend.buildExecSpec({
      command: "pwd",
      workdir: "/sandbox",
      env: {},
      usePty: false,
    });
    await finalize(backend, execSpec.finalizeToken);
  });

  it("completes concurrent validations without starting remote work or retaining a lease", async () => {
    const workspaceDir = await createWorkspace();
    const backend = await createOpenShellBackendFixture({
      workspaceDir,
      scopeKey: "agent:parallel-validation",
    });
    const completed: Array<string | null | undefined> = [];
    let cleaningUp = false;
    const validations = [0, 1].map(async () => {
      const result = await backend.validateWorkdir?.("/sandbox");
      completed.push(result);
      if (cleaningUp) {
        backend.discardPreparedWorkdir?.("/sandbox");
      }
    });
    try {
      await vi.waitFor(() => expect(completed).toEqual(["/sandbox", "/sandbox"]));
      expect(cliMocks.runOpenShellCli).not.toHaveBeenCalled();
      expect(cliMocks.createOpenShellSshSession).not.toHaveBeenCalled();
    } finally {
      cleaningUp = true;
      backend.discardPreparedWorkdir?.("/sandbox");
      await Promise.all(validations);
    }
  });

  it.each([
    { name: "filesystem root", target: "/", expected: null },
    { name: "outside managed roots", target: "/outside", expected: null },
    { name: "ordinary directory", target: "/sandbox/nested", expected: "/sandbox/nested" },
    { name: "missing directory", target: "/sandbox/missing", expected: null },
    { name: "regular file", target: "/sandbox/file.txt", expected: null },
    ...[".git", "hooks", "git-hooks"].map((name) => ({
      name,
      target: `/sandbox/${name}/nested`,
      expected: null,
    })),
    { name: "mid-path symlink", target: "/sandbox/link/nested", expected: null },
    {
      name: "agent read-only directory",
      target: "/agent/nested",
      expected: "/agent/nested",
      access: "ro" as const,
    },
    {
      name: "agent disabled mount",
      target: "/agent/nested",
      expected: null,
      access: "none" as const,
    },
    {
      name: "generated skills ancestor",
      target: "/sandbox/.openclaw",
      expected: "/sandbox/.openclaw",
    },
    {
      name: "materialized skills root",
      target: "/sandbox/.openclaw/sandbox-skills",
      expected: "/sandbox/.openclaw/sandbox-skills",
    },
    {
      name: "materialized skills child",
      target: "/sandbox/.openclaw/sandbox-skills/skills/demo",
      expected: "/sandbox/.openclaw/sandbox-skills/skills/demo",
    },
    {
      name: "missing materialized child",
      target: "/sandbox/.openclaw/sandbox-skills/skills/missing",
      expected: null,
    },
    {
      name: "symlinked materialized source",
      target: "/sandbox/.openclaw/sandbox-skills/nested",
      expected: null,
      sourceLink: true,
    },
  ])("validates the uploaded host directory for $name", async (scenario) => {
    const workspaceDir = await createWorkspace();
    const agentWorkspaceDir = await createWorkspace("agent");
    const skillsWorkspaceDir = await createWorkspace("skills");
    for (const root of [workspaceDir, agentWorkspaceDir]) {
      await fs.mkdir(path.join(root, "nested"));
    }
    await fs.writeFile(path.join(workspaceDir, "file.txt"), "not a directory");
    for (const excluded of [".git", "hooks", "git-hooks"]) {
      await fs.mkdir(path.join(workspaceDir, excluded, "nested"), { recursive: true });
    }
    await fs.symlink(workspaceDir, path.join(workspaceDir, "link"), "junction");
    await fs.mkdir(path.join(skillsWorkspaceDir, "skills", "demo"), { recursive: true });
    if (scenario.sourceLink) {
      await fs.rm(skillsWorkspaceDir, { recursive: true });
      await fs.symlink(workspaceDir, skillsWorkspaceDir, "junction");
    }
    const backend = await createOpenShellBackendFixture({
      workspaceDir,
      agentWorkspaceDir,
      skillsWorkspaceDir,
      scopeKey: `agent:validation:${scenario.name}`,
      workspaceAccess: scenario.access,
    });
    await expect(backend.validateWorkdir?.(scenario.target)).resolves.toBe(scenario.expected);
    expect(cliMocks.runOpenShellCli).not.toHaveBeenCalled();
    expect(cliMocks.createOpenShellSshSession).not.toHaveBeenCalled();
  });

  it.each([
    { workspace: "/sandbox", agent: "/sandbox", target: "/sandbox/agent-only", exists: true },
    {
      workspace: "/sandbox/primary",
      agent: "/sandbox",
      target: "/sandbox/primary/host-only",
      exists: false,
    },
    {
      workspace: "/sandbox",
      agent: "/sandbox/nested/agent",
      target: "/sandbox/nested",
      exists: true,
    },
  ])("resolves overlapping uploads in publication order: $target", async (scenario) => {
    const workspaceDir = await createWorkspace();
    const agentWorkspaceDir = await createWorkspace("agent");
    await fs.mkdir(path.join(workspaceDir, "host-only"));
    await fs.mkdir(path.join(agentWorkspaceDir, "agent-only"));
    const backend = await createOpenShellBackendFixture({
      workspaceDir,
      agentWorkspaceDir,
      scopeKey: `agent:overlap:${scenario.target}`,
      remoteWorkspaceDir: scenario.workspace,
      remoteAgentWorkspaceDir: scenario.agent,
    });
    await expect(backend.validateWorkdir?.(scenario.target)).resolves.toBe(
      scenario.exists ? scenario.target : null,
    );
  });

  it("rejects an aborted file write after waiting for mirror publication", async () => {
    const workspaceDir = await createWorkspace();
    const backend = await createOpenShellBackendFixture({
      workspaceDir,
      scopeKey: "agent:aborted-write",
    });
    const bridge = expectDefined(
      backend.createFsBridge?.({
        sandbox: createSandboxTestContext({
          overrides: {
            workspaceDir,
            agentWorkspaceDir: workspaceDir,
            containerWorkdir: backend.workdir,
            backend,
          },
        }),
      }),
      "mirror bridge",
    );
    const exec = await backend.buildExecSpec({ command: "true", env: {}, usePty: false });
    const controller = new AbortController();
    const write = bridge.writeFile({
      filePath: "cancelled.txt",
      data: "cancelled",
      signal: controller.signal,
    });
    const rejected = expect(write).rejects.toThrow("cancelled while queued");
    controller.abort(new Error("cancelled while queued"));
    await finalize(backend, exec.finalizeToken);
    await rejected;
    await expect(fs.stat(path.join(workspaceDir, "cancelled.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await bridge.writeFile({ filePath: "next.txt", data: "next" });
    await expect(fs.readFile(path.join(workspaceDir, "next.txt"), "utf8")).resolves.toBe("next");
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

  it.each(["exec preparation", "mirror publication", "SSH cleanup"])(
    "releases workspace ownership after failed %s",
    async (failure) => {
      const workspaceDir = await createWorkspace("failure");
      const scopeKey = `agent:failed:${failure}`;
      const first = await createOpenShellBackendFixture({ workspaceDir, scopeKey });
      const second = await createOpenShellBackendFixture({ workspaceDir, scopeKey });
      if (failure === "exec preparation") {
        sdkMocks.prepareSshSandboxExec.mockRejectedValueOnce(new Error("prepare failed"));
        await expect(
          first.buildExecSpec({ command: "first", env: {}, usePty: false }),
        ).rejects.toThrow("prepare failed");
      } else {
        if (failure === "SSH cleanup") {
          sdkMocks.prepareSshSandboxExec.mockResolvedValueOnce({
            argv: ["ssh", "openshell-test"],
            cleanup: async () => {
              throw new Error("cleanup failed");
            },
          });
        }
        const firstExec = await first.buildExecSpec({ command: "first", env: {}, usePty: false });
        if (failure === "mirror publication") {
          cliMocks.runOpenShellCli.mockResolvedValueOnce({
            code: 1,
            stdout: "",
            stderr: "download failed",
          });
        }
        await expect(finalize(first, firstExec.finalizeToken)).rejects.toThrow(
          failure === "SSH cleanup" ? "cleanup failed" : "download failed",
        );
      }
      let secondExec: Awaited<ReturnType<SandboxBackendHandle["buildExecSpec"]>> | undefined;
      const secondPreparation = second
        .buildExecSpec({ command: "second", env: {}, usePty: false })
        .then((prepared) => {
          secondExec = prepared;
          return prepared;
        });
      await vi.waitFor(() => expect(secondExec).toBeDefined());
      await finalize(second, (await secondPreparation).finalizeToken);
    },
  );

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
