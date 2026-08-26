// Openshell tests cover backend-owned exec workdir validation behavior.
import fs from "node:fs/promises";
import path from "node:path";
import type { CreateSandboxBackendParams } from "openclaw/plugin-sdk/sandbox";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspace,
  type TempWorkspace,
} from "openclaw/plugin-sdk/temp-path";
import {
  createSandboxBrowserConfig,
  createSandboxPruneConfig,
  createSandboxSshConfig,
  createSandboxTestContext,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenShellSandboxBackendFactory } from "./backend.js";
import { resolveOpenShellPluginConfig } from "./config.js";

const sdkMocks = vi.hoisted(() => ({
  runSshSandboxCommand: vi.fn(),
  disposeSshSandboxSession: vi.fn(),
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

function createOpenShellBackendSandboxConfig(): CreateSandboxBackendParams["cfg"] {
  return {
    mode: "all",
    backend: "openshell",
    scope: "session",
    workspaceAccess: "rw",
    workspaceRoot: "/tmp/openclaw-sandboxes",
    dockerTmpfsSource: "configured",
    docker: {
      image: "openclaw-sandbox:bookworm-slim",
      containerPrefix: "openclaw-sbx-",
      workdir: "/workspace",
      readOnlyRoot: false,
      tmpfs: [],
      network: "none",
      capDrop: [],
      binds: [],
      env: {},
    },
    ssh: createSandboxSshConfig("/tmp/openclaw-sandboxes"),
    browser: createSandboxBrowserConfig(),
    tools: { allow: ["*"], deny: [] },
    prune: createSandboxPruneConfig(),
  };
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
    const backendFactory = createOpenShellSandboxBackendFactory({
      pluginConfig: resolveOpenShellPluginConfig({
        command: "openshell",
        mode: "mirror",
      }),
    });
    const backend = await backendFactory({
      sessionKey: "agent:main:turn",
      scopeKey: "agent:somalley_alice:dashboard-8",
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      cfg: createOpenShellBackendSandboxConfig(),
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
    const backendFactory = createOpenShellSandboxBackendFactory({
      pluginConfig: resolveOpenShellPluginConfig({
        command: "openshell",
        mode: "mirror",
      }),
    });
    const backend = await backendFactory({
      sessionKey: "agent:main:turn",
      scopeKey: "agent:main",
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      cfg: createOpenShellBackendSandboxConfig(),
    });

    await expect(backend.validateWorkdir?.("/workspace")).resolves.toBe("/workspace");
    backend.discardPreparedWorkdir?.("/workspace");
    await backend.buildExecSpec({
      command: "pwd",
      workdir: "/workspace",
      env: {},
      usePty: false,
    });

    const uploadCalls = cliMocks.runOpenShellCli.mock.calls.filter(
      ([params]) => params.args[0] === "sandbox" && params.args[1] === "upload",
    );
    expect(uploadCalls).toHaveLength(2);
  });
});
