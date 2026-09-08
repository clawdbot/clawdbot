import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { GatewayServiceCommandConfig } from "../../daemon/service.js";
import {
  createUpdateRun,
  getUpdateRun,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createManagedServiceIdentityFixture } from "./update-command-post-update.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const mocks = vi.hoisted(() => ({
  checkCompletionStatus: vi.fn(),
  completePluginUpdate: vi.fn(),
  ensureCompletionCache: vi.fn(),
  leaseActive: false,
  loadPluginRecords: vi.fn(),
  markSentinelFailure: vi.fn(async () => undefined),
  prepareRestartScript: vi.fn(async () => null),
  printResult: vi.fn(),
  readConfig: vi.fn(),
  createServiceConfigIO: vi.fn(),
  readServiceState: vi.fn(),
  restartService: vi.fn<typeof import("./update-command-service.js").maybeRestartService>(
    async () => "ok",
  ),
  stopService:
    vi.fn<
      typeof import("./update-command-service.js").maybeStopManagedServiceBeforeMutableUpdate
    >(),
  revalidateService:
    vi.fn<
      typeof import("./update-command-service.js").revalidateManagedGatewayServiceAfterUpdate
    >(),
  updatePlugins: vi.fn(),
  writeSentinel: vi.fn<
    typeof import("./update-command-result.js").writeControlPlaneUpdateRestartSentinelBestEffort
  >(async () => undefined),
}));

vi.mock("./progress.js", () => ({ printResult: mocks.printResult }));
vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  readConfigFileSnapshot: mocks.readConfig,
}));
vi.mock("../../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/io.js")>()),
  createConfigIO: mocks.createServiceConfigIO,
}));
vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  readGatewayServiceState: mocks.readServiceState,
}));
vi.mock("../../commands/doctor-completion.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../commands/doctor-completion.js")>()),
  checkShellCompletionStatus: mocks.checkCompletionStatus,
  ensureCompletionCacheExists: mocks.ensureCompletionCache,
}));
vi.mock("../../plugins/plugin-lifecycle-lease.js", () => ({
  withPluginLifecycleLease: async (_params: unknown, callback: () => unknown) => {
    mocks.leaseActive = true;
    try {
      return await callback();
    } finally {
      mocks.leaseActive = false;
    }
  },
}));
vi.mock("../../plugins/installed-plugin-index-records.js", () => ({
  loadInstalledPluginIndexInstallRecords: mocks.loadPluginRecords,
}));
vi.mock("./update-command-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-config.js")>()),
  persistRequestedUpdateChannel: async (params: { configSnapshot: unknown }) =>
    params.configSnapshot,
  preparePostCorePluginConfig: async () => ({
    configSnapshot: await mocks.readConfig(),
    configWriteOptions: {},
    configChanged: false,
    restoredAuthoredChannels: [],
  }),
}));
vi.mock("./update-command-fresh-doctor.js", () => ({
  completePostCorePluginUpdate: mocks.completePluginUpdate,
}));
vi.mock("./update-command-plugins.js", () => ({
  updatePluginsAfterCoreUpdate: mocks.updatePlugins,
}));
vi.mock("./restart-helper.js", () => ({
  prepareRestartScript: mocks.prepareRestartScript,
}));
vi.mock("./update-command-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service.js")>()),
  maybeRestartService: mocks.restartService,
  maybeStopManagedServiceBeforeMutableUpdate: mocks.stopService,
  revalidateManagedGatewayServiceAfterUpdate: mocks.revalidateService,
}));
vi.mock("./update-command-result.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-result.js")>()),
  markControlPlaneUpdateRestartSentinelFailureBestEffort: mocks.markSentinelFailure,
  writeControlPlaneUpdateRestartSentinelBestEffort: mocks.writeSentinel,
}));

import { finishUpdate } from "./update-command-post-update.js";
import * as rollbackModule from "./update-command-rollback.js";
import { resolveUpdatedGatewayRestartPort } from "./update-command-service.js";

type FinishUpdateParams = Parameters<typeof finishUpdate>[0];
const stdinIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const programArguments = ["/usr/bin/node", "/tmp/openclaw-update/dist/index.js", "gateway"];

function managedServiceState(
  env: NodeJS.ProcessEnv = {},
  command: Partial<GatewayServiceCommandConfig> = {},
  unloaded = false,
) {
  return {
    installed: true,
    loadState: { status: unloaded ? "not-loaded" : "loaded" },
    env,
    command: { programArguments: [...programArguments], ...command },
  };
}

function expectFailureReport(reason: string, options: unknown = expect.any(Object)) {
  expect(mocks.printResult).toHaveBeenCalledWith(
    expect.objectContaining({ status: "error", reason }),
    options,
    expect.any(Object),
  );
  expect(defaultRuntime.exit).not.toHaveBeenCalled();
}

function expectUpdateFailure(promise: Promise<unknown>, reason: string, details: object = {}) {
  return expect(promise).rejects.toMatchObject({
    name: "UpdateCommandFailure",
    exitCode: 1,
    result: { status: "error", reason },
    ...details,
  });
}

function taskRecovery(record: (phase: string) => void = () => {}) {
  return {
    suspended: Promise.resolve(true),
    beginMutation: vi.fn(() => record("mutation")),
    restore: vi.fn(async () => record("restore")),
    handoff: vi.fn(),
    complete: vi.fn(async () => record("complete")),
    interrupted: () => false,
  };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (stdinIsTTYDescriptor) {
    Object.defineProperty(process.stdin, "isTTY", stdinIsTTYDescriptor);
  } else {
    Reflect.deleteProperty(process.stdin, "isTTY");
  }
});

const validConfigSnapshot = {
  valid: true,
  parsed: {},
  config: {},
  runtimeConfig: {},
  sourceConfig: {},
  warnings: [],
  issues: [],
  legacyIssues: [],
};

const successfulPluginUpdate = {
  status: "ok",
  changed: false,
  sync: {
    changed: false,
    switchedToBundled: [],
    switchedToNpm: [],
    warnings: [],
    errors: [],
  },
  npm: { changed: false, outcomes: [] },
  integrityDrifts: [],
  warnings: [],
};

async function finishSuccessfulPackageSwitch(
  params: {
    previousRoot?: string;
    packageRoot?: string;
    restartEnvironment?: NodeJS.ProcessEnv;
    json?: boolean;
    sealed?: boolean;
    updateMode?: UpdateRunResult["mode"];
    stoppedForUpdate?: boolean;
    stoppedAtMs?: number;
    run?: FinishUpdateParams["opts"]["run"];
    windowsTaskAutoStartRecovery?: NonNullable<
      FinishUpdateParams["preManagedServiceStop"]
    >["windowsTaskAutoStartRecovery"];
  } = {
    restartEnvironment: process.env,
  },
  overrides: Partial<FinishUpdateParams> = {},
): Promise<void> {
  const packageRoot = params.packageRoot ?? "/tmp/openclaw-update";
  const previousRoot = params.previousRoot ?? packageRoot;
  await finishUpdate({
    result: {
      status: "ok",
      mode: params.updateMode ?? "npm",
      root: packageRoot,
      ...(params.sealed && {
        before: { version: "2026.4.23" },
        after: {
          version: "2026.4.24",
          ...(params.updateMode === "git" ? { buildId: "new-build" } : {}),
        },
      }),
      steps: [],
      durationMs: 1,
    },
    root: packageRoot,
    previousInstallRoot: previousRoot,
    installKindChanged: !params.restartEnvironment,
    configSnapshot: validConfigSnapshot,
    requestedChannel: null,
    storedChannel: null,
    channel: params.updateMode === "git" ? "dev" : "stable",
    downgradeRisk: true,
    shouldRestart: Boolean(params.restartEnvironment),
    opts: { json: params.json, run: params.run },
    controlPlaneUpdateSentinelMeta: {},
    preUpdatePluginInstallRecords: {},
    startedAt: Date.now(),
    updateStepTimeoutMs: 1_000,
    ...(params.restartEnvironment && {
      preManagedServiceStop: {
        stopped: params.stoppedForUpdate ?? true,
        stoppedAtMs: params.stoppedAtMs,
        windowsTaskAutoStartRecovery: params.windowsTaskAutoStartRecovery,
        ...(params.sealed && {
          serviceUpdateVerdict: {
            kind: "owned",
            root: previousRoot,
            refreshDefinition: false,
            fingerprint: "sealed",
          },
        }),
      },
      ownedManagedUpdateEnv: params.restartEnvironment,
    }),
    ...overrides,
  } as unknown as FinishUpdateParams);
}

describe("successful update finalization ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readServiceState.mockReset();
    mocks.restartService.mockReset().mockResolvedValue("ok");
    mocks.stopService.mockReset();
    mocks.leaseActive = false;
    mocks.loadPluginRecords.mockResolvedValue({});
    mocks.revalidateService.mockImplementation(async ({ root, preManagedServiceStop }) => ({
      kind: "owned",
      root,
      fingerprint: "sealed",
      refreshDefinition:
        preManagedServiceStop?.serviceUpdateVerdict?.kind === "owned"
          ? preManagedServiceStop.serviceUpdateVerdict.refreshDefinition
          : true,
    }));
    mocks.readConfig.mockResolvedValue(validConfigSnapshot);
    mocks.createServiceConfigIO.mockReturnValue({ readBestEffortConfig: async () => ({}) });
    mocks.updatePlugins.mockResolvedValue(successfulPluginUpdate);
    mocks.completePluginUpdate.mockResolvedValue({
      pluginUpdate: successfulPluginUpdate,
      configSnapshot: validConfigSnapshot,
    });
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
  });

  it("restarts after completion status inspection fails", async () => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    mocks.checkCompletionStatus.mockRejectedValueOnce(
      Object.assign(new Error("EACCES: completion profile read denied"), { code: "EACCES" }),
    );

    await expect.soft(finishSuccessfulPackageSwitch()).resolves.toBeUndefined();

    const output = vi.mocked(defaultRuntime.log).mock.calls.flat().map(String).join("\n");
    expect.soft(output).toContain("Shell completion refresh failed");
    expect.soft(output).toContain("Resolve the reported error before retrying");
    expect.soft(output).not.toContain("session only");
    expect.soft(mocks.restartService).toHaveBeenCalledOnce();
    expect(mocks.restartService.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.checkCompletionStatus.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("restarts when completion cache refresh reports failure", async () => {
    const root = tempDirs.make("openclaw-completion-failure-");
    await fs.writeFile(
      path.join(root, "openclaw.mjs"),
      'process.stderr.write("injected completion cache failure"); process.exit(1);',
    );

    await finishSuccessfulPackageSwitch({
      packageRoot: root,
      restartEnvironment: process.env,
    });

    const logCalls = vi.mocked(defaultRuntime.log).mock.calls;
    const warningIndex = logCalls.findIndex((call) =>
      call.some((value) => String(value).includes("Completion cache update failed")),
    );
    expect(warningIndex).toBeGreaterThanOrEqual(0);
    expect(mocks.restartService.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(defaultRuntime.log).mock.invocationCallOrder[warningIndex] ??
        Number.POSITIVE_INFINITY,
    );
    expect(logCalls[warningIndex]?.join(" ")).toContain("openclaw completion --write-state");
  });

  it("restarts when shell completion cache generation returns false", async () => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    mocks.checkCompletionStatus.mockResolvedValueOnce({
      shell: "zsh",
      profileInstalled: true,
      cacheExists: true,
      cachePath: "/tmp/openclaw-completion.zsh",
      usesSlowPattern: true,
    });
    mocks.ensureCompletionCache.mockResolvedValueOnce(false);

    await finishSuccessfulPackageSwitch();

    const output = vi.mocked(defaultRuntime.log).mock.calls.flat().map(String).join("\n");
    expect(output).toContain("completion cache generation failed");
    expect(output).toContain("Resolve the reported error before retrying");
    expect(output).not.toContain("source /tmp/openclaw-completion.zsh");
    expect(output).toContain("openclaw completion --write-state --install");
    expect(mocks.restartService).toHaveBeenCalledOnce();
    expect(mocks.restartService.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.ensureCompletionCache.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("keeps JSON completion cache failures silent and restarts", async () => {
    const root = tempDirs.make("openclaw-json-completion-failure-");
    await fs.writeFile(path.join(root, "openclaw.mjs"), "process.exit(1);");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });

    await finishSuccessfulPackageSwitch({
      packageRoot: root,
      restartEnvironment: process.env,
      json: true,
    });

    expect(defaultRuntime.error).not.toHaveBeenCalled();
    expect(mocks.checkCompletionStatus).not.toHaveBeenCalled();
    expect(mocks.restartService).toHaveBeenCalledOnce();
  });

  it("skips interactive completion in non-TTY mode", async () => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });

    await finishSuccessfulPackageSwitch();

    expect(mocks.checkCompletionStatus).not.toHaveBeenCalled();
    expect(mocks.restartService).toHaveBeenCalledOnce();
  });

  it.each(["failed", "restart-health-failed"] as const)(
    "keeps %s blocking before completion refresh",
    async (outcome) => {
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
      mocks.restartService.mockResolvedValueOnce(outcome);

      await expectUpdateFailure(finishSuccessfulPackageSwitch(), "restart-unhealthy");

      expect(mocks.printResult).toHaveBeenCalledOnce();
      expectFailureReport("restart-unhealthy");
      expect(mocks.markSentinelFailure).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "restart-unhealthy" }),
      );
      expect(mocks.checkCompletionStatus).not.toHaveBeenCalled();
    },
  );

  it("reports elapsed time through restart and shell completion refresh", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    mocks.restartService.mockImplementationOnce(async () => {
      now += 200;
      return "ok";
    });
    mocks.checkCompletionStatus.mockImplementationOnce(async () => {
      now += 300;
      return { shell: "zsh", profileInstalled: true, cacheExists: true, usesSlowPattern: false };
    });
    mocks.writeSentinel
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(async () => {
        now += 100;
      });
    await finishSuccessfulPackageSwitch();

    expect(mocks.printResult).toHaveBeenCalledOnce();
    expect(mocks.printResult.mock.lastCall?.[0]).toMatchObject({ status: "ok", durationMs: 500 });
    expect(mocks.writeSentinel.mock.lastCall?.[0].result).toEqual(
      mocks.printResult.mock.lastCall?.[0],
    );
  });

  it("reports Windows autostart recovery failure before exiting", async () => {
    const restoreError = new Error("task restore failed");
    const restore = vi.fn(async () => {
      throw restoreError;
    });

    await expectUpdateFailure(
      finishSuccessfulPackageSwitch({
        restartEnvironment: process.env,
        json: true,
        windowsTaskAutoStartRecovery: {
          ...taskRecovery(),
          restore,
        },
      }),
      "windows-task-autostart-restore-failed",
      { cause: restoreError, detail: expect.stringContaining(restoreError.message) },
    );

    expect(restore).toHaveBeenCalledOnce();
    expect(mocks.restartService).not.toHaveBeenCalled();
    expect(mocks.printResult).toHaveBeenCalledOnce();
    expectFailureReport(
      "windows-task-autostart-restore-failed",
      expect.objectContaining({ json: true }),
    );
    expect(mocks.writeSentinel.mock.lastCall?.[0].result).toEqual(
      mocks.printResult.mock.lastCall?.[0],
    );
  });

  it.each([
    { name: "retires the wrapper before persisting and printing success", denied: false },
    {
      name: "recovers and retains the package before reporting failed wrapper retirement",
      denied: true,
    },
  ])("$name", async ({ denied }) => {
    const home = tempDirs.make("openclaw-finalize-wrapper-");
    const previousRoot = path.join(home, "old-root");
    const wrapper = path.join(home, ".local", "bin", "openclaw");
    await fs.mkdir(path.dirname(wrapper), { recursive: true });
    await fs.writeFile(
      wrapper,
      `#!/usr/bin/env bash\nset -euo pipefail\nexec /usr/bin/node ${previousRoot}/dist/entry.js "$@"\n`,
      { mode: 0o755 },
    );
    vi.stubEnv("PATH", path.dirname(wrapper));
    const unlink = vi.spyOn(fs, "unlink");
    if (denied) {
      unlink.mockRejectedValueOnce(new Error("unlink denied"));
    }
    const rollback = vi
      .spyOn(rollbackModule, "rollbackFailedUpdate")
      .mockImplementationOnce(async ({ result }) => ({ result, rolledBack: false }));
    const retained = {
      name: "package backup retained",
      command: "openclaw update",
      cwd: previousRoot,
      durationMs: 0,
      exitCode: 0,
      stderrTail: "Retained previous package for recovery.",
    };
    const complete = vi.fn<NonNullable<FinishUpdateParams["packageTransaction"]>["complete"]>(
      async ({ activationVerified }) => (activationVerified ? undefined : retained),
    );
    const finishing = finishSuccessfulPackageSwitch(
      { previousRoot, packageRoot: path.join(home, "package") },
      { packageTransaction: { backupRoot: previousRoot, rollback: vi.fn(), complete } },
    );
    if (denied) {
      await expectUpdateFailure(finishing, "wrapper-retirement-failed", {
        detail: expect.stringContaining("unlink denied"),
      });
      expect(rollback).toHaveBeenCalledOnce();
      expect(complete).toHaveBeenCalledExactlyOnceWith({ activationVerified: false });
      expect(mocks.printResult).toHaveBeenCalledOnce();
      expect(mocks.printResult.mock.lastCall?.[0]).toMatchObject({
        status: "error",
        steps: expect.arrayContaining([retained]),
      });
      expect(mocks.writeSentinel).toHaveBeenCalledOnce();
      expectFailureReport("wrapper-retirement-failed");
      expect(mocks.markSentinelFailure).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "wrapper-retirement-failed" }),
      );
    } else {
      await finishing;
      expect(mocks.writeSentinel).toHaveBeenCalledTimes(2);
      expect(unlink.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.writeSentinel.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY,
      );
      expect(mocks.writeSentinel.mock.invocationCallOrder[1]).toBeLessThan(
        mocks.printResult.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
    }
  });

  it("releases the plugin lifecycle lease before fresh doctor completion", async () => {
    const pluginInstallRecords = {
      demo: {
        source: "npm",
        spec: "@acme/demo",
        installPath: "/tmp/demo",
      },
    };
    const ownedManagedUpdateEnv = {
      ...process.env,
      OPENCLAW_LIFECYCLE_TEST_MARKER: "owned",
    };
    mocks.readConfig.mockImplementationOnce(async () => {
      expect(mocks.leaseActive).toBe(true);
      expect(process.env.OPENCLAW_LIFECYCLE_TEST_MARKER).toBe("owned");
      return validConfigSnapshot;
    });
    mocks.loadPluginRecords.mockImplementationOnce(async () => {
      expect(mocks.leaseActive).toBe(true);
      expect(process.env.OPENCLAW_LIFECYCLE_TEST_MARKER).toBe("owned");
      return pluginInstallRecords;
    });
    mocks.updatePlugins.mockImplementationOnce(
      async (params: { pluginInstallRecords: unknown }) => {
        expect(mocks.leaseActive).toBe(true);
        expect(process.env.OPENCLAW_LIFECYCLE_TEST_MARKER).toBe("owned");
        expect(params.pluginInstallRecords).toBe(pluginInstallRecords);
        return successfulPluginUpdate;
      },
    );
    mocks.completePluginUpdate.mockImplementationOnce(async () => {
      expect(mocks.leaseActive).toBe(false);
      expect(process.env.OPENCLAW_LIFECYCLE_TEST_MARKER).toBe("owned");
      return {
        pluginUpdate: successfulPluginUpdate,
        configSnapshot: validConfigSnapshot,
      };
    });

    await finishSuccessfulPackageSwitch(
      {},
      { installKindChanged: false, downgradeRisk: false, ownedManagedUpdateEnv },
    );

    expect(mocks.readConfig).toHaveBeenCalledOnce();
    expect(mocks.loadPluginRecords).toHaveBeenCalledOnce();
    expect(mocks.updatePlugins).toHaveBeenCalledOnce();
    expect(mocks.completePluginUpdate).toHaveBeenCalledOnce();
    expect(mocks.leaseActive).toBe(false);
  });

  it("removes operator overrides and process identity from the managed install environment", async () => {
    const identity = createManagedServiceIdentityFixture(
      tempDirs.make("openclaw-post-update-service-home-"),
    );
    const managedEnvironment = {
      ANTHROPIC_API_KEY: "managed-provider",
      MANAGED_VALUE: "base",
      OPENCLAW_SERVICE_MARKER: "openclaw",
      OPENCLAW_SERVICE_KIND: "gateway",
      OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.work",
    };
    const effectiveEnvironment = {
      ...managedEnvironment,
      ANTHROPIC_API_KEY: "drop-in-provider",
      OPENAI_API_KEY: "operator-only-provider",
    };
    mocks.readServiceState.mockResolvedValueOnce(
      managedServiceState(effectiveEnvironment, {
        environment: effectiveEnvironment,
        managedDefinition: { programArguments, environment: managedEnvironment },
        managedOverrides: {
          environment: { keys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "UNSET_PROVIDER_KEY"] },
        },
      }),
    );
    vi.stubEnv("ANTHROPIC_API_KEY", effectiveEnvironment.ANTHROPIC_API_KEY);
    vi.stubEnv("OPENAI_API_KEY", effectiveEnvironment.OPENAI_API_KEY);
    vi.stubEnv("UNSET_PROVIDER_KEY", "removed-by-drop-in");
    vi.stubEnv("GEMINI_API_KEY", "allowed-runtime-credential");
    vi.stubEnv("OPENCLAW_PROFILE", "caller-only-profile");
    const callerStateDir = path.join(identity.home, ".openclaw-caller-only-profile");
    vi.stubEnv("OPENCLAW_STATE_DIR", callerStateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(callerStateDir, "openclaw.json"));
    try {
      const ownedUpdateEnvironment: NodeJS.ProcessEnv = { ...process.env, ...effectiveEnvironment };
      for (const key of ["OPENCLAW_PROFILE", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]) {
        delete ownedUpdateEnvironment[key];
      }
      await finishSuccessfulPackageSwitch({
        restartEnvironment: ownedUpdateEnvironment,
      });

      const installEnv = mocks.restartService.mock.lastCall?.[0].serviceInstallEnv;
      expect(installEnv?.OPENAI_API_KEY).toBeUndefined();
      expect(installEnv?.UNSET_PROVIDER_KEY).toBeUndefined();
      expect(installEnv?.ANTHROPIC_API_KEY).toBe("managed-provider");
      expect(installEnv?.MANAGED_VALUE).toBe("base");
      expect(installEnv?.GEMINI_API_KEY).toBe("allowed-runtime-credential");
      expect(installEnv?.OPENCLAW_PROFILE).toBeUndefined();
      expect(installEnv?.OPENCLAW_STATE_DIR).toBeUndefined();
      expect(installEnv?.OPENCLAW_CONFIG_PATH).toBeUndefined();
      expect(installEnv?.OPENCLAW_SERVICE_MARKER).toBeUndefined();
      expect(installEnv?.OPENCLAW_SERVICE_KIND).toBeUndefined();
      expect(installEnv?.OPENCLAW_LAUNCHD_LABEL).toBe("ai.openclaw.work");
    } finally {
      vi.unstubAllEnvs();
      identity.restore();
    }
  });

  it("reads the preserved service config without using the caller config or writing state", async () => {
    const { createConfigIO } =
      await vi.importActual<typeof import("../../config/io.js")>("../../config/io.js");
    mocks.createServiceConfigIO.mockImplementation(createConfigIO);
    const home = tempDirs.make("openclaw-restart-config-");
    const configPath = path.join(home, "openclaw.json");
    await fs.writeFile(configPath, JSON.stringify({ gateway: { mode: "local", port: 19600 } }));
    expect(
      await resolveUpdatedGatewayRestartPort({
        config: { gateway: { port: 19601 } },
        processEnv: { OPENCLAW_GATEWAY_PORT: "19602" },
        serviceEnv: { HOME: home, OPENCLAW_STATE_DIR: home, OPENCLAW_CONFIG_PATH: configPath },
        serviceCommand: {
          programArguments: ["/usr/bin/node", "/srv/openclaw/dist/index.js", "gateway"],
        },
      }),
    ).toBe(19600);
    expect(await fs.readdir(home)).toEqual(["openclaw.json"]);
  });

  describe("managed service finalization", () => {
    let identity: ReturnType<typeof createManagedServiceIdentityFixture>;
    beforeEach(() => {
      identity = createManagedServiceIdentityFixture(
        tempDirs.make("openclaw-post-update-service-home-"),
      );
    });
    afterEach(() => {
      vi.unstubAllEnvs();
      identity.restore();
    });

    it.each([
      { outcome: "unchanged", stoppedAtMs: 500, downtimeMs: 1_000 },
      { outcome: "restarted", stoppedAtMs: 500, downtimeMs: 1_500 },
      { outcome: "rolled-back", stoppedAtMs: 500, downtimeMs: 2_000 },
      { outcome: "rolled-back", stoppedAtMs: 0, downtimeMs: 2_500 },
      { outcome: "unverified", stoppedAtMs: 500, downtimeMs: null },
    ] as const)(
      "converges plugin packages online and measures migration plus restart ($outcome, initial stop=$stoppedAtMs)",
      async ({ outcome, stoppedAtMs, downtimeMs }) => {
        const changed = outcome !== "unchanged";
        const restartFailed = outcome === "rolled-back" || outcome === "unverified";
        const serviceEnv = {
          ...process.env,
          HOME: identity.home,
          OPENCLAW_STATE_DIR: identity.home,
        };
        const run = {
          runId: createUpdateRun({ trigger: "cli" }, { env: serviceEnv }).runId,
          env: serviceEnv,
        };
        let now = 1_000;
        vi.spyOn(Date, "now").mockImplementation(() => now);
        const events: string[] = [];
        const windowsEvents: string[] = [];
        const oldRecovery = taskRecovery((phase) => {
          if (phase === "complete") {
            windowsEvents.push("old-complete");
          }
        });
        const nextRecovery = taskRecovery((phase) => windowsEvents.push(`next-${phase}`));
        mocks.readServiceState.mockResolvedValue(
          managedServiceState(serviceEnv, { environment: serviceEnv }),
        );
        const recordVerified = () => {
          recordUpdateRunVerification(
            run.runId,
            {
              serviceRunning: true,
              versionMatch: true,
              settled: true,
              readyz: true,
              channelsReady: true,
              pluginErrors: [],
            },
            { env: serviceEnv },
          );
        };
        mocks.restartService.mockImplementation(async (params) => {
          events.push("start");
          now += events.length === 1 ? 500 : 200;
          if (restartFailed && events.length > 1) {
            recordUpdateRunVerification(run.runId, { serviceRunning: false }, { env: serviceEnv });
            return "restart-health-failed";
          }
          recordVerified();
          params.onVerified?.(now);
          return "ok";
        });
        const plugins = { ...successfulPluginUpdate, changed };
        mocks.updatePlugins.mockImplementationOnce(async () => {
          events.push("plugins");
          now = 11_000;
          return plugins;
        });
        mocks.stopService.mockImplementationOnce(async () => {
          events.push("stop");
          windowsEvents.push("next-suspend");
          return {
            stopped: true,
            inspected: true,
            runtimeInspected: true,
            running: true,
            stoppedAtMs: now,
            windowsTaskAutoStartRecovery: nextRecovery,
          };
        });
        mocks.completePluginUpdate.mockImplementationOnce(
          async (params: { beforeDoctor?: () => Promise<void> }) => {
            if (changed) {
              await params.beforeDoctor?.();
              events.push("doctor");
              expect(windowsEvents).toEqual(["old-complete", "next-suspend", "next-mutation"]);
              now += 300;
            }
            return { pluginUpdate: plugins, configSnapshot: validConfigSnapshot };
          },
        );
        vi.spyOn(rollbackModule, "rollbackFailedUpdate").mockImplementationOnce(
          async ({ result }): ReturnType<typeof rollbackModule.rollbackFailedUpdate> => {
            events.push("rollback");
            expect(getUpdateRun(run.runId, { env: serviceEnv })?.confirmedAtMs).toBeNull();
            now = 12_000;
            if (outcome === "rolled-back") {
              recordVerified();
            }
            return {
              result: {
                ...result,
                after: result.before,
                recovery:
                  outcome === "rolled-back"
                    ? {
                        serviceRestartSafe: true,
                        version: "2026.4.23",
                        packageRollbackVerified: true,
                        service: "healthy",
                      }
                    : {
                        serviceRestartSafe: false,
                        packageRollbackVerified: true,
                        reason: "runtime-verification-failed",
                      },
              },
              rolledBack: outcome === "rolled-back",
              ...(outcome === "rolled-back" ? { verifiedAtMs: now } : {}),
            };
          },
        );
        const finishing = finishSuccessfulPackageSwitch(
          {
            restartEnvironment: serviceEnv,
            sealed: true,
            stoppedAtMs,
            run,
            windowsTaskAutoStartRecovery: oldRecovery,
          },
          restartFailed
            ? {
                packageTransaction: {
                  backupRoot: "/tmp/previous-openclaw",
                  rollback: vi.fn(),
                  complete: vi.fn(async () => undefined),
                },
              }
            : {},
        );
        if (restartFailed) {
          await expect(finishing).rejects.toMatchObject({
            result: {
              status: "error",
              recovery: { serviceRestartSafe: outcome === "rolled-back" },
            },
          });
        } else {
          await finishing;
        }
        expect(events).toEqual([
          "start",
          "plugins",
          ...(changed ? ["stop", "doctor", "start"] : []),
          ...(restartFailed ? ["rollback"] : []),
        ]);
        expect(mocks.stopService).toHaveBeenCalledTimes(changed ? 1 : 0);
        if (changed) {
          expect(oldRecovery.complete).toHaveBeenCalledOnce();
          expect(nextRecovery.restore).toHaveBeenCalledWith(true, expect.any(Function), undefined);
          expect(nextRecovery.complete).toHaveBeenLastCalledWith(outcome !== "unverified");
          expect(windowsEvents.at(-1)).toBe("next-complete");
        }
        expect(getUpdateRun(run.runId, { env: serviceEnv })).toMatchObject({
          status:
            outcome === "rolled-back" ? "rolled-back" : restartFailed ? "failed" : "succeeded",
          downtimeMs,
        });
      },
    );

    it.each([
      ["unknown", true],
      ["inline reset", { resetInline: true }],
      ["environment-file reset", { resetFiles: true }],
    ] as const)("skips unsafe metadata refresh for %s ownership", async (_, environment) => {
      const portArguments = [...programArguments, "--port", "19305"];
      mocks.readServiceState.mockResolvedValueOnce(
        managedServiceState(
          {},
          {
            programArguments: portArguments,
            managedDefinition: { programArguments: portArguments },
            managedOverrides: { environment },
          },
        ),
      );

      await finishSuccessfulPackageSwitch();

      expect(mocks.restartService).toHaveBeenCalledWith(
        expect.objectContaining({
          shouldRestart: true,
          refreshServiceEnv: false,
          serviceInstallEnv: null,
          serviceUpdateVerdict: expect.objectContaining({ refreshDefinition: false }),
        }),
      );
      expect(mocks.restartService.mock.lastCall?.[0].gatewayPort).toBe(19305);
    });

    it.each([
      { source: "preserved ExecStart", sealed: true, args: ["--port", "19301"], expected: 19301 },
      { source: "preserved config", sealed: true, args: [], expected: 19304 },
      { source: "writable refresh", sealed: false, args: ["--port=19301"], expected: 19303 },
    ])("verifies the CLI service port for $source", async ({ sealed, args, expected }) => {
      const serviceEnv = { HOME: identity.home };
      mocks.readServiceState.mockResolvedValue(
        managedServiceState(serviceEnv, {
          programArguments: [...programArguments, ...args],
          environment: serviceEnv,
        }),
      );
      mocks.readConfig.mockResolvedValue({
        ...validConfigSnapshot,
        config: { gateway: { port: 19303 } },
      });
      mocks.completePluginUpdate.mockResolvedValue({
        pluginUpdate: successfulPluginUpdate,
        configSnapshot: { ...validConfigSnapshot, config: { gateway: { port: 19303 } } },
      });
      mocks.createServiceConfigIO.mockReturnValue({
        readBestEffortConfig: async () => ({ gateway: { port: 19304 } }),
      });
      vi.stubEnv("OPENCLAW_GATEWAY_PORT", "");
      await finishSuccessfulPackageSwitch({
        restartEnvironment: { ...process.env },
        sealed,
      });

      const restart = mocks.restartService.mock.calls.at(-1)?.[0];
      expect({ port: restart?.gatewayPort, refresh: restart?.refreshServiceEnv }).toEqual({
        port: expected,
        refresh: !sealed,
      });
      if (!sealed) {
        expect(mocks.prepareRestartScript).toHaveBeenCalledWith(
          serviceEnv,
          expected,
          expect.any(Array),
        );
        expect(mocks.createServiceConfigIO).not.toHaveBeenCalled();
      }
    });

    it.each(["inspection", "revalidation"] as const)(
      "does not restart a stopped sealed service when fresh %s fails",
      async (failure) => {
        let now = 1_000;
        vi.spyOn(Date, "now").mockImplementation(() => now);
        mocks.writeSentinel.mockImplementationOnce(async () => {
          now += 100;
        });
        const error = new Error("inspection-secret-canary");
        mocks.readServiceState.mockResolvedValue(managedServiceState());
        if (failure === "inspection") {
          mocks.readServiceState.mockRejectedValueOnce(error);
        } else {
          mocks.revalidateService.mockRejectedValueOnce(error);
        }
        await expectUpdateFailure(
          finishSuccessfulPackageSwitch({
            restartEnvironment: { ...process.env },
            sealed: true,
            json: true,
          }),
          "service-revalidation-failed",
        );

        expect(mocks.restartService).not.toHaveBeenCalled();
        expect(mocks.prepareRestartScript).not.toHaveBeenCalled();
        expect(defaultRuntime.error).toHaveBeenCalledWith(
          "Stopped gateway service could not be revalidated; inspect it before restarting manually.",
        );
        expect(mocks.printResult).toHaveBeenCalledOnce();
        expectFailureReport("service-revalidation-failed", expect.objectContaining({ json: true }));
        expect(mocks.writeSentinel.mock.lastCall?.[0].result).toEqual(
          mocks.printResult.mock.lastCall?.[0],
        );
      },
    );

    it.each([
      { name: "finalizes only after healthy activation", activated: true, unloaded: false },
      {
        name: "marks failed activation without finalizing success",
        activated: false,
        unloaded: false,
      },
      {
        name: "preserves the native context of an unloaded git service",
        activated: true,
        unloaded: true,
      },
    ])("canonical sealed post-update $name", async ({ activated, unloaded }) => {
      const serviceEnv = { MANAGED_VALUE: "revalidated" };
      const env = { OPENCLAW_STATE_DIR: tempDirs.make("update-retention-fact-") };
      const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
      mocks.readServiceState.mockResolvedValueOnce(
        managedServiceState(serviceEnv, { environment: serviceEnv }, unloaded),
      );
      mocks.restartService.mockImplementationOnce(async (params) => {
        if (!activated) {
          params.onVerificationFailure?.("readyz-unhealthy");
        }
        return activated ? "ok" : "failed";
      });
      const finishing = finishSuccessfulPackageSwitch({
        restartEnvironment: { ...process.env },
        sealed: true,
        updateMode: unloaded ? "git" : "npm",
        stoppedForUpdate: !unloaded,
        run,
      });
      if (activated) {
        await finishing;
      } else {
        await expectUpdateFailure(finishing, "readyz-unhealthy");
      }

      expect(mocks.restartService).toHaveBeenCalledOnce();
      expect(mocks.prepareRestartScript).not.toHaveBeenCalled();
      expect(mocks.restartService).toHaveBeenCalledWith(
        expect.objectContaining({
          refreshServiceEnv: false,
          serviceEnv,
          serviceUpdateVerdict: {
            kind: "owned",
            root: "/tmp/openclaw-update",
            refreshDefinition: false,
            fingerprint: "sealed",
          },
          result: expect.objectContaining({
            after: { version: "2026.4.24", ...(unloaded ? { buildId: "new-build" } : {}) },
          }),
          requireRunningServiceAfterRestart: !unloaded,
        }),
      );
      expect(mocks.revalidateService.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.restartService.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
      if (activated) {
        expect(mocks.writeSentinel).toHaveBeenCalledTimes(2);
        expect(mocks.restartService.mock.invocationCallOrder[0]).toBeLessThan(
          mocks.writeSentinel.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY,
        );
      } else {
        expect(mocks.writeSentinel).toHaveBeenCalledOnce();
        expect(mocks.printResult).toHaveBeenCalledOnce();
        expectFailureReport("readyz-unhealthy");
        expect(mocks.markSentinelFailure).toHaveBeenCalledWith(
          expect.objectContaining({ reason: "readyz-unhealthy" }),
        );
        expect(getUpdateRun(run.runId, { env })).toMatchObject({
          status: "failed",
          reason: "readyz-unhealthy",
          steps: expect.arrayContaining([
            expect.objectContaining({
              step: "package rollback",
              status: "skipped",
              detail:
                "No retained previous package transaction is available; automatic package restoration was not attempted.",
            }),
          ]),
        });
      }
    });

    it("leaves native service management blocked when HOME is relocated", async () => {
      const home = tempDirs.make("openclaw-post-update-relocated-home-");
      process.env.HOME = home;
      process.env.USERPROFILE = home;

      await finishSuccessfulPackageSwitch({
        packageRoot: home,
        restartEnvironment: { ...process.env },
        stoppedForUpdate: false,
      });

      expect(mocks.readServiceState).not.toHaveBeenCalled();
      expect(mocks.revalidateService).not.toHaveBeenCalled();
      expect(mocks.restartService).toHaveBeenCalledWith(
        expect.objectContaining({
          shouldRestart: false,
          serviceMutationSkipMessage: expect.stringContaining("HOME set to the OS account home"),
        }),
      );
    });
  });
});
