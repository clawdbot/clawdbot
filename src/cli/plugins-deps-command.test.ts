import { beforeEach, describe, expect, it, vi } from "vitest";

type RuntimeDepFixture = {
  name: string;
  version: string;
  pluginIds: string[];
};

const mocks = vi.hoisted(() => {
  const runtimeLogs: string[] = [];
  const stringifyArgs = (args: unknown[]) => args.map((value) => String(value)).join(" ");
  return {
    runtimeLogs,
    defaultRuntime: {
      log: vi.fn((...args: unknown[]) => {
        runtimeLogs.push(stringifyArgs(args));
      }),
      error: vi.fn((...args: unknown[]) => {
        runtimeLogs.push(stringifyArgs(args));
      }),
      writeStdout: vi.fn((value: string) => {
        runtimeLogs.push(value.endsWith("\n") ? value.slice(0, -1) : value);
      }),
      writeJson: vi.fn((value: unknown, space = 2) => {
        runtimeLogs.push(JSON.stringify(value, null, space > 0 ? space : undefined));
      }),
      exit: vi.fn((code: number) => {
        throw new Error(`__exit__:${code}`);
      }),
    },
    createBundledRuntimeDepsInstallSpecs: vi.fn((params: { deps: readonly RuntimeDepFixture[] }) =>
      params.deps.map((dep) => `${dep.name}@${dep.version}`),
    ),
    pruneUnknownBundledRuntimeDepsRoots: vi.fn(),
    repairBundledRuntimeDepsInstallRootAsync: vi.fn(),
    resolveBundledRuntimeDependencyPackageInstallRootPlan: vi.fn(),
    resolveOpenClawPackageRootSync: vi.fn(),
    scanBundledPluginRuntimeDeps: vi.fn(),
  };
});

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRootSync: mocks.resolveOpenClawPackageRootSync,
}));

vi.mock("../plugins/bundled-runtime-deps.js", () => ({
  createBundledRuntimeDepsInstallSpecs: mocks.createBundledRuntimeDepsInstallSpecs,
  pruneUnknownBundledRuntimeDepsRoots: mocks.pruneUnknownBundledRuntimeDepsRoots,
  repairBundledRuntimeDepsInstallRootAsync: mocks.repairBundledRuntimeDepsInstallRootAsync,
  resolveBundledRuntimeDependencyPackageInstallRootPlan:
    mocks.resolveBundledRuntimeDependencyPackageInstallRootPlan,
  scanBundledPluginRuntimeDeps: mocks.scanBundledPluginRuntimeDeps,
}));

const { runPluginsDepsCommand } = await import("./plugins-deps-command.js");

describe("plugins deps command", () => {
  beforeEach(() => {
    mocks.runtimeLogs.length = 0;
    mocks.defaultRuntime.log.mockClear();
    mocks.defaultRuntime.error.mockClear();
    mocks.defaultRuntime.writeStdout.mockClear();
    mocks.defaultRuntime.writeJson.mockClear();
    mocks.defaultRuntime.exit.mockClear();
    mocks.createBundledRuntimeDepsInstallSpecs.mockClear();
    mocks.pruneUnknownBundledRuntimeDepsRoots.mockReset();
    mocks.repairBundledRuntimeDepsInstallRootAsync.mockReset();
    mocks.resolveBundledRuntimeDependencyPackageInstallRootPlan.mockReset();
    mocks.resolveOpenClawPackageRootSync.mockReset();
    mocks.scanBundledPluginRuntimeDeps.mockReset();
    mocks.resolveBundledRuntimeDependencyPackageInstallRootPlan.mockReturnValue({
      installRoot: "/runtime-deps",
      searchRoots: ["/runtime-deps"],
      external: true,
    });
  });

  it("does not reinstall already materialized bundled runtime deps", async () => {
    mocks.scanBundledPluginRuntimeDeps.mockReturnValue({
      deps: [{ name: "zod", version: "4.0.0", pluginIds: ["openclaw-demo"] }],
      missing: [],
      conflicts: [],
    });

    await runPluginsDepsCommand({
      config: {},
      options: {
        json: true,
        packageRoot: "/openclaw-package",
        repair: true,
      },
    });

    expect(mocks.repairBundledRuntimeDepsInstallRootAsync).not.toHaveBeenCalled();
    expect(JSON.parse(mocks.runtimeLogs[0] ?? "null")).toEqual(
      expect.objectContaining({
        packageRoot: "/openclaw-package",
        installSpecs: ["zod@4.0.0"],
        missingSpecs: [],
        repairedSpecs: [],
      }),
    );
  });

  it("repairs only when bundled runtime deps are missing", async () => {
    const dep = { name: "zod", version: "4.0.0", pluginIds: ["openclaw-demo"] };
    mocks.scanBundledPluginRuntimeDeps
      .mockReturnValueOnce({
        deps: [dep],
        missing: [dep],
        conflicts: [],
      })
      .mockReturnValueOnce({
        deps: [dep],
        missing: [],
        conflicts: [],
      });
    mocks.repairBundledRuntimeDepsInstallRootAsync.mockResolvedValue({
      installSpecs: ["zod@4.0.0"],
      skipped: false,
    });

    await runPluginsDepsCommand({
      config: {},
      options: {
        json: true,
        packageRoot: "/openclaw-package",
        repair: true,
      },
    });

    expect(mocks.repairBundledRuntimeDepsInstallRootAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        installRoot: "/runtime-deps",
        installSpecs: ["zod@4.0.0"],
        missingSpecs: ["zod@4.0.0"],
      }),
    );
    expect(JSON.parse(mocks.runtimeLogs[0] ?? "null")).toEqual(
      expect.objectContaining({
        missing: [],
        missingSpecs: [],
        repairedSpecs: ["zod@4.0.0"],
        warnings: [],
      }),
    );
  });

  it("keeps repair warnings inside JSON output", async () => {
    const dep = { name: "zod", version: "4.0.0", pluginIds: ["openclaw-demo"] };
    mocks.scanBundledPluginRuntimeDeps
      .mockReturnValueOnce({
        deps: [dep],
        missing: [dep],
        conflicts: [],
      })
      .mockReturnValueOnce({
        deps: [dep],
        missing: [],
        conflicts: [],
      });
    mocks.repairBundledRuntimeDepsInstallRootAsync.mockImplementation(async (params: unknown) => {
      (params as { warn: (message: string) => void }).warn("low disk space");
      return {
        installSpecs: ["zod@4.0.0"],
        skipped: false,
      };
    });

    await runPluginsDepsCommand({
      config: {},
      options: {
        json: true,
        packageRoot: "/openclaw-package",
        repair: true,
      },
    });

    expect(mocks.runtimeLogs).toHaveLength(1);
    expect(JSON.parse(mocks.runtimeLogs[0] ?? "null")).toEqual(
      expect.objectContaining({
        missing: [],
        repairedSpecs: ["zod@4.0.0"],
        warnings: ["low disk space"],
      }),
    );
  });

  it("repairs missing deps even when separate deps have version conflicts", async () => {
    const dep = { name: "zod", version: "4.0.0", pluginIds: ["openclaw-demo"] };
    const conflict = {
      name: "shared-conflict",
      versions: ["1.0.0", "2.0.0"],
      pluginIdsByVersion: new Map([
        ["1.0.0", ["openclaw-one"]],
        ["2.0.0", ["openclaw-two"]],
      ]),
    };
    mocks.scanBundledPluginRuntimeDeps
      .mockReturnValueOnce({
        deps: [dep],
        missing: [dep],
        conflicts: [conflict],
      })
      .mockReturnValueOnce({
        deps: [dep],
        missing: [],
        conflicts: [conflict],
      });
    mocks.repairBundledRuntimeDepsInstallRootAsync.mockResolvedValue({
      installSpecs: ["zod@4.0.0"],
      skipped: false,
    });

    await runPluginsDepsCommand({
      config: {},
      options: {
        json: true,
        packageRoot: "/openclaw-package",
        repair: true,
      },
    });

    expect(mocks.repairBundledRuntimeDepsInstallRootAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        installSpecs: ["zod@4.0.0"],
        missingSpecs: ["zod@4.0.0"],
      }),
    );
    expect(JSON.parse(mocks.runtimeLogs[0] ?? "null")).toEqual(
      expect.objectContaining({
        missing: [],
        conflicts: [
          {
            name: "shared-conflict",
            versions: ["1.0.0", "2.0.0"],
            pluginIdsByVersion: {
              "1.0.0": ["openclaw-one"],
              "2.0.0": ["openclaw-two"],
            },
          },
        ],
        repairedSpecs: ["zod@4.0.0"],
      }),
    );
  });
});
