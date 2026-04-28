import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSandboxTestContext } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

function cloneStatWithDev<T extends nodeFs.Stats | nodeFs.BigIntStats>(
  stat: T,
  dev: number | bigint,
): T {
  return Object.defineProperty(
    Object.create(Object.getPrototypeOf(stat), Object.getOwnPropertyDescriptors(stat)),
    "dev",
    {
      value: dev,
      configurable: true,
      enumerable: true,
      writable: true,
    },
  ) as T;
}

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

  it("rejects a parent symlink swap that lands outside the sandbox root", async () => {
    const workspaceDir = await makeTempDir("openclaw-openshell-fs-");
    const outsideDir = await makeTempDir("openclaw-openshell-outside-");
    await fs.mkdir(path.join(workspaceDir, "subdir"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "subdir", "secret.txt"), "inside", "utf8");
    await fs.writeFile(path.join(outsideDir, "secret.txt"), "outside", "utf8");
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
    const originalOpen = fs.open.bind(fs);
    const targetPath = path.join(workspaceDir, "subdir", "secret.txt");
    let swapped = false;
    const openSpy = vi.spyOn(fs, "open").mockImplementation((async (...args: unknown[]) => {
      const filePath = args[0];
      if (!swapped && filePath === targetPath) {
        swapped = true;
        nodeFs.rmSync(path.join(workspaceDir, "subdir"), { recursive: true, force: true });
        nodeFs.symlinkSync(outsideDir, path.join(workspaceDir, "subdir"));
      }
      return await (originalOpen as (...delegated: unknown[]) => Promise<unknown>)(...args);
    }) as unknown as typeof fs.open);

    try {
      await expect(bridge.readFile({ filePath: "subdir/secret.txt" })).rejects.toThrow(
        "Sandbox boundary checks failed",
      );
      expect(openSpy).toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
    }
  });

  it("falls back to inode checks when fd path resolution is unavailable", async () => {
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
    const readlinkSpy = vi
      .spyOn(fs, "readlink")
      .mockRejectedValue(new Error("fd path unavailable"));

    try {
      await expect(bridge.readFile({ filePath: "subdir/secret.txt" })).resolves.toEqual(
        Buffer.from("inside"),
      );
      expect(readlinkSpy).toHaveBeenCalled();
    } finally {
      readlinkSpy.mockRestore();
    }
  });

  // The shared `sameFileIdentity` contract intentionally treats either-side
  // `dev=0` as "unknown device" on win32 (path-based stat can legitimately
  // report `dev=0` there) and only fails closed on other platforms. Skip the
  // Linux/macOS rejection expectation on Windows runners.
  it.skipIf(process.platform === "win32")(
    "rejects fallback reads when path stats report an unknown device id",
    async () => {
      const workspaceDir = await makeTempDir("openclaw-openshell-fs-");
      const targetPath = path.join(workspaceDir, "subdir", "secret.txt");
      await fs.mkdir(path.join(workspaceDir, "subdir"), { recursive: true });
      await fs.writeFile(targetPath, "inside", "utf8");

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
      const readlinkSpy = vi
        .spyOn(fs, "readlink")
        .mockRejectedValue(new Error("fd path unavailable"));
      const originalStat = fs.stat.bind(fs);
      const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
        const stat = await originalStat(...args);
        if (args[0] === targetPath) {
          return cloneStatWithDev(stat, 0);
        }
        return stat;
      });

      try {
        await expect(bridge.readFile({ filePath: "subdir/secret.txt" })).rejects.toThrow(
          "Sandbox boundary checks failed",
        );
        expect(readlinkSpy).toHaveBeenCalled();
        expect(statSpy).toHaveBeenCalledWith(targetPath);
      } finally {
        statSpy.mockRestore();
        readlinkSpy.mockRestore();
      }
    },
  );

  it("rejects fallback reads when an ancestor directory is swapped to a symlink", async () => {
    const workspaceDir = await makeTempDir("openclaw-openshell-fs-");
    const outsideDir = await makeTempDir("openclaw-openshell-outside-");
    await fs.mkdir(path.join(workspaceDir, "subdir"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "subdir", "secret.txt"), "inside", "utf8");
    await fs.writeFile(path.join(outsideDir, "secret.txt"), "outside", "utf8");

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
    const originalOpen = fs.open.bind(fs);
    const targetPath = path.join(workspaceDir, "subdir", "secret.txt");
    let swapped = false;
    const openSpy = vi.spyOn(fs, "open").mockImplementation((async (...args: unknown[]) => {
      const filePath = args[0];
      if (!swapped && filePath === targetPath) {
        swapped = true;
        nodeFs.rmSync(path.join(workspaceDir, "subdir"), { recursive: true, force: true });
        nodeFs.symlinkSync(outsideDir, path.join(workspaceDir, "subdir"));
      }
      return await (originalOpen as (...delegated: unknown[]) => Promise<unknown>)(...args);
    }) as unknown as typeof fs.open);
    // Force the fallback verification path even on Linux so the ancestor-walk
    // guard is exercised directly.
    const readlinkSpy = vi
      .spyOn(fs, "readlink")
      .mockRejectedValue(new Error("fd path unavailable"));

    try {
      await expect(bridge.readFile({ filePath: "subdir/secret.txt" })).rejects.toThrow(
        "Sandbox boundary checks failed",
      );
      expect(openSpy).toHaveBeenCalled();
      expect(readlinkSpy).toHaveBeenCalled();
    } finally {
      readlinkSpy.mockRestore();
      openSpy.mockRestore();
    }
  });

  it("rejects fallback reads of a symlinked leaf when O_NOFOLLOW is unavailable", async () => {
    const workspaceDir = await makeTempDir("openclaw-openshell-fs-");
    const outsideDir = await makeTempDir("openclaw-openshell-outside-");
    await fs.mkdir(path.join(workspaceDir, "subdir"), { recursive: true });
    await fs.writeFile(path.join(outsideDir, "secret.txt"), "outside", "utf8");
    // The workspace contains a symlink as the FINAL path component pointing
    // out-of-root. On Windows `O_NOFOLLOW` is `undefined`, so `open` would
    // silently traverse the symlink to the outside file; the ancestor walk
    // must lstat the leaf in that case to fail closed.
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

    const { createOpenShellFsBridge, setReadOpenFlagsResolverForTest } =
      await import("./fs-bridge.js");
    const bridge = createOpenShellFsBridge({ sandbox, backend });
    // Force the fallback path so the leaf-lstat guard is exercised.
    const readlinkSpy = vi
      .spyOn(fs, "readlink")
      .mockRejectedValue(new Error("fd path unavailable"));
    // Simulate a host that lacks `O_NOFOLLOW` (e.g. Windows) without touching
    // the non-configurable native `fs.constants` data property. The bridge
    // exposes a test-only seam for exactly this case.
    setReadOpenFlagsResolverForTest(() => ({
      flags: nodeFs.constants.O_RDONLY,
      supportsNoFollow: false,
    }));

    try {
      await expect(bridge.readFile({ filePath: "subdir/secret.txt" })).rejects.toThrow(
        "Sandbox boundary checks failed",
      );
      expect(readlinkSpy).toHaveBeenCalled();
    } finally {
      setReadOpenFlagsResolverForTest(undefined);
      readlinkSpy.mockRestore();
    }
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
