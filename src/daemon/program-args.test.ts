// Daemon program argument tests cover CLI argument construction for services.
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { resolveGatewayHeapNodeOptions } from "./gateway-heap.js";
import { resolveGatewayProgramArguments, resolveNodeProgramArguments } from "./program-args.js";

const originalArgv = [...process.argv];
const originalExecPath = process.execPath;
const validatedNodePath = "/opt/Validated Node/bin/node";
const validatedBunPath = "/opt/Validated Bun/bin/bun";
const missingSelectedNodeError =
  "No supported Node runtime was selected for the daemon. Install Node >=22.22.3 <23, >=24.15.0 <25, or >=25.9.0 (Node 26 recommended), then retry.";
const missingSelectedBunError =
  "No supported Bun runtime was selected for the daemon. Install Bun 1.4 or newer with WAL-reset-safe node:sqlite, then retry.";

beforeEach(() => {
  vi.spyOn(os, "totalmem").mockReturnValue(64 * 1024 ** 3);
  vi.spyOn(process, "constrainedMemory").mockReturnValue(0);
});

afterEach(() => {
  process.argv = [...originalArgv];
  process.execPath = originalExecPath;
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("resolveGatewayProgramArguments", () => {
  it.skipIf(Boolean(process.versions.bun))(
    "sizes only the Gateway in an ordinary Node spawn tree",
    async () => {
      const entryPath = path.resolve("/opt/openclaw/dist/index.js");
      process.argv = [originalExecPath, entryPath];
      fsMocks.realpath.mockResolvedValue(entryPath);
      fsMocks.access.mockResolvedValue(undefined);
      const { programArguments } = await resolveGatewayProgramArguments({
        port: 18789,
        runtime: "node",
        runtimePath: originalExecPath,
      });
      const measurement = "console.log(require('node:v8').getHeapStatistics().heap_size_limit)";
      const environment = { NODE_OPTIONS: resolveGatewayHeapNodeOptions(undefined) };
      const nativeDefault = spawnSync(originalExecPath, ["-e", measurement], {
        env: environment,
        encoding: "utf8",
      });
      const parent = spawnSync(
        originalExecPath,
        [
          ...programArguments.slice(1, programArguments.indexOf(entryPath)),
          "-e",
          `const child = require('node:child_process').spawnSync(process.execPath, ['-e', ${JSON.stringify(measurement)}], { encoding: 'utf8' });
       if (child.status !== 0) throw new Error(child.stderr);
       console.log(JSON.stringify({ heap: require('node:v8').getHeapStatistics().heap_size_limit, used: process.memoryUsage().heapUsed, child: Number(child.stdout), options: process.env.NODE_OPTIONS }));`,
        ],
        { env: environment, encoding: "utf8" },
      );
      expect(nativeDefault.status, nativeDefault.stderr).toBe(0);
      expect(parent.status, parent.stderr).toBe(0);
      const result = JSON.parse(parent.stdout);
      expect(result.heap).toBeGreaterThanOrEqual(16384 * 1024 ** 2);
      expect(result.used).toBeLessThan(64 * 1024 ** 2);
      expect(result.child).toBe(Number(nativeDefault.stdout));
      expect(result.options).toBe("");
    },
  );

  it.each([
    { nodeOptions: "--max-old-space-size=24576", existing: [], expected: [] },
    { nodeOptions: "--max-old-space-size-percentage=25", existing: [], expected: [] },
    { nodeOptions: "--max-heap-size=24576", existing: [], expected: [] },
    { nodeOptions: "--max-old-space-size=0", existing: [], expected: [] },
    {
      nodeOptions: "",
      existing: ["--max-old-space-size=24576"],
      expected: ["--max-old-space-size=24576"],
    },
    {
      nodeOptions: "",
      existing: ["--require", "gateway", "--max-old-space-size=24576"],
      expected: ["--max-old-space-size=24576"],
    },
    {
      nodeOptions: "--max-old-space-size-percentage=25",
      existing: ["--max-old-space-size=24576", "--require=/tmp/preload.js"],
      expected: ["--max-old-space-size=24576"],
    },
  ])(
    "preserves stored controls without adding an automatic override: $nodeOptions $existing",
    async ({ nodeOptions, existing, expected }) => {
      const entryPath = path.resolve("/opt/openclaw/dist/index.js");
      process.argv = ["node", entryPath];
      fsMocks.realpath.mockResolvedValue(entryPath);
      fsMocks.access.mockResolvedValue(undefined);
      const result = await resolveGatewayProgramArguments({
        port: 18789,
        runtime: "node",
        runtimePath: validatedNodePath,
        existingCommand: {
          programArguments: [validatedNodePath, ...existing, entryPath, "gateway"],
          environment: { NODE_OPTIONS: nodeOptions },
        },
      });
      expect(result.programArguments).toEqual([
        validatedNodePath,
        ...expected,
        entryPath,
        "gateway",
        "--port",
        "18789",
      ]);
    },
  );

  it("ignores installer execArgv and keeps native defaults when capacity is unknown", async () => {
    vi.spyOn(os, "totalmem").mockReturnValue(Number.NaN);
    const originalExecArgv = process.execArgv;
    const entryPath = path.resolve("/opt/openclaw/dist/index.js");
    process.argv = ["node", entryPath];
    process.execArgv = ["--max-old-space-size=24576", "--require=/tmp/preload.js"];
    fsMocks.realpath.mockResolvedValue(entryPath);
    fsMocks.access.mockResolvedValue(undefined);
    try {
      const result = await resolveGatewayProgramArguments({
        port: 18789,
        runtime: "node",
        runtimePath: validatedNodePath,
      });
      expect(result.programArguments).toEqual([
        validatedNodePath,
        entryPath,
        "gateway",
        "--port",
        "18789",
      ]);
    } finally {
      process.execArgv = originalExecArgv;
    }
  });

  it("prefers index.js over legacy entry.js when both exist in the same dist directory", async () => {
    const entryPath = path.resolve("/opt/openclaw/dist/entry.js");
    const indexPath = path.resolve("/opt/openclaw/dist/index.js");
    process.argv = ["node", entryPath];
    fsMocks.realpath.mockResolvedValue(entryPath);
    fsMocks.access.mockResolvedValue(undefined);

    const result = await resolveGatewayProgramArguments({
      port: 18789,
      runtime: "node",
      runtimePath: validatedNodePath,
    });

    expect(result.programArguments).toEqual([
      validatedNodePath,
      "--max-old-space-size=16384",
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

    const result = await resolveGatewayProgramArguments({
      port: 18789,
      runtime: "node",
      runtimePath: validatedNodePath,
    });

    expect(result.programArguments).toEqual([
      validatedNodePath,
      "--max-old-space-size=16384",
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

    const result = await resolveGatewayProgramArguments({
      port: 18789,
      runtime: "node",
      runtimePath: validatedNodePath,
    });

    expect(result.programArguments).toEqual([
      validatedNodePath,
      "--max-old-space-size=16384",
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

    const result = await resolveGatewayProgramArguments({
      port: 18789,
      runtime: "node",
      runtimePath: validatedNodePath,
    });

    // Should use the symlinked canonical index.js path, not the realpath-resolved versioned path
    expect(result.programArguments[0]).toBe(validatedNodePath);
    expect(result.programArguments[2]).toBe(
      path.resolve("/Users/test/Library/pnpm/global/5/node_modules/openclaw/dist/index.js"),
    );
    expect(result.programArguments[2]).not.toContain("@2026.1.21-2");
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

    const result = await resolveGatewayProgramArguments({
      port: 18789,
      runtime: "node",
      runtimePath: validatedNodePath,
    });

    expect(result.programArguments).toEqual([
      validatedNodePath,
      "--max-old-space-size=16384",
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
      runtimePath: validatedNodePath,
    });

    expect(result.programArguments).toEqual([
      validatedNodePath,
      "--max-old-space-size=16384",
      "--import",
      "tsx",
      repoEntryPath,
      "gateway",
      "--port",
      "18789",
    ]);
    expect(result.workingDirectory).toBe(path.resolve("/repo"));
  });

  it("uses Bun directly for packaged and source-checkout Gateway commands", async () => {
    const packagedEntryPath = path.resolve("/opt/openclaw/dist/entry.js");
    const packagedIndexPath = path.resolve("/opt/openclaw/dist/index.js");
    process.argv = [validatedBunPath, packagedEntryPath];
    fsMocks.realpath.mockResolvedValue(packagedEntryPath);
    fsMocks.access.mockResolvedValue(undefined);

    const packaged = await resolveGatewayProgramArguments({
      port: 18789,
      runtime: "bun",
      runtimePath: validatedBunPath,
    });
    expect(packaged.programArguments).toEqual([
      validatedBunPath,
      packagedIndexPath,
      "gateway",
      "--port",
      "18789",
    ]);

    const repoIndexPath = path.resolve("/repo/src/index.ts");
    const repoEntryPath = path.resolve("/repo/src/entry.ts");
    process.argv = [validatedBunPath, repoIndexPath];
    fsMocks.realpath.mockResolvedValue(repoIndexPath);

    const sourceCheckout = await resolveGatewayProgramArguments({
      dev: true,
      port: 18789,
      runtime: "bun",
      runtimePath: validatedBunPath,
    });
    expect(sourceCheckout.programArguments).toEqual([
      validatedBunPath,
      repoEntryPath,
      "gateway",
      "--port",
      "18789",
    ]);
    expect(sourceCheckout.workingDirectory).toBe(path.resolve("/repo"));
  });

  it.each([
    {
      service: "gateway",
      selection: "missing",
      resolve: () =>
        resolveGatewayProgramArguments({
          dev: true,
          port: 18789,
          runtime: "node",
        }),
    },
    {
      service: "node host",
      selection: "missing",
      resolve: () =>
        resolveNodeProgramArguments({
          dev: true,
          host: "gateway.example",
          port: 18789,
          runtime: "node",
        }),
    },
    {
      service: "gateway",
      selection: "blank",
      resolve: () =>
        resolveGatewayProgramArguments({
          dev: true,
          port: 18789,
          runtime: "node",
          runtimePath: " \t ",
        }),
    },
    {
      service: "node host",
      selection: "blank",
      resolve: () =>
        resolveNodeProgramArguments({
          dev: true,
          host: "gateway.example",
          port: 18789,
          runtime: "node",
          runtimePath: " \t ",
        }),
    },
  ])("rejects a $selection selected Node path for the $service", async ({ resolve }) => {
    process.execPath = "/usr/local/bin/bun";

    await expect(resolve()).rejects.toThrow(missingSelectedNodeError);
  });

  it.each([
    {
      service: "gateway",
      resolve: () => resolveGatewayProgramArguments({ port: 18789, runtime: "bun" }),
    },
    {
      service: "node host",
      resolve: () =>
        resolveNodeProgramArguments({
          host: "gateway.example",
          port: 18789,
          runtime: "bun",
          runtimePath: " \t ",
        }),
    },
  ])("rejects a missing Bun path for the $service", async ({ resolve }) => {
    await expect(resolve()).rejects.toThrow(missingSelectedBunError);
  });

  it("uses an executable wrapper from Bun without a selected Node path", async () => {
    const wrapperPath = path.resolve("/usr/local/bin/openclaw-doppler");
    process.execPath = "/usr/local/bin/bun";
    fsMocks.stat.mockResolvedValue({ isFile: () => true } as never);
    fsMocks.access.mockResolvedValue(undefined);

    const result = await resolveGatewayProgramArguments({
      port: 18789,
      runtime: "node",
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
        runtime: "node",
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
      runtime: "node",
      runtimePath: validatedNodePath,
    });

    expect(result.programArguments).toEqual([
      validatedNodePath,
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

  it("uses Bun for the managed node command", async () => {
    const entryPath = path.resolve("/opt/openclaw/dist/entry.js");
    const indexPath = path.resolve("/opt/openclaw/dist/index.js");
    process.argv = [validatedBunPath, entryPath];
    fsMocks.realpath.mockResolvedValue(entryPath);
    fsMocks.access.mockResolvedValue(undefined);

    const result = await resolveNodeProgramArguments({
      host: "gateway.example",
      port: 18789,
      runtime: "bun",
      runtimePath: validatedBunPath,
    });

    expect(result.programArguments).toEqual([
      validatedBunPath,
      indexPath,
      "node",
      "run",
      "--host",
      "gateway.example",
      "--port",
      "18789",
    ]);
  });
});
