// Openshell tests cover openshell core plugin behavior.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import {
  buildExecRemoteCommand,
  disposeSshSandboxSession,
  shellEscape,
  type CreateSandboxBackendParams,
} from "openclaw/plugin-sdk/sandbox";
import {
  createSandboxBrowserConfig,
  createSandboxPruneConfig,
  createSandboxSshConfig,
  createSandboxTestContext,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenShellSandboxBackend } from "./backend.types.js";
import {
  buildValidatedExecRemoteCommand,
  createOpenShellSshSession,
  runOpenShellCli,
} from "./cli.js";
import { resolveOpenShellPluginConfig } from "./config.js";

const cliMocks = vi.hoisted(() => ({
  runOpenShellCli: vi.fn(),
  createOpenShellSshSession: vi.fn(),
}));

const sandboxMocks = vi.hoisted(() => ({
  runSshSandboxCommand: vi.fn(),
  disposeSshSandboxSession: vi.fn(),
  remoteRoot: "",
  remoteAgentRoot: "",
}));

let createOpenShellSandboxBackendManager: typeof import("./backend.js").createOpenShellSandboxBackendManager;
let createOpenShellSandboxBackendFactory: typeof import("./backend.js").createOpenShellSandboxBackendFactory;

async function installOpenShellBackendMocks() {
  vi.doMock("openclaw/plugin-sdk/sandbox", async () => {
    const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/sandbox")>(
      "openclaw/plugin-sdk/sandbox",
    );
    return {
      ...actual,
      disposeSshSandboxSession: sandboxMocks.disposeSshSandboxSession,
      runSshSandboxCommand: sandboxMocks.runSshSandboxCommand,
    };
  });
  vi.doMock("./cli.js", async () => {
    const actual = await vi.importActual<typeof import("./cli.js")>("./cli.js");
    return {
      ...actual,
      createOpenShellSshSession: cliMocks.createOpenShellSshSession,
      runOpenShellCli: cliMocks.runOpenShellCli,
    };
  });
  ({ createOpenShellSandboxBackendFactory, createOpenShellSandboxBackendManager } =
    await import("./backend.js"));
}

function uninstallOpenShellBackendMocks() {
  vi.doUnmock("openclaw/plugin-sdk/sandbox");
  vi.doUnmock("./cli.js");
  vi.resetModules();
}

function resetOpenShellBackendMocks() {
  vi.clearAllMocks();
  cliMocks.createOpenShellSshSession.mockResolvedValue({
    command: "ssh",
    configPath: "/tmp/openclaw-openshell-test-ssh-config",
    host: "openshell-test",
  });
  sandboxMocks.runSshSandboxCommand.mockImplementation(
    async (params: { remoteCommand: string; stdin?: Buffer | string; allowFailure?: boolean }) => {
      const remoteCommand = params.remoteCommand
        .replaceAll("'/sandbox", `'${sandboxMocks.remoteRoot}`)
        .replaceAll("'/agent", `'${sandboxMocks.remoteAgentRoot}`);
      const result = spawnSync("sh", ["-c", remoteCommand], {
        input: params.stdin,
      });
      if (result.error) {
        throw result.error;
      }
      const stdout = Buffer.isBuffer(result.stdout)
        ? result.stdout
        : Buffer.from(result.stdout ?? "");
      const stderr = Buffer.isBuffer(result.stderr)
        ? result.stderr
        : Buffer.from(result.stderr ?? "");
      const code = result.status ?? 1;
      if (code !== 0 && !params.allowFailure) {
        throw Object.assign(new Error(stderr.toString("utf8").trim()), {
          code,
          stdout,
          stderr,
        });
      }
      return { stdout, stderr, code };
    },
  );
}

describe("openshell cli helpers", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  it("shell escapes single quotes", () => {
    expect(shellEscape(`a'b`)).toBe(`'a'"'"'b'`);
  });

  it("wraps exec commands with env and workdir", () => {
    const command = buildExecRemoteCommand({
      command: "pwd && printenv TOKEN",
      workdir: "/sandbox/project",
      env: {
        TOKEN: "abc 123",
      },
    });
    expect(command).toContain(`'env'`);
    expect(command).toContain(`'TOKEN=abc 123'`);
    expect(command).toContain(`'cd '"'"'/sandbox/project'"'"' && pwd && printenv TOKEN'`);
  });

  it("uses the shared SSH exec command preflight", () => {
    expect(() =>
      buildValidatedExecRemoteCommand({
        command: 'workflow run <workflow-id> "<task>"',
        env: {},
      }),
    ).toThrow(/unresolved placeholder token <workflow-id>/);
  });

  it("passes direct gateway endpoints to openshell commands without registration", async () => {
    const calls: string[][] = [];
    const openshellCommand = await makeExecutable({
      name: "openshell",
      script: ["#!/bin/sh", `printf '%s\\n' "$*" >> "__LOG__"`, "exit 0"].join("\n"),
    });

    await runOpenShellCli({
      context: {
        sandboxName: "demo",
        config: resolveOpenShellPluginConfig({
          command: openshellCommand,
          gateway: "alice",
          gatewayEndpoint: "http://openshell.openshell-alice.svc.cluster.local:8080",
        }),
      },
      args: ["sandbox", "get", "demo"],
    });

    const log = await fs.readFile(process.env.OPEN_SHELL_CLI_TEST_LOG as string, "utf8");
    for (const line of log.trim().split("\n")) {
      calls.push(line.split(" "));
    }
    expect(calls[0]).toEqual([
      "--gateway",
      "alice",
      "--gateway-endpoint",
      "http://openshell.openshell-alice.svc.cluster.local:8080",
      "sandbox",
      "get",
      "demo",
    ]);
  });

  it.runIf(process.platform !== "win32")(
    "adds direct gateway endpoints to generated ssh proxy configs",
    async () => {
      const configText = [
        "Host openshell-demo",
        "    User sandbox",
        "    ProxyCommand /usr/local/bin/openshell ssh-proxy --gateway-name alice --name demo",
        "",
      ].join("\n");

      await expect(
        readOpenShellSshConfig({
          configText,
          gatewayEndpoint: "http://openshell.openshell-alice.svc.cluster.local:8080",
        }),
      ).resolves.toContain(
        "ProxyCommand /usr/local/bin/openshell ssh-proxy --gateway-name alice --name demo --server 'http://openshell.openshell-alice.svc.cluster.local:8080'",
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "leaves ssh proxy configs with an explicit endpoint unchanged",
    async () => {
      const configText =
        "Host openshell-demo\n    ProxyCommand openshell ssh-proxy --gateway-name alice --name demo --server 'http://existing'\n";

      await expect(
        readOpenShellSshConfig({
          configText,
          gatewayEndpoint: "http://replacement",
        }),
      ).resolves.toContain(
        "ProxyCommand openshell ssh-proxy --gateway-name alice --name demo --server 'http://existing'",
      );
    },
  );
});

describe("openshell backend manager", () => {
  beforeAll(installOpenShellBackendMocks);
  afterAll(uninstallOpenShellBackendMocks);
  beforeEach(resetOpenShellBackendMocks);

  it.runIf(process.platform !== "win32")(
    "clears the materialized skills directory through the remote backend boundary",
    async () => {
      const workspaceDir = await makeTempDir("openclaw-openshell-workspace-");
      const skillsWorkspaceDir = await makeTempDir("openclaw-openshell-skills-");
      sandboxMocks.remoteRoot = await makeTempDir("openclaw-openshell-remote-");
      sandboxMocks.remoteAgentRoot = await makeTempDir("openclaw-openshell-agent-remote-");
      const materializedDir = path.join(sandboxMocks.remoteRoot, ".openclaw", "sandbox-skills");
      await fs.mkdir(materializedDir, { recursive: true });
      await fs.writeFile(path.join(materializedDir, "stale.txt"), "stale", "utf8");
      await fs.writeFile(path.join(skillsWorkspaceDir, "SKILL.md"), "# Skill\n", "utf8");
      cliMocks.runOpenShellCli.mockResolvedValue({ code: 0, stdout: "", stderr: "" });

      const factory = createOpenShellSandboxBackendFactory({
        pluginConfig: resolveOpenShellPluginConfig({ command: "openshell", mode: "remote" }),
      });
      const backend = (await factory({
        sessionKey: "agent:main:turn",
        scopeKey: "agent:main",
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        skillsWorkspaceDir,
        cfg: createOpenShellBackendSandboxConfig(),
      })) as OpenShellSandboxBackend;
      if (!backend.runRemoteShellScript) {
        throw new Error("Expected OpenShell remote script boundary");
      }

      const result = await backend.runRemoteShellScript({
        script: 'test -d "$1"',
        args: ["/sandbox/.openclaw/sandbox-skills"],
      });

      expect(result?.code).toBe(0);
      await expectPathMissing(path.join(materializedDir, "stale.txt"));
      await expect(fs.stat(materializedDir)).resolves.toBeDefined();
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects symlinked materialized skills parents through the remote backend boundary",
    async () => {
      const workspaceDir = await makeTempDir("openclaw-openshell-workspace-");
      const skillsWorkspaceDir = await makeTempDir("openclaw-openshell-skills-");
      sandboxMocks.remoteRoot = await makeTempDir("openclaw-openshell-remote-");
      sandboxMocks.remoteAgentRoot = await makeTempDir("openclaw-openshell-agent-remote-");
      const outsideDir = await makeTempDir("openclaw-openshell-outside-");
      await fs.symlink(outsideDir, path.join(sandboxMocks.remoteRoot, ".openclaw"));
      await fs.writeFile(path.join(skillsWorkspaceDir, "SKILL.md"), "# Skill\n", "utf8");
      cliMocks.runOpenShellCli.mockResolvedValue({ code: 0, stdout: "", stderr: "" });

      const factory = createOpenShellSandboxBackendFactory({
        pluginConfig: resolveOpenShellPluginConfig({ command: "openshell", mode: "remote" }),
      });
      const backend = (await factory({
        sessionKey: "agent:main:turn",
        scopeKey: "agent:main",
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        skillsWorkspaceDir,
        cfg: createOpenShellBackendSandboxConfig(),
      })) as OpenShellSandboxBackend;
      if (!backend.runRemoteShellScript) {
        throw new Error("Expected OpenShell remote script boundary");
      }

      await expect(backend.runRemoteShellScript({ script: "true" })).rejects.toThrow(
        "unsafe remote directory symlink",
      );
      await expect(fs.readdir(outsideDir)).resolves.toEqual([]);
    },
  );

  it("checks runtime status with config override from OpenClaw config", async () => {
    cliMocks.runOpenShellCli.mockResolvedValue({
      code: 0,
      stdout: "{}",
      stderr: "",
    });

    const manager = createOpenShellSandboxBackendManager({
      pluginConfig: resolveOpenShellPluginConfig({
        command: "openshell",
        from: "openclaw",
      }),
    });

    const result = await manager.describeRuntime({
      entry: {
        containerName: "openclaw-session-1234",
        backendId: "openshell",
        runtimeLabel: "openclaw-session-1234",
        sessionKey: "agent:main",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "custom-source",
        configLabelKind: "Source",
      },
      config: {
        plugins: {
          entries: {
            openshell: {
              enabled: true,
              config: {
                command: "openshell",
                from: "custom-source",
              },
            },
          },
        },
      },
    });

    expect(result).toEqual({
      running: true,
      actualConfigLabel: "custom-source",
      configLabelMatch: true,
    });
    const expectedConfig = resolveOpenShellPluginConfig({
      command: "openshell",
      from: "custom-source",
    });
    expect(cliMocks.runOpenShellCli).toHaveBeenCalledWith({
      context: {
        sandboxName: "openclaw-session-1234",
        config: expectedConfig,
      },
      args: ["sandbox", "get", "openclaw-session-1234"],
    });
  });

  it("removes runtimes via openshell sandbox delete", async () => {
    cliMocks.runOpenShellCli.mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });

    const manager = createOpenShellSandboxBackendManager({
      pluginConfig: resolveOpenShellPluginConfig({
        command: "/usr/local/bin/openshell",
        gateway: "lab",
      }),
    });

    await manager.removeRuntime({
      entry: {
        containerName: "openclaw-session-5678",
        backendId: "openshell",
        runtimeLabel: "openclaw-session-5678",
        sessionKey: "agent:main",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "openclaw",
        configLabelKind: "Source",
      },
      config: {},
    });

    const expectedConfig = resolveOpenShellPluginConfig({
      command: "/usr/local/bin/openshell",
      gateway: "lab",
    });
    expect(cliMocks.runOpenShellCli).toHaveBeenCalledWith({
      context: {
        sandboxName: "openclaw-session-5678",
        config: expectedConfig,
      },
      args: ["sandbox", "delete", "openclaw-session-5678"],
    });
  });

  it("rejects malformed exec commands before opening an OpenShell SSH session", async () => {
    const factory = createOpenShellSandboxBackendFactory({
      pluginConfig: resolveOpenShellPluginConfig({
        command: "openshell",
      }),
    });
    const backend = await factory({
      sessionKey: "agent:main:turn",
      scopeKey: "agent:main",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg: createOpenShellBackendSandboxConfig(),
    });

    await expect(
      backend.buildExecSpec({
        command: "workflow install <name>",
        env: {},
        usePty: false,
      }),
    ).rejects.toThrow(/unresolved placeholder token <name>/);
    expect(cliMocks.runOpenShellCli).not.toHaveBeenCalled();
  });

  it("preserves a local sandbox skills shadow when mirror sync crosses filesystems", async () => {
    const workspaceDir = await makeTempDir("openclaw-openshell-workspace-");
    const shadowFile = path.join(workspaceDir, ".openclaw", "sandbox-skills", "user-note.txt");
    await fs.mkdir(path.dirname(shadowFile), { recursive: true });
    await fs.writeFile(shadowFile, "local shadow", "utf8");

    const originalRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      const source = String(from);
      const target = String(to);
      const shadowDir = path.dirname(shadowFile);
      const isFallbackStagedMove = path.basename(source).startsWith(".fs-safe-move-");
      if (source === shadowDir || (target === shadowDir && !isFallbackStagedMove)) {
        throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
      }
      return await originalRename(from, to);
    });
    cliMocks.runOpenShellCli.mockImplementation(async ({ args }: { args: string[] }) => {
      if (args[0] === "sandbox" && args[1] === "download") {
        const tmpDir = expectDefined(args[4], "OpenShell download destination");
        await fs.writeFile(path.join(tmpDir, "from-remote.txt"), "remote", "utf8");
        await fs.mkdir(path.join(tmpDir, ".openclaw", "sandbox-skills", "skills"), {
          recursive: true,
        });
        await fs.writeFile(
          path.join(tmpDir, ".openclaw", "sandbox-skills", "skills", "generated.txt"),
          "generated",
          "utf8",
        );
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const factory = createOpenShellSandboxBackendFactory({
      pluginConfig: resolveOpenShellPluginConfig({
        command: "openshell",
        mode: "mirror",
      }),
    });
    const backend = await factory({
      sessionKey: "agent:main:turn",
      scopeKey: "agent:main",
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      cfg: createOpenShellBackendSandboxConfig(),
    });

    try {
      await backend.finalizeExec?.({
        status: "completed",
        exitCode: 0,
        timedOut: false,
        token: undefined,
      });

      expect(renameSpy).toHaveBeenCalled();
      await expect(fs.readFile(shadowFile, "utf8")).resolves.toBe("local shadow");
      await expect(fs.readFile(path.join(workspaceDir, "from-remote.txt"), "utf8")).resolves.toBe(
        "remote",
      );
      await expectPathMissing(
        path.join(workspaceDir, ".openclaw", "sandbox-skills", "skills", "generated.txt"),
      );
    } finally {
      renameSpy.mockRestore();
    }
  });

  it("drops non-directory materialized sandbox skills from mirror downloads", async () => {
    const workspaceDir = await makeTempDir("openclaw-openshell-workspace-");
    cliMocks.runOpenShellCli.mockImplementation(async ({ args }: { args: string[] }) => {
      if (args[0] === "sandbox" && args[1] === "download") {
        const tmpDir = expectDefined(args[4], "OpenShell download destination");
        await fs.writeFile(path.join(tmpDir, "from-remote.txt"), "remote", "utf8");
        await fs.mkdir(path.join(tmpDir, ".openclaw"), { recursive: true });
        await fs.writeFile(path.join(tmpDir, ".openclaw", "sandbox-skills"), "poison", "utf8");
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const factory = createOpenShellSandboxBackendFactory({
      pluginConfig: resolveOpenShellPluginConfig({
        command: "openshell",
        mode: "mirror",
      }),
    });
    const backend = await factory({
      sessionKey: "agent:main:turn",
      scopeKey: "agent:main",
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      cfg: createOpenShellBackendSandboxConfig(),
    });

    await backend.finalizeExec?.({
      status: "completed",
      exitCode: 0,
      timedOut: false,
      token: undefined,
    });

    await expect(fs.readFile(path.join(workspaceDir, "from-remote.txt"), "utf8")).resolves.toBe(
      "remote",
    );
    await expectPathMissing(path.join(workspaceDir, ".openclaw", "sandbox-skills"));
  });

  it("restores a local sandbox skills shadow when mirror download has a file parent", async () => {
    const workspaceDir = await makeTempDir("openclaw-openshell-workspace-");
    const shadowFile = path.join(workspaceDir, ".openclaw", "sandbox-skills", "user-note.txt");
    await fs.mkdir(path.dirname(shadowFile), { recursive: true });
    await fs.writeFile(shadowFile, "local shadow", "utf8");
    cliMocks.runOpenShellCli.mockImplementation(async ({ args }: { args: string[] }) => {
      if (args[0] === "sandbox" && args[1] === "download") {
        const tmpDir = expectDefined(args[4], "OpenShell download destination");
        await fs.writeFile(path.join(tmpDir, "from-remote.txt"), "remote", "utf8");
        await fs.writeFile(path.join(tmpDir, ".openclaw"), "poison", "utf8");
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const factory = createOpenShellSandboxBackendFactory({
      pluginConfig: resolveOpenShellPluginConfig({
        command: "openshell",
        mode: "mirror",
      }),
    });
    const backend = await factory({
      sessionKey: "agent:main:turn",
      scopeKey: "agent:main",
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      cfg: createOpenShellBackendSandboxConfig(),
    });

    await backend.finalizeExec?.({
      status: "completed",
      exitCode: 0,
      timedOut: false,
      token: undefined,
    });

    await expect(fs.readFile(path.join(workspaceDir, "from-remote.txt"), "utf8")).resolves.toBe(
      "remote",
    );
    await expect(fs.readFile(shadowFile, "utf8")).resolves.toBe("local shadow");
    expect((await fs.stat(path.join(workspaceDir, ".openclaw"))).isDirectory()).toBe(true);
  });
});

const tempDirs: string[] = [];

function createOpenShellBackendSandboxConfig(): CreateSandboxBackendParams["cfg"] {
  return {
    mode: "all",
    backend: "openshell",
    scope: "session",
    workspaceAccess: "rw",
    workspaceRoot: "/tmp/openclaw-sandboxes",
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

async function makeTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function makeExecutable(params: { name: string; script: string }): Promise<string> {
  const dir = await makeTempDir("openclaw-openshell-bin-");
  const file = path.join(dir, params.name);
  const logPath = path.join(dir, "openshell.log");
  await fs.writeFile(file, params.script.replaceAll("__LOG__", logPath), { mode: 0o755 });
  await fs.chmod(file, 0o755);
  process.env.OPEN_SHELL_CLI_TEST_LOG = logPath;
  return file;
}

async function readOpenShellSshConfig(params: {
  configText: string;
  gatewayEndpoint: string;
}): Promise<string> {
  const command = await makeExecutable({
    name: "openshell-ssh-config",
    script: [
      "#!/bin/sh",
      "cat <<'OPENCLAW_SSH_CONFIG'",
      params.configText,
      "OPENCLAW_SSH_CONFIG",
    ].join("\n"),
  });
  const session = await createOpenShellSshSession({
    context: {
      sandboxName: "demo",
      config: resolveOpenShellPluginConfig({
        command,
        gatewayEndpoint: params.gatewayEndpoint,
      }),
    },
  });
  try {
    return await fs.readFile(session.configPath, "utf8");
  } finally {
    await disposeSshSandboxSession(session);
  }
}

async function expectPathMissing(targetPath: string): Promise<void> {
  let error: unknown;
  try {
    await fs.stat(targetPath);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function createMirrorBackendMock(): OpenShellSandboxBackend {
  return {
    id: "openshell",
    runtimeId: "openshell-test",
    runtimeLabel: "openshell-test",
    workdir: "/sandbox",
    env: {},
    remoteWorkspaceDir: "/sandbox",
    remoteAgentWorkspaceDir: "/agent",
    buildExecSpec: vi.fn(),
    runShellCommand: vi.fn(),
    runRemoteShellScript: vi.fn().mockResolvedValue({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      code: 0,
    }),
    mkdirpRemotePath: vi.fn().mockResolvedValue(undefined),
    renameRemotePath: vi.fn().mockResolvedValue(undefined),
    removeRemotePath: vi.fn().mockResolvedValue(undefined),
    syncLocalPathToRemote: vi.fn().mockResolvedValue(undefined),
  } as unknown as OpenShellSandboxBackend;
}

describe("openshell fs bridges", () => {
  beforeAll(installOpenShellBackendMocks);
  afterAll(uninstallOpenShellBackendMocks);
  beforeEach(resetOpenShellBackendMocks);

  it.runIf(process.platform !== "win32")(
    "rejects remote-only symlink parents in pinned mirror mutations",
    async () => {
      const stateDir = await makeTempDir("openclaw-openshell-remote-pin-");
      const remoteRoot = path.join(stateDir, "sandbox");
      const remoteAgentRoot = path.join(stateDir, "agent");
      const outsideDir = path.join(stateDir, "outside");
      await fs.mkdir(remoteRoot, { recursive: true });
      await fs.mkdir(remoteAgentRoot, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(path.join(remoteRoot, "source.txt"), "payload", "utf8");
      await fs.symlink(outsideDir, path.join(remoteRoot, "alias"));
      sandboxMocks.remoteRoot = remoteRoot;
      sandboxMocks.remoteAgentRoot = remoteAgentRoot;
      cliMocks.runOpenShellCli.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
      const factory = createOpenShellSandboxBackendFactory({
        pluginConfig: resolveOpenShellPluginConfig({ command: "openshell", mode: "remote" }),
      });
      const backend = (await factory({
        sessionKey: "agent:main:turn",
        scopeKey: "agent:main",
        workspaceDir: stateDir,
        agentWorkspaceDir: stateDir,
        cfg: createOpenShellBackendSandboxConfig(),
      })) as OpenShellSandboxBackend;
      if (!backend.mkdirpRemotePath || !backend.renameRemotePath || !backend.removeRemotePath) {
        throw new Error("Expected OpenShell remote path mutation boundaries");
      }

      await expect(backend.mkdirpRemotePath("/sandbox/safe/nested")).resolves.toBeUndefined();
      await expect(fs.stat(path.join(remoteRoot, "safe", "nested"))).resolves.toBeDefined();

      await expect(backend.mkdirpRemotePath("/sandbox/..cache/file")).resolves.toBeUndefined();
      await expect(fs.stat(path.join(remoteRoot, "..cache", "file"))).resolves.toBeDefined();

      await expect(backend.mkdirpRemotePath("/sandbox/alias/escaped")).rejects.toThrow(
        "unsafe remote directory symlink",
      );
      await expectPathMissing(path.join(outsideDir, "escaped"));

      await expect(
        backend.renameRemotePath("/sandbox/source.txt", "/sandbox/alias/escaped.txt"),
      ).rejects.toThrow("unsafe remote directory symlink");
      await expect(fs.readFile(path.join(remoteRoot, "source.txt"), "utf8")).resolves.toBe(
        "payload",
      );
      await expectPathMissing(path.join(outsideDir, "escaped.txt"));

      await fs.writeFile(path.join(remoteRoot, "victim.txt"), "delete me", "utf8");
      await expect(
        backend.removeRemotePath("/sandbox/alias/victim.txt", { recursive: false }),
      ).rejects.toThrow("unsafe remote directory symlink");
      await expect(
        backend.removeRemotePath("/sandbox/missing-parent/victim.txt", {
          recursive: false,
          ignoreMissing: true,
        }),
      ).resolves.toBeUndefined();
      await expect(
        backend.removeRemotePath("/sandbox/alias/victim.txt", {
          recursive: false,
          ignoreMissing: true,
        }),
      ).rejects.toThrow("unsafe remote directory symlink");
      await expect(fs.readFile(path.join(remoteRoot, "victim.txt"), "utf8")).resolves.toBe(
        "delete me",
      );
      await expectPathMissing(path.join(outsideDir, "victim.txt"));
    },
  );

  it("writes locally and syncs the file to the remote workspace", async () => {
    const workspaceDir = await makeTempDir("openclaw-openshell-fs-");
    const backend = createMirrorBackendMock();
    const sandbox = createSandboxTestContext({
      overrides: {
        backendId: "openshell",
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        containerWorkdir: "/sandbox",
      },
    });

    const { createOpenShellFsBridge } = await import("./fs-bridge.js");
    const bridge = createOpenShellFsBridge({ sandbox, backend });
    await bridge.writeFile({
      filePath: "nested/file.txt",
      data: "hello",
      mkdir: true,
    });

    expect(await fs.readFile(path.join(workspaceDir, "nested", "file.txt"), "utf8")).toBe("hello");
    expect(backend["syncLocalPathToRemote"]).toHaveBeenCalledWith(
      path.join(workspaceDir, "nested", "file.txt"),
      "/sandbox/nested/file.txt",
    );
  });

  it("creates remote mirror directories through the pinned backend operation", async () => {
    const workspaceDir = await makeTempDir("openclaw-openshell-fs-");
    const backend = createMirrorBackendMock();
    const sandbox = createSandboxTestContext({
      overrides: {
        backendId: "openshell",
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        containerWorkdir: "/sandbox",
      },
    });

    const { createOpenShellFsBridge } = await import("./fs-bridge.js");
    const bridge = createOpenShellFsBridge({ sandbox, backend });
    await bridge.mkdirp({ filePath: "nested/dir" });

    await expect(fs.stat(path.join(workspaceDir, "nested", "dir"))).resolves.toBeDefined();
    expect(backend["mkdirpRemotePath"]).toHaveBeenCalledWith("/sandbox/nested/dir", undefined);
    expect(backend["runRemoteShellScript"]).not.toHaveBeenCalled();
  });

  it("renames remote mirror paths through the pinned backend operation", async () => {
    const workspaceDir = await makeTempDir("openclaw-openshell-fs-");
    await fs.writeFile(path.join(workspaceDir, "source.txt"), "payload", "utf8");
    const backend = createMirrorBackendMock();
    const sandbox = createSandboxTestContext({
      overrides: {
        backendId: "openshell",
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        containerWorkdir: "/sandbox",
      },
    });

    const { createOpenShellFsBridge } = await import("./fs-bridge.js");
    const bridge = createOpenShellFsBridge({ sandbox, backend });
    await bridge.rename({ from: "source.txt", to: "nested/target.txt" });

    await expect(
      fs.readFile(path.join(workspaceDir, "nested", "target.txt"), "utf8"),
    ).resolves.toBe("payload");
    expect(backend["renameRemotePath"]).toHaveBeenCalledWith(
      "/sandbox/source.txt",
      "/sandbox/nested/target.txt",
      undefined,
    );
    expect(backend["runRemoteShellScript"]).not.toHaveBeenCalled();
  });

  it("rejects cross-root mirror renames before the remote backend commit", async () => {
    const workspaceDir = await makeTempDir("openclaw-openshell-fs-");
    const agentWorkspaceDir = await makeTempDir("openclaw-openshell-agent-fs-");
    const sourcePath = path.join(workspaceDir, "source.txt");
    await fs.writeFile(sourcePath, "payload", "utf8");
    const backend = createMirrorBackendMock();
    const sandbox = createSandboxTestContext({
      overrides: {
        backendId: "openshell",
        workspaceDir,
        agentWorkspaceDir,
        containerWorkdir: "/sandbox",
      },
    });

    const { createOpenShellFsBridge } = await import("./fs-bridge.js");
    const bridge = createOpenShellFsBridge({ sandbox, backend });

    await expect(bridge.rename({ from: "source.txt", to: "/agent/source.txt" })).rejects.toThrow(
      "OpenShell cross-root mirror renames require pinned fs-safe support",
    );
    expect(backend["renameRemotePath"]).not.toHaveBeenCalled();
    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("payload");
    await expectPathMissing(path.join(agentWorkspaceDir, "source.txt"));
    await expect(fs.readdir(agentWorkspaceDir)).resolves.toStrictEqual([]);
  });

  it.runIf(process.platform !== "win32")(
    "rejects local mirror symlink rename sources before the remote backend commit",
    async () => {
      const workspaceDir = await makeTempDir("openclaw-openshell-fs-");
      await fs.writeFile(path.join(workspaceDir, "target.txt"), "payload", "utf8");
      await fs.symlink("target.txt", path.join(workspaceDir, "link.txt"));
      const backend = createMirrorBackendMock();
      const sandbox = createSandboxTestContext({
        overrides: {
          backendId: "openshell",
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
          containerWorkdir: "/sandbox",
        },
      });

      const { createOpenShellFsBridge } = await import("./fs-bridge.js");
      const bridge = createOpenShellFsBridge({ sandbox, backend });

      await expect(bridge.rename({ from: "link.txt", to: "moved-link.txt" })).rejects.toThrow(
        "Sandbox symlink rename sources are not supported",
      );
      expect(backend["renameRemotePath"]).not.toHaveBeenCalled();
      await expect(fs.readlink(path.join(workspaceDir, "link.txt"))).resolves.toBe("target.txt");
      await expectPathMissing(path.join(workspaceDir, "moved-link.txt"));
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects local mirror hardlinked rename sources before the remote backend commit",
    async () => {
      const workspaceDir = await makeTempDir("openclaw-openshell-fs-");
      const sourcePath = path.join(workspaceDir, "source.txt");
      await fs.writeFile(sourcePath, "payload", "utf8");
      await fs.link(sourcePath, path.join(workspaceDir, "other-link.txt"));
      const backend = createMirrorBackendMock();
      const sandbox = createSandboxTestContext({
        overrides: {
          backendId: "openshell",
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
          containerWorkdir: "/sandbox",
        },
      });

      const { createOpenShellFsBridge } = await import("./fs-bridge.js");
      const bridge = createOpenShellFsBridge({ sandbox, backend });

      await expect(bridge.rename({ from: "source.txt", to: "moved.txt" })).rejects.toThrow(
        "Sandbox hardlinked rename sources are not supported",
      );
      expect(backend["renameRemotePath"]).not.toHaveBeenCalled();
      await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("payload");
      await expectPathMissing(path.join(workspaceDir, "moved.txt"));
    },
  );

  it("removes remote mirror paths through the pinned backend operation", async () => {
    const workspaceDir = await makeTempDir("openclaw-openshell-fs-");
    await fs.writeFile(path.join(workspaceDir, "target.txt"), "payload", "utf8");
    const backend = createMirrorBackendMock();
    const sandbox = createSandboxTestContext({
      overrides: {
        backendId: "openshell",
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        containerWorkdir: "/sandbox",
      },
    });

    const { createOpenShellFsBridge } = await import("./fs-bridge.js");
    const bridge = createOpenShellFsBridge({ sandbox, backend });
    await bridge.remove({ filePath: "target.txt", force: true });

    await expectPathMissing(path.join(workspaceDir, "target.txt"));
    expect(backend["removeRemotePath"]).toHaveBeenCalledWith("/sandbox/target.txt", {
      recursive: false,
      signal: undefined,
      ignoreMissing: true,
    });
    expect(backend["runRemoteShellScript"]).not.toHaveBeenCalled();
  });

  it("removes recursive local mirror directories without raw path deletion", async () => {
    const workspaceDir = await makeTempDir("openclaw-openshell-fs-");
    await fs.mkdir(path.join(workspaceDir, "nested", "child"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "nested", "child", "target.txt"), "payload", "utf8");
    const backend = createMirrorBackendMock();
    const sandbox = createSandboxTestContext({
      overrides: {
        backendId: "openshell",
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        containerWorkdir: "/sandbox",
      },
    });

    const { createOpenShellFsBridge } = await import("./fs-bridge.js");
    const bridge = createOpenShellFsBridge({ sandbox, backend });
    await bridge.remove({ filePath: "nested", recursive: true, force: true });

    await expectPathMissing(path.join(workspaceDir, "nested"));
    expect(backend["removeRemotePath"]).toHaveBeenCalledWith("/sandbox/nested", {
      recursive: true,
      signal: undefined,
      ignoreMissing: true,
    });
  });

  it.runIf(process.platform !== "win32")(
    "removes recursive local mirror directories containing symlink leaves without following them",
    async () => {
      const workspaceDir = await makeTempDir("openclaw-openshell-fs-");
      const outsideDir = await makeTempDir("openclaw-openshell-outside-");
      const outsideTarget = path.join(outsideDir, "target.txt");
      await fs.mkdir(path.join(workspaceDir, "nested"), { recursive: true });
      await fs.writeFile(outsideTarget, "outside", "utf8");
      await fs.symlink(outsideTarget, path.join(workspaceDir, "nested", "link.txt"));
      const backend = createMirrorBackendMock();
      const sandbox = createSandboxTestContext({
        overrides: {
          backendId: "openshell",
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
          containerWorkdir: "/sandbox",
        },
      });

      const { createOpenShellFsBridge } = await import("./fs-bridge.js");
      const bridge = createOpenShellFsBridge({ sandbox, backend });
      await bridge.remove({ filePath: "nested", recursive: true, force: true });

      await expectPathMissing(path.join(workspaceDir, "nested"));
      await expect(fs.readFile(outsideTarget, "utf8")).resolves.toBe("outside");
    },
  );

  it.runIf(process.platform !== "win32")(
    "removes local mirror symlink leaves when force is false",
    async () => {
      const workspaceDir = await makeTempDir("openclaw-openshell-fs-");
      const outsideDir = await makeTempDir("openclaw-openshell-outside-");
      const outsideTarget = path.join(outsideDir, "target.txt");
      await fs.writeFile(outsideTarget, "outside", "utf8");
      await fs.symlink(outsideTarget, path.join(workspaceDir, "link.txt"));
      const backend = createMirrorBackendMock();
      const sandbox = createSandboxTestContext({
        overrides: {
          backendId: "openshell",
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
          containerWorkdir: "/sandbox",
        },
      });

      const { createOpenShellFsBridge } = await import("./fs-bridge.js");
      const bridge = createOpenShellFsBridge({ sandbox, backend });
      await bridge.remove({ filePath: "link.txt", force: false });

      await expectPathMissing(path.join(workspaceDir, "link.txt"));
      await expect(fs.readFile(outsideTarget, "utf8")).resolves.toBe("outside");
      expect(backend["removeRemotePath"]).toHaveBeenCalledWith("/sandbox/link.txt", {
        recursive: false,
        signal: undefined,
        ignoreMissing: false,
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects local mirror mkdir when a validated parent is swapped to an outside symlink",
    async () => {
      const workspaceDir = await makeTempDir("openclaw-openshell-fs-");
      const outsideDir = await makeTempDir("openclaw-openshell-outside-");
      const slotPath = path.join(workspaceDir, "slot");
      await fs.mkdir(slotPath, { recursive: true });
      const backend = createMirrorBackendMock();
      backend["mkdirpRemotePath"] = vi.fn().mockImplementation(async () => {
        await fs.rm(slotPath, { recursive: true, force: true });
        await fs.symlink(outsideDir, slotPath);
      });
      const sandbox = createSandboxTestContext({
        overrides: {
          backendId: "openshell",
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
          containerWorkdir: "/sandbox",
        },
      });

      const { createOpenShellFsBridge } = await import("./fs-bridge.js");
      const bridge = createOpenShellFsBridge({ sandbox, backend });

      await expect(bridge.mkdirp({ filePath: "slot/escaped" })).rejects.toThrow();
      await expectPathMissing(path.join(outsideDir, "escaped"));
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects local mirror remove when a validated parent is swapped to an outside symlink",
    async () => {
      const workspaceDir = await makeTempDir("openclaw-openshell-fs-");
      const outsideDir = await makeTempDir("openclaw-openshell-outside-");
      const slotPath = path.join(workspaceDir, "slot");
      const outsideTarget = path.join(outsideDir, "target.txt");
      await fs.mkdir(slotPath, { recursive: true });
      await fs.writeFile(path.join(slotPath, "target.txt"), "inside", "utf8");
      await fs.writeFile(outsideTarget, "outside", "utf8");
      const backend = createMirrorBackendMock();
      backend["removeRemotePath"] = vi.fn().mockImplementation(async () => {
        await fs.rm(slotPath, { recursive: true, force: true });
        await fs.symlink(outsideDir, slotPath);
      });
      const sandbox = createSandboxTestContext({
        overrides: {
          backendId: "openshell",
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
          containerWorkdir: "/sandbox",
        },
      });

      const { createOpenShellFsBridge } = await import("./fs-bridge.js");
      const bridge = createOpenShellFsBridge({ sandbox, backend });

      await expect(bridge.remove({ filePath: "slot/target.txt", force: true })).rejects.toThrow();
      await expect(fs.readFile(outsideTarget, "utf8")).resolves.toBe("outside");
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects local mirror rename when a validated destination parent is swapped to an outside symlink",
    async () => {
      const workspaceDir = await makeTempDir("openclaw-openshell-fs-");
      const outsideDir = await makeTempDir("openclaw-openshell-outside-");
      const slotPath = path.join(workspaceDir, "slot");
      const sourcePath = path.join(workspaceDir, "source.txt");
      await fs.mkdir(slotPath, { recursive: true });
      await fs.writeFile(sourcePath, "payload", "utf8");
      const backend = createMirrorBackendMock();
      backend["renameRemotePath"] = vi.fn().mockImplementation(async () => {
        await fs.rm(slotPath, { recursive: true, force: true });
        await fs.symlink(outsideDir, slotPath);
      });
      const sandbox = createSandboxTestContext({
        overrides: {
          backendId: "openshell",
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
          containerWorkdir: "/sandbox",
        },
      });

      const { createOpenShellFsBridge } = await import("./fs-bridge.js");
      const bridge = createOpenShellFsBridge({ sandbox, backend });

      await expect(
        bridge.rename({ from: "source.txt", to: "slot/parent/moved.txt" }),
      ).rejects.toThrow();
      await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("payload");
      await expectPathMissing(path.join(outsideDir, "parent", "moved.txt"));
    },
  );

  it("keeps local mirror state unchanged when remote pinned mkdir is rejected", async () => {
    const workspaceDir = await makeTempDir("openclaw-openshell-fs-");
    const backend = createMirrorBackendMock();
    backend["mkdirpRemotePath"] = vi.fn().mockRejectedValue(new Error("remote rejected"));
    const sandbox = createSandboxTestContext({
      overrides: {
        backendId: "openshell",
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        containerWorkdir: "/sandbox",
      },
    });

    const { createOpenShellFsBridge } = await import("./fs-bridge.js");
    const bridge = createOpenShellFsBridge({ sandbox, backend });

    await expect(bridge.mkdirp({ filePath: "alias/escaped" })).rejects.toThrow("remote rejected");
    await expectPathMissing(path.join(workspaceDir, "alias"));
  });

  it("keeps local mirror state unchanged when remote pinned remove is rejected", async () => {
    const workspaceDir = await makeTempDir("openclaw-openshell-fs-");
    const targetPath = path.join(workspaceDir, "target.txt");
    await fs.writeFile(targetPath, "payload", "utf8");
    const backend = createMirrorBackendMock();
    backend["removeRemotePath"] = vi.fn().mockRejectedValue(new Error("remote rejected"));
    const sandbox = createSandboxTestContext({
      overrides: {
        backendId: "openshell",
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        containerWorkdir: "/sandbox",
      },
    });

    const { createOpenShellFsBridge } = await import("./fs-bridge.js");
    const bridge = createOpenShellFsBridge({ sandbox, backend });

    await expect(bridge.remove({ filePath: "target.txt", force: true })).rejects.toThrow(
      "remote rejected",
    );
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("payload");
  });

  it("keeps local mirror state unchanged when remote pinned rename is rejected", async () => {
    const workspaceDir = await makeTempDir("openclaw-openshell-fs-");
    const sourcePath = path.join(workspaceDir, "source.txt");
    const targetPath = path.join(workspaceDir, "nested", "target.txt");
    await fs.writeFile(sourcePath, "payload", "utf8");
    const backend = createMirrorBackendMock();
    backend["renameRemotePath"] = vi.fn().mockRejectedValue(new Error("remote rejected"));
    const sandbox = createSandboxTestContext({
      overrides: {
        backendId: "openshell",
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        containerWorkdir: "/sandbox",
      },
    });

    const { createOpenShellFsBridge } = await import("./fs-bridge.js");
    const bridge = createOpenShellFsBridge({ sandbox, backend });

    await expect(bridge.rename({ from: "source.txt", to: "nested/target.txt" })).rejects.toThrow(
      "remote rejected",
    );
    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("payload");
    await expectPathMissing(targetPath);
  });

  it("rejects symlink-parent writes instead of escaping the local mount root", async () => {
    const workspaceDir = await makeTempDir("openclaw-openshell-fs-");
    const outsideDir = await makeTempDir("openclaw-openshell-outside-");
    await fs.symlink(outsideDir, path.join(workspaceDir, "alias"));
    const backend = createMirrorBackendMock();
    const sandbox = createSandboxTestContext({
      overrides: {
        backendId: "openshell",
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        containerWorkdir: "/sandbox",
      },
    });

    const { createOpenShellFsBridge } = await import("./fs-bridge.js");
    const bridge = createOpenShellFsBridge({ sandbox, backend });

    await expect(
      bridge.writeFile({
        filePath: "alias/escape.txt",
        data: "owned",
        mkdir: true,
      }),
    ).rejects.toThrow("Sandbox path escapes allowed mounts");
    await expectPathMissing(path.join(outsideDir, "escape.txt"));
    await expect(fs.readdir(outsideDir)).resolves.toStrictEqual([]);
    expect(backend["syncLocalPathToRemote"]).not.toHaveBeenCalled();
  });

  it("rejects writes whose final target is a symlink inside the local mount root", async () => {
    const workspaceDir = await makeTempDir("openclaw-openshell-fs-");
    const linkedTarget = path.join(workspaceDir, "existing.txt");
    await fs.writeFile(linkedTarget, "keep", "utf8");
    await fs.symlink("existing.txt", path.join(workspaceDir, "link.txt"));
    const backend = createMirrorBackendMock();
    const sandbox = createSandboxTestContext({
      overrides: {
        backendId: "openshell",
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        containerWorkdir: "/sandbox",
      },
    });

    const { createOpenShellFsBridge } = await import("./fs-bridge.js");
    const bridge = createOpenShellFsBridge({ sandbox, backend });

    await expect(
      bridge.writeFile({
        filePath: "link.txt",
        data: "owned",
        mkdir: true,
      }),
    ).rejects.toThrow("Sandbox boundary checks failed");
    await expect(fs.readlink(path.join(workspaceDir, "link.txt"))).resolves.toBe("existing.txt");
    await expect(fs.readFile(linkedTarget, "utf8")).resolves.toBe("keep");
    expect(backend["syncLocalPathToRemote"]).not.toHaveBeenCalled();
  });

  it("rejects a parent symlink that lands outside the sandbox root", async () => {
    const workspaceDir = await makeTempDir("openclaw-openshell-fs-");
    const outsideDir = await makeTempDir("openclaw-openshell-outside-");
    await fs.writeFile(path.join(outsideDir, "secret.txt"), "outside", "utf8");
    await fs.symlink(outsideDir, path.join(workspaceDir, "subdir"));
    const backend = createMirrorBackendMock();
    const sandbox = createSandboxTestContext({
      overrides: {
        backendId: "openshell",
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        containerWorkdir: "/sandbox",
      },
    });

    const { createOpenShellFsBridge } = await import("./fs-bridge.js");
    const bridge = createOpenShellFsBridge({ sandbox, backend });

    await expect(bridge.readFile({ filePath: "subdir/secret.txt" })).rejects.toThrow(
      "Sandbox boundary checks failed",
    );
  });

  it("reads regular files through the shared safe fs root", async () => {
    const workspaceDir = await makeTempDir("openclaw-openshell-fs-");
    await fs.mkdir(path.join(workspaceDir, "subdir"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "subdir", "secret.txt"), "inside", "utf8");

    const backend = createMirrorBackendMock();
    const sandbox = createSandboxTestContext({
      overrides: {
        backendId: "openshell",
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        containerWorkdir: "/sandbox",
      },
    });

    const { createOpenShellFsBridge } = await import("./fs-bridge.js");
    const bridge = createOpenShellFsBridge({ sandbox, backend });

    await expect(bridge.readFile({ filePath: "subdir/secret.txt" })).resolves.toEqual(
      Buffer.from("inside"),
    );
  });

  it("reads materialized sandbox skills from the protected skills workspace", async () => {
    const workspaceDir = await makeTempDir("openclaw-openshell-fs-");
    const skillsWorkspaceDir = await makeTempDir("openclaw-openshell-skills-");
    const skillFile = path.join(skillsWorkspaceDir, "skills", "demo", "SKILL.md");
    const shadowFile = path.join(
      workspaceDir,
      ".openclaw",
      "sandbox-skills",
      "skills",
      "demo",
      "SKILL.md",
    );
    await fs.mkdir(path.dirname(skillFile), { recursive: true });
    await fs.mkdir(path.dirname(shadowFile), { recursive: true });
    await fs.writeFile(skillFile, "# Demo\nmaterialized\n", "utf8");
    await fs.writeFile(shadowFile, "# Demo\nworkspace shadow\n", "utf8");

    const backend = createMirrorBackendMock();
    const sandbox = createSandboxTestContext({
      overrides: {
        backendId: "openshell",
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        skillsWorkspaceDir,
        workspaceAccess: "rw",
        containerWorkdir: "/sandbox",
      },
    });

    const { createOpenShellFsBridge } = await import("./fs-bridge.js");
    const bridge = createOpenShellFsBridge({ sandbox, backend });

    await expect(
      bridge.readFile({
        filePath: "/sandbox/.openclaw/sandbox-skills/skills/demo/SKILL.md",
      }),
    ).resolves.toEqual(Buffer.from("# Demo\nmaterialized\n"));
    await expect(
      bridge.readFile({
        filePath: ".openclaw/sandbox-skills/skills/demo/SKILL.md",
      }),
    ).resolves.toEqual(Buffer.from("# Demo\nmaterialized\n"));
    await expect(
      bridge.writeFile({
        filePath: ".openclaw/sandbox-skills/skills/demo/SKILL.md",
        data: "owned",
      }),
    ).rejects.toThrow(/read-only/);
    await expect(
      bridge.writeFile({
        filePath: shadowFile,
        data: "owned",
      }),
    ).rejects.toThrow(/read-only/);
    expect(await fs.readFile(shadowFile, "utf8")).toContain("workspace shadow");
    expect(backend["syncLocalPathToRemote"]).not.toHaveBeenCalled();
  });

  it("rejects reads of a symlinked leaf", async () => {
    const workspaceDir = await makeTempDir("openclaw-openshell-fs-");
    const outsideDir = await makeTempDir("openclaw-openshell-outside-");
    await fs.mkdir(path.join(workspaceDir, "subdir"), { recursive: true });
    await fs.writeFile(path.join(outsideDir, "secret.txt"), "outside", "utf8");
    await fs.symlink(
      path.join(outsideDir, "secret.txt"),
      path.join(workspaceDir, "subdir", "secret.txt"),
    );

    const backend = createMirrorBackendMock();
    const sandbox = createSandboxTestContext({
      overrides: {
        backendId: "openshell",
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        containerWorkdir: "/sandbox",
      },
    });

    const { createOpenShellFsBridge } = await import("./fs-bridge.js");
    const bridge = createOpenShellFsBridge({ sandbox, backend });

    await expect(bridge.readFile({ filePath: "subdir/secret.txt" })).rejects.toThrow(
      "Sandbox boundary checks failed",
    );
  });

  it("rejects hardlinked files inside the sandbox root", async () => {
    const workspaceDir = await makeTempDir("openclaw-openshell-fs-");
    const outsideDir = await makeTempDir("openclaw-openshell-outside-");
    await fs.mkdir(path.join(workspaceDir, "subdir"), { recursive: true });
    await fs.writeFile(path.join(outsideDir, "secret.txt"), "outside", "utf8");
    await fs.link(
      path.join(outsideDir, "secret.txt"),
      path.join(workspaceDir, "subdir", "secret.txt"),
    );

    const backend = createMirrorBackendMock();
    const sandbox = createSandboxTestContext({
      overrides: {
        backendId: "openshell",
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        containerWorkdir: "/sandbox",
      },
    });

    const { createOpenShellFsBridge } = await import("./fs-bridge.js");
    const bridge = createOpenShellFsBridge({ sandbox, backend });

    await expect(bridge.readFile({ filePath: "subdir/secret.txt" })).rejects.toThrow(
      "Sandbox boundary checks failed",
    );
  });

  it("maps agent mount paths when the sandbox workspace is read-only", async () => {
    const workspaceDir = await makeTempDir("openclaw-openshell-fs-");
    const agentWorkspaceDir = await makeTempDir("openclaw-openshell-agent-");
    await fs.writeFile(path.join(agentWorkspaceDir, "note.txt"), "agent", "utf8");
    const backend = createMirrorBackendMock();
    const sandbox = createSandboxTestContext({
      overrides: {
        backendId: "openshell",
        workspaceDir,
        agentWorkspaceDir,
        workspaceAccess: "ro",
        containerWorkdir: "/sandbox",
      },
    });

    const { createOpenShellFsBridge } = await import("./fs-bridge.js");
    const bridge = createOpenShellFsBridge({ sandbox, backend });
    const resolved = bridge.resolvePath({ filePath: "/agent/note.txt" });
    expect(resolved.hostPath).toBe(path.join(agentWorkspaceDir, "note.txt"));
    expect(await bridge.readFile({ filePath: "/agent/note.txt" })).toEqual(Buffer.from("agent"));
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
