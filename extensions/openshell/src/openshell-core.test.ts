// Openshell tests cover openshell core plugin behavior.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import {
  buildExecRemoteCommand,
  disposeSshSandboxSession,
  shellEscape,
} from "openclaw/plugin-sdk/sandbox";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspace,
  type TempWorkspace,
} from "openclaw/plugin-sdk/temp-path";
import { createSandboxTestContext } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenShellSandboxBackend } from "./backend.types.js";
import {
  buildValidatedExecRemoteCommand,
  createOpenShellSshSession,
  runOpenShellCli,
} from "./cli.js";
import { resolveOpenShellPluginConfig } from "./config.js";
import {
  createOpenShellBackendSandboxConfig,
  createOpenShellRuntimeEntryFixture,
} from "./openshell.test-support.js";

const openShellTestWorkspaceRoot = resolvePreferredOpenClawTmpDir();

function createOpenShellTestWorkspace(label: string): Promise<TempWorkspace> {
  return tempWorkspace({
    rootDir: openShellTestWorkspaceRoot,
    prefix: `openclaw-openshell-${label}-`,
  });
}

const cliMocks = vi.hoisted(() => ({
  runOpenShellCli: vi.fn(),
  createOpenShellSshSession: vi.fn(),
}));

const sandboxMocks = vi.hoisted(() => ({
  runSshSandboxCommand: vi.fn(),
  disposeSshSandboxSession: vi.fn(),
  prepareSshSandboxExec: vi.fn(),
  cleanupPreparedExec: vi.fn(),
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
      prepareSshSandboxExec: sandboxMocks.prepareSshSandboxExec,
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
  sandboxMocks.cleanupPreparedExec.mockResolvedValue(undefined);
  sandboxMocks.prepareSshSandboxExec.mockImplementation(
    async (params: {
      session: { command: string; configPath: string; host: string };
      tty?: boolean;
    }) => ({
      argv: [
        params.session.command,
        "-F",
        params.session.configPath,
        ...(params.tty ? ["-tt", "-o", "RequestTTY=force"] : ["-T", "-o", "RequestTTY=no"]),
        params.session.host,
        "'/bin/sh' '/tmp/openclaw-synthetic-staging/run.sh'",
      ],
      cleanup: sandboxMocks.cleanupPreparedExec,
    }),
  );
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

  it("wraps exec commands with workdir when no environment is supplied", () => {
    const command = buildExecRemoteCommand({
      command: "pwd && printenv TOKEN",
      workdir: "/sandbox/project",
      env: {},
    });
    expect(command).not.toContain(`'env'`);
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
          workspace: "research",
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
      "--workspace",
      "research",
      "sandbox",
      "get",
      "demo",
    ]);
  });

  it("preserves the ambient workspace when workspace is not configured", async () => {
    process.env.OPENSHELL_WORKSPACE = "ambient";
    const openshellCommand = await makeExecutable({
      name: "openshell",
      script: ["#!/bin/sh", `printf '%s\\n' "$OPENSHELL_WORKSPACE|$*" >> "__LOG__"`, "exit 0"].join(
        "\n",
      ),
    });

    await runOpenShellCli({
      context: {
        sandboxName: "demo",
        config: resolveOpenShellPluginConfig({ command: openshellCommand }),
      },
      args: ["sandbox", "get", "demo"],
    });

    await expect(fs.readFile(process.env.OPEN_SHELL_CLI_TEST_LOG as string, "utf8")).resolves.toBe(
      "ambient|sandbox get demo\n",
    );
  });

  it.runIf(process.platform !== "win32")(
    "preserves workspace selection when adding a direct gateway endpoint",
    async () => {
      const configText = [
        "Host openshell-demo.research",
        "    User sandbox",
        "    ProxyCommand /usr/local/bin/openshell ssh-proxy --gateway-name alice --name demo --workspace research",
        "",
      ].join("\n");

      await expect(
        readOpenShellSshConfig({
          configText,
          gatewayEndpoint: "http://openshell.openshell-alice.svc.cluster.local:8080",
          workspace: "research",
        }),
      ).resolves.toContain(
        "ProxyCommand /usr/local/bin/openshell ssh-proxy --gateway-name alice --name demo --workspace research --server 'http://openshell.openshell-alice.svc.cluster.local:8080'",
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

  it("builds deterministic OpenShell-compatible sandbox names", async () => {
    const factory = createOpenShellSandboxBackendFactory({
      pluginConfig: resolveOpenShellPluginConfig({ command: "openshell" }),
    });
    const createBackend = async (scopeKey: string, registeredRuntimeIds?: readonly string[]) =>
      await factory({
        sessionKey: `${scopeKey}:turn`,
        scopeKey,
        ...(registeredRuntimeIds ? { registeredRuntimeIds } : {}),
        workspaceDir: "/tmp/workspace",
        agentWorkspaceDir: "/tmp/workspace",
        cfg: createOpenShellBackendSandboxConfig(),
      });

    const first = await createBackend("agent:main");
    const repeated = await createBackend("agent:main");
    const other = await createBackend("agent:other");
    const workspaceScoped = await createBackend(`agent:main:workspace:${"a".repeat(32)}`);
    const legacyRuntimeId = "openclaw-agent-main-25bffc4d";
    const adoptedLegacy = await createBackend("agent:main", [legacyRuntimeId]);
    const punctuationLegacyRuntimeId = "openclaw-agent-foo-bar-baz-ab401a99";
    const adoptedPunctuationLegacy = await createBackend("agent:foo_bar.baz", [
      punctuationLegacyRuntimeId,
    ]);
    const ignoresUnknown = await createBackend("agent:main", ["unrelated-runtime"]);
    const prefersCurrent = await createBackend("agent:main", [legacyRuntimeId, first.runtimeId]);

    expect(first.runtimeId).toMatch(/^oc-[a-f0-9]{16}$/u);
    expect(first.runtimeId).toHaveLength(19);
    expect(repeated.runtimeId).toBe(first.runtimeId);
    expect(other.runtimeId).not.toBe(first.runtimeId);
    expect(workspaceScoped.runtimeId).toMatch(/^oc-[a-z0-9]{16}$/u);
    expect(workspaceScoped.runtimeId).toHaveLength(19);
    expect(workspaceScoped.runtimeId).not.toBe(first.runtimeId);
    expect(adoptedLegacy.runtimeId).toBe(legacyRuntimeId);
    expect(adoptedPunctuationLegacy.runtimeId).toBe(punctuationLegacyRuntimeId);
    expect(ignoresUnknown.runtimeId).toBe(first.runtimeId);
    expect(prefersCurrent.runtimeId).toBe(first.runtimeId);
  });

  it("does not recreate an unreachable registered legacy sandbox name", async () => {
    const scopeKey = "agent:main'$(touch /tmp/pwn)";
    const legacyRuntimeId = "openclaw-agent-main-touch-tmp-pwn-87608e6a";
    cliMocks.runOpenShellCli.mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "sandbox not found",
    });
    const factory = createOpenShellSandboxBackendFactory({
      pluginConfig: resolveOpenShellPluginConfig({ command: "openshell", mode: "remote" }),
    });
    const backend = await factory({
      sessionKey: `${scopeKey}:turn`,
      scopeKey,
      registeredRuntimeIds: [legacyRuntimeId],
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg: createOpenShellBackendSandboxConfig(),
    });

    await expect(
      backend.runShellCommand({
        script: "true",
      }),
    ).rejects.toThrow(
      `Run \`openclaw sandbox recreate --session ${shellEscape(scopeKey)}\` to migrate this scope`,
    );
    expect(cliMocks.runOpenShellCli).toHaveBeenCalledTimes(1);
    expect(cliMocks.runOpenShellCli).not.toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.arrayContaining(["create"]),
      }),
    );
  });

  it.each([
    ["gateway authentication expired", "gateway authentication expired"],
    ["", "openshell sandbox get failed"],
  ])(
    "does not create a sandbox after a failed control-plane lookup: %s",
    async (stderr, expected) => {
      cliMocks.runOpenShellCli.mockResolvedValue({ code: 1, stdout: "", stderr });
      const factory = createOpenShellSandboxBackendFactory({
        pluginConfig: resolveOpenShellPluginConfig({ command: "openshell", mode: "remote" }),
      });
      const backend = await factory({
        sessionKey: "agent:main:turn",
        scopeKey: "agent:main",
        workspaceDir: "/tmp/workspace",
        agentWorkspaceDir: "/tmp/workspace",
        cfg: createOpenShellBackendSandboxConfig(),
      });

      await expect(backend.runShellCommand({ script: "true" })).rejects.toThrow(expected);
      expect(cliMocks.runOpenShellCli).toHaveBeenCalledOnce();
    },
  );

  it("does not execute a registered legacy sandbox that is no longer ready", async () => {
    const scopeKey = "agent:main";
    const legacyRuntimeId = "openclaw-agent-main-25bffc4d";
    cliMocks.runOpenShellCli
      .mockResolvedValueOnce({
        code: 0,
        stdout: "sandbox detail",
        stderr: "",
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify(
          Array.from({ length: 100 }, (_, index) => ({
            name: `other-${index}`,
            phase: "Ready",
          })),
        ),
        stderr: "",
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify([{ name: legacyRuntimeId, phase: "Error" }]),
        stderr: "",
      });
    const factory = createOpenShellSandboxBackendFactory({
      pluginConfig: resolveOpenShellPluginConfig({ command: "openshell", mode: "remote" }),
    });
    const backend = await factory({
      sessionKey: `${scopeKey}:turn`,
      scopeKey,
      registeredRuntimeIds: [legacyRuntimeId],
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg: createOpenShellBackendSandboxConfig(),
    });

    await expect(backend.runShellCommand({ script: "true" })).rejects.toThrow(
      'OpenShell reports phase "Error".',
    );
    expect(cliMocks.runOpenShellCli).toHaveBeenNthCalledWith(2, {
      context: expect.objectContaining({
        sandboxName: legacyRuntimeId,
      }),
      args: ["sandbox", "list", "--limit", "100", "--offset", "0", "--output", "json"],
      cwd: "/tmp/workspace",
    });
    expect(cliMocks.runOpenShellCli).toHaveBeenNthCalledWith(3, {
      context: expect.objectContaining({
        sandboxName: legacyRuntimeId,
      }),
      args: ["sandbox", "list", "--limit", "100", "--offset", "100", "--output", "json"],
      cwd: "/tmp/workspace",
    });
    expect(cliMocks.runOpenShellCli).not.toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.arrayContaining(["create"]),
      }),
    );
    expect(cliMocks.createOpenShellSshSession).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== "win32")(
    "clears the materialized skills directory through the remote backend boundary",
    async () => {
      await using workspace = await createOpenShellTestWorkspace("workspace");
      const workspaceDir = workspace.dir;
      await using skillsWorkspace = await createOpenShellTestWorkspace("skills");
      const skillsWorkspaceDir = skillsWorkspace.dir;
      await using remoteWorkspace = await createOpenShellTestWorkspace("remote");
      sandboxMocks.remoteRoot = remoteWorkspace.dir;
      await using remoteAgentWorkspace = await createOpenShellTestWorkspace("agent-remote");
      sandboxMocks.remoteAgentRoot = remoteAgentWorkspace.dir;
      const materializedDir = path.join(sandboxMocks.remoteRoot, ".openclaw", "sandbox-skills");
      await fs.mkdir(materializedDir, { recursive: true });
      await fs.writeFile(path.join(materializedDir, "stale.txt"), "stale", "utf8");
      await fs.writeFile(path.join(skillsWorkspaceDir, "SKILL.md"), "# Skill\n", "utf8");
      cliMocks.runOpenShellCli.mockResolvedValue({ code: 0, stdout: "", stderr: "" });

      const backend = await createOpenShellBackendFixture({
        workspaceDir,
        skillsWorkspaceDir,
        mode: "remote",
      });
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
      await using workspace = await createOpenShellTestWorkspace("workspace");
      const workspaceDir = workspace.dir;
      await using skillsWorkspace = await createOpenShellTestWorkspace("skills");
      const skillsWorkspaceDir = skillsWorkspace.dir;
      await using remoteWorkspace = await createOpenShellTestWorkspace("remote");
      sandboxMocks.remoteRoot = remoteWorkspace.dir;
      await using remoteAgentWorkspace = await createOpenShellTestWorkspace("agent-remote");
      sandboxMocks.remoteAgentRoot = remoteAgentWorkspace.dir;
      await using outsideWorkspace = await createOpenShellTestWorkspace("outside");
      const outsideDir = outsideWorkspace.dir;
      await fs.symlink(outsideDir, path.join(sandboxMocks.remoteRoot, ".openclaw"));
      await fs.writeFile(path.join(skillsWorkspaceDir, "SKILL.md"), "# Skill\n", "utf8");
      cliMocks.runOpenShellCli.mockResolvedValue({ code: 0, stdout: "", stderr: "" });

      const backend = await createOpenShellBackendFixture({
        workspaceDir,
        skillsWorkspaceDir,
        mode: "remote",
      });
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
      stdout: JSON.stringify({ phase: "Ready" }),
      stderr: "",
    });

    const manager = createOpenShellSandboxBackendManager({
      pluginConfig: resolveOpenShellPluginConfig({
        command: "openshell",
        from: "openclaw",
      }),
    });

    const result = await manager.describeRuntime({
      entry: createOpenShellRuntimeEntryFixture("openclaw-session-1234", "custom-source"),
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
      args: ["sandbox", "get", "openclaw-session-1234", "--output", "json"],
    });
  });

  it.each(["Provisioning", "Stopped", "Error", "Deleting"])(
    "does not report an OpenShell runtime in phase %s as running",
    async (phase) => {
      cliMocks.runOpenShellCli.mockResolvedValue({
        code: 0,
        stdout: JSON.stringify({ phase }),
        stderr: "",
      });
      const manager = createOpenShellSandboxBackendManager({
        pluginConfig: resolveOpenShellPluginConfig({ command: "openshell" }),
      });

      await expect(
        manager.describeRuntime({
          entry: createOpenShellRuntimeEntryFixture("openclaw-session-1234"),
          config: {},
        }),
      ).resolves.toMatchObject({ running: false });
    },
  );

  it("removes runtimes using the current OpenShell control-plane configuration", async () => {
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
      entry: createOpenShellRuntimeEntryFixture("openclaw-session-5678"),
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

    await manager.removeRuntime({
      entry: createOpenShellRuntimeEntryFixture("openclaw-session-5678"),
      config: {
        plugins: {
          entries: {
            openshell: {
              enabled: true,
              config: {
                command: "/opt/openshell/bin/openshell",
                gateway: "research",
                workspace: "team-1",
              },
            },
          },
        },
      },
    });

    expect(cliMocks.runOpenShellCli).toHaveBeenLastCalledWith({
      context: {
        sandboxName: "openclaw-session-5678",
        config: resolveOpenShellPluginConfig({
          command: "/opt/openshell/bin/openshell",
          gateway: "research",
          workspace: "team-1",
        }),
      },
      args: ["sandbox", "delete", "openclaw-session-5678"],
    });
  });

  it.each([
    ["gateway unavailable", "gateway unavailable"],
    ["", "openshell sandbox delete failed"],
  ])("preserves deletion failures for sandbox lifecycle owners: %s", async (stderr, expected) => {
    cliMocks.runOpenShellCli.mockResolvedValue({
      code: 1,
      stdout: "",
      stderr,
    });

    const manager = createOpenShellSandboxBackendManager({
      pluginConfig: resolveOpenShellPluginConfig({ command: "openshell" }),
    });

    await expect(
      manager.removeRuntime({
        entry: createOpenShellRuntimeEntryFixture("openclaw-session-5678"),
        config: {},
      }),
    ).rejects.toThrow(expected);
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

  it.each(["completed", "failed"] as const)(
    "stages exec environment outside SSH argv and finalizes %s before session disposal",
    async (status) => {
      const sentinel = "synthetic-openshell-env-value";
      cliMocks.runOpenShellCli.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
      sandboxMocks.runSshSandboxCommand.mockResolvedValueOnce({
        stdout: Buffer.from("1\n"),
        stderr: Buffer.alloc(0),
        code: 0,
      });
      const backend = await createOpenShellBackendFixture({
        workspaceDir: "/tmp/openclaw-synthetic-workspace",
        mode: "remote",
      });

      const execSpec = await backend.buildExecSpec({
        command: "printenv SYNTHETIC_VALUE",
        workdir: "/sandbox",
        env: { SYNTHETIC_VALUE: sentinel },
        usePty: true,
      });

      expect(sandboxMocks.prepareSshSandboxExec).toHaveBeenCalledWith({
        session: expect.objectContaining({ host: "openshell-test" }),
        remoteCommand: expect.stringContaining("printenv SYNTHETIC_VALUE"),
        env: { SYNTHETIC_VALUE: sentinel },
        tty: true,
      });
      expect(execSpec.argv.join(" ")).not.toContain(sentinel);
      expect(execSpec.argv).toContain("-tt");
      expect(execSpec.argv.join(" ")).not.toContain("SetEnv");
      expect(execSpec.stdinMode).toBe("pipe-open");

      sandboxMocks.disposeSshSandboxSession.mockClear();
      await backend.finalizeExec?.({
        status,
        exitCode: status === "completed" ? 0 : 1,
        timedOut: false,
        token: execSpec.finalizeToken,
      });

      expect(sandboxMocks.cleanupPreparedExec).toHaveBeenCalledOnce();
      expect(sandboxMocks.disposeSshSandboxSession).toHaveBeenCalledWith(
        expect.objectContaining({ host: "openshell-test" }),
      );
      expect(sandboxMocks.cleanupPreparedExec.mock.invocationCallOrder[0]).toBeLessThan(
        expectDefined(
          sandboxMocks.disposeSshSandboxSession.mock.invocationCallOrder[0],
          "OpenShell SSH session disposal invocation",
        ),
      );
    },
  );

  it("disposes the OpenShell SSH session when secure exec staging fails", async () => {
    cliMocks.runOpenShellCli.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    sandboxMocks.runSshSandboxCommand.mockResolvedValueOnce({
      stdout: Buffer.from("1\n"),
      stderr: Buffer.alloc(0),
      code: 0,
    });
    sandboxMocks.prepareSshSandboxExec.mockRejectedValueOnce(
      new Error("synthetic staging failure"),
    );
    const backend = await createOpenShellBackendFixture({
      workspaceDir: "/tmp/openclaw-synthetic-workspace",
      mode: "remote",
    });

    await expect(
      backend.buildExecSpec({
        command: "true",
        env: { SYNTHETIC_VALUE: "synthetic-openshell-env-value" },
        usePty: false,
      }),
    ).rejects.toThrow("synthetic staging failure");

    expect(sandboxMocks.disposeSshSandboxSession).toHaveBeenCalledTimes(2);
  });

  it("preserves a local sandbox skills shadow when mirror sync crosses filesystems", async () => {
    await using workspace = await createOpenShellTestWorkspace("workspace");
    const workspaceDir = workspace.dir;
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

    const backend = await createOpenShellBackendFixture({ workspaceDir, mode: "mirror" });

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
    await using workspace = await createOpenShellTestWorkspace("workspace");
    const workspaceDir = workspace.dir;
    cliMocks.runOpenShellCli.mockImplementation(async ({ args }: { args: string[] }) => {
      if (args[0] === "sandbox" && args[1] === "download") {
        const tmpDir = expectDefined(args[4], "OpenShell download destination");
        await fs.writeFile(path.join(tmpDir, "from-remote.txt"), "remote", "utf8");
        await fs.mkdir(path.join(tmpDir, ".openclaw"), { recursive: true });
        await fs.writeFile(path.join(tmpDir, ".openclaw", "sandbox-skills"), "poison", "utf8");
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const backend = await createOpenShellBackendFixture({ workspaceDir, mode: "mirror" });

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
    await using workspace = await createOpenShellTestWorkspace("workspace");
    const workspaceDir = workspace.dir;
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

    const backend = await createOpenShellBackendFixture({ workspaceDir, mode: "mirror" });

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

const executableWorkspaces: TempWorkspace[] = [];

async function makeExecutable(params: { name: string; script: string }): Promise<string> {
  const workspace = await createOpenShellTestWorkspace("bin");
  executableWorkspaces.push(workspace);
  const dir = workspace.dir;
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
  workspace?: string;
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
        workspace: params.workspace,
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
  await Promise.all(executableWorkspaces.splice(0).map((workspace) => workspace.cleanup()));
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

async function createOpenShellBackendFixture(params: {
  workspaceDir: string;
  mode: "mirror" | "remote";
  skillsWorkspaceDir?: string;
}): Promise<OpenShellSandboxBackend> {
  const factory = createOpenShellSandboxBackendFactory({
    pluginConfig: resolveOpenShellPluginConfig({ command: "openshell", mode: params.mode }),
  });
  return (await factory({
    sessionKey: "agent:main:turn",
    scopeKey: "agent:main",
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.workspaceDir,
    ...(params.skillsWorkspaceDir ? { skillsWorkspaceDir: params.skillsWorkspaceDir } : {}),
    cfg: createOpenShellBackendSandboxConfig(),
  })) as OpenShellSandboxBackend;
}

async function createMirrorFsBridgeFixture(
  workspaceDir: string,
  backend: OpenShellSandboxBackend = createMirrorBackendMock(),
) {
  const sandbox = createSandboxTestContext({
    overrides: {
      backendId: "openshell",
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      containerWorkdir: "/sandbox",
    },
  });
  const { createOpenShellFsBridge } = await import("./fs-bridge.js");
  return { backend, bridge: createOpenShellFsBridge({ sandbox, backend }) };
}

describe("openshell fs bridges", () => {
  beforeAll(installOpenShellBackendMocks);
  afterAll(uninstallOpenShellBackendMocks);
  beforeEach(resetOpenShellBackendMocks);

  it.each(["/sandbox/../outside.txt", "/sandbox/nested/../../outside.txt"])(
    "rejects workspace container paths that escape the managed root: %s",
    async (filePath) => {
      await using workspace = await createOpenShellTestWorkspace("fs-path");
      const { bridge } = await createMirrorFsBridgeFixture(workspace.dir);

      expect(() => bridge.resolvePath({ filePath })).toThrow("Sandbox path escapes allowed mounts");
    },
  );

  it("rejects agent container paths that escape the managed root", async () => {
    await using workspace = await createOpenShellTestWorkspace("fs-path");
    await using agentWorkspace = await createOpenShellTestWorkspace("fs-agent");
    const sandbox = createSandboxTestContext({
      overrides: {
        backendId: "openshell",
        workspaceDir: workspace.dir,
        agentWorkspaceDir: agentWorkspace.dir,
        workspaceAccess: "rw",
        containerWorkdir: "/sandbox",
      },
    });
    const { createOpenShellFsBridge } = await import("./fs-bridge.js");
    const bridge = createOpenShellFsBridge({ sandbox, backend: createMirrorBackendMock() });

    expect(() => bridge.resolvePath({ filePath: "/agent/../outside.txt" })).toThrow(
      "Sandbox path escapes allowed mounts",
    );
  });

  it.each(["remote", "mirror"] as const)(
    "keeps the factory backend as the canonical owner of the %s filesystem bridge",
    async (mode) => {
      await using workspace = await createOpenShellTestWorkspace("fs-owner");
      const workspaceDir = workspace.dir;
      sandboxMocks.remoteRoot = workspaceDir;
      sandboxMocks.remoteAgentRoot = workspaceDir;
      cliMocks.runOpenShellCli.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
      const backend = await createOpenShellBackendFixture({ workspaceDir, mode });
      const sandbox = createSandboxTestContext({
        overrides: {
          backendId: "openshell",
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
          containerWorkdir: "/sandbox",
        },
      });
      const bridge = backend.createFsBridge?.({ sandbox });
      if (!bridge) {
        throw new Error("Expected an OpenShell filesystem bridge");
      }
      expect(bridge.resolvePath({ filePath: "owner.txt" })).toEqual({
        ...(mode === "mirror" ? { hostPath: path.join(workspaceDir, "owner.txt") } : {}),
        relativePath: "owner.txt",
        containerPath: "/sandbox/owner.txt",
      });

      if (mode === "remote") {
        const runRemoteShellScript = vi.spyOn(backend, "runRemoteShellScript").mockResolvedValue({
          stdout: Buffer.from("0\n"),
          stderr: Buffer.alloc(0),
          code: 0,
        });
        await expect(bridge.stat({ filePath: "owner.txt" })).resolves.toBeNull();
        expect(runRemoteShellScript).toHaveBeenCalledOnce();
        return;
      }

      const syncLocalPathToRemote = vi
        .spyOn(backend, "syncLocalPathToRemote")
        .mockResolvedValue(undefined);
      await bridge.writeFile({ filePath: "owner.txt", data: "owner" });
      expect(syncLocalPathToRemote).toHaveBeenCalledWith(
        path.join(workspaceDir, "owner.txt"),
        "/sandbox/owner.txt",
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects remote-only symlink parents in pinned mirror mutations",
    async () => {
      await using stateWorkspace = await createOpenShellTestWorkspace("remote-pin");
      const stateDir = stateWorkspace.dir;
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
      const backend = await createOpenShellBackendFixture({
        workspaceDir: stateDir,
        mode: "remote",
      });
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
    await using workspace = await createOpenShellTestWorkspace("fs");
    const workspaceDir = workspace.dir;
    const { backend, bridge } = await createMirrorFsBridgeFixture(workspaceDir);
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

  it("creates mirror files exclusively before syncing them", async () => {
    await using workspace = await createOpenShellTestWorkspace("fs");
    const workspaceDir = workspace.dir;
    const { backend, bridge } = await createMirrorFsBridgeFixture(workspaceDir);
    const createFileExclusive = bridge.createFileExclusive?.bind(bridge);
    expect(createFileExclusive).toBeTypeOf("function");

    await expect(
      createFileExclusive!({ filePath: "nested/file.txt", data: "first" }),
    ).resolves.toBe("created");
    await expect(
      createFileExclusive!({ filePath: "nested/file.txt", data: "replacement" }),
    ).resolves.toBe("exists");
    await expect(fs.readFile(path.join(workspaceDir, "nested", "file.txt"), "utf8")).resolves.toBe(
      "first",
    );
    expect(backend["syncLocalPathToRemote"]).toHaveBeenCalledTimes(1);
  });

  it("keeps the canonical local exclusive create when mirror sync fails", async () => {
    await using workspace = await createOpenShellTestWorkspace("fs");
    const workspaceDir = workspace.dir;
    const backend = createMirrorBackendMock();
    backend["syncLocalPathToRemote"] = vi.fn().mockRejectedValue(new Error("remote rejected"));
    const { bridge } = await createMirrorFsBridgeFixture(workspaceDir, backend);
    const createFileExclusive = bridge.createFileExclusive?.bind(bridge);
    expect(createFileExclusive).toBeTypeOf("function");

    await expect(createFileExclusive!({ filePath: "file.txt", data: "canonical" })).rejects.toThrow(
      "remote rejected",
    );
    await expect(fs.readFile(path.join(workspaceDir, "file.txt"), "utf8")).resolves.toBe(
      "canonical",
    );
  });

  it("creates remote mirror directories through the pinned backend operation", async () => {
    await using workspace = await createOpenShellTestWorkspace("fs");
    const workspaceDir = workspace.dir;
    const { backend, bridge } = await createMirrorFsBridgeFixture(workspaceDir);
    await bridge.mkdirp({ filePath: "nested/dir" });

    await expect(fs.stat(path.join(workspaceDir, "nested", "dir"))).resolves.toBeDefined();
    expect(backend["mkdirpRemotePath"]).toHaveBeenCalledWith("/sandbox/nested/dir", undefined);
    expect(backend["runRemoteShellScript"]).not.toHaveBeenCalled();
  });

  it("renames remote mirror paths through the pinned backend operation", async () => {
    await using workspace = await createOpenShellTestWorkspace("fs");
    const workspaceDir = workspace.dir;
    await fs.writeFile(path.join(workspaceDir, "source.txt"), "payload", "utf8");
    const { backend, bridge } = await createMirrorFsBridgeFixture(workspaceDir);
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
    await using workspace = await createOpenShellTestWorkspace("fs");
    const workspaceDir = workspace.dir;
    await using agentWorkspace = await createOpenShellTestWorkspace("agent-fs");
    const agentWorkspaceDir = agentWorkspace.dir;
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
      await using workspace = await createOpenShellTestWorkspace("fs");
      const workspaceDir = workspace.dir;
      await fs.writeFile(path.join(workspaceDir, "target.txt"), "payload", "utf8");
      await fs.symlink("target.txt", path.join(workspaceDir, "link.txt"));
      const { backend, bridge } = await createMirrorFsBridgeFixture(workspaceDir);

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
      await using workspace = await createOpenShellTestWorkspace("fs");
      const workspaceDir = workspace.dir;
      const sourcePath = path.join(workspaceDir, "source.txt");
      await fs.writeFile(sourcePath, "payload", "utf8");
      await fs.link(sourcePath, path.join(workspaceDir, "other-link.txt"));
      const { backend, bridge } = await createMirrorFsBridgeFixture(workspaceDir);

      await expect(bridge.rename({ from: "source.txt", to: "moved.txt" })).rejects.toThrow(
        "Sandbox hardlinked rename sources are not supported",
      );
      expect(backend["renameRemotePath"]).not.toHaveBeenCalled();
      await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("payload");
      await expectPathMissing(path.join(workspaceDir, "moved.txt"));
    },
  );

  it("removes remote mirror paths through the pinned backend operation", async () => {
    await using workspace = await createOpenShellTestWorkspace("fs");
    const workspaceDir = workspace.dir;
    await fs.writeFile(path.join(workspaceDir, "target.txt"), "payload", "utf8");
    const { backend, bridge } = await createMirrorFsBridgeFixture(workspaceDir);
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
    await using workspace = await createOpenShellTestWorkspace("fs");
    const workspaceDir = workspace.dir;
    await fs.mkdir(path.join(workspaceDir, "nested", "child"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "nested", "child", "target.txt"), "payload", "utf8");
    const { backend, bridge } = await createMirrorFsBridgeFixture(workspaceDir);
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
      await using workspace = await createOpenShellTestWorkspace("fs");
      const workspaceDir = workspace.dir;
      await using outsideWorkspace = await createOpenShellTestWorkspace("outside");
      const outsideDir = outsideWorkspace.dir;
      const outsideTarget = path.join(outsideDir, "target.txt");
      await fs.mkdir(path.join(workspaceDir, "nested"), { recursive: true });
      await fs.writeFile(outsideTarget, "outside", "utf8");
      await fs.symlink(outsideTarget, path.join(workspaceDir, "nested", "link.txt"));
      const { bridge } = await createMirrorFsBridgeFixture(workspaceDir);
      await bridge.remove({ filePath: "nested", recursive: true, force: true });

      await expectPathMissing(path.join(workspaceDir, "nested"));
      await expect(fs.readFile(outsideTarget, "utf8")).resolves.toBe("outside");
    },
  );

  it.runIf(process.platform !== "win32")(
    "removes local mirror symlink leaves when force is false",
    async () => {
      await using workspace = await createOpenShellTestWorkspace("fs");
      const workspaceDir = workspace.dir;
      await using outsideWorkspace = await createOpenShellTestWorkspace("outside");
      const outsideDir = outsideWorkspace.dir;
      const outsideTarget = path.join(outsideDir, "target.txt");
      await fs.writeFile(outsideTarget, "outside", "utf8");
      await fs.symlink(outsideTarget, path.join(workspaceDir, "link.txt"));
      const { backend, bridge } = await createMirrorFsBridgeFixture(workspaceDir);
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
      await using workspace = await createOpenShellTestWorkspace("fs");
      const workspaceDir = workspace.dir;
      await using outsideWorkspace = await createOpenShellTestWorkspace("outside");
      const outsideDir = outsideWorkspace.dir;
      const slotPath = path.join(workspaceDir, "slot");
      await fs.mkdir(slotPath, { recursive: true });
      const backend = createMirrorBackendMock();
      backend["mkdirpRemotePath"] = vi.fn().mockImplementation(async () => {
        await fs.rm(slotPath, { recursive: true, force: true });
        await fs.symlink(outsideDir, slotPath);
      });
      const { bridge } = await createMirrorFsBridgeFixture(workspaceDir, backend);

      await expect(bridge.mkdirp({ filePath: "slot/escaped" })).rejects.toThrow();
      await expectPathMissing(path.join(outsideDir, "escaped"));
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects local mirror remove when a validated parent is swapped to an outside symlink",
    async () => {
      await using workspace = await createOpenShellTestWorkspace("fs");
      const workspaceDir = workspace.dir;
      await using outsideWorkspace = await createOpenShellTestWorkspace("outside");
      const outsideDir = outsideWorkspace.dir;
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
      const { bridge } = await createMirrorFsBridgeFixture(workspaceDir, backend);

      await expect(bridge.remove({ filePath: "slot/target.txt", force: true })).rejects.toThrow();
      await expect(fs.readFile(outsideTarget, "utf8")).resolves.toBe("outside");
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects local mirror rename when a validated destination parent is swapped to an outside symlink",
    async () => {
      await using workspace = await createOpenShellTestWorkspace("fs");
      const workspaceDir = workspace.dir;
      await using outsideWorkspace = await createOpenShellTestWorkspace("outside");
      const outsideDir = outsideWorkspace.dir;
      const slotPath = path.join(workspaceDir, "slot");
      const sourcePath = path.join(workspaceDir, "source.txt");
      await fs.mkdir(slotPath, { recursive: true });
      await fs.writeFile(sourcePath, "payload", "utf8");
      const backend = createMirrorBackendMock();
      backend["renameRemotePath"] = vi.fn().mockImplementation(async () => {
        await fs.rm(slotPath, { recursive: true, force: true });
        await fs.symlink(outsideDir, slotPath);
      });
      const { bridge } = await createMirrorFsBridgeFixture(workspaceDir, backend);

      await expect(
        bridge.rename({ from: "source.txt", to: "slot/parent/moved.txt" }),
      ).rejects.toThrow();
      await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("payload");
      await expectPathMissing(path.join(outsideDir, "parent", "moved.txt"));
    },
  );

  it("keeps local mirror state unchanged when remote pinned mkdir is rejected", async () => {
    await using workspace = await createOpenShellTestWorkspace("fs");
    const workspaceDir = workspace.dir;
    const backend = createMirrorBackendMock();
    backend["mkdirpRemotePath"] = vi.fn().mockRejectedValue(new Error("remote rejected"));
    const { bridge } = await createMirrorFsBridgeFixture(workspaceDir, backend);

    await expect(bridge.mkdirp({ filePath: "alias/escaped" })).rejects.toThrow("remote rejected");
    await expectPathMissing(path.join(workspaceDir, "alias"));
  });

  it("keeps local mirror state unchanged when remote pinned remove is rejected", async () => {
    await using workspace = await createOpenShellTestWorkspace("fs");
    const workspaceDir = workspace.dir;
    const targetPath = path.join(workspaceDir, "target.txt");
    await fs.writeFile(targetPath, "payload", "utf8");
    const backend = createMirrorBackendMock();
    backend["removeRemotePath"] = vi.fn().mockRejectedValue(new Error("remote rejected"));
    const { bridge } = await createMirrorFsBridgeFixture(workspaceDir, backend);

    await expect(bridge.remove({ filePath: "target.txt", force: true })).rejects.toThrow(
      "remote rejected",
    );
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("payload");
  });

  it("keeps local mirror state unchanged when remote pinned rename is rejected", async () => {
    await using workspace = await createOpenShellTestWorkspace("fs");
    const workspaceDir = workspace.dir;
    const sourcePath = path.join(workspaceDir, "source.txt");
    const targetPath = path.join(workspaceDir, "nested", "target.txt");
    await fs.writeFile(sourcePath, "payload", "utf8");
    const backend = createMirrorBackendMock();
    backend["renameRemotePath"] = vi.fn().mockRejectedValue(new Error("remote rejected"));
    const { bridge } = await createMirrorFsBridgeFixture(workspaceDir, backend);

    await expect(bridge.rename({ from: "source.txt", to: "nested/target.txt" })).rejects.toThrow(
      "remote rejected",
    );
    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("payload");
    await expectPathMissing(targetPath);
  });

  it("rejects symlink-parent writes instead of escaping the local mount root", async () => {
    await using workspace = await createOpenShellTestWorkspace("fs");
    const workspaceDir = workspace.dir;
    await using outsideWorkspace = await createOpenShellTestWorkspace("outside");
    const outsideDir = outsideWorkspace.dir;
    await fs.symlink(outsideDir, path.join(workspaceDir, "alias"));
    const { backend, bridge } = await createMirrorFsBridgeFixture(workspaceDir);

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
    await using workspace = await createOpenShellTestWorkspace("fs");
    const workspaceDir = workspace.dir;
    const linkedTarget = path.join(workspaceDir, "existing.txt");
    await fs.writeFile(linkedTarget, "keep", "utf8");
    await fs.symlink("existing.txt", path.join(workspaceDir, "link.txt"));
    const { backend, bridge } = await createMirrorFsBridgeFixture(workspaceDir);

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
    await using workspace = await createOpenShellTestWorkspace("fs");
    const workspaceDir = workspace.dir;
    await using outsideWorkspace = await createOpenShellTestWorkspace("outside");
    const outsideDir = outsideWorkspace.dir;
    await fs.writeFile(path.join(outsideDir, "secret.txt"), "outside", "utf8");
    await fs.symlink(outsideDir, path.join(workspaceDir, "subdir"));
    const { bridge } = await createMirrorFsBridgeFixture(workspaceDir);

    await expect(bridge.readFile({ filePath: "subdir/secret.txt" })).rejects.toThrow(
      "Sandbox boundary checks failed",
    );
  });

  it("reads regular files through the shared safe fs root", async () => {
    await using workspace = await createOpenShellTestWorkspace("fs");
    const workspaceDir = workspace.dir;
    await fs.mkdir(path.join(workspaceDir, "subdir"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "subdir", "secret.txt"), "inside", "utf8");

    const { bridge } = await createMirrorFsBridgeFixture(workspaceDir);

    await expect(bridge.readFile({ filePath: "subdir/secret.txt" })).resolves.toEqual(
      Buffer.from("inside"),
    );
    await expect(bridge.readFile({ filePath: "subdir/secret.txt", maxBytes: 6 })).resolves.toEqual(
      Buffer.from("inside"),
    );
    await expect(bridge.readFile({ filePath: "subdir/secret.txt", maxBytes: 5 })).rejects.toThrow(
      "Sandbox boundary checks failed",
    );
  });

  it("reads materialized sandbox skills from the protected skills workspace", async () => {
    await using workspace = await createOpenShellTestWorkspace("fs");
    const workspaceDir = workspace.dir;
    await using skillsWorkspace = await createOpenShellTestWorkspace("skills");
    const skillsWorkspaceDir = skillsWorkspace.dir;
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
    await using workspace = await createOpenShellTestWorkspace("fs");
    const workspaceDir = workspace.dir;
    await using outsideWorkspace = await createOpenShellTestWorkspace("outside");
    const outsideDir = outsideWorkspace.dir;
    await fs.mkdir(path.join(workspaceDir, "subdir"), { recursive: true });
    await fs.writeFile(path.join(outsideDir, "secret.txt"), "outside", "utf8");
    await fs.symlink(
      path.join(outsideDir, "secret.txt"),
      path.join(workspaceDir, "subdir", "secret.txt"),
    );

    const { bridge } = await createMirrorFsBridgeFixture(workspaceDir);

    await expect(bridge.readFile({ filePath: "subdir/secret.txt" })).rejects.toThrow(
      "Sandbox boundary checks failed",
    );
  });

  it("rejects hardlinked files inside the sandbox root", async () => {
    await using workspace = await createOpenShellTestWorkspace("fs");
    const workspaceDir = workspace.dir;
    await using outsideWorkspace = await createOpenShellTestWorkspace("outside");
    const outsideDir = outsideWorkspace.dir;
    await fs.mkdir(path.join(workspaceDir, "subdir"), { recursive: true });
    await fs.writeFile(path.join(outsideDir, "secret.txt"), "outside", "utf8");
    await fs.link(
      path.join(outsideDir, "secret.txt"),
      path.join(workspaceDir, "subdir", "secret.txt"),
    );

    const { bridge } = await createMirrorFsBridgeFixture(workspaceDir);

    await expect(bridge.readFile({ filePath: "subdir/secret.txt" })).rejects.toThrow(
      "Sandbox boundary checks failed",
    );
  });

  it("maps agent mount paths when the sandbox workspace is read-only", async () => {
    await using workspace = await createOpenShellTestWorkspace("fs");
    const workspaceDir = workspace.dir;
    await using agentWorkspace = await createOpenShellTestWorkspace("agent");
    const agentWorkspaceDir = agentWorkspace.dir;
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
