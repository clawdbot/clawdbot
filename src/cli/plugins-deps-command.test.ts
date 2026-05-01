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
    createBundledRuntimeDepsPackagePlan: vi.fn((params: { packageRoot: string }) => {
      const plan = mocks.runtimeDepsPlan(params);
      const installRootPlan = mocks.resolveBundledRuntimeDependencyPackageInstallRootPlan();
      const specs = (deps: readonly RuntimeDepFixture[]) =>
        deps.map((dep) => `${dep.name}@${dep.version}`);
      return {
        packageRoot: params.packageRoot,
        installRootPlan,
        deps: plan.deps,
        missing: plan.missing,
        conflicts: plan.conflicts,
        installSpecs: specs(plan.deps),
        missingSpecs: specs(plan.missing),
      };
    }),
    pruneUnknownBundledRuntimeDepsRoots: vi.fn(),
    repairBundledRuntimeDepsPackagePlanAsync: vi.fn(),
    resolveBundledRuntimeDependencyPackageInstallRootPlan: vi.fn(),
    resolveOpenClawPackageRootSync: vi.fn(),
    runtimeDepsPlan: vi.fn(),
  };
});

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRootSync: mocks.resolveOpenClawPackageRootSync,
}));

vi.mock("../plugins/bundled-runtime-deps.js", () => ({
  createBundledRuntimeDepsPackagePlan: mocks.createBundledRuntimeDepsPackagePlan,
  repairBundledRuntimeDepsPackagePlanAsync: mocks.repairBundledRuntimeDepsPackagePlanAsync,
}));

vi.mock("../plugins/bundled-runtime-deps-roots.js", () => ({
  pruneUnknownBundledRuntimeDepsRoots: mocks.pruneUnknownBundledRuntimeDepsRoots,
  resolveBundledRuntimeDependencyPackageInstallRootPlan:
    mocks.resolveBundledRuntimeDependencyPackageInstallRootPlan,
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
    mocks.createBundledRuntimeDepsPackagePlan.mockClear();
    mocks.pruneUnknownBundledRuntimeDepsRoots.mockReset();
    mocks.repairBundledRuntimeDepsPackagePlanAsync.mockReset();
    mocks.resolveBundledRuntimeDependencyPackageInstallRootPlan.mockReset();
    mocks.resolveOpenClawPackageRootSync.mockReset();
    mocks.runtimeDepsPlan.mockReset();
    mocks.runtimeDepsPlan.mockReturnValue({
      deps: [],
      missing: [],
      conflicts: [],
    });
    mocks.resolveBundledRuntimeDependencyPackageInstallRootPlan.mockReturnValue({
      installRoot: "/runtime-deps",
      searchRoots: ["/runtime-deps"],
      external: true,
    });
  });

  it("does not reinstall already materialized bundled runtime deps", async () => {
    mocks.runtimeDepsPlan.mockReturnValue({
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

    expect(mocks.repairBundledRuntimeDepsPackagePlanAsync).not.toHaveBeenCalled();
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
    mocks.runtimeDepsPlan
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
    mocks.repairBundledRuntimeDepsPackagePlanAsync.mockResolvedValue({
      repairedSpecs: ["zod@4.0.0"],
    });

    await runPluginsDepsCommand({
      config: {},
      options: {
        json: true,
        packageRoot: "/openclaw-package",
        repair: true,
      },
    });

    expect(mocks.repairBundledRuntimeDepsPackagePlanAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        packageRoot: "/openclaw-package",
        includeConfiguredChannels: true,
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
    mocks.runtimeDepsPlan
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
    mocks.repairBundledRuntimeDepsPackagePlanAsync.mockImplementation(async (params: unknown) => {
      (params as { warn: (message: string) => void }).warn("low disk space");
      return {
        repairedSpecs: ["zod@4.0.0"],
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
    mocks.runtimeDepsPlan
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
    mocks.repairBundledRuntimeDepsPackagePlanAsync.mockResolvedValue({
      repairedSpecs: ["zod@4.0.0"],
    });

    await runPluginsDepsCommand({
      config: {},
      options: {
        json: true,
        packageRoot: "/openclaw-package",
        repair: true,
      },
    });

    expect(mocks.repairBundledRuntimeDepsPackagePlanAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        packageRoot: "/openclaw-package",
        includeConfiguredChannels: true,
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
