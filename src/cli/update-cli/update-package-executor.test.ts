import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import type { captureTargetDatabaseSchemaContext } from "./schema-preflight.js";
import type { PackageInstallUpdateParams } from "./update-command-package.js";
import type { PreManagedServiceStop } from "./update-command-service.js";
import type { PackageUpdateExecutor } from "./update-package-executor.js";

const mocks = vi.hoisted(() => ({
  captureManagedContext: vi.fn(),
  captureManagedPreflight:
    vi.fn<
      typeof import("./update-command-managed-context.js").captureOwnedManagedUpdatePreflightContext
    >(),
  captureSchemaContext:
    vi.fn<typeof import("./schema-preflight.js").captureTargetDatabaseSchemaContext>(),
  checkTargetSchemas:
    vi.fn<typeof import("./schema-preflight.js").checkTargetDatabaseSchemasForContexts>(),
  formatSchemaRefusalLines: vi.fn(),
  hasSchemaRefusal: vi.fn(),
  maybeRestartService: vi.fn(),
  maybeStopService: vi.fn(),
  prepareMutableUpdate: vi.fn<(env?: NodeJS.ProcessEnv) => Promise<void>>(),
  readGitRecovery: vi.fn(),
  runGitUpdate: vi.fn(),
  runPackageUpdate: vi.fn(),
  runtimeError: vi.fn(),
  revalidateSchemaContext:
    vi.fn<typeof import("./update-command-managed-context.js").revalidateUpdateDatabaseContext>(),
  selectPackageExecutor: vi.fn(),
  serviceStopped: false,
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
  captureTargetDatabaseSchemaContext: mocks.captureSchemaContext,
  checkTargetDatabaseSchemasForContexts: mocks.checkTargetSchemas,
  formatSchemaRefusalLines: mocks.formatSchemaRefusalLines,
  hasSchemaRefusal: mocks.hasSchemaRefusal,
}));

vi.mock("./update-command-git.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-git.js")>()),
  updateGitInstall: mocks.runGitUpdate,
}));

vi.mock("./update-command-handoff.js", () => ({
  formatUpdateAncestryBlockMessage: (message: string) => message,
  handoffUpdateFromGateway: vi.fn(),
}));

vi.mock("./update-command-managed-context.js", () => ({
  captureOwnedManagedUpdateContext: mocks.captureManagedContext,
  captureOwnedManagedUpdatePreflightContext: mocks.captureManagedPreflight,
  revalidateUpdateDatabaseContext: mocks.revalidateSchemaContext,
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
  managedServiceEnv: { OPENCLAW_PROFILE: "default" },
};

function packagePreparation(): Parameters<PackageUpdateExecutor["prepare"]>[0] {
  return {
    root: "/opt/openclaw",
    installKind: "package",
    tag: "1.0.1",
    timeoutMs: 30_000,
    startedAt: 1,
    progress: {},
    jsonMode: true,
    invocationCwd: "/work",
    validateCandidate: async () => [],
    beforeActivate: async () => {},
    onTransaction: () => {},
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
    prepareMutableUpdate: mocks.prepareMutableUpdate,
    packageTargetSchemaVersions: { state: 15, agent: 19 },
  };
}

function schemaContext(
  profile: string,
): Awaited<ReturnType<typeof captureTargetDatabaseSchemaContext>> {
  const env = { OPENCLAW_PROFILE: profile };
  return {
    env,
    readEnv: { ...env },
    config: {},
    configSnapshot: {
      path: `/fixture/${profile}/openclaw.json`,
      exists: true,
      raw: "{}",
      parsed: {},
      resolved: {},
      sourceConfig: {},
      config: {},
      runtimeConfig: {},
      valid: true,
      issues: [],
      warnings: [],
      legacyIssues: [],
    },
  };
}

function inspectOrStopService(phase: "inspect" | "prepare" = "prepare"): PreManagedServiceStop {
  const running = !mocks.serviceStopped;
  if (phase === "prepare") {
    mocks.serviceStopped = true;
  }
  return {
    stopped: phase === "prepare",
    inspected: true,
    runtimeInspected: true,
    running,
    serviceEnv: { OPENCLAW_PROFILE: "default" },
    serviceUpdateVerdict: {
      kind: "owned",
      root: "/opt/openclaw",
      fingerprint: "service-fingerprint",
      refreshDefinition: false,
    },
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
  mocks.serviceStopped = false;
  mocks.captureManagedContext.mockResolvedValue(undefined);
  mocks.captureManagedPreflight.mockResolvedValue(schemaContext("default"));
  mocks.captureSchemaContext.mockResolvedValue(schemaContext("invoker"));
  mocks.revalidateSchemaContext.mockImplementation(async (context) => context);
  mocks.checkTargetSchemas.mockResolvedValue({ incompatible: [], indeterminate: [] });
  mocks.formatSchemaRefusalLines.mockReturnValue(["schema refused"]);
  mocks.hasSchemaRefusal.mockImplementation(
    (schemas) => schemas.incompatible.length > 0 || schemas.indeterminate.length > 0,
  );
  mocks.maybeRestartService.mockResolvedValue(undefined);
  mocks.maybeStopService.mockImplementation(async ({ phase }) => inspectOrStopService(phase));
  mocks.prepareMutableUpdate.mockResolvedValue(undefined);
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
  it("admits both contexts before preparation and keeps the service online until activation", async () => {
    const events: string[] = [];
    const executor = observeExecutor(await actualPackageExecutor(), events);
    mocks.selectPackageExecutor.mockReturnValue(executor);
    mocks.maybeStopService.mockImplementation(async ({ phase }) => {
      if (phase === "prepare") {
        events.push("stop");
      }
      return inspectOrStopService(phase);
    });
    mocks.prepareMutableUpdate.mockImplementation(async (env) => {
      expect(env).toEqual({ OPENCLAW_PROFILE: "default" });
      events.push("mutable-prepare");
    });
    const schemaGate = createDeferred();
    mocks.checkTargetSchemas.mockImplementation(async (_versions, contexts) => {
      expect(contexts.map((context) => context.env.OPENCLAW_PROFILE)).toEqual([
        "invoker",
        "default",
      ]);
      events.push(events.includes("prepare") ? "schema-after-prepare" : "schema-before-prepare");
      if (events.includes("prepare")) {
        await schemaGate.promise;
      }
      return { incompatible: [], indeterminate: [] };
    });

    const pendingExecution = executeMutableUpdate(executionParams("package"));
    try {
      await vi.waitFor(() => expect(events).toContain("schema-after-prepare"));
      expect(events).toEqual([
        "schema-before-prepare",
        "mutable-prepare",
        "prepare",
        "schema-after-prepare",
      ]);
      expect(mocks.serviceStopped).toBe(false);
      expect(mocks.runPackageUpdate).not.toHaveBeenCalled();
    } finally {
      schemaGate.resolve();
      await pendingExecution;
    }
    const execution = await pendingExecution;

    expect(events.at(-1)).toBe("activate");
    expect(mocks.prepareMutableUpdate).toHaveBeenCalledOnce();
    expect(execution?.result).toBe(successfulUpdate);
    expect(mocks.runPackageUpdate).toHaveBeenCalledOnce();
    expect(mocks.runPackageUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        installSpec: "openclaw@1.0.1",
        managedServiceEnv: { OPENCLAW_PROFILE: "default" },
      }),
    );
  });

  it.each(["before-prepare", "after-prepare"] as const)(
    "preserves executor refusal at %s",
    async (phase) => {
      const events: string[] = [];
      mocks.selectPackageExecutor.mockReturnValue(
        observeExecutor(await actualPackageExecutor(), events),
      );
      mocks.checkTargetSchemas.mockImplementation(async () => ({
        incompatible:
          phase === "before-prepare" || events.includes("prepare")
            ? [
                {
                  kind: "agent",
                  path: "/fixture/default/worker.sqlite",
                  foundVersion: 999,
                  supportedVersion: 19,
                },
              ]
            : [],
        indeterminate: [],
      }));

      const execution = await executeMutableUpdate(executionParams("package"));

      expect(events).toEqual(
        phase === "before-prepare" ? [] : ["prepare", "discard:pre-activation-failed"],
      );
      expect(mocks.serviceStopped).toBe(false);
      expect(mocks.prepareMutableUpdate).toHaveBeenCalledTimes(phase === "after-prepare" ? 1 : 0);
      expect(execution?.result.reason).toBe("database-schema-preflight");
      expect(mocks.runPackageUpdate).not.toHaveBeenCalled();
    },
  );

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

  it("keeps Git candidate selection online and delegates its later activation", async () => {
    const events: string[] = [];
    mocks.maybeStopService.mockImplementation(async ({ phase }) => {
      if (phase === "prepare") {
        events.push("stop");
      }
      return inspectOrStopService(phase);
    });
    mocks.prepareMutableUpdate.mockImplementation(async () => {
      events.push("mutable-prepare");
    });
    mocks.runGitUpdate.mockImplementation(
      async (params: Parameters<typeof import("./update-command-git.js").updateGitInstall>[0]) => {
        if (!params.inspectGitTarget || !params.beforeGitMutation) {
          throw new Error("Expected both real Git admission callbacks");
        }
        const target = { schemaVersions: { state: 15, agent: 19 } };
        await params.inspectGitTarget(target);
        events.push("git");
        return { ...successfulUpdate, mode: "git" };
      },
    );

    const execution = await executeMutableUpdate(executionParams("git"));

    expect(events).toEqual(["mutable-prepare", "git"]);
    expect(mocks.serviceStopped).toBe(false);
    expect(execution?.result.mode).toBe("git");
    expect(mocks.selectPackageExecutor).not.toHaveBeenCalled();
    expect(mocks.runPackageUpdate).not.toHaveBeenCalled();
  });
});
