// Daemon program argument tests cover CLI argument construction for services.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withMockedPlatform, withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";

const execFileSyncMock = vi.hoisted(() => vi.fn());

const fsMocks = vi.hoisted(() => ({
  access: vi.fn(),
  realpath: vi.fn(),
  stat: vi.fn(),
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    default: {
      ...actual,
      access: fsMocks.access,
      realpath: fsMocks.realpath,
      stat: fsMocks.stat,
    },
    access: fsMocks.access,
    realpath: fsMocks.realpath,
    stat: fsMocks.stat,
  };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFileSync: execFileSyncMock };
});

import { resolveGatewayProgramArguments, resolveNodeProgramArguments } from "./program-args.js";

const originalArgv = [...process.argv];
const originalExecPath = process.execPath;

afterEach(() => {
  process.argv = [...originalArgv];
  process.execPath = originalExecPath;
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe("resolveGatewayProgramArguments", () => {
  it("prefers index.js over legacy entry.js when both exist in the same dist directory", async () => {
    const entryPath = path.resolve("/opt/openclaw/dist/entry.js");
    const indexPath = path.resolve("/opt/openclaw/dist/index.js");
    process.argv = ["node", entryPath];
    fsMocks.realpath.mockResolvedValue(entryPath);
    fsMocks.access.mockResolvedValue(undefined);

    const result = await resolveGatewayProgramArguments({ port: 18789 });

    expect(result.programArguments).toEqual([
      process.execPath,
      indexPath,
      "gateway",
      "--port",
      "18789",
    ]);
  });

  it("keeps entry.js when index.js is missing", async () => {
    const entryPath = path.resolve("/opt/openclaw/dist/entry.js");
    const indexPath = path.resolve("/opt/openclaw/dist/index.js");
    const indexMjsPath = path.resolve("/opt/openclaw/dist/index.mjs");
    process.argv = ["node", entryPath];
    fsMocks.realpath.mockResolvedValue(entryPath);
    fsMocks.access.mockImplementation(async (target: string) => {
      if (target === indexPath || target === indexMjsPath) {
        throw new Error("missing");
      }
    });

    const result = await resolveGatewayProgramArguments({ port: 18789 });

    expect(result.programArguments).toEqual([
      process.execPath,
      entryPath,
      "gateway",
      "--port",
      "18789",
    ]);
  });

  it("uses realpath-resolved dist entry when running via npx shim", async () => {
    const argv1 = path.resolve("/tmp/.npm/_npx/63c3/node_modules/.bin/openclaw");
    const entryPath = path.resolve("/tmp/.npm/_npx/63c3/node_modules/openclaw/dist/entry.js");
    process.argv = ["node", argv1];
    fsMocks.realpath.mockResolvedValue(entryPath);
    fsMocks.access.mockImplementation(async (target: string) => {
      if (target === entryPath) {
        return;
      }
      throw new Error("missing");
    });

    const result = await resolveGatewayProgramArguments({ port: 18789 });

    expect(result.programArguments).toEqual([
      process.execPath,
      entryPath,
      "gateway",
      "--port",
      "18789",
    ]);
  });

  it("prefers symlinked path over realpath for stable service config", async () => {
    // Simulates pnpm global install where node_modules/openclaw is a symlink
    // to .pnpm/openclaw@X.Y.Z/node_modules/openclaw
    const symlinkPath = path.resolve(
      "/Users/test/Library/pnpm/global/5/node_modules/openclaw/dist/entry.js",
    );
    const realpathResolved = path.resolve(
      "/Users/test/Library/pnpm/global/5/node_modules/.pnpm/openclaw@2026.1.21-2/node_modules/openclaw/dist/entry.js",
    );
    process.argv = ["node", symlinkPath];
    fsMocks.realpath.mockResolvedValue(realpathResolved);
    fsMocks.access.mockResolvedValue(undefined); // Both paths exist

    const result = await resolveGatewayProgramArguments({ port: 18789 });

    // Should use the symlinked canonical index.js path, not the realpath-resolved versioned path
    expect(result.programArguments[1]).toBe(
      path.resolve("/Users/test/Library/pnpm/global/5/node_modules/openclaw/dist/index.js"),
    );
    expect(result.programArguments[1]).not.toContain("@2026.1.21-2");
  });

  it("falls back to node_modules package dist when .bin path is not resolved", async () => {
    const argv1 = path.resolve("/tmp/.npm/_npx/63c3/node_modules/.bin/openclaw");
    const indexPath = path.resolve("/tmp/.npm/_npx/63c3/node_modules/openclaw/dist/index.js");
    process.argv = ["node", argv1];
    fsMocks.realpath.mockRejectedValue(new Error("no realpath"));
    fsMocks.access.mockImplementation(async (target: string) => {
      if (target === indexPath) {
        return;
      }
      throw new Error("missing");
    });

    const result = await resolveGatewayProgramArguments({ port: 18789 });

    expect(result.programArguments).toEqual([
      process.execPath,
      indexPath,
      "gateway",
      "--port",
      "18789",
    ]);
  });

  it("uses Node with tsx for source-checkout dev mode", async () => {
    const repoIndexPath = path.resolve("/repo/src/index.ts");
    const repoEntryPath = path.resolve("/repo/src/entry.ts");
    process.argv = ["/usr/local/bin/node", repoIndexPath];
    fsMocks.realpath.mockResolvedValue(repoIndexPath);
    fsMocks.access.mockResolvedValue(undefined);

    const result = await resolveGatewayProgramArguments({
      dev: true,
      port: 18789,
      runtime: "node",
      nodePath: "/usr/local/bin/node",
    });

    expect(result.programArguments).toEqual([
      "/usr/local/bin/node",
      "--import",
      "tsx",
      repoEntryPath,
      "gateway",
      "--port",
      "18789",
    ]);
    expect(result.workingDirectory).toBe(path.resolve("/repo"));
  });

  it("uses trusted Windows where.exe when resolving the Node runtime", async () => {
    const repoIndexPath = path.resolve("/repo/src/index.ts");
    const repoEntryPath = path.resolve("/repo/src/entry.ts");
    const launcherPath = String.raw`D:\OpenClaw\openclaw.exe`;
    process.argv = [launcherPath, repoIndexPath];
    process.execPath = launcherPath;
    vi.stubEnv("SystemRoot", String.raw`D:\Windows`);
    fsMocks.realpath.mockResolvedValue(repoIndexPath);
    fsMocks.access.mockResolvedValue(undefined);
    execFileSyncMock.mockReturnValue(String.raw`D:\Tools\node.exe` + "\r\n");

    let result: Awaited<ReturnType<typeof resolveGatewayProgramArguments>> | undefined;
    await withMockedWindowsPlatform(async () => {
      result = await resolveGatewayProgramArguments({
        dev: true,
        port: 18789,
        runtime: "node",
      });
    });

    expect(execFileSyncMock).toHaveBeenCalledWith(
      path.win32.join(String.raw`D:\Windows`, "System32", "where.exe"),
      ["node"],
      { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" },
    );
    expect(result?.programArguments).toEqual([
      String.raw`D:\Tools\node.exe`,
      "--import",
      "tsx",
      repoEntryPath,
      "gateway",
      "--port",
      "18789",
    ]);
  });

  it("bounds POSIX Node runtime lookup", async () => {
    const repoIndexPath = path.resolve("/repo/src/index.ts");
    const repoEntryPath = path.resolve("/repo/src/entry.ts");
    process.argv = ["/usr/local/bin/bun", repoIndexPath];
    process.execPath = "/usr/local/bin/bun";
    fsMocks.realpath.mockResolvedValue(repoIndexPath);
    fsMocks.access.mockResolvedValue(undefined);
    execFileSyncMock.mockReturnValue("/usr/local/bin/node\n");

    const result = await withMockedPlatform(
      "linux",
      async () =>
        await resolveGatewayProgramArguments({
          dev: true,
          port: 18789,
          runtime: "node",
        }),
    );

    expect(execFileSyncMock).toHaveBeenCalledWith("which", ["node"], {
      encoding: "utf8",
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
    expect(result.programArguments).toEqual([
      "/usr/local/bin/node",
      "--import",
      "tsx",
      repoEntryPath,
      "gateway",
      "--port",
      "18789",
    ]);
  });

  it("uses an executable wrapper when provided", async () => {
    const wrapperPath = path.resolve("/usr/local/bin/openclaw-doppler");
    fsMocks.stat.mockResolvedValue({ isFile: () => true } as never);
    fsMocks.access.mockResolvedValue(undefined);

    const result = await resolveGatewayProgramArguments({
      port: 18789,
      wrapperPath,
    });

    expect(result.programArguments).toEqual([wrapperPath, "gateway", "--port", "18789"]);
    expect(result.workingDirectory).toBeUndefined();
  });

  it("rejects a non-executable wrapper file", async () => {
    const wrapperPath = path.resolve("/usr/local/bin/openclaw-doppler");
    fsMocks.stat.mockResolvedValue({ isFile: () => true } as never);
    fsMocks.access.mockRejectedValue(new Error("EACCES"));

    await expect(
      resolveGatewayProgramArguments({
        port: 18789,
        wrapperPath,
      }),
    ).rejects.toThrow("OPENCLAW_WRAPPER must point to an executable file");
  });
});

describe("resolveNodeProgramArguments", () => {
  it("carries an explicit plaintext selection into the managed node command", async () => {
    const entryPath = path.resolve("/opt/openclaw/dist/entry.js");
    const indexPath = path.resolve("/opt/openclaw/dist/index.js");
    process.argv = ["node", entryPath];
    fsMocks.realpath.mockResolvedValue(entryPath);
    fsMocks.access.mockResolvedValue(undefined);

    const result = await resolveNodeProgramArguments({
      host: "gateway.example",
      port: 18789,
      tls: false,
    });

    expect(result.programArguments).toEqual([
      process.execPath,
      indexPath,
      "node",
      "run",
      "--host",
      "gateway.example",
      "--port",
      "18789",
      "--no-tls",
    ]);
  });
});
