import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSandboxTestContext } from "../../../src/agents/sandbox/test-fixtures.js";
import type { OpenShellSandboxBackend } from "./backend.js";
import {
  buildExecRemoteCommand,
  buildOpenShellBaseArgv,
  resolveOpenShellCommand,
  setBundledOpenShellCommandResolverForTest,
  shellEscape,
} from "./cli.js";
import { resolveOpenShellPluginConfig } from "./config.js";

const cliMocks = vi.hoisted(() => ({
  runOpenShellCli: vi.fn(),
}));

let createOpenShellSandboxBackendManager: typeof import("./backend.js").createOpenShellSandboxBackendManager;

describe("openshell cli helpers", () => {
  afterEach(() => {
    setBundledOpenShellCommandResolverForTest();
  });

  it("builds base argv with gateway overrides", () => {
    const config = resolveOpenShellPluginConfig({
      command: "/usr/local/bin/openshell",
      gateway: "lab",
      gatewayEndpoint: "https://lab.example",
    });
    expect(buildOpenShellBaseArgv(config)).toEqual([
      "/usr/local/bin/openshell",
      "--gateway",
      "lab",
      "--gateway-endpoint",
      "https://lab.example",
    ]);
  });

  it("prefers the bundled openshell command when available", () => {
    setBundledOpenShellCommandResolverForTest(() => "/tmp/node_modules/.bin/openshell");
    const config = resolveOpenShellPluginConfig(undefined);

    expect(resolveOpenShellCommand("openshell")).toBe("/tmp/node_modules/.bin/openshell");
    expect(buildOpenShellBaseArgv(config)).toEqual(["/tmp/node_modules/.bin/openshell"]);
  });

  it("falls back to the PATH command when no bundled openshell is present", () => {
    setBundledOpenShellCommandResolverForTest(() => null);

    expect(resolveOpenShellCommand("openshell")).toBe("openshell");
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
});

describe("openshell backend manager", () => {
  beforeAll(async () => {
    vi.doMock("./cli.js", async () => {
      const actual = await vi.importActual<typeof import("./cli.js")>("./cli.js");
      return {
        ...actual,
        runOpenShellCli: cliMocks.runOpenShellCli,
      };
    });
    ({ createOpenShellSandboxBackendManager } = await import("./backend.js"));
  });

  afterAll(() => {
    vi.doUnmock("./cli.js");
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

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
    expect(cliMocks.runOpenShellCli).toHaveBeenCalledWith({
      context: expect.objectContaining({
        sandboxName: "openclaw-session-1234",
        config: expect.objectContaining({
          from: "custom-source",
        }),
      }),
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

    expect(cliMocks.runOpenShellCli).toHaveBeenCalledWith({
      context: expect.objectContaining({
        sandboxName: "openclaw-session-5678",
        config: expect.objectContaining({
          command: "/usr/local/bin/openshell",
          gateway: "lab",
        }),
      }),
      args: ["sandbox", "delete", "openclaw-session-5678"],
    });
  });
});

const tempDirs: string[] = [];

async function makeTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
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
    syncLocalPathToRemote: vi.fn().mockResolvedValue(undefined),
  } as unknown as OpenShellSandboxBackend;
}

describe("openshell fs bridges", () => {
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
    expect(backend.syncLocalPathToRemote).toHaveBeenCalledWith(
      path.join(workspaceDir, "nested", "file.txt"),
      "/sandbox/nested/file.txt",
    );
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
    ).rejects.toThrow();
    await expect(fs.stat(path.join(outsideDir, "escape.txt"))).rejects.toThrow();
    await expect(fs.readdir(outsideDir)).resolves.toEqual([]);
    expect(backend.syncLocalPathToRemote).not.toHaveBeenCalled();
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
    ).rejects.toThrow();
    await expect(fs.readlink(path.join(workspaceDir, "link.txt"))).resolves.toBe("existing.txt");
    await expect(fs.readFile(linkedTarget, "utf8")).resolves.toBe("keep");
    expect(backend.syncLocalPathToRemote).not.toHaveBeenCalled();
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
