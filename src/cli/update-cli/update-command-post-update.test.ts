import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { GATEWAY_SERVICE_SELECTOR_ENV_KEYS } from "../../daemon/constants.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import { captureEnv } from "../../test-utils/env.js";

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
    async () => true,
  ),
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
  restoreDroppedPreUpdateChannels: (snapshot: unknown) => ({
    snapshot,
    changed: false,
    authoredChannels: [],
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
  revalidateManagedGatewayServiceAfterUpdate: mocks.revalidateService,
}));
vi.mock("./update-command-result.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-result.js")>()),
  markControlPlaneUpdateRestartSentinelFailureBestEffort: mocks.markSentinelFailure,
  writeControlPlaneUpdateRestartSentinelBestEffort: mocks.writeSentinel,
}));

import { finishUpdate } from "./update-command-post-update.js";
import { resolveUpdatedGatewayRestartPort } from "./update-command-service.js";

type FinishUpdateParams = Parameters<typeof finishUpdate>[0];
const stdinIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

afterEach(() => {
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

function createManagedServiceIdentityFixture() {
  const home = tempDirs.make("openclaw-post-update-service-home-");
  const keys = [
    "HOME",
    "USERPROFILE",
    "OPENCLAW_HOME",
    "OPENCLAW_SUPERVISOR_MODE",
    ...GATEWAY_SERVICE_SELECTOR_ENV_KEYS,
  ];
  const env = captureEnv(keys);
  // A private HOME does not change the OS account home checked by the real service guard.
  const userInfo = vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), homedir: home });
  for (const key of keys) {
    delete process.env[key];
  }
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return {
    home,
    restore: () => {
      userInfo.mockRestore();
      env.restore();
    },
  };
}

async function finishSuccessfulPackageSwitch(
  params: {
    previousRoot: string;
    packageRoot: string;
    restartEnvironment?: NodeJS.ProcessEnv;
    json?: boolean;
    sealed?: boolean;
    updateMode?: UpdateRunResult["mode"];
    stoppedForUpdate?: boolean;
    windowsTaskAutoStartRecovery?: NonNullable<
      FinishUpdateParams["preManagedServiceStop"]
    >["windowsTaskAutoStartRecovery"];
  } = {
    previousRoot: "/tmp/openclaw-update",
    packageRoot: "/tmp/openclaw-update",
    restartEnvironment: process.env,
  },
): Promise<void> {
  await finishUpdate({
    result: {
      status: "ok",
      mode: params.updateMode ?? "npm",
      root: params.packageRoot,
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
    root: params.packageRoot,
    previousInstallRoot: params.previousRoot,
    installKindChanged: !params.restartEnvironment,
    configSnapshot: validConfigSnapshot,
    requestedChannel: null,
    storedChannel: null,
    channel: params.updateMode === "git" ? "dev" : "stable",
    downgradeRisk: true,
    shouldRestart: Boolean(params.restartEnvironment),
    opts: { json: params.json },
    showProgress: false,
    controlPlaneUpdateSentinelMeta: {},
    preUpdatePluginInstallRecords: {},
    startedAt: Date.now(),
    updateStepTimeoutMs: 1_000,
    ...(params.restartEnvironment && {
      preManagedServiceStop: {
        stopped: params.stoppedForUpdate ?? true,
        windowsTaskAutoStartRecovery: params.windowsTaskAutoStartRecovery,
        ...(params.sealed && {
          serviceUpdateVerdict: {
            kind: "owned",
            root: params.previousRoot,
            refreshDefinition: false,
            fingerprint: "sealed",
          },
        }),
      },
      ownedManagedUpdateEnv: params.restartEnvironment,
    }),
  } as unknown as FinishUpdateParams);
}

describe("successful update finalization ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    let failure: unknown;
    try {
      await finishSuccessfulPackageSwitch();
    } catch (err) {
      failure = err;
    }

    const output = vi.mocked(defaultRuntime.log).mock.calls.flat().map(String).join("\n");
    expect.soft(failure).toBeUndefined();
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
      previousRoot: root,
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
      previousRoot: root,
      packageRoot: root,
      restartEnvironment: process.env,
      json: true,
    });

    expect(defaultRuntime.error).not.toHaveBeenCalled();
    expect(mocks.checkCompletionStatus).not.toHaveBeenCalled();
    expect(mocks.ensureCompletionCache).not.toHaveBeenCalled();
    expect(mocks.restartService).toHaveBeenCalledOnce();
  });

  it("skips interactive completion in non-TTY mode", async () => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });

    await finishSuccessfulPackageSwitch();

    expect(mocks.checkCompletionStatus).not.toHaveBeenCalled();
    expect(mocks.ensureCompletionCache).not.toHaveBeenCalled();
    expect(mocks.restartService).toHaveBeenCalledOnce();
  });

  it("keeps an unhealthy restart blocking before completion refresh", async () => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    mocks.restartService.mockResolvedValueOnce(false);

    await expect(finishSuccessfulPackageSwitch()).rejects.toMatchObject({
      name: "UpdateCommandFailure",
      exitCode: 1,
      result: { status: "error", reason: "restart-unhealthy" },
    });

    expect(mocks.printResult).toHaveBeenCalledOnce();
    expect(mocks.printResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", reason: "restart-unhealthy" }),
      expect.any(Object),
    );
    expect(mocks.markSentinelFailure).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "restart-unhealthy" }),
    );
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(mocks.checkCompletionStatus).not.toHaveBeenCalled();
  });

  it("reports elapsed time through restart and shell completion refresh", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    mocks.restartService.mockImplementationOnce(async () => {
      now += 200;
      return true;
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

    await expect(
      finishSuccessfulPackageSwitch({
        previousRoot: "/tmp/openclaw-update",
        packageRoot: "/tmp/openclaw-update",
        restartEnvironment: process.env,
        json: true,
        windowsTaskAutoStartRecovery: {
          suspended: Promise.resolve(true),
          beginMutation: () => {},
          restore,
          complete: () => {},
          interrupted: () => false,
        },
      }),
    ).rejects.toMatchObject({
      name: "UpdateCommandFailure",
      exitCode: 1,
      cause: restoreError,
      detail: expect.stringContaining(restoreError.message),
      result: { status: "error", reason: "windows-task-autostart-restore-failed" },
    });

    expect(restore).toHaveBeenCalledOnce();
    expect(mocks.restartService).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(mocks.printResult).toHaveBeenCalledOnce();
    expect(mocks.printResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", reason: "windows-task-autostart-restore-failed" }),
      expect.objectContaining({ json: true }),
    );
    expect(mocks.writeSentinel.mock.lastCall?.[0].result).toEqual(
      mocks.printResult.mock.lastCall?.[0],
    );
  });

  it("retires the wrapper before persisting and printing success", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-finalize-order-"));
    const previousRoot = path.join(home, "old-root");
    const wrapper = path.join(home, ".local", "bin", "openclaw");
    await fs.mkdir(path.dirname(wrapper), { recursive: true });
    await fs.writeFile(
      wrapper,
      `#!/usr/bin/env bash\nset -euo pipefail\nexec /usr/bin/node ${previousRoot}/dist/entry.js "$@"\n`,
      { mode: 0o755 },
    );
    const previousPath = process.env.PATH;
    process.env.PATH = path.dirname(wrapper);
    const unlink = vi.spyOn(fs, "unlink");
    try {
      await finishSuccessfulPackageSwitch({
        previousRoot,
        packageRoot: path.join(home, "package"),
      });

      expect(mocks.writeSentinel).toHaveBeenCalledTimes(2);
      expect(unlink.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.writeSentinel.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY,
      );
      expect(mocks.writeSentinel.mock.invocationCallOrder[1]).toBeLessThan(
        mocks.printResult.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
    } finally {
      unlink.mockRestore();
      process.env.PATH = previousPath;
      await fs.rm(home, { recursive: true, force: true });
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

    await finishUpdate({
      result: {
        status: "ok",
        mode: "npm",
        root: "/tmp/openclaw-update",
        steps: [],
        durationMs: 1,
      },
      root: "/tmp/openclaw-update",
      installKindChanged: false,
      configSnapshot: validConfigSnapshot,
      requestedChannel: null,
      storedChannel: null,
      channel: "stable",
      downgradeRisk: false,
      shouldRestart: false,
      opts: {},
      showProgress: false,
      ownedManagedUpdateEnv,
      controlPlaneUpdateSentinelMeta: {},
      preUpdatePluginInstallRecords: {},
      startedAt: Date.now(),
      updateStepTimeoutMs: 1_000,
    } as unknown as FinishUpdateParams);

    expect(mocks.readConfig).toHaveBeenCalledOnce();
    expect(mocks.loadPluginRecords).toHaveBeenCalledOnce();
    expect(mocks.updatePlugins).toHaveBeenCalledOnce();
    expect(mocks.completePluginUpdate).toHaveBeenCalledOnce();
    expect(mocks.leaseActive).toBe(false);
  });

  it("marks and prints an error without persisting success when retirement fails", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-finalize-failure-"));
    const previousRoot = path.join(home, "old-root");
    const wrapper = path.join(home, ".local", "bin", "openclaw");
    await fs.mkdir(path.dirname(wrapper), { recursive: true });
    await fs.writeFile(
      wrapper,
      `#!/usr/bin/env bash\nset -euo pipefail\nexec /usr/bin/node ${previousRoot}/dist/entry.js "$@"\n`,
      { mode: 0o755 },
    );
    const previousPath = process.env.PATH;
    process.env.PATH = path.dirname(wrapper);
    const unlink = vi.spyOn(fs, "unlink").mockRejectedValueOnce(new Error("unlink denied"));
    try {
      await expect(
        finishSuccessfulPackageSwitch({
          previousRoot,
          packageRoot: path.join(home, "package"),
        }),
      ).rejects.toMatchObject({
        name: "UpdateCommandFailure",
        exitCode: 1,
        detail: expect.stringContaining("unlink denied"),
        result: { status: "error", reason: "wrapper-retirement-failed" },
      });

      expect(mocks.writeSentinel).toHaveBeenCalledOnce();
      expect(mocks.printResult).toHaveBeenCalledWith(
        expect.objectContaining({ status: "error", reason: "wrapper-retirement-failed" }),
        expect.any(Object),
      );
      expect(mocks.markSentinelFailure).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "wrapper-retirement-failed" }),
      );
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
    } finally {
      unlink.mockRestore();
      process.env.PATH = previousPath;
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("removes operator overrides and process identity from the managed install environment", async () => {
    const identity = createManagedServiceIdentityFixture();
    const programArguments = ["/usr/bin/node", "/tmp/openclaw-update/dist/index.js", "gateway"];
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
    mocks.readServiceState.mockResolvedValueOnce({
      installed: true,
      loadState: { status: "loaded" },
      env: effectiveEnvironment,
      command: {
        programArguments,
        environment: effectiveEnvironment,
        managedDefinition: { programArguments, environment: managedEnvironment },
        managedOverrides: {
          environment: { keys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "UNSET_PROVIDER_KEY"] },
        },
      },
    });
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
        previousRoot: "/tmp/openclaw-update",
        packageRoot: "/tmp/openclaw-update",
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
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restart-config-"));
    const configPath = path.join(home, "openclaw.json");
    await fs.writeFile(configPath, JSON.stringify({ gateway: { mode: "local", port: 19600 } }));
    try {
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
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  describe("managed service finalization", () => {
    let identity: ReturnType<typeof createManagedServiceIdentityFixture>;
    beforeEach(() => {
      identity = createManagedServiceIdentityFixture();
    });
    afterEach(() => {
      vi.unstubAllEnvs();
      identity.restore();
    });

    it.each([
      ["unknown", true],
      ["inline reset", { resetInline: true }],
      ["environment-file reset", { resetFiles: true }],
    ] as const)("skips unsafe metadata refresh for %s ownership", async (_, environment) => {
      const programArguments = [
        "/usr/bin/node",
        "/tmp/openclaw-update/dist/index.js",
        "gateway",
        "--port",
        "19305",
      ];
      mocks.readServiceState.mockResolvedValueOnce({
        installed: true,
        loadState: { status: "loaded" },
        env: {},
        command: {
          programArguments,
          managedDefinition: { programArguments },
          managedOverrides: { environment },
        },
      });

      await finishSuccessfulPackageSwitch();

      expect(mocks.restartService).toHaveBeenCalledWith(
        expect.objectContaining({
          shouldRestart: true,
          refreshServiceEnv: false,
          serviceInstallEnv: null,
        }),
      );
      expect(mocks.restartService).toHaveBeenCalledWith(
        expect.objectContaining({
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
      mocks.readServiceState.mockResolvedValue({
        installed: true,
        loadState: { status: "loaded" },
        env: serviceEnv,
        command: {
          programArguments: [
            "/usr/bin/node",
            "/tmp/openclaw-update/dist/index.js",
            "gateway",
            ...args,
          ],
          environment: serviceEnv,
        },
      });
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
        previousRoot: "/tmp/openclaw-update",
        packageRoot: "/tmp/openclaw-update",
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
        mocks.readServiceState.mockResolvedValue({
          installed: true,
          loadState: { status: "loaded" },
          env: {},
          command: {
            programArguments: ["/usr/bin/node", "/tmp/openclaw-update/dist/index.js", "gateway"],
          },
        });
        if (failure === "inspection") {
          mocks.readServiceState.mockRejectedValueOnce(error);
        } else {
          mocks.revalidateService.mockRejectedValueOnce(error);
        }
        await expect(
          finishSuccessfulPackageSwitch({
            previousRoot: "/tmp/openclaw-update",
            packageRoot: "/tmp/openclaw-update",
            restartEnvironment: { ...process.env },
            sealed: true,
            json: true,
          }),
        ).rejects.toMatchObject({
          name: "UpdateCommandFailure",
          exitCode: 1,
          result: { status: "error", reason: "service-revalidation-failed" },
        });

        expect(mocks.restartService).not.toHaveBeenCalled();
        expect(mocks.prepareRestartScript).not.toHaveBeenCalled();
        expect(defaultRuntime.exit).not.toHaveBeenCalled();
        expect(defaultRuntime.error).toHaveBeenCalledWith(
          "Stopped gateway service could not be revalidated; inspect it before restarting manually.",
        );
        expect(mocks.printResult).toHaveBeenCalledOnce();
        expect(mocks.printResult).toHaveBeenCalledWith(
          expect.objectContaining({ status: "error", reason: "service-revalidation-failed" }),
          expect.objectContaining({ json: true }),
        );
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
      const programArguments = ["/usr/bin/node", "/tmp/openclaw-update/dist/index.js", "gateway"];
      mocks.readServiceState.mockResolvedValueOnce({
        installed: true,
        loadState: { status: unloaded ? "not-loaded" : "loaded" },
        env: serviceEnv,
        command: { programArguments, environment: serviceEnv },
      });
      mocks.restartService.mockResolvedValueOnce(activated);
      const finishing = finishSuccessfulPackageSwitch({
        previousRoot: "/tmp/openclaw-update",
        packageRoot: "/tmp/openclaw-update",
        restartEnvironment: { ...process.env },
        sealed: true,
        updateMode: unloaded ? "git" : "npm",
        stoppedForUpdate: !unloaded,
      });
      if (activated) {
        await finishing;
      } else {
        await expect(finishing).rejects.toMatchObject({
          name: "UpdateCommandFailure",
          exitCode: 1,
          result: { status: "error", reason: "restart-unhealthy" },
        });
      }

      expect(mocks.revalidateService).toHaveBeenCalledOnce();
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
          channel: unloaded ? "dev" : "stable",
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
        expect(mocks.printResult).toHaveBeenCalledWith(
          expect.objectContaining({ status: "error", reason: "restart-unhealthy" }),
          expect.any(Object),
        );
        expect(mocks.markSentinelFailure).toHaveBeenCalledWith(
          expect.objectContaining({ reason: "restart-unhealthy" }),
        );
        expect(defaultRuntime.exit).not.toHaveBeenCalled();
      }
    });

    it("leaves native service management blocked when HOME is relocated", async () => {
      const home = tempDirs.make("openclaw-post-update-relocated-home-");
      process.env.HOME = home;
      process.env.USERPROFILE = home;

      await finishSuccessfulPackageSwitch({
        previousRoot: home,
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
