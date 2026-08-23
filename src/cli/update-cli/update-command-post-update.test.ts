import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";

const mocks = vi.hoisted(() => ({
  completePluginUpdate: vi.fn(),
  markSentinelFailure: vi.fn(async () => undefined),
  printResult: vi.fn(),
  readConfig: vi.fn(),
  restart: vi.fn(async () => undefined),
  restartService: vi.fn(async () => true),
  restoreWindowsAutoStart: vi.fn(async () => true),
  tryInstallCompletion: vi.fn(async () => undefined),
  tryWriteCompletionCache: vi.fn(async () => undefined),
  updatePlugins: vi.fn(),
  writeSentinel: vi.fn(async () => undefined),
}));

vi.mock("./progress.js", () => ({ printResult: mocks.printResult }));
vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  readConfigFileSnapshot: mocks.readConfig,
}));
vi.mock("../../plugins/plugin-lifecycle-lease.js", () => ({
  withPluginLifecycleLease: async (_params: unknown, callback: () => unknown) => callback(),
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
vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  tryWriteCompletionCache: mocks.tryWriteCompletionCache,
}));
vi.mock("./update-command-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service.js")>()),
  maybeRestartService: mocks.restartService,
  maybeRestartServiceAfterFailedMutableUpdate: mocks.restart,
  restoreWindowsTaskAutoStartOrExit: mocks.restoreWindowsAutoStart,
  tryInstallShellCompletion: mocks.tryInstallCompletion,
}));
vi.mock("./update-command-post-core.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-post-core.js")>()),
  markControlPlaneUpdateRestartSentinelFailureBestEffort: mocks.markSentinelFailure,
  writeControlPlaneUpdateRestartSentinelBestEffort: mocks.writeSentinel,
}));

import { retireStandaloneGitWrapper } from "./update-command-git.js";
import { finishUpdate } from "./update-command-post-update.js";

type FinishUpdateParams = Parameters<typeof finishUpdate>[0];

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

async function finishSuccessfulPackageSwitch(params: {
  previousRoot: string;
  packageRoot: string;
}): Promise<void> {
  await finishUpdate({
    result: {
      status: "ok",
      mode: "npm",
      root: params.packageRoot,
      steps: [],
      durationMs: 1,
    },
    root: params.packageRoot,
    previousInstallRoot: params.previousRoot,
    installKindChanged: true,
    configSnapshot: validConfigSnapshot,
    requestedChannel: null,
    storedChannel: null,
    channel: "stable",
    downgradeRisk: true,
    shouldRestart: false,
    opts: {},
    showProgress: false,
    controlPlaneUpdateSentinelMeta: {},
    preUpdatePluginInstallRecords: {},
    startedAt: Date.now(),
    updateStepTimeoutMs: 1_000,
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
    mocks.readConfig.mockResolvedValue(validConfigSnapshot);
    mocks.updatePlugins.mockResolvedValue(successfulPluginUpdate);
    mocks.completePluginUpdate.mockResolvedValue({
      pluginUpdate: successfulPluginUpdate,
      configSnapshot: validConfigSnapshot,
    });
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
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
});

function failedResult(recovery: UpdateRunResult["recovery"]): UpdateRunResult {
  return {
    status: "error",
    mode: "git",
    reason: "doctor-failed",
    recovery,
    steps: [],
    durationMs: 1,
  };
}

async function finishFailedUpdate(result: UpdateRunResult): Promise<void> {
  await finishUpdate({
    result,
    opts: {},
    showProgress: false,
    preManagedServiceStop: { stopped: true, serviceEnv: {} },
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

    expect(mocks.restart).toHaveBeenCalledOnce();
  });

  it("leaves a managed Gateway stopped after unverified rollback recovery", async () => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);

    await finishFailedUpdate(
      failedResult({ serviceRestartSafe: false, reason: "runtime-verification-failed" }),
    );

    expect(mocks.restart).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Managed gateway remains stopped"));
  });
});
