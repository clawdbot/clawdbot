import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";

const mocks = vi.hoisted(() => ({
  resolveOpenClawPackageRootSync: vi.fn<() => string | null>(() => "/pkg"),
  createBundledRuntimeDepsPackagePlan: vi.fn(),
  repairBundledRuntimeDepsPackagePlanAsync: vi.fn(),
}));

vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRootSync: mocks.resolveOpenClawPackageRootSync,
}));

vi.mock("../plugins/bundled-runtime-deps.js", () => ({
  createBundledRuntimeDepsPackagePlan: mocks.createBundledRuntimeDepsPackagePlan,
  repairBundledRuntimeDepsPackagePlanAsync: mocks.repairBundledRuntimeDepsPackagePlanAsync,
}));

import { preparePostConfigBundledRuntimeDeps } from "./post-config-runtime-deps.js";

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function createPlan(overrides: Record<string, unknown> = {}) {
  return {
    conflicts: [],
    missing: [],
    installSpecs: [],
    ...overrides,
  };
}

describe("preparePostConfigBundledRuntimeDeps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveOpenClawPackageRootSync.mockReturnValue("/pkg");
    mocks.createBundledRuntimeDepsPackagePlan.mockReturnValue(createPlan());
    mocks.repairBundledRuntimeDepsPackagePlanAsync.mockResolvedValue({
      repairedSpecs: [],
    });
  });

  it("skips remote gateway configs", async () => {
    await preparePostConfigBundledRuntimeDeps({
      config: { gateway: { mode: "remote" } } as OpenClawConfig,
      runtime: createRuntime(),
    });

    expect(mocks.resolveOpenClawPackageRootSync).not.toHaveBeenCalled();
    expect(mocks.createBundledRuntimeDepsPackagePlan).not.toHaveBeenCalled();
  });

  it("skips when no package root is available", async () => {
    mocks.resolveOpenClawPackageRootSync.mockReturnValueOnce(null);

    await preparePostConfigBundledRuntimeDeps({
      config: { gateway: { mode: "local" } } as OpenClawConfig,
      runtime: createRuntime(),
    });

    expect(mocks.createBundledRuntimeDepsPackagePlan).not.toHaveBeenCalled();
  });

  it("repairs missing bundled deps selected by local config", async () => {
    const env = { OPENCLAW_STATE_DIR: "/state" } as NodeJS.ProcessEnv;
    const config = {
      gateway: { mode: "local" },
      channels: { telegram: { enabled: true } },
    } as unknown as OpenClawConfig;
    mocks.createBundledRuntimeDepsPackagePlan.mockReturnValueOnce(
      createPlan({
        missing: [{ name: "grammy", version: "1.0.0", pluginIds: ["telegram"] }],
        installSpecs: ["grammy@1.0.0"],
      }),
    );
    mocks.repairBundledRuntimeDepsPackagePlanAsync.mockResolvedValueOnce({
      repairedSpecs: ["grammy@1.0.0"],
    });
    const runtime = createRuntime();

    await preparePostConfigBundledRuntimeDeps({
      config,
      runtime,
      env,
      packageRoot: "/pkg",
    });

    expect(mocks.createBundledRuntimeDepsPackagePlan).toHaveBeenCalledWith({
      packageRoot: "/pkg",
      config,
      includeConfiguredChannels: true,
      env,
    });
    expect(mocks.repairBundledRuntimeDepsPackagePlanAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        packageRoot: "/pkg",
        config,
        includeConfiguredChannels: true,
        env,
      }),
    );
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("grammy@1.0.0"));
  });

  it("fails fast on conflicting bundled dependency versions", async () => {
    const runtime = createRuntime();
    mocks.createBundledRuntimeDepsPackagePlan.mockReturnValueOnce(
      createPlan({
        conflicts: [
          {
            name: "demo",
            versions: ["1.0.0", "2.0.0"],
            pluginIdsByVersion: new Map([
              ["1.0.0", ["one"]],
              ["2.0.0", ["two"]],
            ]),
          },
        ],
      }),
    );

    await expect(
      preparePostConfigBundledRuntimeDeps({
        config: { gateway: { mode: "local" } } as OpenClawConfig,
        runtime,
        packageRoot: "/pkg",
      }),
    ).rejects.toThrow("conflicting versions");

    expect(mocks.repairBundledRuntimeDepsPackagePlanAsync).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("openclaw doctor --fix"));
  });

  it("keeps the repair error attached to the post-config failure", async () => {
    const runtime = createRuntime();
    const failure = new Error("disk full");
    mocks.createBundledRuntimeDepsPackagePlan.mockReturnValueOnce(
      createPlan({
        missing: [{ name: "dotenv", version: "1.0.0", pluginIds: ["provider"] }],
        installSpecs: ["dotenv@1.0.0"],
      }),
    );
    mocks.repairBundledRuntimeDepsPackagePlanAsync.mockRejectedValueOnce(failure);

    await expect(
      preparePostConfigBundledRuntimeDeps({
        config: { gateway: { mode: "local" } } as OpenClawConfig,
        runtime,
        packageRoot: "/pkg",
      }),
    ).rejects.toThrow("disk full");

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to install bundled plugin runtime deps after config update"),
    );
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("disk full"));
  });
});
