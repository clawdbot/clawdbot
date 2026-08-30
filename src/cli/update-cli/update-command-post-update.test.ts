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
  restart: vi.fn(async () => undefined),
  restartService: vi.fn<typeof import("./update-command-service.js").maybeRestartService>(
    async () => true,
  ),
  revalidateService:
    vi.fn<
      typeof import("./update-command-service.js").revalidateManagedGatewayServiceAfterUpdate
    >(),
  restoreWindowsAutoStart: vi.fn(async () => true),
  updatePlugins: vi.fn(),
  writeSentinel: vi.fn(async () => undefined),
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
  maybeRestartServiceAfterFailedMutableUpdate: mocks.restart,
  revalidateManagedGatewayServiceAfterUpdate: mocks.revalidateService,
  restoreWindowsTaskAutoStartOrExit: mocks.restoreWindowsAutoStart,
}));
vi.mock("./update-command-post-core.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-post-core.js")>()),
  markControlPlaneUpdateRestartSentinelFailureBestEffort: mocks.markSentinelFailure,
  writeControlPlaneUpdateRestartSentinelBestEffort: mocks.writeSentinel,
}));

import { retireStandaloneGitWrapper } from "./update-command-git.js";
import { finishUpdate } from "./update-command-post-update.js";
import { resolveUpdatedGatewayRestartPort } from "./update-command-service.js";

type FinishUpdateParams = Parameters<typeof finishUpdate>[0];
const stdinIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

afterEach(() => {
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

async function finishSuccessfulPackageSwitch(params: {
  previousRoot: string;
  packageRoot: string;
  restartEnvironment?: NodeJS.ProcessEnv;
  json?: boolean;
  sealed?: boolean;
  updateMode?: UpdateRunResult["mode"];
  stoppedForUpdate?: boolean;
}): Promise<void> {
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

describe("retireStandaloneGitWrapper", () => {
  it("removes only the installer wrapper for the previous checkout", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wrapper-retire-"));
    const oldRoot = path.join(home, "old checkout");
    const unrelatedWrapper = path.join(home, "earlier", "openclaw");
    const wrapper = path.join(home, ".local", "bin", "openclaw");
    const secondWrapper = path.join(home, "legacy", "bin", "openclaw");
    const oldWrapperContents = `#!/usr/bin/env bash\nset -euo pipefail\nexec /usr/bin/node ${oldRoot.replaceAll(" ", "\\ ")}/dist/entry.js "$@"\n`;
    await Promise.all([
      fs.mkdir(path.dirname(unrelatedWrapper), { recursive: true }),
      fs.mkdir(path.dirname(wrapper), { recursive: true }),
      fs.mkdir(path.dirname(secondWrapper), { recursive: true }),
    ]);
    await fs.writeFile(unrelatedWrapper, "#!/usr/bin/env bash\necho unrelated\n", { mode: 0o755 });
    await Promise.all([
      fs.writeFile(wrapper, oldWrapperContents, { mode: 0o755 }),
      fs.writeFile(secondWrapper, oldWrapperContents, { mode: 0o755 }),
    ]);
    try {
      await expect(
        retireStandaloneGitWrapper({
          previousRoot: oldRoot,
          platform: "linux",
          searchDirs: [
            path.dirname(unrelatedWrapper),
            path.dirname(wrapper),
            path.dirname(secondWrapper),
          ],
        }),
      ).resolves.toEqual({});
      await expect(fs.readFile(unrelatedWrapper, "utf8")).resolves.toContain("unrelated");
      await expect(fs.stat(wrapper)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(secondWrapper)).rejects.toMatchObject({ code: "ENOENT" });

      await fs.writeFile(
        wrapper,
        "#!/usr/bin/env node\nimport '../lib/node_modules/openclaw/openclaw.mjs';\n",
        { mode: 0o755 },
      );
      await expect(
        retireStandaloneGitWrapper({
          previousRoot: oldRoot,
          platform: "linux",
          searchDirs: [path.dirname(wrapper)],
        }),
      ).resolves.toEqual({});
      await expect(fs.stat(wrapper)).resolves.toBeDefined();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("removes only the exact PowerShell installer wrapper on Windows", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wrapper-retire-win-"));
    const oldRoot = "C:\\Users\\operator\\openclaw";
    const wrapper = path.join(home, ".local", "bin", "openclaw.cmd");
    await fs.mkdir(path.dirname(wrapper), { recursive: true });
    await fs.writeFile(
      wrapper,
      `@echo off\r\nnode "${path.win32.join(oldRoot, "dist", "entry.js")}" %*\r\n`,
    );
    try {
      await expect(
        retireStandaloneGitWrapper({
          previousRoot: oldRoot,
          platform: "win32",
          searchDirs: [path.dirname(wrapper)],
        }),
      ).resolves.toEqual({});
      await expect(fs.stat(wrapper)).rejects.toMatchObject({ code: "ENOENT" });

      await fs.writeFile(wrapper, "@echo off\r\necho unrelated\r\n");
      await expect(
        retireStandaloneGitWrapper({
          previousRoot: oldRoot,
          platform: "win32",
          searchDirs: [path.dirname(wrapper)],
        }),
      ).resolves.toEqual({});
      await expect(fs.readFile(wrapper, "utf8")).resolves.toContain("unrelated");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

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
      await finishSuccessfulPackageSwitch({
        previousRoot: "/tmp/openclaw-update",
        packageRoot: "/tmp/openclaw-update",
        restartEnvironment: process.env,
      });
    } catch (err) {
      failure = err;
    }

    const output = vi.mocked(defaultRuntime.log).mock.calls.flat().map(String).join("\n");
    expect.soft(failure).toBeUndefined();
    expect.soft(output).toContain("Shell completion refresh failed");
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

    await finishSuccessfulPackageSwitch({
      previousRoot: "/tmp/openclaw-update",
      packageRoot: "/tmp/openclaw-update",
      restartEnvironment: process.env,
    });

    const output = vi.mocked(defaultRuntime.log).mock.calls.flat().map(String).join("\n");
    expect(output).toContain("completion cache generation failed");
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

    await finishSuccessfulPackageSwitch({
      previousRoot: "/tmp/openclaw-update",
      packageRoot: "/tmp/openclaw-update",
      restartEnvironment: process.env,
    });

    expect(mocks.checkCompletionStatus).not.toHaveBeenCalled();
    expect(mocks.ensureCompletionCache).not.toHaveBeenCalled();
    expect(mocks.restartService).toHaveBeenCalledOnce();
  });

  it("keeps an unhealthy restart blocking before completion refresh", async () => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    mocks.restartService.mockResolvedValueOnce(false);
    mocks.checkCompletionStatus.mockRejectedValueOnce(
      new Error("completion status should not run after failed restart health"),
    );

    await finishSuccessfulPackageSwitch({
      previousRoot: "/tmp/openclaw-update",
      packageRoot: "/tmp/openclaw-update",
      restartEnvironment: process.env,
    });

    expect(mocks.markSentinelFailure).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "restart-unhealthy" }),
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(mocks.checkCompletionStatus).not.toHaveBeenCalled();
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
      await finishSuccessfulPackageSwitch({
        previousRoot,
        packageRoot: path.join(home, "package"),
      });

      expect(mocks.writeSentinel).toHaveBeenCalledTimes(1);
      expect(mocks.markSentinelFailure).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "wrapper-retirement-failed" }),
      );
      expect(mocks.printResult).toHaveBeenCalledWith(
        expect.objectContaining({ status: "error", reason: "wrapper-retirement-failed" }),
        expect.any(Object),
      );
      expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
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

      await finishSuccessfulPackageSwitch({
        previousRoot: "/tmp/openclaw-update",
        packageRoot: "/tmp/openclaw-update",
        restartEnvironment: process.env,
      });

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
        await finishSuccessfulPackageSwitch({
          previousRoot: "/tmp/openclaw-update",
          packageRoot: "/tmp/openclaw-update",
          restartEnvironment: { ...process.env },
          sealed: true,
        });

        expect(mocks.restartService).not.toHaveBeenCalled();
        expect(mocks.prepareRestartScript).not.toHaveBeenCalled();
        expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
        expect(defaultRuntime.error).toHaveBeenCalledWith(
          "Stopped gateway service could not be revalidated; inspect it before restarting manually.",
        );
        expect(mocks.printResult).not.toHaveBeenCalled();
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
      await finishSuccessfulPackageSwitch({
        previousRoot: "/tmp/openclaw-update",
        packageRoot: "/tmp/openclaw-update",
        restartEnvironment: { ...process.env },
        sealed: true,
        updateMode: unloaded ? "git" : "npm",
        stoppedForUpdate: !unloaded,
      });

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
        expect(mocks.markSentinelFailure).not.toHaveBeenCalled();
      } else {
        expect(mocks.writeSentinel).toHaveBeenCalledOnce();
        expect(mocks.markSentinelFailure).toHaveBeenCalledWith(
          expect.objectContaining({ reason: "restart-unhealthy" }),
        );
        expect(mocks.printResult).not.toHaveBeenCalled();
        expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
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

function failedResult(recovery: UpdateRunResult["recovery"]): UpdateRunResult {
  return {
    status: "error",
    mode: "git",
    reason: "doctor-failed",
    root: "/repo",
    recovery,
    steps: [],
    durationMs: 1,
  };
}

async function finishFailedUpdate(
  result: UpdateRunResult,
  options: { json?: boolean; stopped?: boolean } = {},
): Promise<void> {
  await finishUpdate({
    result,
    opts: { json: options.json },
    showProgress: false,
    preManagedServiceStop: { stopped: options.stopped ?? true, serviceEnv: {} },
    controlPlaneUpdateSentinelMeta: undefined,
  } as unknown as FinishUpdateParams);
}

async function finishSkippedUpdate(reason: string): Promise<void> {
  await finishUpdate({
    result: {
      status: "skipped",
      mode: reason === "dirty" ? "git" : "unknown",
      reason,
      steps: [],
      durationMs: 1,
    },
    opts: {},
    showProgress: false,
    controlPlaneUpdateSentinelMeta: undefined,
  } as unknown as FinishUpdateParams);
}

describe("skipped update exit status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
  });

  it("exits nonzero when local changes block a Git update", async () => {
    await finishSkippedUpdate("dirty");

    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("Update blocked: local files are edited"),
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("keeps a non-Git install skip successful", async () => {
    await finishSkippedUpdate("not-git-install");

    expect(defaultRuntime.exit).toHaveBeenCalledWith(0);
  });
});

describe("failed Git update recovery restart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
  });

  it("restarts a managed Gateway after verified rollback recovery", async () => {
    await finishFailedUpdate(failedResult({ serviceRestartSafe: true }));

    expect(mocks.restart).toHaveBeenCalledWith(expect.objectContaining({ root: "/repo" }));
  });

  it("leaves a managed Gateway stopped after unverified rollback recovery", async () => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);

    await finishFailedUpdate(
      failedResult({ serviceRestartSafe: false, reason: "runtime-verification-failed" }),
    );

    expect(mocks.restart).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Managed gateway remains stopped"));
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("repair the checkout or installation"),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("rerun `openclaw update`"));
  });

  it("explains how to recover from a dirty rollback checkout", async () => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);

    await finishFailedUpdate(
      failedResult({ serviceRestartSafe: false, reason: "rollback-checkout-dirty" }),
    );

    const output = log.mock.calls.flat().map(String).join("\n");
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(output).toContain("From the update root shown above");
    expect(output).toContain("git status --short");
    expect(output).toContain("resolve the reported changes");
    expect(output).toContain("rerun `openclaw update`");
    expect(output).toContain("Keep the gateway stopped until the update succeeds");
  });

  it("preserves the active profile in unsafe recovery guidance", async () => {
    vi.stubEnv("OPENCLAW_PROFILE", "work");
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);

    await finishFailedUpdate(
      failedResult({ serviceRestartSafe: false, reason: "rollback-checkout-dirty" }),
    );

    const output = log.mock.calls.flat().map(String).join("\n");
    expect(output).toContain("rerun `openclaw --profile work update`");
    expect(output).not.toContain("rerun `openclaw update`");
  });

  it("does not claim an unsafe recovery stopped a service that was already down", async () => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);

    await finishFailedUpdate(
      failedResult({ serviceRestartSafe: false, reason: "rollback-checkout-dirty" }),
      { stopped: false },
    );

    const output = log.mock.calls.flat().map(String).join("\n");
    expect(output).toContain("Update recovery could not prove a runnable installation");
    expect(output).toContain("resolve the reported changes");
    expect(output).not.toContain("remains stopped");
    expect(output).not.toContain("Keep the gateway stopped");
  });

  it("keeps structured JSON recovery free of prose guidance", async () => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
    const result = failedResult({
      serviceRestartSafe: false,
      reason: "rollback-checkout-dirty",
    });

    await finishFailedUpdate(result, { json: true });

    expect(mocks.printResult).toHaveBeenCalledWith(result, expect.objectContaining({ json: true }));
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});
