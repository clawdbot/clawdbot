import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import type { PackageInstallUpdateParams } from "./update-command-package.js";
import type { PackageUpdateExecutor, PackageUpdatePreparation } from "./update-package-executor.js";

const mocks = vi.hoisted(() => ({
  captureManagedContext: vi.fn(),
  checkTargetSchemas: vi.fn(),
  createBeforeGitMutation: vi.fn(),
  formatSchemaRefusalLines: vi.fn(),
  hasSchemaRefusal: vi.fn(),
  maybeRestartService: vi.fn(),
  maybeStopService: vi.fn(),
  readGitRecovery: vi.fn(),
  runGitUpdate: vi.fn(),
  runPackageUpdate: vi.fn(),
  runtimeError: vi.fn(),
  selectPackageExecutor: vi.fn(),
  shouldBlockServiceUpdate: vi.fn(),
  verifyPackageRecovery: vi.fn(),
}));

vi.mock("../../infra/update-global.js", () => ({
  verifyPackageUpdateRecovery: mocks.verifyPackageRecovery,
}));

vi.mock("../../infra/update-runner-git-recovery.js", () => ({
  readCurrentGitUpdateRecovery: mocks.readGitRecovery,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: { error: mocks.runtimeError },
}));

vi.mock("./schema-preflight.js", () => ({
  checkTargetDatabaseSchemas: mocks.checkTargetSchemas,
  formatSchemaRefusalLines: mocks.formatSchemaRefusalLines,
  hasSchemaRefusal: mocks.hasSchemaRefusal,
}));

vi.mock("./update-command-git.js", () => ({
  createBeforeGitMutation: mocks.createBeforeGitMutation,
  updateGitInstall: mocks.runGitUpdate,
}));

vi.mock("./update-command-handoff.js", () => ({
  formatUpdateAncestryBlockMessage: (message: string) => message,
  handoffUpdateFromGateway: vi.fn(),
}));

vi.mock("./update-command-managed-context.js", () => ({
  captureOwnedManagedUpdateContext: mocks.captureManagedContext,
}));

vi.mock("./update-command-package.js", () => ({
  runPackageInstallUpdate: mocks.runPackageUpdate,
}));

vi.mock("./update-command-service.js", async () => {
  const actual = await vi.importActual<typeof import("./update-command-service-maintenance.js")>(
    "./update-command-service-maintenance.js",
  );
  return {
    maybeRestartServiceAfterFailedMutableUpdate: mocks.maybeRestartService,
    maybeStopManagedServiceBeforeMutableUpdate: mocks.maybeStopService,
    resolvePreparedGatewayUpdatePolicy: actual.resolvePreparedGatewayUpdatePolicy,
    shouldBlockMutableUpdateFromGatewayServiceEnv: mocks.shouldBlockServiceUpdate,
    UpdateCommandAbort: actual.UpdateCommandAbort,
  };
});

vi.mock("./update-package-executor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./update-package-executor.js")>();
  return { ...actual, selectPackageExecutor: mocks.selectPackageExecutor };
});

import { executeMutableUpdate } from "./update-command-execution.js";

const successfulUpdate: UpdateRunResult = {
  status: "ok",
  mode: "npm",
  root: "/opt/openclaw",
  before: { version: "1.0.0" },
  after: { version: "1.0.1" },
  steps: [],
  durationMs: 1,
};

const activation: Parameters<PackageUpdateExecutor["activate"]>[0]["activation"] = {
  allowGatewayActivation: true,
  allowGatewayServiceRepair: false,
  managedServiceEnv: { OPENCLAW_PROFILE: "default" },
};

function packagePreparation(): PackageUpdatePreparation {
  return {
    root: "/opt/openclaw",
    installKind: "package",
    tag: "1.0.1",
    timeoutMs: 30_000,
    startedAt: 1,
    progress: {},
    jsonMode: true,
    invocationCwd: "/work",
  };
}

function executionParams(
  updateInstallKind: "git" | "package",
): Parameters<typeof executeMutableUpdate>[0] {
  return {
    root: "/opt/openclaw",
    installKind: updateInstallKind,
    updateInstallKind,
    switchToGit: false,
    timeoutMs: 30_000,
    updateStepTimeoutMs: 30_000,
    startedAt: 1,
    progress: {},
    stop: vi.fn(),
    channel: "stable",
    tag: "1.0.1",
    opts: { json: true },
    shouldRestart: true,
    packageInstallSpec: "openclaw@1.0.1",
    managedServiceRootRedirect: null,
    invocationCwd: "/work",
    recoveryState: { triageTarget: { env: {} } },
  };
}

async function actualPackageExecutor(): Promise<PackageUpdateExecutor> {
  const actual = await vi.importActual<typeof import("./update-package-executor.js")>(
    "./update-package-executor.js",
  );
  return actual.selectPackageExecutor();
}

function observeExecutor(executor: PackageUpdateExecutor, events: string[]): PackageUpdateExecutor {
  return {
    async prepare(update) {
      events.push("prepare");
      return executor.prepare(update);
    },
    async activate(params) {
      events.push("activate");
      return executor.activate(params);
    },
    async discard(prepared, reason) {
      events.push(`discard:${reason}`);
      await executor.discard(prepared, reason);
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.captureManagedContext.mockResolvedValue(undefined);
  mocks.checkTargetSchemas.mockReturnValue({ incompatible: [], indeterminate: [] });
  mocks.formatSchemaRefusalLines.mockReturnValue(["schema refused"]);
  mocks.hasSchemaRefusal.mockReturnValue(false);
  mocks.maybeRestartService.mockResolvedValue(undefined);
  mocks.maybeStopService.mockResolvedValue({
    stopped: true,
    inspected: true,
    runtimeInspected: true,
    running: true,
    serviceEnv: { OPENCLAW_PROFILE: "default" },
    serviceUpdateVerdict: {
      kind: "owned",
      root: "/opt/openclaw",
      fingerprint: "service-fingerprint",
      refreshDefinition: false,
    },
  });
  mocks.readGitRecovery.mockResolvedValue({ serviceRestartSafe: true });
  mocks.runGitUpdate.mockResolvedValue({ ...successfulUpdate, mode: "git" });
  mocks.runPackageUpdate.mockResolvedValue(successfulUpdate);
  mocks.shouldBlockServiceUpdate.mockReturnValue(false);
  mocks.verifyPackageRecovery.mockResolvedValue({ serviceRestartSafe: true });
});

describe("package update executor contract", () => {
  it("seals a path-free preparation and consumes it exactly once", async () => {
    const executor = await actualPackageExecutor();
    const update = packagePreparation();
    const prepared = await executor.prepare(update);
    update.tag = "changed-after-prepare";

    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.keys(prepared)).toEqual([]);
    await expect(executor.activate({ prepared, activation })).resolves.toBe(successfulUpdate);
    await expect(executor.activate({ prepared, activation })).rejects.toThrow(
      "belongs to another executor or was already consumed",
    );
    expect(mocks.runPackageUpdate).toHaveBeenCalledOnce();
    expect(mocks.runPackageUpdate).toHaveBeenCalledWith(
      expect.objectContaining<Partial<PackageInstallUpdateParams>>({ tag: "1.0.1" }),
    );
  });

  it("rejects a preparation issued by another executor", async () => {
    const owner = await actualPackageExecutor();
    const foreign = await actualPackageExecutor();
    const prepared = await owner.prepare(packagePreparation());

    await expect(foreign.activate({ prepared, activation })).rejects.toThrow(
      "belongs to another executor",
    );
    await expect(owner.activate({ prepared, activation })).resolves.toBe(successfulUpdate);
    expect(mocks.runPackageUpdate).toHaveBeenCalledOnce();
  });

  it("makes discard terminal for a prepared update", async () => {
    const executor = await actualPackageExecutor();
    const prepared = await executor.prepare(packagePreparation());

    await executor.discard(prepared, "pre-activation-failed");

    await expect(executor.activate({ prepared, activation })).rejects.toThrow("already consumed");
    expect(mocks.runPackageUpdate).not.toHaveBeenCalled();
  });
});

describe("mutable update execution", () => {
  it("routes a real package update through prepare, stop, schema recheck, and activate", async () => {
    const events: string[] = [];
    const executor = observeExecutor(await actualPackageExecutor(), events);
    mocks.selectPackageExecutor.mockReturnValue(executor);
    mocks.maybeStopService.mockImplementation(async () => {
      events.push("stop");
      return {
        stopped: true,
        inspected: true,
        runtimeInspected: true,
        running: true,
        serviceEnv: { OPENCLAW_PROFILE: "default" },
        serviceUpdateVerdict: {
          kind: "owned",
          root: "/opt/openclaw",
          fingerprint: "service-fingerprint",
          refreshDefinition: false,
        },
      };
    });
    mocks.checkTargetSchemas.mockImplementation(() => {
      events.push("schema");
      return { incompatible: [], indeterminate: [] };
    });

    const execution = await executeMutableUpdate(executionParams("package"));

    expect(events).toEqual(["prepare", "stop", "schema", "activate"]);
    expect(execution?.result).toBe(successfulUpdate);
    expect(mocks.runPackageUpdate).toHaveBeenCalledOnce();
    expect(mocks.runPackageUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        installSpec: "openclaw@1.0.1",
        managedServiceEnv: { OPENCLAW_PROFILE: "default" },
      }),
    );
  });

  it("discards preparation when the post-stop schema check refuses activation", async () => {
    const events: string[] = [];
    mocks.selectPackageExecutor.mockReturnValue(
      observeExecutor(await actualPackageExecutor(), events),
    );
    mocks.hasSchemaRefusal.mockReturnValue(true);

    const execution = await executeMutableUpdate(executionParams("package"));

    expect(events).toEqual(["prepare", "discard:pre-activation-failed"]);
    expect(execution?.result.reason).toBe("database-schema-preflight");
    expect(mocks.runPackageUpdate).not.toHaveBeenCalled();
  });

  it("reports activation exceptions without retrying a fallback package updater", async () => {
    const failure = new Error("activation failed");
    mocks.selectPackageExecutor.mockReturnValue(await actualPackageExecutor());
    mocks.runPackageUpdate.mockRejectedValue(failure);

    const execution = await executeMutableUpdate(executionParams("package"));

    expect(mocks.runPackageUpdate).toHaveBeenCalledOnce();
    expect(execution?.failure?.cause).toBe(failure);
    expect(execution?.result).toMatchObject({
      status: "error",
      reason: "update-failed",
      recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
    });
  });

  it("leaves Git updates on their existing execution path", async () => {
    const events: string[] = [];
    mocks.maybeStopService.mockImplementation(async () => {
      events.push("stop");
      return {
        stopped: true,
        inspected: true,
        runtimeInspected: true,
        running: true,
      };
    });
    mocks.runGitUpdate.mockImplementation(async () => {
      events.push("git");
      return { ...successfulUpdate, mode: "git" };
    });

    const execution = await executeMutableUpdate(executionParams("git"));

    expect(events).toEqual(["stop", "git"]);
    expect(execution?.result.mode).toBe("git");
    expect(mocks.selectPackageExecutor).not.toHaveBeenCalled();
    expect(mocks.runPackageUpdate).not.toHaveBeenCalled();
  });
});
