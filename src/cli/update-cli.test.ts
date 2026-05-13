import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_BUNDLED_RUNTIME_SIDECAR_PATHS } from "../../test/helpers/bundled-runtime-sidecars.js";
import type { OpenClawConfig, ConfigFileSnapshot } from "../config/types.openclaw.js";
import { writePackageDistInventory } from "../infra/package-dist-inventory.js";
import { isBetaTag } from "../infra/update-channels.js";
import type { UpdateRunResult } from "../infra/update-runner.js";
import { withEnvAsync } from "../test-utils/env.js";
import { VERSION } from "../version.js";
import { createCliRuntimeCapture } from "./test-runtime-capture.js";
import { isOwningNpmCommand } from "./update-cli.test-helpers.js";

const confirm = vi.fn();
const select = vi.fn();
const spinner = vi.fn(() => ({ start: vi.fn(), stop: vi.fn() }));
const isCancel = (value: unknown) => value === "cancel";

const readPackageName = vi.fn();
const readPackageVersion = vi.fn();
const resolveGlobalManager = vi.fn();
const serviceLoaded = vi.fn();
const serviceStop = vi.fn();
const serviceRestart = vi.fn();
const prepareRestartScript = vi.fn();
const runRestartScript = vi.fn();
const mockedRunDaemonInstall = vi.fn();
const serviceReadCommand = vi.fn();
const serviceReadRuntime = vi.fn();
const mockGetSelfAndAncestorPidsSync = vi.fn(() => new Set<number>([process.pid]));
const inspectPortUsage = vi.fn();
const classifyPortListener = vi.fn();
const formatPortDiagnostics = vi.fn();
const probeGateway = vi.fn();
const pathExists = vi.fn();
const syncPluginsForUpdateChannel = vi.fn();
const updateNpmInstalledPlugins = vi.fn();
const loadInstalledPluginIndexInstallRecords = vi.fn(
  async (params: { config?: OpenClawConfig } = {}) => params.config?.plugins?.installs ?? {},
);
const legacyConfigRepairMocks = vi.hoisted(() => ({
  repairLegacyConfigForUpdateChannel: vi.fn(),
}));
const nodeVersionSatisfiesEngine = vi.fn();
const spawn = vi.fn();
const { defaultRuntime: runtimeCapture, resetRuntimeCapture } = createCliRuntimeCapture();

vi.mock("@clack/prompts", () => ({
  confirm,
  select,
  isCancel,
  spinner,
}));

// Mock the update-runner module
vi.mock("../infra/update-runner.js", () => ({
  runGatewayUpdate: vi.fn(),
}));

vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRoot: vi.fn(),
  resolveOpenClawPackageRootSync: vi.fn(() => process.cwd()),
}));

vi.mock("../config/config.js", () => ({
  assertConfigWriteAllowedInCurrentMode: () => {
    if (process.env.OPENCLAW_NIX_MODE === "1") {
      throw new Error(
        [
          "Config is managed by Nix (`OPENCLAW_NIX_MODE=1`), so OpenClaw treats openclaw.json as immutable.",
          "Do not run setup, onboarding, openclaw update, plugin install/update/uninstall/enable, doctor repair/token-generation, or config set against this file.",
          "Agent-first Nix setup: https://github.com/openclaw/nix-openclaw#quick-start",
          "OpenClaw Nix overview: https://docs.openclaw.ai/install/nix",
        ].join("\n"),
      );
    }
  },
  ConfigMutationConflictError: class ConfigMutationConflictError extends Error {
    readonly currentHash: string | null;

    constructor(message: string, params: { currentHash: string | null }) {
      super(message);
      this.name = "ConfigMutationConflictError";
      this.currentHash = params.currentHash;
    }
  },
  readConfigFileSnapshot: vi.fn(),
  readSourceConfigBestEffort: vi.fn(),
  replaceConfigFile: vi.fn(),
  resolveGatewayPort: vi.fn(() => 18789),
}));

vi.mock("../infra/update-check.js", () => ({
  checkUpdateStatus: vi.fn(),
  compareSemverStrings: vi.fn((left: string | null, right: string | null) => {
    const parse = (value: string | null) => {
      if (!value) {
        return null;
      }
      const match = value.match(/(\d+)\.(\d+)\.(\d+)/);
      if (!match) {
        return null;
      }
      return [
        Number.parseInt(match[1] ?? "0", 10),
        Number.parseInt(match[2] ?? "0", 10),
        Number.parseInt(match[3] ?? "0", 10),
      ] as const;
    };
    const a = parse(left);
    const b = parse(right);
    if (!a || !b) {
      return null;
    }
    for (let index = 0; index < a.length; index += 1) {
      const diff = a[index] - b[index];
      if (diff !== 0) {
        return diff;
      }
    }
    return 0;
  }),
  fetchNpmPackageTargetStatus: vi.fn(),
  fetchNpmTagVersion: vi.fn(),
  resolveNpmChannelTag: vi.fn(),
}));

vi.mock("../infra/runtime-guard.js", () => ({
  nodeVersionSatisfiesEngine,
  parseSemver: (version: string | null) => {
    if (!version) {
      return null;
    }
    const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!match) {
      return null;
    }
    return {
      major: Number.parseInt(match[1] ?? "0", 10),
      minor: Number.parseInt(match[2] ?? "0", 10),
      patch: Number.parseInt(match[3] ?? "0", 10),
    };
  },
}));

vi.mock("../infra/restart-stale-pids.js", () => ({
  getSelfAndAncestorPidsSync: () => mockGetSelfAndAncestorPidsSync(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn,
    spawnSync: vi.fn(() => ({
      pid: 0,
      output: [],
      stdout: "",
      stderr: "",
      status: 0,
      signal: null,
    })),
  };
});

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: vi.fn(),
}));

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return {
    ...actual,
    displayString: (input: string) => input,
    isRecord: (value: unknown) =>
      typeof value === "object" && value !== null && !Array.isArray(value),
    pathExists: (...args: unknown[]) => pathExists(...args),
    resolveConfigDir: () => "/tmp/openclaw-config",
  };
});

vi.mock("../plugins/update.js", () => ({
  resolveTrustedSourceLinkedOfficialClawHubSpec: vi.fn(() => undefined),
  resolveTrustedSourceLinkedOfficialNpmSpec: vi.fn(() => undefined),
  syncPluginsForUpdateChannel: (...args: unknown[]) => syncPluginsForUpdateChannel(...args),
  updateNpmInstalledPlugins: (...args: unknown[]) => updateNpmInstalledPlugins(...args),
}));

vi.mock("../plugins/installed-plugin-index-records.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../plugins/installed-plugin-index-records.js")>();
  return {
    ...actual,
    loadInstalledPluginIndexInstallRecords,
    writePersistedInstalledPluginIndexInstallRecords: vi.fn(async () => undefined),
  };
});

vi.mock("../daemon/service.js", () => ({
  readGatewayServiceState: async () => {
    const command = await serviceReadCommand();
    const env = {
      ...process.env,
      ...(command && typeof command === "object" && "environment" in command
        ? (command.environment as NodeJS.ProcessEnv | undefined)
        : undefined),
    };
    const [loaded, runtime] = await Promise.all([
      serviceLoaded({ env }).catch(() => false),
      serviceReadRuntime(env).catch(() => undefined),
    ]);
    return {
      installed: command !== null,
      loaded,
      running: runtime?.status === "running",
      env,
      command,
      runtime,
    };
  },
  resolveGatewayService: vi.fn(() => ({
    isLoaded: (...args: unknown[]) => serviceLoaded(...args),
    readCommand: (...args: unknown[]) => serviceReadCommand(...args),
    readRuntime: (...args: unknown[]) => serviceReadRuntime(...args),
    stop: (...args: unknown[]) => serviceStop(...args),
    restart: (...args: unknown[]) => serviceRestart(...args),
  })),
}));

vi.mock("../infra/ports.js", () => ({
  inspectPortUsage: (...args: unknown[]) => inspectPortUsage(...args),
  classifyPortListener: (...args: unknown[]) => classifyPortListener(...args),
  formatPortDiagnostics: (...args: unknown[]) => formatPortDiagnostics(...args),
}));

vi.mock("../gateway/probe.js", () => ({
  probeGateway: (...args: unknown[]) => probeGateway(...args),
}));

vi.mock("./update-cli/restart-helper.js", () => ({
  prepareRestartScript: (...args: unknown[]) => prepareRestartScript(...args),
  runRestartScript: (...args: unknown[]) => runRestartScript(...args),
}));

// Mock doctor (heavy module; should not run in unit tests)
vi.mock("../commands/doctor.js", () => ({
  doctorCommand: vi.fn(),
}));
vi.mock("../commands/doctor/legacy-config-repair.js", () => ({
  repairLegacyConfigForUpdateChannel: legacyConfigRepairMocks.repairLegacyConfigForUpdateChannel,
}));
// Mock the daemon-cli module
vi.mock("./daemon-cli.js", () => ({
  runDaemonInstall: mockedRunDaemonInstall,
  runDaemonRestart: vi.fn(),
}));

// Mock the runtime
vi.mock("../runtime.js", () => ({
  defaultRuntime: runtimeCapture,
}));

const { runGatewayUpdate } = await import("../infra/update-runner.js");
const { resolveOpenClawPackageRoot } = await import("../infra/openclaw-root.js");
const {
  ConfigMutationConflictError,
  readConfigFileSnapshot,
  readSourceConfigBestEffort,
  replaceConfigFile,
} = await import("../config/config.js");
const { checkUpdateStatus, fetchNpmPackageTargetStatus, fetchNpmTagVersion, resolveNpmChannelTag } =
  await import("../infra/update-check.js");
const { runCommandWithTimeout } = await import("../process/exec.js");
const { runDaemonRestart, runDaemonInstall } = await import("./daemon-cli.js");
const { doctorCommand } = await import("../commands/doctor.js");
const { defaultRuntime } = await import("../runtime.js");
const { updateCommand, updateStatusCommand, updateWizardCommand } = await import("./update-cli.js");
const updateCliShared = await import("./update-cli/shared.js");
const { resolveGitInstallDir } = updateCliShared;
const { spawnSync } = await import("node:child_process");

function requireValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

type UpdateCliScenario = {
  name: string;
  run: () => Promise<void>;
  assert: () => void;
};

describe("update-cli", () => {
  const fixtureRoot = "/tmp/openclaw-update-tests";
  let fixtureCount = 0;
  const tempDirsToCleanup = new Set<string>();

  const createCaseDir = (prefix: string) => {
    const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
    // Tests only need a stable path; the directory does not have to exist because all I/O is mocked.
    return dir;
  };

  const createTrackedTempDir = async (prefix: string) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tempDirsToCleanup.add(dir);
    return dir;
  };

  const baseConfig = {} as OpenClawConfig;
  const baseSnapshot: ConfigFileSnapshot = {
    path: "/tmp/openclaw-config.json",
    exists: true,
    raw: "{}",
    parsed: {},
    resolved: baseConfig,
    sourceConfig: baseConfig,
    valid: true,
    config: baseConfig,
    runtimeConfig: baseConfig,
    issues: [],
    warnings: [],
    legacyIssues: [],
  };

  const setTty = (value: boolean | undefined) => {
    Object.defineProperty(process.stdin, "isTTY", {
      value,
      configurable: true,
    });
  };

  const setStdoutTty = (value: boolean | undefined) => {
    Object.defineProperty(process.stdout, "isTTY", {
      value,
      configurable: true,
    });
  };

  const mockPackageInstallStatus = (root: string) => {
    vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(root);
    vi.mocked(checkUpdateStatus).mockResolvedValue({
      root,
      installKind: "package",
      packageManager: "npm",
      deps: {
        manager: "npm",
        status: "ok",
        lockfilePath: null,
        markerPath: null,
      },
    });
  };

  const expectUpdateCallChannel = (channel: string) => {
    const call = vi.mocked(runGatewayUpdate).mock.calls[0]?.[0];
    expect(call?.channel).toBe(channel);
    return call;
  };

  const commandCall = (index = 0) => {
    const calls = vi.mocked(runCommandWithTimeout).mock.calls as unknown as Array<
      [string[], Record<string, unknown>]
    >;
    return calls[index];
  };

  const commandCalls = () =>
    vi.mocked(runCommandWithTimeout).mock.calls as unknown as Array<
      [string[], Record<string, unknown>]
    >;

  const packageInstallCommandCall = () =>
    commandCalls().find(([argv]) => argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g");

  const doctorCommandCall = () =>
    commandCalls().find(
      ([argv]) => argv[2] === "doctor" && argv[3] === "--non-interactive" && argv[4] === "--fix",
    );

  const gatewayCommandCall = (entryPath: string, action: "install" | "restart") =>
    commandCalls().find(
      ([argv]) => argv[1] === entryPath && argv[2] === "gateway" && argv[3] === action,
    );

  const spawnCall = (index = 0) => {
    const calls = spawn.mock.calls as unknown as Array<
      [string, string[], { env?: NodeJS.ProcessEnv; stdio?: unknown }]
    >;
    return calls[index];
  };

  const spawnSyncCall = (index = 0) => {
    const calls = vi.mocked(spawnSync).mock.calls as unknown as Array<
      [string, string[], { env?: NodeJS.ProcessEnv; timeout?: number }]
    >;
    return calls[index];
  };

  const syncPluginCall = (index = 0) => {
    const calls = syncPluginsForUpdateChannel.mock.calls as unknown as Array<
      [Record<string, unknown> & { channel?: string; config?: OpenClawConfig }]
    >;
    return calls[index]?.[0];
  };

  const npmPluginUpdateCall = (index = 0) => {
    const calls = updateNpmInstalledPlugins.mock.calls as unknown as Array<
      [Record<string, unknown> & { config?: OpenClawConfig; timeoutMs?: number }]
    >;
    return calls[index]?.[0];
  };
  const lastNpmPluginUpdateCall = () =>
    npmPluginUpdateCall(updateNpmInstalledPlugins.mock.calls.length - 1);

  const replaceConfigCall = (index = 0) => vi.mocked(replaceConfigFile).mock.calls[index]?.[0];
  const lastReplaceConfigCall = () =>
    replaceConfigCall(vi.mocked(replaceConfigFile).mock.calls.length - 1);

  const writeJsonCall = (index = 0) => vi.mocked(defaultRuntime.writeJson).mock.calls[index]?.[0];
  const lastWriteJsonCall = () =>
    writeJsonCall(vi.mocked(defaultRuntime.writeJson).mock.calls.length - 1);

  const probeGatewayCall = (index = 0) => probeGateway.mock.calls[index]?.[0];

  const pluginWarning = (result?: UpdateRunResult) => result?.postUpdate?.plugins?.warnings?.[0];
  const pluginOutcome = (result?: UpdateRunResult) => result?.postUpdate?.plugins?.npm.outcomes[0];

  const expectPackageInstallSpec = (spec: string) => {
    expect(runGatewayUpdate).not.toHaveBeenCalled();
    const call = packageInstallCommandCall();
    expect(call?.[0]).toEqual([
      "npm",
      "i",
      "-g",
      spec,
      "--no-fund",
      "--no-audit",
      "--loglevel=error",
    ]);
    if (call?.[1] === undefined) {
      throw new Error("Expected package install command options");
    }
  };

  const statfsFixture = (params: {
    bavail: number;
    bsize?: number;
    blocks?: number;
  }): ReturnType<typeof fsSync.statfsSync> => ({
    type: 0,
    bsize: params.bsize ?? 1024,
    blocks: params.blocks ?? 2_000_000,
    bfree: params.bavail,
    bavail: params.bavail,
    files: 0,
    ffree: 0,
  });

  const makeOkUpdateResult = (overrides: Partial<UpdateRunResult> = {}): UpdateRunResult =>
    ({
      status: "ok",
      mode: "git",
      steps: [],
      durationMs: 100,
      ...overrides,
    }) as UpdateRunResult;

  const runUpdateCliScenario = async (testCase: UpdateCliScenario) => {
    vi.clearAllMocks();
    await testCase.run();
    testCase.assert();
  };

  const runRestartFallbackScenario = async (params: { daemonInstall: "ok" | "fail" }) => {
    vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());
    if (params.daemonInstall === "fail") {
      vi.mocked(runDaemonInstall).mockRejectedValueOnce(new Error("refresh failed"));
    } else {
      vi.mocked(runDaemonInstall).mockResolvedValue(undefined);
    }
    prepareRestartScript.mockResolvedValue(null);
    serviceLoaded.mockResolvedValue(true);
    vi.mocked(runDaemonRestart).mockResolvedValue(true);

    await updateCommand({});

    expect(runDaemonInstall).toHaveBeenCalledWith({
      force: true,
      json: undefined,
    });
    expect(runDaemonRestart).toHaveBeenCalledTimes(1);
  };

  const setupNonInteractiveDowngrade = async () => {
    const tempDir = createCaseDir("openclaw-update");
    setTty(false);
    readPackageVersion.mockResolvedValue("2.0.0");

    mockPackageInstallStatus(tempDir);
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({
      tag: "latest",
      version: "0.0.1",
    });
    vi.mocked(runGatewayUpdate).mockResolvedValue({
      status: "ok",
      mode: "npm",
      steps: [],
      durationMs: 100,
    });
    vi.mocked(defaultRuntime.error).mockClear();
    vi.mocked(defaultRuntime.exit).mockClear();

    return tempDir;
  };

  const setupUpdatedRootRefresh = (params?: {
    gatewayUpdateImpl?: (root: string) => Promise<UpdateRunResult>;
    entrypoints?: string[];
  }) => {
    const root = createCaseDir("openclaw-updated-root");
    const entrypoints = params?.entrypoints ?? [path.join(root, "dist", "entry.js")];
    pathExists.mockImplementation(async (candidate: string) => entrypoints.includes(candidate));
    if (params?.gatewayUpdateImpl) {
      vi.mocked(runGatewayUpdate).mockImplementation(() => params.gatewayUpdateImpl!(root));
    } else {
      vi.mocked(runGatewayUpdate).mockResolvedValue({
        status: "ok",
        mode: "npm",
        root,
        steps: [],
        durationMs: 100,
      });
    }
    serviceLoaded.mockResolvedValue(true);
    return { root, entrypoints };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetRuntimeCapture();
    spawn.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        once: EventEmitter["once"];
      };
      queueMicrotask(() => {
        child.emit("exit", 0, null);
      });
      return child;
    });
    vi.mocked(defaultRuntime.exit).mockImplementation(() => {});
    vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(process.cwd());
    vi.mocked(readConfigFileSnapshot).mockResolvedValue(baseSnapshot);
    vi.mocked(readSourceConfigBestEffort).mockResolvedValue(baseSnapshot.config);
    vi.mocked(fetchNpmTagVersion).mockResolvedValue({
      tag: "latest",
      version: "9999.0.0",
    });
    vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue({
      target: "latest",
      version: "9999.0.0",
      nodeEngine: ">=22.16.0",
    });
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({
      tag: "latest",
      version: "9999.0.0",
    });
    nodeVersionSatisfiesEngine.mockReturnValue(true);
    vi.mocked(checkUpdateStatus).mockResolvedValue({
      root: "/test/path",
      installKind: "git",
      packageManager: "pnpm",
      git: {
        root: "/test/path",
        sha: "abcdef1234567890",
        tag: "v1.2.3",
        branch: "main",
        upstream: "origin/main",
        dirty: false,
        ahead: 0,
        behind: 0,
        fetchOk: true,
      },
      deps: {
        manager: "pnpm",
        status: "ok",
        lockfilePath: "/test/path/pnpm-lock.yaml",
        markerPath: "/test/path/node_modules",
      },
      registry: {
        latestVersion: "1.2.3",
      },
    });
    vi.mocked(runCommandWithTimeout).mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    });
    vi.spyOn(updateCliShared, "readPackageName").mockImplementation(readPackageName);
    vi.spyOn(updateCliShared, "readPackageVersion").mockImplementation(readPackageVersion);
    vi.spyOn(updateCliShared, "resolveGlobalManager").mockImplementation(resolveGlobalManager);
    readPackageName.mockResolvedValue("openclaw");
    readPackageVersion.mockResolvedValue("1.0.0");
    resolveGlobalManager.mockResolvedValue("npm");
    serviceStop.mockResolvedValue(undefined);
    serviceRestart.mockResolvedValue({ outcome: "completed" });
    serviceLoaded.mockResolvedValue(false);
    serviceReadCommand.mockImplementation(async () =>
      (await serviceLoaded()) ? { programArguments: ["openclaw", "gateway", "run"] } : null,
    );
    serviceReadRuntime.mockResolvedValue({
      status: "running",
      pid: 4242,
      state: "running",
    });
    mockGetSelfAndAncestorPidsSync.mockReturnValue(new Set<number>([process.pid]));
    prepareRestartScript.mockResolvedValue("/tmp/openclaw-restart-test.sh");
    runRestartScript.mockResolvedValue(undefined);
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 4242, command: "openclaw-gateway" }],
      hints: [],
    });
    classifyPortListener.mockReturnValue("gateway");
    formatPortDiagnostics.mockReturnValue(["Port 18789 is already in use."]);
    probeGateway.mockResolvedValue({
      ok: true,
      close: null,
      server: {
        version: "1.0.0",
        connId: "conn-test",
      },
      auth: { role: "operator", scopes: ["operator.read"], capability: "read_only" },
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
      connectLatencyMs: 1,
      error: null,
      url: "ws://127.0.0.1:18789",
    });
    pathExists.mockResolvedValue(false);
    syncPluginsForUpdateChannel.mockResolvedValue({
      changed: false,
      config: baseConfig,
      summary: {
        switchedToBundled: [],
        switchedToNpm: [],
        warnings: [],
        errors: [],
      },
    });
    updateNpmInstalledPlugins.mockResolvedValue({
      changed: false,
      config: baseConfig,
      outcomes: [],
    });
    vi.mocked(runDaemonInstall).mockResolvedValue(undefined);
    vi.mocked(runDaemonRestart).mockResolvedValue(true);
    vi.mocked(doctorCommand).mockResolvedValue(undefined);
    legacyConfigRepairMocks.repairLegacyConfigForUpdateChannel.mockImplementation(
      async (params: { configSnapshot: ConfigFileSnapshot }) => ({
        snapshot: params.configSnapshot,
        repaired: false,
      }),
    );
    confirm.mockResolvedValue(false);
    select.mockResolvedValue("stable");
    vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());
    setTty(false);
    setStdoutTty(false);
  });

  afterEach(async () => {
    if (tempDirsToCleanup.size === 0) {
      return;
    }
    await Promise.allSettled(
      [...tempDirsToCleanup].map(async (dir) => {
        await fs.rm(dir, { recursive: true, force: true });
      }),
    );
    tempDirsToCleanup.clear();
  });

  it("bounds completion cache refresh during update follow-up", async () => {
    const root = createCaseDir("openclaw-completion-timeout");
    pathExists.mockResolvedValue(true);

    await updateCliShared.tryWriteCompletionCache(root, false);

    const call = spawnSyncCall();
    expect(typeof call?.[0]).toBe("string");
    expect(call?.[1]).toEqual([path.join(root, "openclaw.mjs"), "completion", "--write-state"]);
    expect(call?.[2]?.env?.OPENCLAW_COMPLETION_SKIP_PLUGIN_COMMANDS).toBe("1");
    expect(call?.[2]?.timeout).toBe(30_000);
  });

  it("refuses mutating updates in Nix mode before update side effects", async () => {
    await withEnvAsync({ OPENCLAW_NIX_MODE: "1" }, async () => {
      await expect(updateCommand({ yes: true })).rejects.toThrow("OPENCLAW_NIX_MODE=1");
    });

    expect(runGatewayUpdate).not.toHaveBeenCalled();
    expect(replaceConfigFile).not.toHaveBeenCalled();
    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
  });

  it("logs friendly hint with manual refresh command when completion cache write times out", async () => {
    const root = createCaseDir("openclaw-completion-timeout-msg");
    pathExists.mockResolvedValue(true);
    const timeoutErr = Object.assign(new Error("spawnSync /usr/bin/node ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });
    vi.mocked(spawnSync).mockReturnValueOnce({
      pid: 0,
      output: [],
      stdout: "",
      stderr: "",
      status: null,
      signal: null,
      error: timeoutErr,
    });
    vi.mocked(runtimeCapture.log).mockClear();

    await updateCliShared.tryWriteCompletionCache(root, false);

    const logOutput = vi
      .mocked(runtimeCapture.log)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(logOutput).toContain("timed out after 30s");
    expect(logOutput).toContain("openclaw completion --write-state");
    expect(logOutput).not.toContain("Error: spawnSync");
  });

  it("respawns into the updated package root before running post-update tasks", async () => {
    const { entrypoints } = setupUpdatedRootRefresh();

    await updateCommand({ yes: true, timeout: "1800" });

    const call = spawnCall();
    expect(call?.[0]).toMatch(/node/);
    expect(call?.[1]).toEqual([entrypoints[0], "update", "--yes", "--timeout", "1800"]);
    expect(call?.[2]?.stdio).toBe("inherit");
    expect(call?.[2]?.env?.NODE_DISABLE_COMPILE_CACHE).toBe("1");
    expect(call?.[2]?.env?.OPENCLAW_UPDATE_POST_CORE).toBe("1");
    expect(call?.[2]?.env?.OPENCLAW_UPDATE_POST_CORE_CHANNEL).toBe("dev");
    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(runDaemonInstall).not.toHaveBeenCalled();
    expect(runDaemonRestart).not.toHaveBeenCalled();
  });

  it("finishes package updates when the post-core process writes a result but keeps handles open", async () => {
    setupUpdatedRootRefresh();
    const kill = vi.fn();
    spawn.mockImplementationOnce((_command: unknown, _argv: unknown, options: unknown) => {
      const resultPath = (options as { env?: NodeJS.ProcessEnv }).env
        ?.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH;
      if (!resultPath) {
        throw new Error("missing post-core result path");
      }
      queueMicrotask(() => {
        void fs.writeFile(resultPath, `${JSON.stringify({ status: "ok" })}\n`, "utf-8");
      });
      const child = new EventEmitter() as EventEmitter & {
        kill: typeof kill;
        once: EventEmitter["once"];
      };
      child.kill = kill;
      return child;
    });

    await updateCommand({ yes: true, restart: false });

    expect(kill).toHaveBeenCalledTimes(1);
    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
  });

  it("does not restart a stopped managed gateway after post-core plugin errors", async () => {
    const root = createCaseDir("openclaw-update");
    const entryPath = path.join(root, "dist", "index.js");
    mockPackageInstallStatus(root);
    serviceLoaded.mockResolvedValue(true);
    pathExists.mockImplementation(async (candidate: string) => candidate === entryPath);
    spawn.mockImplementationOnce((_command: unknown, _argv: unknown, options: unknown) => {
      const resultPath = (options as { env?: NodeJS.ProcessEnv }).env
        ?.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH;
      if (!resultPath) {
        throw new Error("missing post-core result path");
      }
      queueMicrotask(() => {
        void fs.writeFile(
          resultPath,
          JSON.stringify({
            status: "error",
            changed: false,
            warnings: [
              {
                pluginId: "demo",
                reason: "missing-extension-entry: ./dist/index.js",
                message:
                  'Plugin "demo" failed post-core payload smoke check (missing-extension-entry): ./dist/index.js',
                guidance: ["Run openclaw doctor --fix to attempt automatic repair."],
              },
            ],
            sync: {
              changed: false,
              switchedToBundled: [],
              switchedToNpm: [],
              warnings: [],
              errors: [],
            },
            npm: {
              changed: false,
              outcomes: [
                {
                  pluginId: "demo",
                  status: "error",
                  message: "Plugin extension entry missing",
                },
              ],
            },
            integrityDrifts: [],
          }),
          "utf-8",
        );
      });
      const child = new EventEmitter() as EventEmitter & {
        kill: () => boolean;
        once: EventEmitter["once"];
      };
      child.kill = vi.fn(() => true);
      return child;
    });

    await updateCommand({ yes: true });

    expect(serviceStop).toHaveBeenCalled();
    expect(serviceRestart).not.toHaveBeenCalled();
    expect(runDaemonRestart).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("does not carry gateway service markers into the post-core update process", async () => {
    setupUpdatedRootRefresh();

    await withEnvAsync(
      {
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
      },
      async () => {
        await updateCommand({ yes: true });
      },
    );

    const spawnEnv = spawnCall()?.[2]?.env;
    expect(spawnEnv?.OPENCLAW_SERVICE_MARKER).toBeUndefined();
    expect(spawnEnv?.OPENCLAW_SERVICE_KIND).toBeUndefined();
  });

  it("passes pre-update plugin install records into the post-core update process", async () => {
    setupUpdatedRootRefresh();
    const pluginInstallRecords = {
      demo: {
        source: "npm",
        spec: "@openclaw/demo@1.0.0",
        installPath: "/tmp/openclaw-demo-plugin",
      },
    } as const;
    let capturedRecords: unknown;
    loadInstalledPluginIndexInstallRecords.mockResolvedValueOnce(pluginInstallRecords);
    spawn.mockImplementationOnce((_node, _argv, options) => {
      const env = (options as { env?: NodeJS.ProcessEnv }).env;
      const recordsPath = env?.OPENCLAW_UPDATE_POST_CORE_INSTALL_RECORDS_PATH;
      if (!recordsPath) {
        throw new Error("missing post-core install records path");
      }
      capturedRecords = JSON.parse(fsSync.readFileSync(recordsPath, "utf-8"));
      const child = new EventEmitter() as EventEmitter & {
        once: EventEmitter["once"];
      };
      queueMicrotask(() => {
        child.emit("exit", 0, null);
      });
      return child;
    });

    await updateCommand({ yes: true, restart: false });

    expect(capturedRecords).toEqual(pluginInstallRecords);
    expect(syncPluginsForUpdateChannel).not.toHaveBeenCalled();
    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
  });

  it("respawns into the updated git root before requested channel persistence", async () => {
    const { entrypoints } = setupUpdatedRootRefresh({
      gatewayUpdateImpl: async (root) =>
        makeOkUpdateResult({
          mode: "git",
          root,
          before: { sha: "old-sha", version: "2026.4.26" },
          after: { sha: "new-sha", version: "2026.4.27" },
        }),
    });

    await updateCommand({ channel: "dev", yes: true, restart: false });

    const call = spawnCall();
    expect(call?.[0]).toMatch(/node/);
    expect(call?.[1]).toEqual([entrypoints[0], "update", "--no-restart", "--yes"]);
    expect(call?.[2]?.stdio).toBe("inherit");
    expect(call?.[2]?.env?.OPENCLAW_UPDATE_POST_CORE).toBe("1");
    expect(call?.[2]?.env?.OPENCLAW_UPDATE_POST_CORE_CHANNEL).toBe("dev");
    expect(call?.[2]?.env?.OPENCLAW_UPDATE_POST_CORE_REQUESTED_CHANNEL).toBe("dev");
    expect(replaceConfigFile).not.toHaveBeenCalled();
    expect(syncPluginsForUpdateChannel).not.toHaveBeenCalled();
    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
  });

  it("carries ClawHub risk acknowledgement into post-core resume", async () => {
    const { entrypoints } = setupUpdatedRootRefresh({
      gatewayUpdateImpl: async (root) =>
        makeOkUpdateResult({
          mode: "git",
          root,
          before: { sha: "old-sha", version: "2026.4.26" },
          after: { sha: "new-sha", version: "2026.4.27" },
        }),
    });

    await updateCommand({
      channel: "dev",
      yes: true,
      restart: false,
      acknowledgeClawHubRisk: true,
    });

    expect(spawnCall()?.[1]).toEqual([
      entrypoints[0],
      "update",
      "--no-restart",
      "--yes",
      "--acknowledge-clawhub-risk",
    ]);
  });

  it("keeps downgrade post-update work in the current process", async () => {
    const downgradedRoot = createCaseDir("openclaw-downgraded-root");
    setupUpdatedRootRefresh({
      gatewayUpdateImpl: async () =>
        makeOkUpdateResult({
          mode: "npm",
          root: downgradedRoot,
          before: { version: "2026.4.14" },
          after: { version: "2026.4.10" },
        }),
    });
    readPackageVersion.mockResolvedValue("2026.4.14");
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({
      tag: "latest",
      version: "2026.4.10",
    });
    probeGateway.mockResolvedValue({
      ok: true,
      close: null,
      server: {
        version: "2026.4.10",
        connId: "downgraded-gateway",
      },
      auth: { role: "operator", scopes: ["operator.read"], capability: "read_only" },
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
      connectLatencyMs: 1,
      error: null,
      url: "ws://127.0.0.1:18789",
    });

    await updateCommand({ yes: true, tag: "2026.4.10", restart: false });

    expect(spawn).not.toHaveBeenCalled();
    expect(syncPluginsForUpdateChannel).toHaveBeenCalledTimes(1);
    expect(updateNpmInstalledPlugins).toHaveBeenCalledTimes(1);
    expect(runDaemonInstall).not.toHaveBeenCalled();
    expect(probeGateway).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
  });

  it("fails the update when the fresh process exits non-zero", async () => {
    setupUpdatedRootRefresh();
    spawn.mockImplementationOnce(() => {
      const child = new EventEmitter() as EventEmitter & {
        once: EventEmitter["once"];
      };
      queueMicrotask(() => {
        child.emit("exit", 2, null);
      });
      return child;
    });

    await expect(updateCommand({ yes: true })).rejects.toThrow(
      "post-update process exited with code 2",
    );

    expect(defaultRuntime.exit).toHaveBeenCalledWith(2);
    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
  });

  it("post-core resume mode skips the core update and only runs post-update tasks", async () => {
    await withEnvAsync(
      {
        OPENCLAW_UPDATE_POST_CORE: "1",
        OPENCLAW_UPDATE_POST_CORE_CHANNEL: "stable",
      },
      async () => {
        await updateCommand({ restart: false });
      },
    );

    expect(runGatewayUpdate).not.toHaveBeenCalled();
    const installCall = (
      vi.mocked(runCommandWithTimeout).mock.calls as unknown as Array<[string[], unknown]>
    ).find(([argv]) => argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g");
    expect(installCall).toBeUndefined();
    expect(defaultRuntime.exit).toHaveBeenCalledWith(0);
    expect(syncPluginsForUpdateChannel).toHaveBeenCalledTimes(1);
    expect(updateNpmInstalledPlugins).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("post-core resume children exit after writing a plugin update result", async () => {
    const resultDir = createCaseDir("openclaw-post-core-result");
    const resultPath = path.join(resultDir, "plugins.json");
    await fs.mkdir(resultDir, { recursive: true });

    await withEnvAsync(
      {
        OPENCLAW_UPDATE_POST_CORE: "1",
        OPENCLAW_UPDATE_POST_CORE_CHANNEL: "stable",
        OPENCLAW_UPDATE_POST_CORE_RESULT_PATH: resultPath,
      },
      async () => {
        await updateCommand({ restart: false });
      },
    );

    const result = JSON.parse(await fs.readFile(resultPath, "utf-8")) as {
      status?: string;
    };
    expect(result.status).toBe("ok");
    expect(defaultRuntime.exit).toHaveBeenCalledWith(0);
    expect(runGatewayUpdate).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("post-core resume mode uses the parent install records snapshot for missing payload warnings", async () => {
    const resultDir = createCaseDir("openclaw-post-core-records");
    const recordsPath = path.join(resultDir, "plugin-install-records.json");
    const installPath = path.join(resultDir, "demo-plugin");
    await fs.mkdir(installPath, { recursive: true });
    await fs.writeFile(
      recordsPath,
      `${JSON.stringify({
        demo: {
          source: "npm",
          spec: "@openclaw/demo@1.0.0",
          installPath,
        },
      })}\n`,
      "utf-8",
    );
    pathExists.mockImplementation(async (candidate: string) => candidate === installPath);

    await withEnvAsync(
      {
        OPENCLAW_UPDATE_POST_CORE: "1",
        OPENCLAW_UPDATE_POST_CORE_CHANNEL: "stable",
        OPENCLAW_UPDATE_POST_CORE_INSTALL_RECORDS_PATH: recordsPath,
      },
      async () => {
        await updateCommand({ json: true, restart: false });
      },
    );

    const jsonOutput = lastWriteJsonCall() as UpdateRunResult | undefined;
    expect(jsonOutput?.postUpdate?.plugins?.status).toBe("warning");
    expect(jsonOutput?.postUpdate?.plugins?.warnings?.[0]?.reason).toContain(
      "package.json is missing",
    );
    const updateCall = lastNpmPluginUpdateCall() as { skipIds?: Set<string> } | undefined;
    expect(updateCall?.skipIds?.has("demo")).toBe(true);
  });

  it("post-core resume mode persists the requested update channel with the updated process", async () => {
    vi.mocked(readConfigFileSnapshot).mockResolvedValue({
      ...baseSnapshot,
      parsed: { update: { channel: "stable" } },
      resolved: { update: { channel: "stable" } } as OpenClawConfig,
      sourceConfig: { update: { channel: "stable" } } as OpenClawConfig,
      runtimeConfig: { update: { channel: "stable" } } as OpenClawConfig,
      config: { update: { channel: "stable" } } as OpenClawConfig,
      hash: "stable-hash",
    });

    await withEnvAsync(
      {
        OPENCLAW_UPDATE_POST_CORE: "1",
        OPENCLAW_UPDATE_POST_CORE_CHANNEL: "dev",
        OPENCLAW_UPDATE_POST_CORE_REQUESTED_CHANNEL: "dev",
      },
      async () => {
        await updateCommand({ restart: false });
      },
    );

    expect(runGatewayUpdate).not.toHaveBeenCalled();
    expect(replaceConfigFile).toHaveBeenCalledWith({
      nextConfig: {
        update: {
          channel: "dev",
        },
      },
      baseHash: "stable-hash",
    });
    expect(syncPluginCall()?.channel).toBe("dev");
    expect(syncPluginCall()?.config?.update?.channel).toBe("dev");
  });

  it("post-core resume mode retries update channel persistence after config hash drift", async () => {
    vi.mocked(readConfigFileSnapshot)
      .mockResolvedValueOnce({
        ...baseSnapshot,
        parsed: { update: { channel: "stable" } },
        resolved: { update: { channel: "stable" } } as OpenClawConfig,
        sourceConfig: { update: { channel: "stable" } } as OpenClawConfig,
        runtimeConfig: { update: { channel: "stable" } } as OpenClawConfig,
        config: { update: { channel: "stable" } } as OpenClawConfig,
        hash: "stable-hash",
      })
      .mockResolvedValueOnce({
        ...baseSnapshot,
        parsed: {
          meta: { lastTouchedVersion: "2026.4.30" },
          update: { channel: "stable" },
        },
        resolved: {
          meta: { lastTouchedVersion: "2026.4.30" },
          update: { channel: "stable" },
        } as OpenClawConfig,
        sourceConfig: {
          meta: { lastTouchedVersion: "2026.4.30" },
          update: { channel: "stable" },
        } as OpenClawConfig,
        runtimeConfig: {
          meta: { lastTouchedVersion: "2026.4.30" },
          update: { channel: "stable" },
        } as OpenClawConfig,
        config: {
          meta: { lastTouchedVersion: "2026.4.30" },
          update: { channel: "stable" },
        } as OpenClawConfig,
        hash: "newer-hash",
      });
    vi.mocked(replaceConfigFile)
      .mockRejectedValueOnce(
        new ConfigMutationConflictError("config changed since last load", {
          currentHash: "newer-hash",
        }),
      )
      .mockResolvedValueOnce({} as Awaited<ReturnType<typeof replaceConfigFile>>);

    await withEnvAsync(
      {
        OPENCLAW_UPDATE_POST_CORE: "1",
        OPENCLAW_UPDATE_POST_CORE_CHANNEL: "dev",
        OPENCLAW_UPDATE_POST_CORE_REQUESTED_CHANNEL: "dev",
      },
      async () => {
        await updateCommand({ restart: false });
      },
    );

    expect(replaceConfigFile).toHaveBeenCalledTimes(2);
    expect(replaceConfigFile).toHaveBeenLastCalledWith({
      nextConfig: {
        meta: { lastTouchedVersion: "2026.4.30" },
        update: { channel: "dev" },
      },
      baseHash: "newer-hash",
    });
    expect(syncPluginCall()?.config?.meta?.lastTouchedVersion).toBe("2026.4.30");
    expect(syncPluginCall()?.config?.update?.channel).toBe("dev");
  });

  it("passes the update timeout budget into post-core plugin updates", async () => {
    await withEnvAsync(
      {
        OPENCLAW_UPDATE_POST_CORE: "1",
        OPENCLAW_UPDATE_POST_CORE_CHANNEL: "stable",
      },
      async () => {
        await updateCommand({ restart: false, timeout: "1800" });
      },
    );

    expect(npmPluginUpdateCall()?.timeoutMs).toBe(1_800_000);
  });

  it("uses a fail-closed integrity policy for post-core plugin updates", async () => {
    await withEnvAsync(
      {
        OPENCLAW_UPDATE_POST_CORE: "1",
        OPENCLAW_UPDATE_POST_CORE_CHANNEL: "stable",
      },
      async () => {
        await updateCommand({ restart: false });
      },
    );

    const updateCall = npmPluginUpdateCall() as
      | {
          onIntegrityDrift?: (drift: {
            pluginId: string;
            spec: string;
            expectedIntegrity: string;
            actualIntegrity: string;
            resolvedSpec?: string;
          }) => Promise<boolean>;
        }
      | undefined;
    const onIntegrityDrift = updateCall?.onIntegrityDrift;
    expect(onIntegrityDrift).toBeTypeOf("function");
    if (!onIntegrityDrift) {
      throw new Error("missing integrity drift handler");
    }

    vi.mocked(runtimeCapture.log).mockClear();
    await expect(
      onIntegrityDrift({
        pluginId: "demo",
        spec: "@openclaw/demo@1.0.0",
        resolvedSpec: "@openclaw/demo@1.0.0",
        expectedIntegrity: "sha512-old",
        actualIntegrity: "sha512-new",
      }),
    ).resolves.toBe(false);
    const logs = vi.mocked(runtimeCapture.log).mock.calls.map((call) => String(call[0]));
    expect(logs.join("\n")).toContain("Plugin update aborted");
  });

  it("keeps json update output successful when post-core plugin updates warn", async () => {
    updateNpmInstalledPlugins.mockImplementationOnce(
      async (params: {
        config: OpenClawConfig;
        onIntegrityDrift?: (drift: {
          pluginId: string;
          spec: string;
          resolvedSpec?: string;
          resolvedVersion?: string;
          expectedIntegrity: string;
          actualIntegrity: string;
          dryRun: boolean;
        }) => Promise<boolean>;
      }) => {
        const proceed = await params.onIntegrityDrift?.({
          pluginId: "demo",
          spec: "@openclaw/demo@1.0.0",
          resolvedSpec: "@openclaw/demo@1.0.0",
          resolvedVersion: "1.0.0",
          expectedIntegrity: "sha512-old",
          actualIntegrity: "sha512-new",
          dryRun: false,
        });
        return {
          changed: false,
          config: params.config,
          outcomes: [
            {
              pluginId: "demo",
              status: "error",
              message:
                proceed === false
                  ? "Failed to update demo: aborted: npm package integrity drift detected for @openclaw/demo@1.0.0"
                  : "unexpected drift continuation",
            },
          ],
        };
      },
    );
    vi.mocked(defaultRuntime.writeJson).mockClear();

    await updateCommand({ json: true, restart: false });

    const jsonOutput = lastWriteJsonCall() as UpdateRunResult | undefined;
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
    expect(jsonOutput?.status).toBe("ok");
    expect(jsonOutput?.reason).toBeUndefined();
    expect(jsonOutput?.postUpdate?.plugins?.integrityDrifts).toEqual([
      {
        pluginId: "demo",
        spec: "@openclaw/demo@1.0.0",
        resolvedSpec: "@openclaw/demo@1.0.0",
        resolvedVersion: "1.0.0",
        expectedIntegrity: "sha512-old",
        actualIntegrity: "sha512-new",
        action: "aborted",
      },
    ]);
    expect(jsonOutput?.postUpdate?.plugins?.status).toBe("warning");
    expect(pluginWarning(jsonOutput)?.pluginId).toBe("demo");
    expect(pluginWarning(jsonOutput)?.guidance).toEqual([
      "Run openclaw doctor --fix to attempt automatic repair.",
      "Run openclaw plugins inspect demo --runtime --json for details.",
    ]);
    expect(pluginWarning(jsonOutput)?.reason).toContain("npm package integrity drift");
    expect(jsonOutput?.postUpdate?.plugins?.npm.outcomes[0]?.status).toBe("error");
    expect(jsonOutput?.postUpdate?.plugins?.npm.outcomes[0]?.message).toContain(
      "Run openclaw doctor --fix to attempt automatic repair.",
    );
    expect(jsonOutput?.postUpdate?.plugins?.npm.outcomes[0]?.message).toContain(
      "Run openclaw plugins inspect demo --runtime --json for details.",
    );
  });

  it("detects missing plugin payloads from persisted records before npm updates", async () => {
    const installPath = createCaseDir("openclaw-missing-plugin-payload");
    fsSync.mkdirSync(installPath, { recursive: true });
    const config = {
      plugins: {
        entries: {
          demo: { enabled: true },
        },
      },
    } as OpenClawConfig;
    vi.mocked(readConfigFileSnapshot).mockResolvedValue({
      ...baseSnapshot,
      parsed: config,
      resolved: config,
      sourceConfig: config,
      config,
      runtimeConfig: config,
    });
    loadInstalledPluginIndexInstallRecords.mockResolvedValueOnce({
      demo: {
        source: "npm",
        spec: "@openclaw/demo@1.0.0",
        installPath,
      },
    });
    syncPluginsForUpdateChannel.mockResolvedValueOnce({
      changed: false,
      config,
      summary: {
        switchedToBundled: [],
        switchedToNpm: [],
        warnings: [],
        errors: [],
      },
    });
    pathExists.mockImplementation(async (candidate: string) => candidate === installPath);
    vi.mocked(defaultRuntime.writeJson).mockClear();

    await updateCommand({ json: true, restart: false });

    const updateCall = lastNpmPluginUpdateCall() as { skipIds?: Set<string> } | undefined;
    expect(updateCall?.skipIds?.has("demo")).toBe(true);
    const jsonOutput = lastWriteJsonCall() as UpdateRunResult | undefined;
    expect(jsonOutput?.status).toBe("ok");
    expect(jsonOutput?.postUpdate?.plugins?.status).toBe("warning");
    expect(pluginWarning(jsonOutput)?.pluginId).toBe("demo");
    expect(pluginWarning(jsonOutput)?.reason).toContain("package.json is missing");
    expect(pluginOutcome(jsonOutput)?.pluginId).toBe("demo");
    expect(pluginOutcome(jsonOutput)?.status).toBe("error");
  });

  it("prints non-fatal plugin warnings in human update output", async () => {
    updateNpmInstalledPlugins.mockResolvedValueOnce({
      changed: false,
      config: baseConfig,
      outcomes: [
        {
          pluginId: "demo",
          status: "error",
          message: "Failed to update demo: registry timeout",
        },
      ],
    });

    await updateCommand({ yes: true, restart: false });

    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
    expect(runDaemonInstall).not.toHaveBeenCalled();
    expect(runDaemonRestart).not.toHaveBeenCalled();
    expect(runRestartScript).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(defaultRuntime.error)
        .mock.calls.map((call) => String(call[0]))
        .join("\n"),
    ).not.toContain("Update failed during plugin post-update sync.");
    const logs = vi
      .mocked(defaultRuntime.log)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(logs).toContain("Failed to update demo: registry timeout");
    expect(logs).toContain("Run openclaw doctor --fix to attempt automatic repair.");
    expect(logs).toContain("Run openclaw plugins inspect demo --runtime --json for details.");
  });

  it("marks disabled-after-failure plugin skips as post-update warnings", async () => {
    updateNpmInstalledPlugins.mockResolvedValueOnce({
      changed: true,
      config: baseConfig,
      outcomes: [
        {
          pluginId: "demo",
          status: "skipped",
          message:
            'Disabled "demo" after plugin update failure; OpenClaw will continue without it. Failed to update demo: registry timeout',
        },
      ],
    });
    vi.mocked(defaultRuntime.writeJson).mockClear();

    await updateCommand({ json: true, restart: false });

    const jsonOutput = lastWriteJsonCall() as UpdateRunResult | undefined;
    expect(jsonOutput?.postUpdate?.plugins?.status).toBe("warning");
    expect(pluginWarning(jsonOutput)?.pluginId).toBe("demo");
    expect(pluginWarning(jsonOutput)?.guidance).toEqual([
      "Run openclaw doctor --fix to attempt automatic repair.",
      "Run openclaw plugins inspect demo --runtime --json for details.",
    ]);
    expect(pluginOutcome(jsonOutput)?.pluginId).toBe("demo");
    expect(pluginOutcome(jsonOutput)?.status).toBe("skipped");
  });

  it("fails unexpected post-core plugin sync exceptions", async () => {
    syncPluginsForUpdateChannel.mockRejectedValueOnce(new Error("plugin sync invariant broke"));

    await expect(updateCommand({ json: true, restart: false })).rejects.toThrow(
      "plugin sync invariant broke",
    );
  });

  it("fails unexpected post-core npm update exceptions", async () => {
    updateNpmInstalledPlugins.mockRejectedValueOnce(new Error("npm update invariant broke"));

    await expect(updateCommand({ json: true, restart: false })).rejects.toThrow(
      "npm update invariant broke",
    );
  });

  it("preserves fresh-process plugin warning details in parent json output", async () => {
    setupUpdatedRootRefresh();
    spawn.mockImplementationOnce((_node, _argv, options) => {
      const child = new EventEmitter() as EventEmitter & {
        once: EventEmitter["once"];
      };
      const env = (options as { env?: NodeJS.ProcessEnv }).env;
      queueMicrotask(async () => {
        const resultPath = env?.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH;
        if (resultPath) {
          await fs.writeFile(
            resultPath,
            JSON.stringify({
              status: "warning",
              changed: false,
              warnings: [
                {
                  pluginId: "demo",
                  reason: "Failed to update demo: registry timeout",
                  message:
                    'Plugin "demo" could not be processed after the core update: Failed to update demo: registry timeout Run openclaw doctor --fix to attempt automatic repair. Run openclaw plugins inspect demo --runtime --json for details.',
                  guidance: [
                    "Run openclaw doctor --fix to attempt automatic repair.",
                    "Run openclaw plugins inspect demo --runtime --json for details.",
                  ],
                },
              ],
              sync: {
                changed: false,
                switchedToBundled: [],
                switchedToNpm: [],
                warnings: [],
                errors: [],
              },
              npm: {
                changed: false,
                outcomes: [
                  {
                    pluginId: "demo",
                    status: "error",
                    message: "Failed to update demo: registry timeout",
                  },
                ],
              },
              integrityDrifts: [],
            }),
            "utf-8",
          );
        }
        child.emit("exit", 0, null);
      });
      return child;
    });
    vi.mocked(defaultRuntime.writeJson).mockClear();

    await updateCommand({ yes: true, json: true, restart: false });

    const jsonOutput = lastWriteJsonCall() as UpdateRunResult | undefined;
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
    expect(jsonOutput?.status).toBe("ok");
    expect(jsonOutput?.reason).toBeUndefined();
    expect(jsonOutput?.postUpdate?.plugins?.warnings?.[0]?.guidance).toContain(
      "Run openclaw doctor --fix to attempt automatic repair.",
    );
    expect(jsonOutput?.postUpdate?.plugins?.npm.outcomes[0]?.message).toContain("registry timeout");
  });

  it.each([
    {
      name: "preview mode",
      run: async () => {
        vi.mocked(defaultRuntime.log).mockClear();
        serviceLoaded.mockResolvedValue(true);
        await updateCommand({ dryRun: true, channel: "beta" });
      },
      assert: () => {
        expect(replaceConfigFile).not.toHaveBeenCalled();
        expect(runGatewayUpdate).not.toHaveBeenCalled();
        expect(runDaemonInstall).not.toHaveBeenCalled();
        expect(runRestartScript).not.toHaveBeenCalled();
        expect(runDaemonRestart).not.toHaveBeenCalled();

        const logs = vi.mocked(defaultRuntime.log).mock.calls.map((call) => String(call[0]));
        expect(logs.join("\n")).toContain("Update dry-run");
        expect(logs.join("\n")).toContain("No changes were applied.");
      },
    },
    {
      name: "downgrade bypass",
      run: async () => {
        await setupNonInteractiveDowngrade();
        vi.mocked(defaultRuntime.exit).mockClear();
        await updateCommand({ dryRun: true });
      },
      assert: () => {
        expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
        expect(runGatewayUpdate).not.toHaveBeenCalled();
      },
    },
  ] as const)("updateCommand dry-run behavior: $name", runUpdateCliScenario);

  it.each([
    {
      name: "table output",
      run: async () => {
        vi.mocked(defaultRuntime.log).mockClear();
        await updateStatusCommand({ json: false });
      },
      assert: () => {
        const logs = vi.mocked(defaultRuntime.log).mock.calls.map((call) => call[0]);
        expect(logs.join("\n")).toContain("OpenClaw update status");
      },
    },
    {
      name: "json output",
      run: async () => {
        vi.mocked(defaultRuntime.log).mockClear();
        await updateStatusCommand({ json: true });
      },
      assert: () => {
        const last = requireValue(lastWriteJsonCall(), "update status JSON output");
        const parsed = last as Record<string, unknown>;
        const channel = parsed.channel as { value?: unknown };
        expect(channel.value).toBe(isBetaTag(VERSION) ? "beta" : "stable");
      },
    },
  ] as const)("updateStatusCommand rendering: $name", runUpdateCliScenario);

  it("renders update status when unrelated config validation would fail", async () => {
    vi.mocked(readConfigFileSnapshot).mockResolvedValue({
      ...baseSnapshot,
      valid: false,
      config: {} as OpenClawConfig,
    });
    vi.mocked(readSourceConfigBestEffort).mockResolvedValue({
      update: { channel: "dev" },
    } as OpenClawConfig);

    await updateStatusCommand({ json: true });

    const last = requireValue(lastWriteJsonCall(), "update status JSON output");
    const parsed = last as Record<string, unknown>;
    const channel = parsed.channel as { value?: unknown; config?: unknown };
    expect(channel.value).toBe("dev");
    expect(channel.config).toBe("dev");
  });

  it("parses update status --json as the subcommand option", async () => {
    const program = new Command();
    program.name("openclaw");
    program.enablePositionalOptions();
    let seenJson = false;
    const update = program.command("update").option("--json", "", false);
    update
      .command("status")
      .option("--json", "", false)
      .action((opts) => {
        seenJson = Boolean(opts.json);
      });

    await program.parseAsync(["node", "openclaw", "update", "status", "--json"]);

    expect(seenJson).toBe(true);
  });

  it.each([
    {
      name: "defaults to dev channel for git installs when unset",
      mode: "git" as const,
      options: {},
      prepare: async () => {},
      expectedChannel: "dev" as const,
      expectedTag: undefined as string | undefined,
    },
    {
      name: "defaults to stable channel for package installs when unset",
      options: { yes: true },
      prepare: async () => {
        const tempDir = createCaseDir("openclaw-update");
        mockPackageInstallStatus(tempDir);
      },
      expectedChannel: undefined as "stable" | undefined,
      expectedTag: undefined as string | undefined,
    },
    {
      name: "uses stored beta channel when configured",
      mode: "git" as const,
      options: {},
      prepare: async () => {
        vi.mocked(readConfigFileSnapshot).mockResolvedValue({
          ...baseSnapshot,
          config: { update: { channel: "beta" } } as OpenClawConfig,
        });
      },
      expectedChannel: "beta" as const,
      expectedTag: undefined as string | undefined,
    },
    {
      name: "switches git installs to package mode for explicit beta and persists it",
      mode: "git" as const,
      options: { channel: "beta" },
      prepare: async () => {},
      expectedChannel: undefined as string | undefined,
      expectedTag: undefined as string | undefined,
      expectedPersistedChannel: "beta" as const,
    },
  ])(
    "$name",
    async ({ mode, options, prepare, expectedChannel, expectedTag, expectedPersistedChannel }) => {
      await prepare();
      if (mode) {
        vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult({ mode }));
      }

      await updateCommand(options);

      if (expectedChannel !== undefined) {
        const call = expectUpdateCallChannel(expectedChannel);
        if (expectedTag !== undefined) {
          expect(call?.tag).toBe(expectedTag);
        }
      } else {
        expectPackageInstallSpec("openclaw@latest");
      }

      if (expectedPersistedChannel !== undefined) {
        expect(replaceConfigFile).toHaveBeenCalledTimes(1);
        const writeCall = replaceConfigCall() as
          | { nextConfig?: { update?: { channel?: string } } }
          | undefined;
        expect(writeCall?.nextConfig?.update?.channel).toBe(expectedPersistedChannel);
      }
    },
  );

  it("falls back to latest when beta tag is older than release", async () => {
    const tempDir = createCaseDir("openclaw-update");

    mockPackageInstallStatus(tempDir);
    vi.mocked(readConfigFileSnapshot).mockResolvedValue({
      ...baseSnapshot,
      config: { update: { channel: "beta" } } as OpenClawConfig,
    });
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({
      tag: "latest",
      version: "1.2.3-1",
    });
    await updateCommand({});

    expectPackageInstallSpec("openclaw@latest");
  });

  it("refreshes package-manager updates when the installed version already matches the target", async () => {
    const tempDir = createCaseDir("openclaw-update");
    mockPackageInstallStatus(tempDir);
    readPackageVersion.mockResolvedValue("2026.4.22");
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({
      tag: "latest",
      version: "2026.4.22",
    });

    await updateCommand({ yes: true });

    const installCalls = vi
      .mocked(runCommandWithTimeout)
      .mock.calls.filter(
        ([argv]) => Array.isArray(argv) && argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g",
      );
    expect(installCalls).toHaveLength(1);
    expect(updateNpmInstalledPlugins).toHaveBeenCalledTimes(1);
    expect(replaceConfigFile).not.toHaveBeenCalled();
    const logs = vi.mocked(defaultRuntime.log).mock.calls.map((call) => String(call[0]));
    expect(logs.join("\n")).not.toContain("already-current");
  });

  it("warns but still runs package updates when disk space looks low", async () => {
    const tempDir = createCaseDir("openclaw-update");
    mockPackageInstallStatus(tempDir);
    vi.spyOn(fsSync, "statfsSync").mockReturnValue(
      statfsFixture({
        bavail: 256,
        bsize: 1024 * 1024,
      }),
    );

    await updateCommand({ yes: true });

    expectPackageInstallSpec("openclaw@latest");
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
    expect(
      vi
        .mocked(defaultRuntime.log)
        .mock.calls.map((call) => String(call[0]))
        .join("\n"),
    ).toContain("Low disk space near");
  });

  it("allows package updates from inherited gateway service env when the managed gateway is not running", async () => {
    mockPackageInstallStatus(createCaseDir("openclaw-update"));
    serviceReadRuntime.mockResolvedValueOnce({
      status: "stopped",
      state: "stopped",
    });

    await withEnvAsync(
      {
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
      },
      async () => {
        await updateCommand({ yes: true });
      },
    );

    expect(defaultRuntime.error).not.toHaveBeenCalledWith(
      [
        "Package updates cannot run from inside the gateway service process.",
        "That path replaces the active OpenClaw dist tree while the live gateway may still lazy-load old chunks.",
        "Run `openclaw update` from a shell outside the gateway service, or stop the gateway service first and then update.",
      ].join("\n"),
    );
    expectPackageInstallSpec("openclaw@latest");
  });

  it("refuses package updates from inherited gateway service env when --no-restart leaves the gateway running", async () => {
    mockPackageInstallStatus(createCaseDir("openclaw-update"));
    serviceReadCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "run"],
      environment: {
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
      },
    });
    serviceLoaded.mockResolvedValue(true);

    await withEnvAsync(
      {
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
      },
      async () => {
        await updateCommand({ yes: true, restart: false });
      },
    );

    expect(defaultRuntime.error).toHaveBeenCalledWith(
      [
        "Package updates cannot run from inside the gateway service process.",
        "That path replaces the active OpenClaw dist tree while the live gateway may still lazy-load old chunks.",
        "Run `openclaw update` from a shell outside the gateway service, or stop the gateway service first and then update.",
      ].join("\n"),
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(serviceStop).not.toHaveBeenCalled();
    expect(runGatewayUpdate).not.toHaveBeenCalled();
    expect(packageInstallCommandCall()).toBeUndefined();
  });

  it.each([
    {
      name: "runtime probe fails",
      setupRuntime: () =>
        serviceReadRuntime.mockRejectedValueOnce(new Error("runtime probe failed")),
    },
    {
      name: "runtime status is unknown",
      setupRuntime: () => serviceReadRuntime.mockResolvedValueOnce({ status: "unknown" }),
    },
  ])(
    "refuses package updates from inherited gateway service env when $name",
    async ({ setupRuntime }) => {
      mockPackageInstallStatus(createCaseDir("openclaw-update"));
      serviceReadCommand.mockResolvedValue({
        programArguments: ["openclaw", "gateway", "run"],
        environment: {
          OPENCLAW_SERVICE_MARKER: "openclaw",
          OPENCLAW_SERVICE_KIND: "gateway",
        },
      });
      setupRuntime();

      await withEnvAsync(
        {
          OPENCLAW_SERVICE_MARKER: "openclaw",
          OPENCLAW_SERVICE_KIND: "gateway",
        },
        async () => {
          await updateCommand({ yes: true });
        },
      );

      expect(defaultRuntime.error).toHaveBeenCalledWith(
        [
          "Package updates cannot run from inside the gateway service process.",
          "That path replaces the active OpenClaw dist tree while the live gateway may still lazy-load old chunks.",
          "Run `openclaw update` from a shell outside the gateway service, or stop the gateway service first and then update.",
        ].join("\n"),
      );
      expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
      expect(serviceStop).not.toHaveBeenCalled();
      expect(runGatewayUpdate).not.toHaveBeenCalled();
      expect(packageInstallCommandCall()).toBeUndefined();
    },
  );

  it("refuses package updates from inherited gateway service env when the service definition is missing but runtime is live", async () => {
    mockPackageInstallStatus(createCaseDir("openclaw-update"));
    serviceReadCommand.mockResolvedValue(null);
    serviceReadRuntime.mockResolvedValueOnce({
      status: "running",
      pid: 4242,
      state: "running",
    });

    await withEnvAsync(
      {
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
      },
      async () => {
        await updateCommand({ yes: true });
      },
    );

    expect(defaultRuntime.error).toHaveBeenCalledWith(
      [
        "Package updates cannot run from inside the gateway service process.",
        "That path replaces the active OpenClaw dist tree while the live gateway may still lazy-load old chunks.",
        "Run `openclaw update` from a shell outside the gateway service, or stop the gateway service first and then update.",
      ].join("\n"),
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(serviceStop).not.toHaveBeenCalled();
    expect(runGatewayUpdate).not.toHaveBeenCalled();
    expect(packageInstallCommandCall()).toBeUndefined();
  });

  it("refuses package updates from inside the active gateway process tree", async () => {
    mockPackageInstallStatus(createCaseDir("openclaw-update"));
    serviceLoaded.mockResolvedValue(true);
    mockGetSelfAndAncestorPidsSync.mockReturnValue(new Set<number>([process.pid, 4242]));

    await updateCommand({ yes: true });

    const errors = vi.mocked(defaultRuntime.error).mock.calls.map((call) => String(call[0]));
    expect(errors.join("\n")).toContain(
      "openclaw update detected it is running inside the gateway process tree.",
    );
    expect(errors.join("\n")).toContain("Gateway PID 4242 is an ancestor");
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(serviceStop).not.toHaveBeenCalled();
    expect(packageInstallCommandCall()).toBeUndefined();
  });

  it("blocks package updates when the target requires a newer Node runtime", async () => {
    mockPackageInstallStatus(createCaseDir("openclaw-update"));
    vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue({
      target: "latest",
      version: "2026.3.23-2",
      nodeEngine: ">=22.16.0",
    });
    nodeVersionSatisfiesEngine.mockReturnValue(false);

    await updateCommand({ yes: true });

    expect(runGatewayUpdate).not.toHaveBeenCalled();
    expect(packageInstallCommandCall()).toBeUndefined();
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    const errors = vi.mocked(defaultRuntime.error).mock.calls.map((call) => String(call[0]));
    expect(errors.join("\n")).toContain("Node ");
    expect(errors.join("\n")).toContain(
      "Bare `npm i -g openclaw` can silently install an older compatible release.",
    );
  });

  it.each([
    {
      name: "explicit dist-tag",
      run: async () => {
        mockPackageInstallStatus(createCaseDir("openclaw-update"));
        await updateCommand({ tag: "next" });
      },
      expectedSpec: "openclaw@next",
    },
    {
      name: "main shorthand",
      run: async () => {
        mockPackageInstallStatus(createCaseDir("openclaw-update"));
        await updateCommand({ yes: true, tag: "main" });
      },
      expectedSpec: "github:openclaw/openclaw#main",
    },
    {
      name: "explicit git package spec",
      run: async () => {
        mockPackageInstallStatus(createCaseDir("openclaw-update"));
        await updateCommand({ yes: true, tag: "github:openclaw/openclaw#main" });
      },
      expectedSpec: "github:openclaw/openclaw#main",
    },
    {
      name: "OPENCLAW_UPDATE_PACKAGE_SPEC override",
      run: async () => {
        mockPackageInstallStatus(createCaseDir("openclaw-update"));
        await withEnvAsync(
          { OPENCLAW_UPDATE_PACKAGE_SPEC: "http://10.211.55.2:8138/openclaw-next.tgz" },
          async () => {
            await updateCommand({ yes: true, tag: "latest" });
          },
        );
      },
      expectedSpec: "http://10.211.55.2:8138/openclaw-next.tgz",
    },
  ] as const)(
    "resolves package install specs from tags and env overrides: $name",
    async ({ run, expectedSpec }) => {
      vi.clearAllMocks();
      readPackageName.mockResolvedValue("openclaw");
      readPackageVersion.mockResolvedValue("1.0.0");
      resolveGlobalManager.mockResolvedValue("npm");
      vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(process.cwd());
      await run();
      expectPackageInstallSpec(expectedSpec);
    },
  );

  it("fails package updates when the installed correction version does not match the requested target", async () => {
    const tempDir = createCaseDir("openclaw-update");
    const nodeModules = path.join(tempDir, "node_modules");
    const pkgRoot = path.join(nodeModules, "openclaw");
    mockPackageInstallStatus(tempDir);
    await fs.mkdir(pkgRoot, { recursive: true });
    await fs.writeFile(
      path.join(pkgRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.3.23" }),
      "utf-8",
    );
    for (const relativePath of TEST_BUNDLED_RUNTIME_SIDECAR_PATHS) {
      const absolutePath = path.join(pkgRoot, relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, "export {};\n", "utf-8");
    }
    await writePackageDistInventory(pkgRoot);
    readPackageVersion.mockResolvedValue("2026.3.23");
    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv) => {
      if (Array.isArray(argv) && argv[0] === "npm" && argv[1] === "root" && argv[2] === "-g") {
        return {
          stdout: nodeModules,
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
        };
      }
      return {
        stdout: "",
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      };
    });

    await updateCommand({ yes: true, tag: "2026.3.23-2" });

    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(replaceConfigFile).not.toHaveBeenCalled();
    const logs = vi.mocked(defaultRuntime.log).mock.calls.map((call) => String(call[0]));
    expect(logs.join("\n")).toContain("global install verify");
    expect(logs.join("\n")).toContain("expected installed version 2026.3.23-2, found 2026.3.23");
  });

  it("stops package post-update work when staged npm install verification fails", async () => {
    const tempDir = await createTrackedTempDir("openclaw-update-staged-fail-");
    const prefix = path.join(tempDir, "prefix");
    const nodeModules = path.join(prefix, "lib", "node_modules");
    const pkgRoot = path.join(nodeModules, "openclaw");
    mockPackageInstallStatus(pkgRoot);
    readPackageVersion.mockResolvedValue("2026.4.20");
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({
      tag: "latest",
      version: "2026.4.25",
    });
    await fs.mkdir(path.join(pkgRoot, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(pkgRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.20" }),
      "utf-8",
    );
    await fs.writeFile(path.join(pkgRoot, "dist", "index.js"), "export {};\n", "utf-8");
    await writePackageDistInventory(pkgRoot);

    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv) => {
      if (Array.isArray(argv) && argv[0] === "npm" && argv[1] === "root" && argv[2] === "-g") {
        return {
          stdout: `${nodeModules}\n`,
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
        };
      }
      if (
        Array.isArray(argv) &&
        argv[0] === "npm" &&
        argv[1] === "i" &&
        argv.includes("--prefix")
      ) {
        const stagePrefix = argv[argv.indexOf("--prefix") + 1];
        if (typeof stagePrefix !== "string") {
          throw new Error("missing stage prefix");
        }
        const stageRoot = path.join(stagePrefix, "lib", "node_modules", "openclaw");
        await fs.mkdir(path.join(stageRoot, "dist"), { recursive: true });
        await fs.writeFile(
          path.join(stageRoot, "package.json"),
          JSON.stringify({ name: "openclaw", version: "2026.4.25" }),
          "utf-8",
        );
        await fs.writeFile(path.join(stageRoot, "dist", "index.js"), "export {};\n", "utf-8");
        await writePackageDistInventory(stageRoot);
        await fs.writeFile(
          path.join(stageRoot, "dist", "stale-runtime.js"),
          "export {};\n",
          "utf-8",
        );
      }
      return {
        stdout: "",
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      };
    });

    await updateCommand({ yes: true, restart: false });

    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(doctorCommandCall()).toBeUndefined();
    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
    await expect(fs.readFile(path.join(pkgRoot, "package.json"), "utf-8")).resolves.toContain(
      '"version":"2026.4.20"',
    );
    const logs = vi.mocked(defaultRuntime.log).mock.calls.map((call) => String(call[0]));
    expect(logs.join("\n")).toContain("global install verify");
    expect(logs.join("\n")).toContain("unexpected packaged dist file dist/stale-runtime.js");
  });

  it("marks package post-update doctor as update-in-progress", async () => {
    const tempDir = await createTrackedTempDir("openclaw-update-package-");
    const nodeModules = path.join(tempDir, "node_modules");
    const pkgRoot = path.join(nodeModules, "openclaw");
    const entryPath = path.join(pkgRoot, "dist", "index.js");
    mockPackageInstallStatus(pkgRoot);
    await fs.mkdir(path.dirname(entryPath), { recursive: true });
    await fs.writeFile(
      path.join(pkgRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.21" }),
      "utf-8",
    );
    await fs.writeFile(entryPath, "export {};\n", "utf-8");
    await writePackageDistInventory(pkgRoot);
    pathExists.mockImplementation(async (candidate: string) => {
      try {
        await fs.access(candidate);
        return true;
      } catch {
        return false;
      }
    });
    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv) => {
      if (Array.isArray(argv) && argv[0] === "npm" && argv[1] === "root" && argv[2] === "-g") {
        return {
          stdout: `${nodeModules}\n`,
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
        };
      }
      return {
        stdout: "",
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      };
    });

    await updateCommand({ yes: true });

    const doctorCall = doctorCommandCall();
    expect(doctorCall?.[0][0]).toContain("node");
    expect(doctorCall?.[0].slice(1)).toEqual([entryPath, "doctor", "--non-interactive", "--fix"]);
    expect(
      (doctorCall?.[1].env as NodeJS.ProcessEnv | undefined)?.OPENCLAW_UPDATE_IN_PROGRESS,
    ).toBe("1");
  });

  it("stops a running managed gateway before package replacement", async () => {
    const tempDir = await createTrackedTempDir("openclaw-update-stop-service-");
    const nodeModules = path.join(tempDir, "node_modules");
    const pkgRoot = path.join(nodeModules, "openclaw");
    const entryPath = path.join(pkgRoot, "dist", "index.js");
    mockPackageInstallStatus(pkgRoot);
    await fs.mkdir(path.dirname(entryPath), { recursive: true });
    await fs.writeFile(
      path.join(pkgRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.21" }),
      "utf-8",
    );
    await fs.writeFile(entryPath, "export {};\n", "utf-8");
    await writePackageDistInventory(pkgRoot);
    serviceReadCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "run"],
      environment: {
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
      },
    });
    serviceLoaded.mockResolvedValue(true);
    serviceReadRuntime.mockResolvedValue({
      status: "running",
      pid: 4242,
      state: "running",
    });
    pathExists.mockImplementation(async (candidate: string) => {
      try {
        await fs.access(candidate);
        return true;
      } catch {
        return false;
      }
    });
    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv) => {
      if (Array.isArray(argv) && argv[0] === "npm" && argv[1] === "root" && argv[2] === "-g") {
        return {
          stdout: `${nodeModules}\n`,
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
        };
      }
      return {
        stdout: "",
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      };
    });

    await withEnvAsync(
      {
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
      },
      async () => {
        await updateCommand({ yes: true });
      },
    );

    const npmInstallCallIndex = vi
      .mocked(runCommandWithTimeout)
      .mock.calls.findIndex(
        (call) => Array.isArray(call[0]) && call[0][0] === "npm" && call[0][1] === "i",
      );
    const npmInstallCallOrder =
      vi.mocked(runCommandWithTimeout).mock.invocationCallOrder[npmInstallCallIndex];
    const serviceStopCall = serviceStop.mock.calls[0]?.[0] as
      | { env?: NodeJS.ProcessEnv }
      | undefined;
    expect(serviceStopCall?.env?.OPENCLAW_SERVICE_MARKER).toBe("openclaw");
    expect(serviceStopCall?.env?.OPENCLAW_SERVICE_KIND).toBe("gateway");
    const serviceStopCallOrder = serviceStop.mock.invocationCallOrder[0];
    const requiredServiceStopCallOrder = requireValue(
      serviceStopCallOrder,
      "service stop call order",
    );
    const requiredNpmInstallCallOrder = requireValue(npmInstallCallOrder, "npm install call order");
    expect(requiredServiceStopCallOrder).toBeLessThan(requiredNpmInstallCallOrder);
  });

  it("refreshes package installs even when the current version already matches the target", async () => {
    const tempDir = await createTrackedTempDir("openclaw-update-current-");
    const nodeModules = path.join(tempDir, "node_modules");
    const pkgRoot = path.join(nodeModules, "openclaw");
    const entryPath = path.join(pkgRoot, "dist", "index.js");
    mockPackageInstallStatus(pkgRoot);
    readPackageVersion.mockResolvedValue("2026.4.23");
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({
      tag: "latest",
      version: "2026.4.23",
    });
    await fs.mkdir(path.dirname(entryPath), { recursive: true });
    await fs.writeFile(
      path.join(pkgRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.23" }),
      "utf-8",
    );
    await fs.writeFile(entryPath, "export {};\n", "utf-8");
    for (const relativePath of TEST_BUNDLED_RUNTIME_SIDECAR_PATHS) {
      const absolutePath = path.join(pkgRoot, relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, "export {};\n", "utf-8");
    }
    await writePackageDistInventory(pkgRoot);
    pathExists.mockImplementation(async (candidate: string) => {
      try {
        await fs.access(candidate);
        return true;
      } catch {
        return false;
      }
    });
    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv) => {
      if (Array.isArray(argv) && argv[0] === "npm" && argv[1] === "root" && argv[2] === "-g") {
        return {
          stdout: `${nodeModules}\n`,
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
        };
      }
      return {
        stdout: "",
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      };
    });

    await updateCommand({ yes: true, restart: false });

    expectPackageInstallSpec("openclaw@latest");
    const doctorCall = doctorCommandCall();
    expect(doctorCall?.[0][0]).toContain("node");
    expect(doctorCall?.[0].slice(1)).toEqual([entryPath, "doctor", "--non-interactive", "--fix"]);
    const postCoreSpawn = spawnCall();
    expect(postCoreSpawn?.[0]).toContain("node");
    expect(postCoreSpawn?.[1]).toEqual([entryPath, "update", "--no-restart", "--yes"]);
    expect(postCoreSpawn?.[2].stdio).toBe("inherit");
    expect(postCoreSpawn?.[2].env?.OPENCLAW_UPDATE_POST_CORE).toBe("1");
    expect(postCoreSpawn?.[2].env?.OPENCLAW_UPDATE_POST_CORE_CHANNEL).toBe("stable");
    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(defaultRuntime.log)
        .mock.calls.map((call) => String(call[0]))
        .join("\n"),
    ).not.toContain("already-current");
  });

  it("retries package updates without optional deps when npm global update fails", async () => {
    const tempDir = await createTrackedTempDir("openclaw-update-optional-");
    const nodeModules = path.join(tempDir, "node_modules");
    const pkgRoot = path.join(nodeModules, "openclaw");
    mockPackageInstallStatus(pkgRoot);
    await fs.mkdir(pkgRoot, { recursive: true });
    await fs.writeFile(
      path.join(pkgRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "1.0.0" }),
      "utf-8",
    );

    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv) => {
      if (Array.isArray(argv) && argv[0] === "npm" && argv[1] === "root" && argv[2] === "-g") {
        return {
          stdout: `${nodeModules}\n`,
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
        };
      }
      if (
        Array.isArray(argv) &&
        argv[0] === "npm" &&
        argv.includes("-g") &&
        !argv.includes("--omit=optional")
      ) {
        return {
          stdout: "",
          stderr: "node-gyp failed",
          code: 1,
          signal: null,
          killed: false,
          termination: "exit",
        };
      }
      return {
        stdout: "",
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      };
    });

    await updateCommand({ yes: true, restart: false });

    const installArgvs = commandCalls()
      .map(([argv]) => argv)
      .filter((argv) => argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g");
    expect(installArgvs).toEqual([
      ["npm", "i", "-g", "openclaw@latest", "--no-fund", "--no-audit", "--loglevel=error"],
      [
        "npm",
        "i",
        "-g",
        "openclaw@latest",
        "--omit=optional",
        "--no-fund",
        "--no-audit",
        "--loglevel=error",
      ],
    ]);
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
  });

  it("uses the owning npm binary for package updates when PATH npm points elsewhere", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const brewPrefix = createCaseDir("brew-prefix");
    const brewRoot = path.join(brewPrefix, "lib", "node_modules");
    const pkgRoot = path.join(brewRoot, "openclaw");
    const brewNpm = path.join(brewPrefix, "bin", "npm");
    const win32PrefixNpm = path.join(brewPrefix, "npm.cmd");
    const pathNpmRoot = createCaseDir("nvm-root");
    mockPackageInstallStatus(pkgRoot);
    pathExists.mockResolvedValue(false);

    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv) => {
      if (!Array.isArray(argv)) {
        return {
          stdout: "",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
        };
      }
      if (argv[0] === "npm" && argv[1] === "root" && argv[2] === "-g") {
        return {
          stdout: `${pathNpmRoot}\n`,
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
        };
      }
      if (isOwningNpmCommand(argv[0], brewPrefix) && argv[1] === "root" && argv[2] === "-g") {
        return {
          stdout: `${brewRoot}\n`,
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
        };
      }
      return {
        stdout: "",
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      };
    });

    await fs.mkdir(path.dirname(brewNpm), { recursive: true });
    await fs.writeFile(brewNpm, "", "utf8");
    await fs.writeFile(win32PrefixNpm, "", "utf8");
    await updateCommand({ yes: true });

    platformSpy.mockRestore();

    expect(runGatewayUpdate).not.toHaveBeenCalled();
    const installCall = vi
      .mocked(runCommandWithTimeout)
      .mock.calls.find(
        ([argv]) =>
          Array.isArray(argv) &&
          isOwningNpmCommand(argv[0], brewPrefix) &&
          argv[1] === "i" &&
          argv[2] === "-g" &&
          argv.includes("openclaw@latest"),
      );

    const requiredInstallCall = requireValue(installCall, "brew npm install call");
    const installCommand = requiredInstallCall[0][0] ?? "";
    expect(installCommand).not.toBe("npm");
    expect(path.isAbsolute(installCommand)).toBe(true);
    expect(path.normalize(installCommand)).toContain(path.normalize(brewPrefix));
    expect(path.normalize(installCommand)).toMatch(
      new RegExp(
        `${path
          .normalize(path.join(brewPrefix, path.sep))
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*npm(?:\\.cmd)?$`,
        "i",
      ),
    );
    const installOptions = requiredInstallCall[1] as { timeoutMs?: number };
    expect(typeof installOptions.timeoutMs).toBe("number");
  });

  it("prepends portable Git PATH for package updates on Windows", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const tempDir = createCaseDir("openclaw-update");
    const localAppData = createCaseDir("openclaw-localappdata");
    const portableGitMingw = path.join(
      localAppData,
      "OpenClaw",
      "deps",
      "portable-git",
      "mingw64",
      "bin",
    );
    const portableGitUsr = path.join(
      localAppData,
      "OpenClaw",
      "deps",
      "portable-git",
      "usr",
      "bin",
    );
    await fs.mkdir(portableGitMingw, { recursive: true });
    await fs.mkdir(portableGitUsr, { recursive: true });
    mockPackageInstallStatus(tempDir);
    pathExists.mockImplementation(
      async (candidate: string) => candidate === portableGitMingw || candidate === portableGitUsr,
    );

    await withEnvAsync({ LOCALAPPDATA: localAppData }, async () => {
      await updateCommand({ yes: true });
    });

    platformSpy.mockRestore();

    const updateCall = vi
      .mocked(runCommandWithTimeout)
      .mock.calls.find(
        (call) =>
          Array.isArray(call[0]) &&
          call[0][0] === "npm" &&
          call[0][1] === "i" &&
          call[0][2] === "-g",
      );
    const updateOptions =
      typeof updateCall?.[1] === "object" && updateCall[1] !== null ? updateCall[1] : undefined;
    const mergedPath = updateOptions?.env?.Path ?? updateOptions?.env?.PATH ?? "";
    expect(mergedPath.split(path.delimiter).slice(0, 2)).toEqual([
      portableGitMingw,
      portableGitUsr,
    ]);
    expect(updateOptions?.env?.NPM_CONFIG_SCRIPT_SHELL).toBeUndefined();
    expect(updateOptions?.env?.NODE_LLAMA_CPP_SKIP_DOWNLOAD).toBe("1");
  });

  it.each([
    {
      name: "outputs JSON when --json is set",
      run: async () => {
        vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());
        vi.mocked(defaultRuntime.writeJson).mockClear();
        await updateCommand({ json: true });
      },
      assert: () => {
        requireValue(lastWriteJsonCall(), "update JSON output");
      },
    },
    {
      name: "exits with error on failure",
      run: async () => {
        vi.mocked(runGatewayUpdate).mockResolvedValue({
          status: "error",
          mode: "git",
          reason: "rebase-failed",
          steps: [],
          durationMs: 100,
        } satisfies UpdateRunResult);
        vi.mocked(defaultRuntime.exit).mockClear();
        await updateCommand({});
      },
      assert: () => {
        expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
      },
    },
  ] as const)("updateCommand reports outcomes: $name", runUpdateCliScenario);

  it("persists the requested channel only after a successful package update", async () => {
    const tempDir = createCaseDir("openclaw-update");
    mockPackageInstallStatus(tempDir);

    await updateCommand({ channel: "beta", yes: true });

    const installCallIndex = vi
      .mocked(runCommandWithTimeout)
      .mock.calls.findIndex(
        (call) =>
          Array.isArray(call[0]) &&
          call[0][0] === "npm" &&
          call[0][1] === "i" &&
          call[0][2] === "-g",
      );
    expect(installCallIndex).toBeGreaterThanOrEqual(0);
    expect(replaceConfigFile).toHaveBeenCalledTimes(1);
    expect(replaceConfigFile).toHaveBeenCalledWith({
      nextConfig: {
        update: {
          channel: "beta",
        },
      },
      baseHash: undefined,
    });
    expect(
      vi.mocked(runCommandWithTimeout).mock.invocationCallOrder[installCallIndex] ?? 0,
    ).toBeLessThan(
      vi.mocked(replaceConfigFile).mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("repairs legacy config before persisting a requested update channel", async () => {
    const tempDir = createCaseDir("openclaw-update");
    mockPackageInstallStatus(tempDir);
    const legacyConfig = {
      channels: {
        slack: {
          streaming: "partial",
          nativeStreaming: false,
        },
        telegram: {
          streaming: "block",
        },
      },
    } as OpenClawConfig;
    const migratedConfig = {
      channels: {
        slack: {
          streaming: {
            mode: "partial",
            nativeTransport: false,
          },
        },
        telegram: {
          streaming: {
            mode: "block",
          },
        },
      },
    } as OpenClawConfig;
    vi.mocked(readConfigFileSnapshot)
      .mockResolvedValueOnce({
        ...baseSnapshot,
        parsed: legacyConfig,
        resolved: legacyConfig,
        sourceConfig: legacyConfig,
        config: legacyConfig,
        runtimeConfig: legacyConfig,
        valid: false,
        hash: "legacy-hash",
        issues: [
          {
            path: "channels.slack.streaming",
            message: "Invalid input: expected object, received string",
          },
        ],
        legacyIssues: [
          {
            path: "channels.slack",
            message: "legacy slack streaming keys",
          },
          {
            path: "channels.telegram",
            message: "legacy telegram streaming keys",
          },
        ],
      })
      .mockResolvedValueOnce({
        ...baseSnapshot,
        parsed: migratedConfig,
        resolved: migratedConfig,
        sourceConfig: migratedConfig,
        config: migratedConfig,
        runtimeConfig: migratedConfig,
        valid: true,
        hash: "migrated-hash",
      });
    legacyConfigRepairMocks.repairLegacyConfigForUpdateChannel.mockImplementationOnce(
      async (params: { configSnapshot: ConfigFileSnapshot; jsonMode: boolean }) => {
        await replaceConfigFile({
          nextConfig: migratedConfig,
          baseHash: params.configSnapshot.hash,
          writeOptions: {
            allowConfigSizeDrop: true,
            skipOutputLogs: params.jsonMode,
          },
        });
        return {
          snapshot: await readConfigFileSnapshot(),
          repaired: true,
        };
      },
    );

    await updateCommand({ channel: "beta", yes: true });

    const repairCall =
      legacyConfigRepairMocks.repairLegacyConfigForUpdateChannel.mock.calls[0]?.[0];
    expect(repairCall?.configSnapshot.hash).toBe("legacy-hash");
    expect(repairCall?.configSnapshot.valid).toBe(false);
    expect(repairCall?.jsonMode).toBe(false);
    expect(replaceConfigFile).toHaveBeenCalledTimes(2);
    const replaceCalls = vi.mocked(replaceConfigFile).mock.calls.map((call) => call[0]);
    expect(replaceCalls[0]).toEqual({
      nextConfig: migratedConfig,
      baseHash: "legacy-hash",
      writeOptions: {
        allowConfigSizeDrop: true,
        skipOutputLogs: false,
      },
    });
    expect(replaceCalls[1]).toEqual({
      nextConfig: {
        ...migratedConfig,
        update: {
          channel: "beta",
        },
      },
      baseHash: "migrated-hash",
    });
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
  });

  it("does not auto-repair legacy config when authored includes are present", async () => {
    const tempDir = createCaseDir("openclaw-update");
    mockPackageInstallStatus(tempDir);
    const legacyConfigWithInclude = {
      $include: "./channels.json5",
      channels: {
        slack: {
          streaming: "partial",
          nativeStreaming: false,
        },
      },
    } as unknown as OpenClawConfig;
    vi.mocked(readConfigFileSnapshot).mockResolvedValueOnce({
      ...baseSnapshot,
      parsed: legacyConfigWithInclude,
      resolved: legacyConfigWithInclude,
      sourceConfig: legacyConfigWithInclude,
      config: legacyConfigWithInclude,
      runtimeConfig: legacyConfigWithInclude,
      valid: false,
      hash: "legacy-include-hash",
      issues: [
        {
          path: "channels.slack.streaming",
          message: "Invalid input: expected object, received string",
        },
      ],
      legacyIssues: [
        {
          path: "channels.slack",
          message: "legacy slack streaming keys",
        },
      ],
    });

    await updateCommand({ channel: "beta", yes: true });

    expect(replaceConfigFile).not.toHaveBeenCalled();
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("does not repair legacy config during a dry run", async () => {
    const tempDir = createCaseDir("openclaw-update");
    mockPackageInstallStatus(tempDir);
    const legacyConfig = {
      channels: {
        slack: {
          streaming: "partial",
          nativeStreaming: false,
        },
      },
    } as OpenClawConfig;
    vi.mocked(readConfigFileSnapshot).mockResolvedValueOnce({
      ...baseSnapshot,
      parsed: legacyConfig,
      resolved: legacyConfig,
      sourceConfig: legacyConfig,
      config: legacyConfig,
      runtimeConfig: legacyConfig,
      valid: false,
      hash: "legacy-hash",
      issues: [
        {
          path: "channels.slack.streaming",
          message: "Invalid input: expected object, received string",
        },
      ],
      legacyIssues: [
        {
          path: "channels.slack",
          message: "legacy slack streaming keys",
        },
      ],
    });

    await updateCommand({ dryRun: true, channel: "beta", yes: true });

    expect(replaceConfigFile).not.toHaveBeenCalled();
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("does not persist the requested channel when the package update fails", async () => {
    const tempDir = createCaseDir("openclaw-update");
    mockPackageInstallStatus(tempDir);
    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv) => {
      if (Array.isArray(argv) && argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g") {
        return {
          stdout: "",
          stderr: "install failed",
          code: 1,
          signal: null,
          killed: false,
          termination: "exit",
        };
      }
      return {
        stdout: "",
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      };
    });

    await updateCommand({ channel: "beta", yes: true });

    expect(replaceConfigFile).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("keeps the requested channel when plugin sync writes config after update", async () => {
    const tempDir = createCaseDir("openclaw-update");
    mockPackageInstallStatus(tempDir);
    syncPluginsForUpdateChannel.mockImplementation(async ({ config }) => ({
      changed: true,
      config,
      summary: {
        switchedToBundled: [],
        switchedToNpm: [],
        warnings: [],
        errors: [],
      },
    }));
    updateNpmInstalledPlugins.mockImplementation(async ({ config }) => ({
      changed: false,
      config,
      outcomes: [],
    }));

    await updateCommand({ channel: "beta", yes: true });

    const lastWrite = lastReplaceConfigCall() as
      | { nextConfig?: { update?: { channel?: string } } }
      | undefined;
    expect(lastWrite?.nextConfig?.update?.channel).toBe("beta");
  });

  it("uses source config and plugin index records for post-update plugin sync", async () => {
    const tempDir = createCaseDir("openclaw-update");
    mockPackageInstallStatus(tempDir);
    const pluginInstallRecords = {
      "lossless-claw": {
        source: "npm",
        spec: "@martian-engineering/lossless-claw",
        installPath: "/tmp/lossless-claw",
      },
    } as const;
    const sourceConfig = {
      plugins: {},
    } as OpenClawConfig;
    loadInstalledPluginIndexInstallRecords.mockResolvedValueOnce(pluginInstallRecords);
    vi.mocked(readConfigFileSnapshot).mockResolvedValue({
      ...baseSnapshot,
      sourceConfig,
      config: {
        ...sourceConfig,
        gateway: { auth: { mode: "token", token: "runtime" } },
        plugins: {
          ...sourceConfig.plugins,
          entries: {
            firecrawl: {
              config: {
                webFetch: { provider: "firecrawl" },
              },
            },
          },
        },
      } as OpenClawConfig,
    });
    syncPluginsForUpdateChannel.mockResolvedValue({
      changed: false,
      config: sourceConfig,
      summary: {
        switchedToBundled: [],
        switchedToNpm: [],
        warnings: [],
        errors: [],
      },
    });
    updateNpmInstalledPlugins.mockResolvedValue({
      changed: false,
      config: sourceConfig,
      outcomes: [],
    });

    await updateCommand({ channel: "beta", yes: true });

    const syncConfig = syncPluginCall()?.config;
    const updateCall = npmPluginUpdateCall() as
      | { skipDisabledPlugins?: boolean; syncOfficialPluginInstalls?: boolean }
      | undefined;
    expect(syncConfig?.plugins?.installs).toEqual(pluginInstallRecords);
    expect(syncConfig?.update?.channel).toBe("beta");
    expect(syncConfig?.gateway?.auth).toBeUndefined();
    expect(syncConfig?.plugins?.entries).toBeUndefined();
    expect(updateCall?.skipDisabledPlugins).toBe(true);
    expect(updateCall?.syncOfficialPluginInstalls).toBe(true);
  });

  it("forwards ClawHub risk acknowledgement to post-update plugin work", async () => {
    const tempDir = createCaseDir("openclaw-update");
    mockPackageInstallStatus(tempDir);

    await updateCommand({
      channel: "beta",
      yes: true,
      restart: false,
      acknowledgeClawHubRisk: true,
    });

    expect(syncPluginCall()?.acknowledgeClawHubRisk).toBe(true);
    expect(npmPluginUpdateCall()?.acknowledgeClawHubRisk).toBe(true);
    expect(lastNpmPluginUpdateCall()?.acknowledgeClawHubRisk).toBe(true);
  });

  it("persists channel and runs post-update work after switching from package to git", async () => {
    const tempDir = createCaseDir("openclaw-update");
    const gitRoot = path.join(tempDir, "..", "openclaw");
    const completionCacheSpy = vi
      .spyOn(updateCliShared, "tryWriteCompletionCache")
      .mockResolvedValue(undefined);
    mockPackageInstallStatus(tempDir);
    vi.mocked(readConfigFileSnapshot).mockResolvedValue({
      ...baseSnapshot,
      parsed: { update: { channel: "stable" } },
      resolved: { update: { channel: "stable" } } as OpenClawConfig,
      sourceConfig: { update: { channel: "stable" } } as OpenClawConfig,
      runtimeConfig: { update: { channel: "stable" } } as OpenClawConfig,
      config: { update: { channel: "stable" } } as OpenClawConfig,
    });
    vi.mocked(runGatewayUpdate).mockResolvedValue(
      makeOkUpdateResult({
        mode: "git",
        root: gitRoot,
        after: { version: "2026.4.10" },
      }),
    );
    syncPluginsForUpdateChannel.mockImplementation(async ({ config }) => ({
      changed: false,
      config,
      summary: {
        switchedToBundled: [],
        switchedToNpm: [],
        warnings: [],
        errors: [],
      },
    }));
    updateNpmInstalledPlugins.mockImplementation(async ({ config }) => ({
      changed: false,
      config,
      outcomes: [],
    }));

    await updateCommand({ channel: "dev", yes: true, restart: false });

    const persistedConfig = replaceConfigCall()?.nextConfig;
    expect(persistedConfig?.update?.channel).toBe("dev");
    const syncCall = syncPluginCall() as
      | { channel?: string; config?: OpenClawConfig; workspaceDir?: string }
      | undefined;
    expect(syncCall?.channel).toBe("dev");
    expect(syncCall?.config?.update?.channel).toBe("dev");
    expect(syncCall?.workspaceDir).toBe(gitRoot);
    expect(npmPluginUpdateCall()?.config?.update?.channel).toBe("dev");
    expect(completionCacheSpy).toHaveBeenCalledWith(gitRoot, false);
    expect(runRestartScript).not.toHaveBeenCalled();
    expect(runDaemonRestart).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
  });
  it("explains why git updates cannot run with edited files", async () => {
    vi.mocked(defaultRuntime.log).mockClear();
    vi.mocked(defaultRuntime.error).mockClear();
    vi.mocked(defaultRuntime.exit).mockClear();
    vi.mocked(runGatewayUpdate).mockResolvedValue({
      status: "skipped",
      mode: "git",
      reason: "dirty",
      steps: [],
      durationMs: 100,
    } satisfies UpdateRunResult);

    await updateCommand({ channel: "dev" });

    const errors = vi.mocked(defaultRuntime.error).mock.calls.map((call) => String(call[0]));
    const logs = vi.mocked(defaultRuntime.log).mock.calls.map((call) => String(call[0]));
    expect(errors.join("\n")).toContain("Update blocked: local files are edited in this checkout.");
    expect(logs.join("\n")).toContain(
      "Git-based updates need a clean working tree before they can switch commits, fetch, or rebase.",
    );
    expect(logs.join("\n")).toContain(
      "Commit, stash, or discard the local changes, then rerun `openclaw update`.",
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(0);
  });
  it.each([
    {
      name: "refreshes service env when already installed",
      run: async () => {
        vi.mocked(runGatewayUpdate).mockResolvedValue({
          status: "ok",
          mode: "git",
          steps: [],
          durationMs: 100,
        } satisfies UpdateRunResult);
        vi.mocked(runDaemonInstall).mockResolvedValue(undefined);
        serviceLoaded.mockResolvedValue(true);

        await updateCommand({});
      },
      assert: () => {
        expect(runDaemonInstall).toHaveBeenCalledWith({
          force: true,
          json: undefined,
        });
        expect(runRestartScript).toHaveBeenCalledTimes(1);
        expect(runDaemonRestart).not.toHaveBeenCalled();
      },
    },
    {
      name: "falls back to daemon restart when service env refresh cannot complete",
      run: async () => {
        vi.mocked(runDaemonRestart).mockResolvedValue(true);
        await runRestartFallbackScenario({ daemonInstall: "fail" });
      },
      assert: () => {
        expect(runDaemonInstall).toHaveBeenCalledWith({
          force: true,
          json: undefined,
        });
        expect(runDaemonRestart).toHaveBeenCalledTimes(1);
      },
    },
    {
      name: "keeps going when daemon install succeeds but restart fallback still handles relaunch",
      run: async () => {
        vi.mocked(runDaemonRestart).mockResolvedValue(true);
        await runRestartFallbackScenario({ daemonInstall: "ok" });
      },
      assert: () => {
        expect(runDaemonInstall).toHaveBeenCalledWith({
          force: true,
          json: undefined,
        });
        expect(runDaemonRestart).toHaveBeenCalledTimes(1);
      },
    },
    {
      name: "skips service env refresh when --no-restart is set",
      run: async () => {
        vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());
        serviceLoaded.mockResolvedValue(true);

        await updateCommand({ restart: false });
      },
      assert: () => {
        expect(runDaemonInstall).not.toHaveBeenCalled();
        expect(runRestartScript).not.toHaveBeenCalled();
        expect(runDaemonRestart).not.toHaveBeenCalled();
      },
    },
    {
      name: "skips success message when restart does not run",
      run: async () => {
        vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());
        vi.mocked(runDaemonRestart).mockResolvedValue(false);
        vi.mocked(defaultRuntime.log).mockClear();
        await updateCommand({ restart: true });
      },
      assert: () => {
        const logLines = vi.mocked(defaultRuntime.log).mock.calls.map((call) => String(call[0]));
        expect(logLines.some((line) => line.includes("Daemon restarted successfully."))).toBe(
          false,
        );
      },
    },
  ] as const)("updateCommand service refresh behavior: $name", runUpdateCliScenario);

  it("fails a package update when service env refresh cannot complete", async () => {
    const tempDir = createCaseDir("openclaw-update");
    mockPackageInstallStatus(tempDir);
    serviceLoaded.mockResolvedValue(true);
    vi.mocked(runDaemonInstall).mockRejectedValueOnce(new Error("refresh failed"));

    await updateCommand({ yes: true });

    expect(runDaemonInstall).not.toHaveBeenCalled();
    expect(runRestartScript).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(
      vi
        .mocked(defaultRuntime.log)
        .mock.calls.map((call) => String(call[0]))
        .join("\n"),
    ).toContain("updated install entrypoint not found");
  });

  it("fails a JSON package update when fallback restart leaves the old gateway running", async () => {
    const updatedRoot = createCaseDir("openclaw-updated-root");
    const updatedEntrypoint = path.join(updatedRoot, "dist", "entry.js");
    setupUpdatedRootRefresh({
      entrypoints: [updatedEntrypoint],
      gatewayUpdateImpl: async () =>
        makeOkUpdateResult({
          mode: "npm",
          root: updatedRoot,
          before: { version: "2026.4.23" },
          after: { version: "2026.4.24" },
        }),
    });
    prepareRestartScript.mockResolvedValue(null);
    serviceLoaded.mockResolvedValue(true);
    probeGateway.mockResolvedValue({
      ok: true,
      close: null,
      server: {
        version: "2026.4.23",
        connId: "old-gateway",
      },
      auth: { role: "operator", scopes: ["operator.read"], capability: "read_only" },
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
      connectLatencyMs: 1,
      error: null,
      url: "ws://127.0.0.1:18789",
    });

    await updateCommand({ yes: true, json: true });

    expect(runRestartScript).not.toHaveBeenCalled();
    expect(runDaemonRestart).not.toHaveBeenCalled();
    const restartCall = gatewayCommandCall(updatedEntrypoint, "restart");
    expect(restartCall?.[0][0]).toContain("node");
    expect(restartCall?.[0].slice(1)).toEqual([updatedEntrypoint, "gateway", "restart", "--json"]);
    expect(restartCall?.[1].cwd).toBe(updatedRoot);
    expect(restartCall?.[1].timeoutMs).toBe(60_000);
    const probeCall = probeGatewayCall() as { includeDetails?: boolean } | undefined;
    expect(probeCall?.includeDetails).toBe(true);
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(defaultRuntime.error)
        .mock.calls.map((call) => String(call[0]))
        .join("\n"),
    ).toContain(
      "Gateway version mismatch: expected 2026.4.24, running gateway reported 2026.4.23.",
    );
    expect(doctorCommand).not.toHaveBeenCalled();
  });

  it("skips the post-refresh restart script when LaunchAgent already serves the expected package version", async () => {
    const updatedRoot = createCaseDir("openclaw-updated-root");
    const updatedEntrypoint = path.join(updatedRoot, "dist", "entry.js");
    setupUpdatedRootRefresh({
      entrypoints: [updatedEntrypoint],
      gatewayUpdateImpl: async () =>
        makeOkUpdateResult({
          mode: "npm",
          root: updatedRoot,
          before: { version: "2026.4.23" },
          after: { version: "2026.4.24" },
        }),
    });
    serviceLoaded.mockResolvedValue(true);
    probeGateway.mockResolvedValue({
      ok: true,
      close: null,
      server: {
        version: "2026.4.24",
        connId: "updated-gateway",
      },
      auth: { role: "operator", scopes: ["operator.read"], capability: "read_only" },
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
      connectLatencyMs: 1,
      error: null,
      url: "ws://127.0.0.1:18789",
    });

    await updateCommand({ yes: true });

    const installCall = gatewayCommandCall(updatedEntrypoint, "install");
    expect(installCall?.[0][0]).toContain("node");
    expect(installCall?.[0].slice(1)).toEqual([updatedEntrypoint, "gateway", "install", "--force"]);
    expect(installCall?.[1].cwd).toBe(updatedRoot);
    expect(installCall?.[1].timeoutMs).toBe(60_000);
    expect(gatewayCommandCall(updatedEntrypoint, "restart")).toBeUndefined();
    expect(runRestartScript).not.toHaveBeenCalled();
    const probeCall = probeGatewayCall() as { includeDetails?: boolean } | undefined;
    expect(probeCall?.includeDetails).toBe(true);
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
  });

  it("fails a package update when the restarted gateway reports activated plugin load errors", async () => {
    const updatedRoot = createCaseDir("openclaw-updated-root");
    const updatedEntrypoint = path.join(updatedRoot, "dist", "entry.js");
    setupUpdatedRootRefresh({
      entrypoints: [updatedEntrypoint],
      gatewayUpdateImpl: async () =>
        makeOkUpdateResult({
          mode: "npm",
          root: updatedRoot,
          before: { version: "2026.4.23" },
          after: { version: "2026.4.24" },
        }),
    });
    readPackageVersion.mockResolvedValue("2026.4.24");
    serviceLoaded.mockResolvedValue(true);
    probeGateway.mockResolvedValue({
      ok: true,
      close: null,
      server: {
        version: "2026.4.24",
        connId: "updated-gateway",
      },
      auth: { role: "operator", scopes: ["operator.read"], capability: "read_only" },
      health: {
        ok: true,
        plugins: {
          errors: [
            {
              id: "telegram",
              origin: "bundled",
              activated: true,
              error: "failed to load plugin dependency: ENOSPC",
            },
          ],
        },
      },
      status: null,
      presence: null,
      configSnapshot: null,
      connectLatencyMs: 1,
      error: null,
      url: "ws://127.0.0.1:18789",
    });

    await updateCommand({ yes: true });

    expect(runRestartScript).toHaveBeenCalledTimes(1);
    const probeCall = probeGatewayCall() as { includeDetails?: boolean } | undefined;
    expect(probeCall?.includeDetails).toBe(true);
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(
      vi
        .mocked(defaultRuntime.log)
        .mock.calls.map((call) => String(call[0]))
        .join("\n"),
    ).toContain("- telegram: failed to load plugin dependency: ENOSPC");
  });

  it.each([
    {
      name: "updateCommand refreshes service env from updated install root when available",
      invoke: async () => {
        await updateCommand({});
      },
      assertExtra: () => {
        expect(runDaemonInstall).not.toHaveBeenCalled();
        expect(runRestartScript).toHaveBeenCalledTimes(1);
      },
    },
    {
      name: "updateCommand preserves invocation-relative service env overrides during refresh",
      invoke: async () => {
        await withEnvAsync(
          {
            OPENCLAW_STATE_DIR: "./state",
            OPENCLAW_CONFIG_PATH: "./config/openclaw.json",
          },
          async () => {
            await updateCommand({});
          },
        );
      },
      expectedEnv: () => ({
        OPENCLAW_STATE_DIR: path.resolve("./state"),
        OPENCLAW_CONFIG_PATH: path.resolve("./config/openclaw.json"),
      }),
      assertExtra: () => {
        expect(runDaemonInstall).not.toHaveBeenCalled();
      },
    },
    {
      name: "updateCommand reuses the captured invocation cwd when process.cwd later fails",
      invoke: async () => {
        const originalCwd = process.cwd();
        let restoreCwd: (() => void) | undefined;
        const { root } = setupUpdatedRootRefresh({
          gatewayUpdateImpl: async () => {
            const cwdSpy = vi.spyOn(process, "cwd").mockImplementation(() => {
              throw new Error("ENOENT: current working directory is gone");
            });
            restoreCwd = () => cwdSpy.mockRestore();
            return {
              status: "ok",
              mode: "npm",
              root,
              steps: [],
              durationMs: 100,
            };
          },
        });
        try {
          await withEnvAsync(
            {
              OPENCLAW_STATE_DIR: "./state",
            },
            async () => {
              await updateCommand({});
            },
          );
        } finally {
          restoreCwd?.();
        }
        return { originalCwd };
      },
      customSetup: true,
      expectedEnv: (context?: { originalCwd: string }) => ({
        OPENCLAW_STATE_DIR: path.resolve(context?.originalCwd ?? process.cwd(), "./state"),
      }),
      assertExtra: () => {
        expect(runDaemonInstall).not.toHaveBeenCalled();
      },
    },
  ])("$name", async (testCase) => {
    const setup = testCase.customSetup ? undefined : setupUpdatedRootRefresh();
    const context = (await testCase.invoke()) as { originalCwd: string } | undefined;
    const runCommandWithTimeoutMock = vi.mocked(runCommandWithTimeout) as unknown as {
      mock: { calls: Array<[unknown, { cwd?: string }?]> };
    };
    const root = setup?.root ?? runCommandWithTimeoutMock.mock.calls[0]?.[1]?.cwd;
    const entryPath = setup?.entrypoints?.[0] ?? path.join(String(root), "dist", "entry.js");

    const installCall = gatewayCommandCall(entryPath, "install");
    expect(installCall?.[0][0]).toContain("node");
    expect(installCall?.[0].slice(1)).toEqual([entryPath, "gateway", "install", "--force"]);
    expect(installCall?.[1].cwd).toBe(String(root));
    expect(installCall?.[1].timeoutMs).toBe(60_000);
    const expectedEnv =
      "expectedEnv" in testCase && testCase.expectedEnv ? testCase.expectedEnv(context) : {};
    for (const [key, value] of Object.entries(expectedEnv)) {
      expect((installCall?.[1].env as NodeJS.ProcessEnv | undefined)?.[key]).toBe(value);
    }
    testCase.assertExtra();
  });

  it("updateCommand continues after doctor sub-step and clears update flag", async () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      await withEnvAsync({ OPENCLAW_UPDATE_IN_PROGRESS: undefined }, async () => {
        vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());
        vi.mocked(runDaemonRestart).mockResolvedValue(true);
        vi.mocked(doctorCommand).mockResolvedValue(undefined);
        vi.mocked(defaultRuntime.log).mockClear();

        await updateCommand({});

        const doctorCall = vi.mocked(doctorCommand).mock.calls[0];
        expect(doctorCall?.[0]).toBe(defaultRuntime);
        expect(doctorCall?.[1]?.nonInteractive).toBe(true);
        expect(process.env.OPENCLAW_UPDATE_IN_PROGRESS).toBeUndefined();

        const logLines = vi.mocked(defaultRuntime.log).mock.calls.map((call) => String(call[0]));
        expect(
          logLines.some((line) =>
            line.includes("Leveled up! New skills unlocked. You're welcome."),
          ),
        ).toBe(true);
      });
    } finally {
      randomSpy.mockRestore();
    }
  });

  it.each([
    {
      name: "update command invalid timeout",
      run: async () => await updateCommand({ timeout: "invalid" }),
      requireTty: false,
      expectedError: "--timeout must be a positive integer (seconds)",
    },
    {
      name: "update status command invalid timeout",
      run: async () => await updateStatusCommand({ timeout: "invalid" }),
      requireTty: false,
      expectedError: "--timeout must be a positive integer (seconds)",
    },
    {
      name: "update wizard invalid timeout",
      run: async () => await updateWizardCommand({ timeout: "invalid" }),
      requireTty: true,
      expectedError: "--timeout must be a positive integer (seconds)",
    },
    {
      name: "update wizard requires a TTY",
      run: async () => await updateWizardCommand({}),
      requireTty: false,
      expectedError:
        "Update wizard requires a TTY. Use `openclaw update --channel <stable|beta|dev>` instead.",
    },
  ] as const)(
    "validates update command invocation errors: $name",
    async ({ run, requireTty, expectedError, name }) => {
      setTty(requireTty);
      vi.mocked(defaultRuntime.error).mockClear();
      vi.mocked(defaultRuntime.exit).mockClear();

      await run();

      expect(defaultRuntime.error, name).toHaveBeenCalledWith(expectedError);
      expect(defaultRuntime.exit, name).toHaveBeenCalledWith(1);
    },
  );

  it.each([
    {
      name: "requires confirmation without --yes",
      options: {},
      shouldExit: true,
      shouldRunPackageUpdate: false,
    },
    {
      name: "allows downgrade with --yes",
      options: { yes: true },
      shouldExit: false,
      shouldRunPackageUpdate: true,
    },
  ])("$name in non-interactive mode", async ({ options, shouldExit, shouldRunPackageUpdate }) => {
    await setupNonInteractiveDowngrade();
    await updateCommand(options);

    const downgradeMessageSeen = vi
      .mocked(defaultRuntime.error)
      .mock.calls.some((call) => String(call[0]).includes("Downgrade confirmation required."));
    expect(downgradeMessageSeen).toBe(shouldExit);
    if (shouldExit) {
      expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    } else {
      expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
    }
    expect(runGatewayUpdate).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(runCommandWithTimeout)
        .mock.calls.some((call) => Array.isArray(call[0]) && call[0][0] === "npm"),
    ).toBe(shouldRunPackageUpdate);
  });

  it("updateWizardCommand offers dev checkout and forwards selections", async () => {
    const tempDir = createCaseDir("openclaw-update-wizard");
    await withEnvAsync({ OPENCLAW_GIT_DIR: tempDir }, async () => {
      setTty(true);

      vi.mocked(checkUpdateStatus).mockResolvedValue({
        root: "/test/path",
        installKind: "package",
        packageManager: "npm",
        deps: {
          manager: "npm",
          status: "ok",
          lockfilePath: null,
          markerPath: null,
        },
      });
      select.mockResolvedValue("dev");
      confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      vi.mocked(runGatewayUpdate).mockResolvedValue({
        status: "ok",
        mode: "git",
        steps: [],
        durationMs: 100,
      });

      await updateWizardCommand({});

      const call = vi.mocked(runGatewayUpdate).mock.calls[0]?.[0];
      expect(call?.channel).toBe("dev");
    });
  });

  it("uses ~/openclaw as the default dev checkout directory", async () => {
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue("/tmp/oc-home");
    await withEnvAsync({ OPENCLAW_GIT_DIR: undefined }, async () => {
      expect(resolveGitInstallDir()).toBe(path.posix.join("/tmp/oc-home", "openclaw"));
    });
    homedirSpy.mockRestore();
  });
});
