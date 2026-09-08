import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import type { captureTargetDatabaseSchemaContext } from "./schema-preflight.js";
import type { PreManagedServiceStop } from "./update-command-service.js";

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
  pluginPreflight: vi.fn(),
  readGitRecovery: vi.fn(),
  runGitUpdate: vi.fn(),
  runPackageUpdate: vi.fn(),
  runtimeError: vi.fn(),
  revalidateSchemaContext:
    vi.fn<typeof import("./update-command-managed-context.js").revalidateUpdateDatabaseContext>(),
  validateCanary: vi.fn(),
  serviceStopped: false,
  shouldBlockServiceUpdate: vi.fn(),
  verifyPackageRecovery: vi.fn(),
}));

vi.mock("../../infra/update-global.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-global.js")>()),
  verifyPackageUpdateRecovery: mocks.verifyPackageRecovery,
}));
vi.mock("../../infra/update-candidate-canary.js", () => ({
  validateUpdateCandidateCanary: mocks.validateCanary,
}));

vi.mock("./update-command-plugin-preflight.js", () => ({
  preflightConfiguredNpmPluginTargets: mocks.pluginPreflight,
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

vi.mock("./update-command-managed-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-managed-context.js")>()),
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

import { UpdatePreMutationError } from "./shared.js";
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
    packageTargetVersion: "1.0.1",
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.serviceStopped = false;
  mocks.validateCanary.mockResolvedValue({
    status: "ok",
    phase: "readiness",
    steps: [],
    durationMs: 1,
    logTail: [],
  });
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
  mocks.pluginPreflight.mockResolvedValue(undefined);
  mocks.readGitRecovery.mockResolvedValue({ serviceRestartSafe: true });
  mocks.runGitUpdate.mockResolvedValue({ ...successfulUpdate, mode: "git" });
  mocks.runPackageUpdate.mockResolvedValue(successfulUpdate);
  mocks.shouldBlockServiceUpdate.mockReturnValue(false);
  mocks.verifyPackageRecovery.mockResolvedValue({ serviceRestartSafe: true });
});

describe("mutable update execution", () => {
  it.each(["available", "unavailable", "changed-owner"] as const)(
    "admits local artifacts from the staged version before rehearsal: %s",
    async (outcome) => {
      await withTestDir({ prefix: "openclaw-staged-plugin-admission-" }, async (stage) => {
        await fs.writeFile(
          path.join(stage, "package.json"),
          JSON.stringify({ name: "openclaw", version: "1.0.7" }),
        );
        const events: string[] = [];
        mocks.pluginPreflight.mockImplementation(async ({ targetVersion }) => {
          events.push("preflight");
          expect(targetVersion).toBe("1.0.7");
          expect(mocks.serviceStopped).toBe(false);
          if (outcome === "unavailable") {
            throw new UpdatePreMutationError(
              "plugin-target-unavailable",
              "fixture plugin is unavailable",
            );
          }
        });
        mocks.revalidateSchemaContext.mockImplementation(async (context) => {
          if (outcome === "changed-owner" && events.includes("preflight")) {
            throw new UpdatePreMutationError("database-schema-preflight", "fixture owner changed");
          }
          return context;
        });
        mocks.validateCanary.mockImplementation(async () => {
          events.push("rehearsal");
          return { status: "ok", phase: "readiness", steps: [], durationMs: 1, logTail: [] };
        });
        mocks.runPackageUpdate.mockImplementation(async ({ validateCandidate }) => {
          events.push("staged");
          expect(mocks.prepareMutableUpdate).not.toHaveBeenCalled();
          try {
            await validateCandidate(stage);
            return successfulUpdate;
          } catch (error) {
            if (!(error instanceof UpdatePreMutationError)) {
              throw error;
            }
            return { ...successfulUpdate, status: "error", reason: "package-update-failed" };
          }
        });
        const execution = await executeMutableUpdate({
          ...executionParams("package"),
          tag: "/tmp/candidate.tgz",
          packageInstallSpec: "/tmp/candidate.tgz",
          packageTargetVersion: undefined,
        });
        expect(events).toEqual(
          outcome === "available" ? ["staged", "preflight", "rehearsal"] : ["staged", "preflight"],
        );
        expect(execution?.mutationStarted).toBe(false);
        expect(mocks.serviceStopped).toBe(false);
        expect(execution?.result.status).toBe(outcome === "available" ? "ok" : "error");
        if (outcome !== "available") {
          expect(mocks.validateCanary).not.toHaveBeenCalled();
          expect(mocks.prepareMutableUpdate).not.toHaveBeenCalled();
          expect(execution?.result.reason).toBe(
            outcome === "unavailable" ? "plugin-target-unavailable" : "database-schema-preflight",
          );
        }
      });
    },
  );

  it("leaves a staged local same-version no-op free of plugin or mutable preparation", async () => {
    mocks.runPackageUpdate.mockResolvedValue({
      ...successfulUpdate,
      status: "skipped",
      reason: "already-current",
    });
    const execution = await executeMutableUpdate({
      ...executionParams("package"),
      tag: "/tmp/candidate.tgz",
      packageInstallSpec: "/tmp/candidate.tgz",
      packageTargetVersion: undefined,
    });
    expect(execution?.result.reason).toBe("already-current");
    expect(mocks.prepareMutableUpdate).not.toHaveBeenCalled();
    expect(mocks.pluginPreflight).not.toHaveBeenCalled();
    expect(mocks.serviceStopped).toBe(false);
  });

  it.each([
    "@openclaw/example@1.0.1: Package not found on npm",
    "@openclaw/example@1.0.1: npm view failed: ECONNRESET",
  ])("keeps the serving package unchanged when plugin admission fails: %s", async (detail) => {
    mocks.pluginPreflight.mockRejectedValue(
      new UpdatePreMutationError("plugin-target-unavailable", detail),
    );

    const execution = await executeMutableUpdate(executionParams("package"));

    expect(execution).toMatchObject({
      mutationStarted: false,
      result: {
        status: "error",
        reason: "plugin-target-unavailable",
        steps: [expect.objectContaining({ stderrTail: detail })],
      },
    });
    expect(mocks.serviceStopped).toBe(false);
    expect(mocks.prepareMutableUpdate).not.toHaveBeenCalled();
    expect(mocks.runPackageUpdate).not.toHaveBeenCalled();
  });

  it("waits for plugin availability before preparing a package update", async () => {
    const available = createDeferred();
    mocks.pluginPreflight.mockImplementation(() => available.promise);
    const execution = executeMutableUpdate(executionParams("package"));
    try {
      await vi.waitFor(() => expect(mocks.pluginPreflight).toHaveBeenCalledOnce());
      expect(mocks.serviceStopped).toBe(false);
      expect(mocks.prepareMutableUpdate).not.toHaveBeenCalled();
      expect(mocks.runPackageUpdate).not.toHaveBeenCalled();
    } finally {
      available.resolve();
    }
    expect((await execution)?.result).toBe(successfulUpdate);
    expect(mocks.runPackageUpdate).toHaveBeenCalledOnce();
  });

  it("refuses configuration drift during plugin admission before mutable preparation", async () => {
    let configChanged = false;
    mocks.pluginPreflight.mockImplementation(async () => {
      configChanged = true;
    });
    mocks.revalidateSchemaContext.mockImplementation(async (context) => {
      if (configChanged) {
        throw new UpdatePreMutationError("database-schema-preflight", "Configuration changed");
      }
      return context;
    });

    const execution = await executeMutableUpdate(executionParams("package"));

    expect(execution?.result.reason).toBe("database-schema-preflight");
    expect(mocks.prepareMutableUpdate).not.toHaveBeenCalled();
    expect(mocks.serviceStopped).toBe(false);
    expect(mocks.runPackageUpdate).not.toHaveBeenCalled();
  });

  it("captures the package target before schema revalidation and binds the latest service environment", async () => {
    const events: string[] = [];
    mocks.runPackageUpdate.mockImplementation(async () => {
      events.push("install");
      return successfulUpdate;
    });
    const serviceState = inspectOrStopService("inspect");
    mocks.maybeStopService.mockImplementation(async ({ phase }) => {
      if (phase === "prepare") {
        events.push("stop");
        return inspectOrStopService(phase);
      }
      return serviceState;
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
      events.push(
        events.includes("mutable-prepare") ? "schema-after-inspection" : "schema-before-inspection",
      );
      if (events.includes("mutable-prepare")) {
        await schemaGate.promise;
      }
      return { incompatible: [], indeterminate: [] };
    });

    const params = executionParams("package");
    const pendingExecution = executeMutableUpdate(params);
    try {
      await vi.waitFor(() => expect(events).toContain("schema-after-inspection"));
      expect(events.indexOf("schema-before-inspection")).toBeLessThan(
        events.indexOf("mutable-prepare"),
      );
      expect(events.at(-1)).toBe("schema-after-inspection");
      expect(mocks.serviceStopped).toBe(false);
      expect(mocks.runPackageUpdate).not.toHaveBeenCalled();
      params.packageInstallSpec = "openclaw@changed-during-schema-check";
      serviceState.serviceEnv = { OPENCLAW_PROFILE: "revalidated" };
    } finally {
      schemaGate.resolve();
      await pendingExecution;
    }
    const execution = await pendingExecution;

    expect(events.at(-1)).toBe("install");
    expect(mocks.prepareMutableUpdate).toHaveBeenCalledOnce();
    expect(execution?.result).toBe(successfulUpdate);
    expect(mocks.runPackageUpdate).toHaveBeenCalledOnce();
    expect(mocks.runPackageUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        installSpec: "openclaw@1.0.1",
        managedServiceEnv: { OPENCLAW_PROFILE: "revalidated" },
      }),
    );
  });

  it.each(["before-prepare", "after-prepare"] as const)(
    "refuses schema mismatch at %s without invoking the package updater",
    async (phase) => {
      mocks.checkTargetSchemas.mockImplementation(async () => ({
        incompatible:
          phase === "before-prepare" || mocks.prepareMutableUpdate.mock.calls.length > 0
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

      expect(mocks.serviceStopped).toBe(false);
      expect(mocks.prepareMutableUpdate).toHaveBeenCalledTimes(phase === "after-prepare" ? 1 : 0);
      expect(execution?.result.reason).toBe("database-schema-preflight");
      expect(mocks.runPackageUpdate).not.toHaveBeenCalled();
    },
  );

  it("reports activation exceptions without retrying a fallback package updater", async () => {
    const failure = new Error("activation failed");
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
    expect(mocks.runPackageUpdate).not.toHaveBeenCalled();
  });
});
