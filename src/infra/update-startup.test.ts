// Covers startup update check and auto-update behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatCliCommand } from "../cli/command-format.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import type { GatewayActiveWorkInspectors } from "./gateway-active-work.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { writeUpdateInstallReceiptRowSync } from "./restart-sentinel-store.js";
import type { UpdateCheckResult } from "./update-check.js";
import { parseDevUpdateTargetEnv } from "./update-dev-target.js";

const {
  detectRespawnSupervisorMock,
  getRuntimeConfigMock,
  refreshRemoteModelCatalogMock,
  scheduleGatewaySigusr1RestartMock,
  startManagedServiceUpdateHandoffMock,
  versionMock,
} = vi.hoisted(() => ({
  detectRespawnSupervisorMock: vi.fn(),
  getRuntimeConfigMock: vi.fn(() => ({})),
  refreshRemoteModelCatalogMock: vi.fn<
    typeof import("../model-catalog/remote-refresh.js").refreshRemoteModelCatalog
  >(async () => ({
    status: "unchanged" as const,
    providers: 1,
    models: 1,
    generatedAt: 1_753_500_000_000,
  })),
  scheduleGatewaySigusr1RestartMock: vi.fn(() => ({ scheduled: true })),
  startManagedServiceUpdateHandoffMock: vi.fn<
    typeof import("./update-managed-service-handoff.js").startManagedServiceUpdateHandoff
  >(async () => ({
    status: "started" as const,
    pid: 12345,
    command: "openclaw update --yes --channel beta --timeout 2700",
    logPath: "/tmp/openclaw-handoff.log",
  })),
  versionMock: { value: "1.0.0" },
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: getRuntimeConfigMock,
}));

vi.mock("../model-catalog/remote-refresh.js", async () => {
  const actual = await vi.importActual<typeof import("../model-catalog/remote-refresh.js")>(
    "../model-catalog/remote-refresh.js",
  );
  return { ...actual, refreshRemoteModelCatalog: refreshRemoteModelCatalogMock };
});

vi.mock("./openclaw-root.js", async () => {
  const actual = await vi.importActual<typeof import("./openclaw-root.js")>("./openclaw-root.js");
  return {
    ...actual,
    resolveOpenClawPackageRoot: vi.fn(),
  };
});

vi.mock("./restart.js", () => ({
  resolveGatewayRestartDeferralTimeoutMs: (timeoutMs: unknown) => {
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
      return 300_000;
    }
    return timeoutMs <= 0 ? undefined : Math.floor(timeoutMs);
  },
  scheduleGatewaySigusr1Restart: scheduleGatewaySigusr1RestartMock,
}));

vi.mock("./supervisor-markers.js", async () => {
  const actual =
    await vi.importActual<typeof import("./supervisor-markers.js")>("./supervisor-markers.js");
  return {
    ...actual,
    detectRespawnSupervisor: detectRespawnSupervisorMock,
  };
});

vi.mock("./update-check.js", async () => {
  const parse = (value: string) => value.split(".").map((part) => Number.parseInt(part, 10));
  const compareSemverStrings = (a: string, b: string) => {
    const left = parse(a);
    const right = parse(b);
    for (let idx = 0; idx < 3; idx += 1) {
      const l = left[idx] ?? 0;
      const r = right[idx] ?? 0;
      if (l !== r) {
        return l < r ? -1 : 1;
      }
    }
    return 0;
  };

  return {
    checkUpdateStatus: vi.fn(),
    compareSemverStrings,
    resolveNpmChannelTag: vi.fn(),
  };
});

vi.mock("../version.js", () => ({
  get VERSION() {
    return versionMock.value;
  },
}));

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: vi.fn(),
}));

vi.mock("./update-managed-service-handoff.js", () => ({
  startManagedServiceUpdateHandoff: startManagedServiceUpdateHandoffMock,
}));

const UPDATE_CHECK_STATE_KEY = "default";

type UpdateCheckStateDatabase = Pick<OpenClawStateKyselyDatabase, "update_check_state">;
type PersistedUpdateCheckState = {
  lastCheckedAt?: string;
  lastNotifiedVersion?: string;
  lastNotifiedTag?: string;
  lastAvailableVersion?: string;
  lastAvailableTag?: string;
  autoInstallId?: string;
  autoFirstSeenVersion?: string;
  autoFirstSeenTag?: string;
  autoFirstSeenAt?: string;
  autoLastAttemptVersion?: string;
  autoLastAttemptAt?: string;
  autoLastSuccessVersion?: string;
  autoLastSuccessAt?: string;
};

function presentString(value: string | null): string | undefined {
  return value ?? undefined;
}

describe("update-startup", () => {
  let tempDir: string;
  let testState: OpenClawTestState;

  let resolveOpenClawPackageRoot: (typeof import("./openclaw-root.js"))["resolveOpenClawPackageRoot"];
  let checkUpdateStatus: (typeof import("./update-check.js"))["checkUpdateStatus"];
  let resolveNpmChannelTag: (typeof import("./update-check.js"))["resolveNpmChannelTag"];
  let runCommandWithTimeout: (typeof import("../process/exec.js"))["runCommandWithTimeout"];
  let runGatewayUpdateCheck: (typeof import("./update-startup.js"))["runGatewayUpdateCheck"];
  let scheduleGatewayUpdateCheck: (typeof import("./update-startup.js"))["scheduleGatewayUpdateCheck"];
  let getUpdateAvailable: (typeof import("./update-startup.js"))["getUpdateAvailable"];
  let getUpdateSchedule: (typeof import("./update-startup.js"))["getUpdateSchedule"];
  let resetUpdateAvailableStateForTest: (typeof import("./update-startup.js"))["resetUpdateAvailableStateForTest"];
  let loaded = false;

  function requireFirstRunCommandCall(): Parameters<typeof runCommandWithTimeout> {
    const [call] = vi.mocked(runCommandWithTimeout).mock.calls;
    if (!call) {
      throw new Error("expected update command run");
    }
    return call;
  }

  function readPersistedUpdateCheckState(): PersistedUpdateCheckState | null {
    const { db } = openOpenClawStateDatabase();
    const stateDb = getNodeSqliteKysely<UpdateCheckStateDatabase>(db);
    const row = executeSqliteQueryTakeFirstSync(
      db,
      stateDb
        .selectFrom("update_check_state")
        .selectAll()
        .where("state_key", "=", UPDATE_CHECK_STATE_KEY),
    );
    if (!row) {
      return null;
    }
    return {
      lastCheckedAt: presentString(row.last_checked_at),
      lastNotifiedVersion: presentString(row.last_notified_version),
      lastNotifiedTag: presentString(row.last_notified_tag),
      lastAvailableVersion: presentString(row.last_available_version),
      lastAvailableTag: presentString(row.last_available_tag),
      autoInstallId: presentString(row.auto_install_id),
      autoFirstSeenVersion: presentString(row.auto_first_seen_version),
      autoFirstSeenTag: presentString(row.auto_first_seen_tag),
      autoFirstSeenAt: presentString(row.auto_first_seen_at),
      autoLastAttemptVersion: presentString(row.auto_last_attempt_version),
      autoLastAttemptAt: presentString(row.auto_last_attempt_at),
      autoLastSuccessVersion: presentString(row.auto_last_success_version),
      autoLastSuccessAt: presentString(row.auto_last_success_at),
    };
  }

  function writePersistedUpdateCheckState(state: PersistedUpdateCheckState): void {
    runOpenClawStateWriteTransaction(({ db }) => {
      const stateDb = getNodeSqliteKysely<UpdateCheckStateDatabase>(db);
      executeSqliteQuerySync(
        db,
        stateDb.deleteFrom("update_check_state").where("state_key", "=", UPDATE_CHECK_STATE_KEY),
      );
      executeSqliteQuerySync(
        db,
        stateDb.insertInto("update_check_state").values({
          state_key: UPDATE_CHECK_STATE_KEY,
          last_checked_at: state.lastCheckedAt ?? null,
          last_notified_version: state.lastNotifiedVersion ?? null,
          last_notified_tag: state.lastNotifiedTag ?? null,
          last_available_version: state.lastAvailableVersion ?? null,
          last_available_tag: state.lastAvailableTag ?? null,
          auto_install_id: state.autoInstallId ?? null,
          auto_first_seen_version: state.autoFirstSeenVersion ?? null,
          auto_first_seen_tag: state.autoFirstSeenTag ?? null,
          auto_first_seen_at: state.autoFirstSeenAt ?? null,
          auto_last_attempt_version: state.autoLastAttemptVersion ?? null,
          auto_last_attempt_at: state.autoLastAttemptAt ?? null,
          auto_last_success_version: state.autoLastSuccessVersion ?? null,
          auto_last_success_at: state.autoLastSuccessAt ?? null,
          updated_at_ms: Date.now(),
        }),
      );
    });
  }

  beforeEach(async () => {
    versionMock.value = "1.0.0";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-17T10:00:00Z"));
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-update-check-suite-",
      env: {
        OPENCLAW_NO_AUTO_UPDATE: undefined,
        OPENCLAW_SUPERVISOR_MODE: undefined,
        OPENCLAW_SERVICE_KIND: undefined,
        OPENCLAW_SERVICE_MARKER: undefined,
        OPENCLAW_GATEWAY_SERVICE_PID: undefined,
        OPENCLAW_LAUNCHD_LABEL: undefined,
        OPENCLAW_SYSTEMD_UNIT: undefined,
        OPENCLAW_WINDOWS_TASK_NAME: undefined,
        INVOCATION_ID: undefined,
        NODE_ENV: "test",
        VITEST: undefined,
      },
    });
    tempDir = testState.stateDir;

    // Perf: load mocked modules once (after timers/env are set up).
    if (!loaded) {
      ({ resolveOpenClawPackageRoot } = await import("./openclaw-root.js"));
      ({ checkUpdateStatus, resolveNpmChannelTag } = await import("./update-check.js"));
      ({ runCommandWithTimeout } = await import("../process/exec.js"));
      ({
        runGatewayUpdateCheck,
        scheduleGatewayUpdateCheck,
        getUpdateAvailable,
        getUpdateSchedule,
        resetUpdateAvailableStateForTest,
      } = await import("./update-startup.js"));
      loaded = true;
    }
    vi.mocked(resolveOpenClawPackageRoot).mockClear();
    vi.mocked(checkUpdateStatus).mockClear();
    vi.mocked(resolveNpmChannelTag).mockClear();
    vi.mocked(runCommandWithTimeout).mockReset();
    vi.mocked(runCommandWithTimeout).mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    });
    getRuntimeConfigMock.mockReset();
    getRuntimeConfigMock.mockReturnValue({});
    refreshRemoteModelCatalogMock.mockClear();
    detectRespawnSupervisorMock.mockReset();
    detectRespawnSupervisorMock.mockReturnValue(null);
    scheduleGatewaySigusr1RestartMock.mockClear();
    startManagedServiceUpdateHandoffMock.mockClear();
    startManagedServiceUpdateHandoffMock.mockResolvedValue({
      status: "started",
      pid: 12345,
      command: "openclaw update --yes --channel beta --timeout 2700",
      logPath: "/tmp/openclaw-handoff.log",
    });
    resetUpdateAvailableStateForTest();
  });

  afterEach(async () => {
    vi.useRealTimers();
    closeOpenClawStateDatabaseForTest();
    await testState.cleanup();
    resetUpdateAvailableStateForTest();
  });

  function mockPackageUpdateStatus(tag = "latest", version = "2.0.0") {
    mockPackageInstallStatus();
    mockNpmChannelTag(tag, version);
  }

  function mockPackageInstallStatus(root = "/opt/openclaw") {
    vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(root);
    vi.mocked(checkUpdateStatus).mockResolvedValue({
      root,
      installKind: "package",
      packageManager: "npm",
    } satisfies UpdateCheckResult);
  }

  function mockNpmChannelTag(tag: string, version: string) {
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({
      tag,
      version,
    });
  }

  function mockDevGitStatus(params?: {
    currentSha?: string;
    branch?: string | null;
    upstream?: string | null;
    upstreamSource?: "tracking" | "receipt";
    upstreamSha?: string | null;
    commitAtMs?: number | null;
    ahead?: number | null;
    behind?: number | null;
    fetchOk?: boolean;
  }) {
    const upstream = params?.upstream === undefined ? "origin/main" : params.upstream;
    vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue("/opt/openclaw");
    vi.mocked(checkUpdateStatus).mockResolvedValue({
      root: "/opt/openclaw",
      installKind: "git",
      packageManager: "pnpm",
      git: {
        root: "/opt/openclaw",
        sha: params?.currentSha ?? "current-sha",
        tag: null,
        branch: params?.branch === undefined ? "main" : params.branch,
        upstream,
        ...(params?.upstreamSource
          ? { upstreamSource: params.upstreamSource }
          : upstream
            ? { upstreamSource: "tracking" as const }
            : {}),
        upstreamSha: params?.upstreamSha === undefined ? "upstream-sha" : params.upstreamSha,
        commitAtMs: params?.commitAtMs ?? null,
        dirty: false,
        ahead: params?.ahead === undefined ? 0 : params.ahead,
        behind: params?.behind === undefined ? 2 : params.behind,
        fetchOk: params?.fetchOk ?? true,
      },
    } satisfies UpdateCheckResult);
  }

  async function runUpdateCheckAndReadState(channel: "stable" | "beta") {
    mockPackageUpdateStatus("latest", "2.0.0");

    const log = { info: vi.fn() };
    await runGatewayUpdateCheck({
      cfg: { update: { channel } },
      log,
      isNixMode: false,
      allowInTests: true,
    });

    const parsed = readPersistedUpdateCheckState();
    expect(parsed).not.toBeNull();
    return { log, parsed };
  }

  async function expectPathMissing(targetPath: string): Promise<void> {
    let statError: NodeJS.ErrnoException | undefined;
    try {
      await fs.stat(targetPath);
    } catch (error) {
      statError = error as NodeJS.ErrnoException;
    }
    expect(statError).toBeInstanceOf(Error);
    expect(statError?.code).toBe("ENOENT");
    expect(statError?.path).toBe(targetPath);
    expect(statError?.syscall).toBe("stat");
  }

  function createAutoUpdateSuccessMock() {
    return vi.fn().mockResolvedValue({
      ok: true,
      code: 0,
    });
  }

  function idleActiveWorkInspectors(): GatewayActiveWorkInspectors {
    return {
      getQueueSize: () => 0,
      getPendingReplies: () => 0,
      getEmbeddedRuns: () => 0,
      getBackgroundExecSessions: () => 0,
      getCronRuns: () => 0,
      getActiveTasks: () => 0,
      getTaskBlockers: () => [],
      getRootRequests: () => 0,
      getSessionAdmissions: () => 0,
      getSessionMutations: () => 0,
      getChatRuns: () => 0,
      getQueuedTurns: () => 0,
      getTerminalPersistence: () => 0,
      getTerminalSessions: () => 0,
    };
  }

  function createBetaAutoUpdateConfig(params?: { checkOnStart?: boolean }) {
    return {
      update: {
        ...(params?.checkOnStart === false ? { checkOnStart: false } : {}),
        channel: "beta" as const,
        auto: {
          enabled: true,
        },
      },
    };
  }

  function createExtendedStableConfig(params?: { checkOnStart?: boolean; autoEnabled?: boolean }) {
    return {
      update: {
        ...(params?.checkOnStart === false ? { checkOnStart: false } : {}),
        channel: "extended-stable" as const,
        ...(params?.autoEnabled ? { auto: { enabled: true } } : {}),
      },
    };
  }

  async function runExtendedStableUpdateCheck(params?: {
    cfg?: ReturnType<typeof createExtendedStableConfig>;
    log?: Parameters<typeof runGatewayUpdateCheck>[0]["log"];
    onUpdateAvailableChange?: Parameters<
      typeof runGatewayUpdateCheck
    >[0]["onUpdateAvailableChange"];
    runAutoUpdate?: ReturnType<typeof createAutoUpdateSuccessMock>;
    isNixMode?: boolean;
  }) {
    const log = params?.log ?? { info: vi.fn() };
    await runGatewayUpdateCheck({
      cfg: params?.cfg ?? createExtendedStableConfig(),
      log,
      isNixMode: params?.isNixMode ?? false,
      allowInTests: true,
      ...(params?.onUpdateAvailableChange
        ? { onUpdateAvailableChange: params.onUpdateAvailableChange }
        : {}),
      ...(params?.runAutoUpdate ? { runAutoUpdate: params.runAutoUpdate } : {}),
    });
  }

  async function seedExtendedStableAvailability(params?: {
    onUpdateAvailableChange?: Parameters<
      typeof runGatewayUpdateCheck
    >[0]["onUpdateAvailableChange"];
  }) {
    mockPackageInstallStatus();
    mockNpmChannelTag("extended-stable", "2.0.0");
    await runExtendedStableUpdateCheck({
      onUpdateAvailableChange: params?.onUpdateAvailableChange,
    });
  }

  function seedStableAutoRolloutState() {
    writePersistedUpdateCheckState({
      ...readPersistedUpdateCheckState(),
      autoInstallId: "stable-install-id",
      autoFirstSeenVersion: "3.0.0",
      autoFirstSeenTag: "latest",
      autoFirstSeenAt: "2026-01-16T10:00:00.000Z",
    });
  }

  function expectStableAutoRolloutStatePreserved() {
    expect(readPersistedUpdateCheckState()).toMatchObject({
      autoInstallId: "stable-install-id",
      autoFirstSeenVersion: "3.0.0",
      autoFirstSeenTag: "latest",
      autoFirstSeenAt: "2026-01-16T10:00:00.000Z",
    });
  }

  async function runAutoUpdateCheckWithDefaults(params: {
    cfg: { update?: Record<string, unknown> };
    runAutoUpdate?: ReturnType<typeof createAutoUpdateSuccessMock>;
  }) {
    await runGatewayUpdateCheck({
      cfg: params.cfg,
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
      activeWorkInspectors: idleActiveWorkInspectors(),
      ...(params.runAutoUpdate ? { runAutoUpdate: params.runAutoUpdate } : {}),
    });
    await vi.advanceTimersByTimeAsync(60_000);
  }

  async function runStableUpdateCheck(params: {
    onUpdateAvailableChange?: Parameters<
      typeof runGatewayUpdateCheck
    >[0]["onUpdateAvailableChange"];
  }) {
    await runGatewayUpdateCheck({
      cfg: { update: { channel: "stable" } },
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
      ...(params.onUpdateAvailableChange
        ? { onUpdateAvailableChange: params.onUpdateAvailableChange }
        : {}),
    });
  }

  it.each([
    {
      name: "stable channel",
      channel: "stable" as const,
    },
    {
      name: "beta channel with older beta tag",
      channel: "beta" as const,
    },
  ])("logs latest update hint for $name", async ({ channel }) => {
    const { log, parsed } = await runUpdateCheckAndReadState(channel);

    expect(log.info).toHaveBeenCalledWith(
      `update available (latest): v2.0.0 (current v1.0.0). Run: ${formatCliCommand("openclaw update")}`,
    );
    expect(parsed?.lastNotifiedVersion).toBe("2.0.0");
    expect(parsed?.lastAvailableVersion).toBe("2.0.0");
    expect(parsed?.lastNotifiedTag).toBe("latest");
  });

  it("falls back when the update-check clock is outside Date range", async () => {
    mockPackageUpdateStatus("latest", "2.0.0");
    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_001);

    await runGatewayUpdateCheck({
      cfg: { update: { channel: "stable" } },
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
    });

    const parsed = readPersistedUpdateCheckState();
    expect(parsed?.lastCheckedAt).toBe("1970-01-01T00:00:00.000Z");
    expect(parsed?.lastAvailableVersion).toBe("2.0.0");
  });

  it("does not throttle invalid update-check clocks against persisted state", async () => {
    writePersistedUpdateCheckState({
      lastCheckedAt: "2026-01-17T09:30:00.000Z",
    });
    mockPackageUpdateStatus("latest", "2.0.0");
    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_001);

    await runGatewayUpdateCheck({
      cfg: { update: { channel: "stable" } },
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
    });

    expect(checkUpdateStatus).toHaveBeenCalledTimes(1);
    const parsed = readPersistedUpdateCheckState();
    expect(parsed?.lastCheckedAt).toBe("1970-01-01T00:00:00.000Z");
    expect(parsed?.lastAvailableVersion).toBe("2.0.0");
  });

  it.each([
    {
      channel: "stable" as const,
      persistedTag: undefined,
      expectedTag: "latest",
      preflightsInstallKind: false,
    },
    {
      channel: "stable" as const,
      persistedTag: "latest",
      expectedTag: "latest",
      preflightsInstallKind: false,
    },
    {
      channel: "beta" as const,
      persistedTag: "beta",
      expectedTag: "beta",
      preflightsInstallKind: false,
    },
    {
      channel: "beta" as const,
      persistedTag: "latest",
      expectedTag: "latest",
      preflightsInstallKind: false,
    },
    {
      channel: "extended-stable" as const,
      persistedTag: "extended-stable",
      expectedTag: "extended-stable",
      preflightsInstallKind: true,
    },
    {
      channel: "dev" as const,
      persistedTag: "dev",
      expectedTag: "dev",
      preflightsInstallKind: true,
    },
  ])(
    "hydrates $channel cached availability from its compatible $expectedTag tag",
    async ({ channel, persistedTag, expectedTag, preflightsInstallKind }) => {
      writePersistedUpdateCheckState({
        lastCheckedAt: new Date(Date.now()).toISOString(),
        lastAvailableVersion: "2.0.0",
        lastAvailableTag: persistedTag,
      });
      if (preflightsInstallKind) {
        mockPackageInstallStatus();
      }
      const onUpdateAvailableChange = vi.fn();

      await runGatewayUpdateCheck({
        cfg: { update: { channel } },
        log: { info: vi.fn() },
        isNixMode: false,
        allowInTests: true,
        onUpdateAvailableChange,
      });

      expect(checkUpdateStatus).toHaveBeenCalledTimes(preflightsInstallKind ? 1 : 0);
      expect(resolveNpmChannelTag).not.toHaveBeenCalled();
      expect(onUpdateAvailableChange).toHaveBeenCalledWith({
        currentVersion: "1.0.0",
        latestVersion: "2.0.0",
        channel: expectedTag,
      });
      expect(getUpdateAvailable()).toEqual({
        currentVersion: "1.0.0",
        latestVersion: "2.0.0",
        channel: expectedTag,
      });
    },
  );

  it.each([
    { channel: "stable" as const, persistedTag: "beta" },
    { channel: "stable" as const, persistedTag: "extended-stable" },
    { channel: "beta" as const, persistedTag: undefined },
    { channel: "beta" as const, persistedTag: "extended-stable" },
    { channel: "dev" as const, persistedTag: "latest" },
  ])(
    "suppresses $persistedTag persisted availability on the $channel channel",
    async ({ channel, persistedTag }) => {
      writePersistedUpdateCheckState({
        lastCheckedAt: new Date(Date.now()).toISOString(),
        lastAvailableVersion: "2.0.0",
        lastAvailableTag: persistedTag,
      });
      if (channel === "dev") {
        mockPackageInstallStatus();
      }
      const onUpdateAvailableChange = vi.fn();

      await runGatewayUpdateCheck({
        cfg: { update: { channel } },
        log: { info: vi.fn() },
        isNixMode: false,
        allowInTests: true,
        onUpdateAvailableChange,
      });

      expect(checkUpdateStatus).toHaveBeenCalledTimes(channel === "dev" ? 1 : 0);
      expect(resolveNpmChannelTag).not.toHaveBeenCalled();
      expect(onUpdateAvailableChange).not.toHaveBeenCalled();
      expect(getUpdateAvailable()).toBeNull();
    },
  );

  it.each(["latest", "beta"])(
    "bypasses the shared throttle for mismatched %s availability on extended-stable",
    async (persistedTag) => {
      writePersistedUpdateCheckState({
        lastCheckedAt: new Date(Date.now()).toISOString(),
        lastAvailableVersion: "2.0.0",
        lastAvailableTag: persistedTag,
      });
      mockPackageUpdateStatus("extended-stable", "2.0.0");
      const onUpdateAvailableChange = vi.fn();

      await runExtendedStableUpdateCheck({ onUpdateAvailableChange });

      expect(checkUpdateStatus).toHaveBeenCalledTimes(1);
      expect(resolveNpmChannelTag).toHaveBeenCalledWith({
        channel: "extended-stable",
        timeoutMs: 2500,
      });
      expect(onUpdateAvailableChange).toHaveBeenCalledWith({
        currentVersion: "1.0.0",
        latestVersion: "2.0.0",
        channel: "extended-stable",
      });
      expect(readPersistedUpdateCheckState()).toMatchObject({
        lastAvailableVersion: "2.0.0",
        lastAvailableTag: "extended-stable",
      });
    },
  );

  it("bypasses a recent empty prior-channel check on extended-stable", async () => {
    writePersistedUpdateCheckState({
      lastCheckedAt: new Date(Date.now()).toISOString(),
    });
    mockPackageUpdateStatus("extended-stable", "2.0.0");

    await runExtendedStableUpdateCheck();

    expect(checkUpdateStatus).toHaveBeenCalledTimes(1);
    expect(resolveNpmChannelTag).toHaveBeenCalledWith({
      channel: "extended-stable",
      timeoutMs: 2500,
    });
    expect(getUpdateAvailable()).toEqual({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "extended-stable",
    });
  });

  it("honors the shared throttle after a recent extended-stable check marker", async () => {
    writePersistedUpdateCheckState({
      lastCheckedAt: new Date(Date.now()).toISOString(),
      lastAvailableVersion: "1.0.0",
      lastAvailableTag: "extended-stable",
    });
    mockPackageUpdateStatus("extended-stable", "2.0.0");

    await runExtendedStableUpdateCheck();

    expect(resolveNpmChannelTag).not.toHaveBeenCalled();
    expect(getUpdateAvailable()).toBeNull();
  });

  it("emits update change callback when update state clears", async () => {
    mockPackageInstallStatus();
    vi.mocked(resolveNpmChannelTag)
      .mockResolvedValueOnce({
        tag: "latest",
        version: "2.0.0",
      })
      .mockResolvedValueOnce({
        tag: "latest",
        version: "1.0.0",
      });

    const onUpdateAvailableChange = vi.fn();
    await runStableUpdateCheck({ onUpdateAvailableChange });
    vi.setSystemTime(new Date("2026-01-18T11:00:00Z"));
    await runStableUpdateCheck({ onUpdateAvailableChange });

    expect(onUpdateAvailableChange).toHaveBeenNthCalledWith(1, {
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "latest",
    });
    expect(onUpdateAvailableChange).toHaveBeenNthCalledWith(2, null);
    expect(getUpdateAvailable()).toBeNull();
  });

  it("skips update check when disabled in config", async () => {
    const log = { info: vi.fn() };

    await runGatewayUpdateCheck({
      cfg: { update: { checkOnStart: false } },
      log,
      isNixMode: false,
      allowInTests: true,
    });

    expect(log.info).not.toHaveBeenCalled();
    expect(readPersistedUpdateCheckState()).toBeNull();
    await expectPathMissing(path.join(tempDir, "update-check.json"));
  });

  it("uses the extended-stable selector for an installed final extended-stable package", async () => {
    versionMock.value = "2026.6.33";
    mockPackageUpdateStatus("extended-stable", "2026.7.33");
    const onUpdateAvailableChange = vi.fn();

    await runGatewayUpdateCheck({
      cfg: {},
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
      onUpdateAvailableChange,
    });

    expect(resolveNpmChannelTag).toHaveBeenCalledWith({
      channel: "extended-stable",
      timeoutMs: 2500,
    });
    expect(onUpdateAvailableChange).toHaveBeenCalledWith({
      currentVersion: "2026.6.33",
      latestVersion: "2026.7.33",
      channel: "extended-stable",
    });
  });

  it("does not query extended-stable when configless startup hints are disabled", async () => {
    versionMock.value = "2026.6.33";
    mockPackageInstallStatus();
    const runAutoUpdate = createAutoUpdateSuccessMock();

    await runGatewayUpdateCheck({
      cfg: { update: { checkOnStart: false, auto: { enabled: true } } },
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
      runAutoUpdate,
    });

    expect(checkUpdateStatus).toHaveBeenCalledOnce();
    expect(resolveNpmChannelTag).not.toHaveBeenCalled();
    expect(runAutoUpdate).not.toHaveBeenCalled();
    expect(readPersistedUpdateCheckState()).toBeNull();
  });

  it("discovers and deduplicates an exact extended-stable update without auto-applying", async () => {
    const onUpdateAvailableChange = vi.fn();
    const runAutoUpdate = createAutoUpdateSuccessMock();
    mockPackageUpdateStatus("extended-stable", "2.0.0");
    const log = { info: vi.fn() };

    await runExtendedStableUpdateCheck({
      cfg: createExtendedStableConfig({ autoEnabled: true }),
      log,
      onUpdateAvailableChange,
      runAutoUpdate,
    });
    vi.setSystemTime(new Date("2026-01-18T11:00:00Z"));
    await runExtendedStableUpdateCheck({
      cfg: createExtendedStableConfig({ autoEnabled: true }),
      log,
      onUpdateAvailableChange,
      runAutoUpdate,
    });

    expect(resolveNpmChannelTag).toHaveBeenCalledTimes(2);
    expect(resolveNpmChannelTag).toHaveBeenNthCalledWith(1, {
      channel: "extended-stable",
      timeoutMs: 2500,
    });
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      `update available (extended-stable): v2.0.0 (current v1.0.0). Run: ${formatCliCommand("openclaw update")}`,
    );
    expect(onUpdateAvailableChange).toHaveBeenCalledTimes(1);
    expect(onUpdateAvailableChange).toHaveBeenCalledWith({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "extended-stable",
    });
    expect(getUpdateAvailable()).toEqual({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "extended-stable",
    });
    expect(readPersistedUpdateCheckState()).toMatchObject({
      lastNotifiedVersion: "2.0.0",
      lastNotifiedTag: "extended-stable",
      lastAvailableVersion: "2.0.0",
      lastAvailableTag: "extended-stable",
    });
    expect(runAutoUpdate).not.toHaveBeenCalled();
    expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(readPersistedUpdateCheckState()?.autoFirstSeenVersion).toBeUndefined();
  });

  it("does no extended-stable hint or auto work when checkOnStart is false", async () => {
    await seedExtendedStableAvailability();
    vi.mocked(resolveOpenClawPackageRoot).mockClear();
    vi.mocked(checkUpdateStatus).mockClear();
    vi.mocked(resolveNpmChannelTag).mockClear();
    const onUpdateAvailableChange = vi.fn();
    const runAutoUpdate = createAutoUpdateSuccessMock();

    await runExtendedStableUpdateCheck({
      cfg: createExtendedStableConfig({ checkOnStart: false, autoEnabled: true }),
      onUpdateAvailableChange,
      runAutoUpdate,
    });

    expect(resolveOpenClawPackageRoot).not.toHaveBeenCalled();
    expect(checkUpdateStatus).not.toHaveBeenCalled();
    expect(resolveNpmChannelTag).not.toHaveBeenCalled();
    expect(runAutoUpdate).not.toHaveBeenCalled();
    expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(onUpdateAvailableChange).toHaveBeenCalledOnce();
    expect(onUpdateAvailableChange).toHaveBeenCalledWith(null);
    expect(getUpdateAvailable()).toBeNull();
  });

  it.each([
    { name: "equal", version: "1.0.0" },
    { name: "older", version: "0.9.0" },
  ])("clears stale extended-stable availability for an $name target", async ({ version }) => {
    const onUpdateAvailableChange = vi.fn();
    await seedExtendedStableAvailability({ onUpdateAvailableChange });
    seedStableAutoRolloutState();
    onUpdateAvailableChange.mockClear();
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({
      tag: "extended-stable",
      version,
    });
    vi.setSystemTime(new Date("2026-01-18T11:00:00Z"));
    const log = { info: vi.fn() };

    await runExtendedStableUpdateCheck({ log, onUpdateAvailableChange });

    expect(log.info).not.toHaveBeenCalled();
    expect(onUpdateAvailableChange).toHaveBeenCalledOnce();
    expect(onUpdateAvailableChange).toHaveBeenCalledWith(null);
    expect(getUpdateAvailable()).toBeNull();
    expect(readPersistedUpdateCheckState()).toMatchObject({
      lastNotifiedVersion: "2.0.0",
      lastNotifiedTag: "extended-stable",
    });
    expect(readPersistedUpdateCheckState()?.lastAvailableVersion).toBeUndefined();
    expect(readPersistedUpdateCheckState()?.lastAvailableTag).toBe("extended-stable");
    expectStableAutoRolloutStatePreserved();
  });

  it.each(["selector_missing", "selector_query_failed", "exact_package_mismatch"] as const)(
    "clears stale extended-stable availability when exact resolution fails with %s",
    async (failure) => {
      const onUpdateAvailableChange = vi.fn();
      await seedExtendedStableAvailability({ onUpdateAvailableChange });
      seedStableAutoRolloutState();
      onUpdateAvailableChange.mockClear();
      vi.mocked(resolveNpmChannelTag).mockResolvedValue({
        tag: "extended-stable",
        version: null,
        reason: failure,
      });
      vi.setSystemTime(new Date("2026-01-18T11:00:00Z"));
      const log = { info: vi.fn() };

      await runExtendedStableUpdateCheck({ log, onUpdateAvailableChange });

      expect(log.info).not.toHaveBeenCalled();
      expect(onUpdateAvailableChange).toHaveBeenCalledOnce();
      expect(onUpdateAvailableChange).toHaveBeenCalledWith(null);
      expect(getUpdateAvailable()).toBeNull();
      expect(readPersistedUpdateCheckState()?.lastAvailableVersion).toBeUndefined();
      expect(readPersistedUpdateCheckState()?.lastAvailableTag).toBe("extended-stable");
      expectStableAutoRolloutStatePreserved();
      expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
      expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();

      await runExtendedStableUpdateCheck({ log, onUpdateAvailableChange });
      expect(resolveNpmChannelTag).toHaveBeenCalledTimes(2);
    },
  );

  it("preserves cross-channel persisted availability when extended-stable resolution fails", async () => {
    writePersistedUpdateCheckState({
      lastCheckedAt: "2026-01-16T10:00:00.000Z",
      lastAvailableVersion: "2.0.0",
      lastAvailableTag: "latest",
    });
    mockPackageInstallStatus();
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({
      tag: "extended-stable",
      version: null,
      reason: "selector_query_failed",
    });
    const onUpdateAvailableChange = vi.fn();

    await runExtendedStableUpdateCheck({ onUpdateAvailableChange });

    expect(onUpdateAvailableChange).not.toHaveBeenCalled();
    expect(getUpdateAvailable()).toBeNull();
    expect(readPersistedUpdateCheckState()).toMatchObject({
      lastAvailableVersion: "2.0.0",
      lastAvailableTag: "latest",
    });
  });

  it("does not resolve the npm channel for an extended-stable Git install", async () => {
    await seedExtendedStableAvailability();
    seedStableAutoRolloutState();
    resetUpdateAvailableStateForTest();
    vi.mocked(resolveOpenClawPackageRoot).mockClear();
    vi.mocked(checkUpdateStatus).mockClear();
    vi.mocked(resolveNpmChannelTag).mockClear();
    vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue("/opt/openclaw");
    vi.mocked(checkUpdateStatus).mockResolvedValue({
      root: "/opt/openclaw",
      installKind: "git",
      packageManager: "unknown",
    } satisfies UpdateCheckResult);
    const runAutoUpdate = createAutoUpdateSuccessMock();
    const onUpdateAvailableChange = vi.fn();

    await runExtendedStableUpdateCheck({ onUpdateAvailableChange, runAutoUpdate });

    expect(checkUpdateStatus).toHaveBeenCalledTimes(1);
    expect(resolveNpmChannelTag).not.toHaveBeenCalled();
    expect(runAutoUpdate).not.toHaveBeenCalled();
    expect(onUpdateAvailableChange).not.toHaveBeenCalled();
    expect(getUpdateAvailable()).toBeNull();
    expect(readPersistedUpdateCheckState()).toMatchObject({
      lastAvailableVersion: "2.0.0",
      lastAvailableTag: "extended-stable",
    });
    expectStableAutoRolloutStatePreserved();
  });

  it("uses the verified package install kind for a configless extended-stable release", async () => {
    versionMock.value = "2026.6.33";
    mockPackageInstallStatus();
    mockNpmChannelTag("extended-stable", "2026.6.34");

    await runGatewayUpdateCheck({
      cfg: {},
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
    });

    expect(resolveNpmChannelTag).toHaveBeenCalledWith({
      channel: "extended-stable",
      timeoutMs: 2500,
    });
  });

  it("skips all extended-stable work in Nix mode", async () => {
    const runAutoUpdate = createAutoUpdateSuccessMock();

    await runExtendedStableUpdateCheck({ isNixMode: true, runAutoUpdate });

    expect(resolveOpenClawPackageRoot).not.toHaveBeenCalled();
    expect(checkUpdateStatus).not.toHaveBeenCalled();
    expect(resolveNpmChannelTag).not.toHaveBeenCalled();
    expect(runAutoUpdate).not.toHaveBeenCalled();
    expect(readPersistedUpdateCheckState()).toBeNull();
  });

  it("announces and applies a dev git campaign without consulting npm", async () => {
    mockDevGitStatus();
    const longSubject = "x".repeat(140);
    vi.mocked(runCommandWithTimeout).mockResolvedValueOnce({
      stdout: [
        `aaaaaaa\t${longSubject}`,
        "bbbbbbb\tSecond commit",
        "ccccccc\tThird commit",
        "ddddddd\tFourth commit",
        "eeeeeee\tFifth commit",
        "fffffff\tUnexpected sixth commit",
      ].join("\n"),
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    });
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({
      tag: "dev",
      version: "99.0.0-dev.1",
    });
    const runAutoUpdate = createAutoUpdateSuccessMock();

    await runGatewayUpdateCheck({
      cfg: { update: { channel: "dev", auto: { enabled: true } } },
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
      activeWorkInspectors: idleActiveWorkInspectors(),
      runAutoUpdate,
    });

    expect(checkUpdateStatus).toHaveBeenCalledWith({
      root: "/opt/openclaw",
      timeoutMs: 2500,
      fetchGit: true,
      includeRegistry: false,
      useDetachedDevUpstream: true,
    });
    expect(resolveNpmChannelTag).not.toHaveBeenCalled();
    expect(getUpdateAvailable()).toEqual({
      currentVersion: "1.0.0",
      latestVersion: "1.0.0",
      channel: "dev",
      currentSha: "current-sha",
      upstreamRef: "origin/main",
      upstreamSha: "upstream-sha",
      commitsBehind: 2,
      commits: [
        { sha: "aaaaaaa", subject: "x".repeat(120) },
        { sha: "bbbbbbb", subject: "Second commit" },
        { sha: "ccccccc", subject: "Third commit" },
        { sha: "ddddddd", subject: "Fourth commit" },
        { sha: "eeeeeee", subject: "Fifth commit" },
      ],
    });
    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      [
        "git",
        "-C",
        "/opt/openclaw",
        "log",
        "--format=%h%x09%s",
        "--max-count=5",
        "current-sha..upstream-sha",
      ],
      {
        timeoutMs: 2500,
        maxOutputBytes: { stdout: 8 * 1024, stderr: 1024 },
      },
    );
    expect(getUpdateSchedule()).toMatchObject({
      channel: "dev",
      autoEnabled: true,
      install: { kind: "git", git: { status: "behind", commitsBehind: 2 } },
      target: {
        kind: "git",
        upstreamRef: "origin/main",
        upstreamSha: "upstream-sha",
        commitsBehind: 2,
      },
      campaign: { state: "countdown" },
    });
    expect(runAutoUpdate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(runAutoUpdate).toHaveBeenCalledWith({
      channel: "dev",
      timeoutMs: 45 * 60 * 1000,
      restartDrainTimeoutMs: 300_000,
      root: "/opt/openclaw",
      devTarget: {
        mode: "tracked",
        upstreamRef: "origin/main",
        upstreamSha: "upstream-sha",
      },
    });
  });

  it("pins direct dev campaign updates to the announced commit", async () => {
    mockDevGitStatus({ upstreamSha: "frozen-upstream-sha" });
    const originalArgv = process.argv.slice();
    process.argv = [process.execPath, "/opt/openclaw/dist/entry.js"];
    try {
      await runGatewayUpdateCheck({
        cfg: { update: { channel: "dev", auto: { enabled: true } } },
        log: { info: vi.fn() },
        isNixMode: false,
        allowInTests: true,
        activeWorkInspectors: idleActiveWorkInspectors(),
      });
      await vi.advanceTimersByTimeAsync(60_000);
    } finally {
      process.argv = originalArgv;
    }

    const updateCall = vi
      .mocked(runCommandWithTimeout)
      .mock.calls.find(([argv]) => argv.includes("update"));
    const updateOptions = updateCall?.[1];
    if (!updateOptions || typeof updateOptions === "number") {
      throw new Error("expected update command options");
    }
    expect(updateOptions.timeoutMs).toBe(45 * 60 * 1000);
    expect(parseDevUpdateTargetEnv(updateOptions.env ?? {})).toEqual({
      status: "valid",
      target: {
        mode: "tracked",
        upstreamRef: "origin/main",
        upstreamSha: "frozen-upstream-sha",
      },
    });
  });

  it("pins managed dev campaign handoffs to the announced commit", async () => {
    mockDevGitStatus({ upstreamSha: "frozen-upstream-sha" });
    detectRespawnSupervisorMock.mockReturnValue("launchd");

    await runGatewayUpdateCheck({
      cfg: { update: { channel: "dev", auto: { enabled: true } } },
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
      activeWorkInspectors: idleActiveWorkInspectors(),
    });
    await vi.advanceTimersByTimeAsync(60_000);

    const [handoffParams] = startManagedServiceUpdateHandoffMock.mock.calls[0] ?? [];
    expect(handoffParams?.devTarget).toEqual({
      mode: "tracked",
      upstreamRef: "origin/main",
      upstreamSha: "frozen-upstream-sha",
    });
  });

  it("continues managed dev campaigns from a detached tracked deployment", async () => {
    mockDevGitStatus({ branch: "HEAD", upstreamSource: "tracking" });
    const runAutoUpdate = createAutoUpdateSuccessMock();

    await runGatewayUpdateCheck({
      cfg: { update: { channel: "dev", auto: { enabled: true } } },
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
      activeWorkInspectors: idleActiveWorkInspectors(),
      runAutoUpdate,
    });

    expect(getUpdateSchedule()?.campaign?.state).toBe("countdown");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runAutoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        devTarget: {
          mode: "tracked",
          upstreamRef: "origin/main",
          upstreamSha: "upstream-sha",
        },
      }),
    );
  });

  it.each([
    { name: "successful install", status: "ok", reason: undefined },
    {
      name: "failed handoff",
      status: "error",
      reason: "managed-service-handoff-failed",
    },
  ] as const)("continues automatic dev campaigns from a $name receipt", async (testCase) => {
    runOpenClawStateWriteTransaction(({ db }) => {
      writeUpdateInstallReceiptRowSync(db, {
        kind: "update",
        status: testCase.status,
        ts: Date.now() - 60_000,
        stats: {
          mode: "git",
          ...(testCase.reason ? { reason: testCase.reason } : {}),
          root: "/opt/openclaw",
          after: {
            sha: "current-sha",
            version: "1.0.0",
            upstreamRef: "origin/main",
          },
        },
      });
    });
    mockDevGitStatus({ branch: "HEAD", upstreamSource: "receipt" });
    const runAutoUpdate = createAutoUpdateSuccessMock();

    await runGatewayUpdateCheck({
      cfg: { update: { channel: "dev", auto: { enabled: true } } },
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
      activeWorkInspectors: idleActiveWorkInspectors(),
      runAutoUpdate,
    });

    expect(checkUpdateStatus).toHaveBeenCalledWith({
      root: "/opt/openclaw",
      timeoutMs: 2500,
      fetchGit: true,
      includeRegistry: false,
      useDetachedDevUpstream: true,
      gitUpstreamFallback: { currentSha: "current-sha", upstreamRef: "origin/main" },
    });
    expect(getUpdateSchedule()?.campaign?.state).toBe("countdown");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runAutoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        devTarget: {
          mode: "tracked",
          upstreamRef: "origin/main",
          upstreamSha: "upstream-sha",
        },
      }),
    );
  });

  it.each([
    { name: "ahead", git: { ahead: 1, behind: 0 } },
    { name: "diverged", git: { ahead: 1, behind: 2 } },
    { name: "non-main", git: { branch: "feature" } },
    {
      name: "detached without tracking",
      git: { branch: "HEAD", upstream: null, upstreamSha: null, ahead: null, behind: null },
    },
  ])("does not announce an automatic dev campaign for a $name checkout", async ({ git }) => {
    mockDevGitStatus(git);
    const runAutoUpdate = createAutoUpdateSuccessMock();

    await runGatewayUpdateCheck({
      cfg: { update: { channel: "dev", auto: { enabled: true } } },
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
      activeWorkInspectors: idleActiveWorkInspectors(),
      runAutoUpdate,
    });
    await vi.advanceTimersByTimeAsync(15 * 60_000);

    expect(getUpdateSchedule()?.campaign).toBeUndefined();
    expect(runAutoUpdate).not.toHaveBeenCalled();
  });

  it("does not probe dev commits when the checkout is up to date", async () => {
    mockDevGitStatus({ behind: 0 });

    await runGatewayUpdateCheck({
      cfg: { update: { channel: "dev" } },
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
    });

    expect(runCommandWithTimeout).not.toHaveBeenCalled();
    expect(getUpdateAvailable()).toBeNull();
    expect(getUpdateSchedule()?.install).toEqual({
      kind: "git",
      git: { currentSha: "current-sha", status: "current" },
    });
  });

  it("reports commit and verified installation times for the current checkout", async () => {
    const installedAtMs = Date.now() - 60 * 60 * 1000;
    const commitAtMs = installedAtMs - 24 * 60 * 60 * 1000;
    runOpenClawStateWriteTransaction(({ db }) => {
      writeUpdateInstallReceiptRowSync(db, {
        kind: "update",
        status: "ok",
        ts: installedAtMs,
        stats: {
          mode: "git",
          root: "/opt/openclaw",
          after: { sha: "current-sha", version: "1.0.0", upstreamRef: "origin/main" },
        },
      });
    });
    mockDevGitStatus({ behind: 0, commitAtMs });

    await runGatewayUpdateCheck({
      cfg: { update: { channel: "dev" } },
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
    });

    expect(getUpdateSchedule()?.install?.git).toEqual({
      status: "current",
      currentSha: "current-sha",
      commitAtMs,
      installedAtMs,
    });
  });

  it("does not inherit install time from a same-SHA receipt for another checkout", async () => {
    const installedAtMs = Date.now() - 60 * 60 * 1000;
    runOpenClawStateWriteTransaction(({ db }) => {
      writeUpdateInstallReceiptRowSync(db, {
        kind: "update",
        status: "ok",
        ts: installedAtMs,
        stats: {
          mode: "git",
          root: "/opt/other-openclaw",
          after: { sha: "current-sha", version: "1.0.0" },
        },
      });
    });
    mockDevGitStatus({ behind: 0 });

    await runGatewayUpdateCheck({
      cfg: { update: { channel: "dev" } },
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
    });

    expect(getUpdateSchedule()?.install?.git).toEqual({
      status: "current",
      currentSha: "current-sha",
    });
  });

  it.each([
    {
      name: "failed fetch",
      git: { fetchOk: false, ahead: null, behind: null },
      expected: { status: "unavailable", reason: "fetch-failed" },
    },
    {
      name: "missing upstream",
      git: { upstream: null, upstreamSha: null, ahead: null, behind: null },
      expected: { status: "unavailable", reason: "no-upstream" },
    },
    {
      name: "missing receipt-backed upstream ref",
      git: {
        branch: "HEAD",
        upstream: "origin/missing",
        upstreamSource: "receipt" as const,
        upstreamSha: null,
        ahead: null,
        behind: null,
      },
      expected: { status: "unavailable", reason: "no-upstream-sha" },
    },
    {
      name: "incomparable history",
      git: { ahead: null, behind: null },
      expected: { status: "unavailable", reason: "comparison-failed" },
    },
    {
      name: "ahead checkout",
      git: { ahead: 2, behind: 0 },
      expected: { status: "ahead", commitsAhead: 2 },
    },
    {
      name: "diverged checkout",
      git: { ahead: 1, behind: 3 },
      expected: { status: "diverged", commitsAhead: 1, commitsBehind: 3 },
    },
  ])("reports $name without fabricating current", async ({ git, expected }) => {
    mockDevGitStatus(git);

    await runGatewayUpdateCheck({
      cfg: { update: { channel: "dev" } },
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
    });

    expect(getUpdateSchedule()?.install?.git).toEqual({ currentSha: "current-sha", ...expected });
    expect(getUpdateSchedule()?.install?.git?.status).not.toBe("current");
  });

  it("keeps a dev campaign countdown stable when active work begins", async () => {
    mockDevGitStatus();
    let busy = 1;
    const log = { info: vi.fn() };
    const runAutoUpdate = createAutoUpdateSuccessMock();

    await runGatewayUpdateCheck({
      cfg: { update: { channel: "dev", auto: { enabled: true } } },
      log,
      isNixMode: false,
      allowInTests: true,
      activeWorkInspectors: {
        ...idleActiveWorkInspectors(),
        getQueueSize: () => busy,
      },
      runAutoUpdate,
    });
    expect(getUpdateSchedule()?.campaign).toMatchObject({ state: "waiting-for-idle" });
    expect(log.info).toHaveBeenCalledWith(
      "update campaign waiting-for-idle",
      expect.objectContaining({
        campaignId: expect.any(String),
        state: "waiting-for-idle",
        channel: "dev",
        target: { upstreamSha: "upstream-sha", commitsBehind: 2 },
        forceAtMs: expect.any(Number),
      }),
    );
    busy = 0;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getUpdateSchedule()?.campaign).toMatchObject({ state: "countdown" });
    expect(log.info).toHaveBeenCalledWith(
      "update campaign countdown",
      expect.objectContaining({
        campaignId: expect.any(String),
        state: "countdown",
        channel: "dev",
        applyAtMs: expect.any(Number),
      }),
    );
    const applyAtMs = getUpdateSchedule()?.campaign?.applyAtMs;
    busy = 1;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getUpdateSchedule()?.campaign).toMatchObject({
      state: "countdown",
      applyAtMs,
    });

    await vi.advanceTimersByTimeAsync(55_000);
    expect(getUpdateSchedule()?.campaign?.state).toBe("applying");
    expect(runAutoUpdate).toHaveBeenCalledOnce();
    expect(log.info).toHaveBeenCalledWith(
      "auto-update applied",
      expect.objectContaining({
        channel: "dev",
        version: "upstream-sha",
        forced: false,
      }),
    );
  });

  it("keeps a new dev target visible during the automatic attempt cooldown", async () => {
    writePersistedUpdateCheckState({
      autoLastAttemptVersion: "upstream-one",
      autoLastAttemptAt: new Date(Date.now()).toISOString(),
    });
    mockDevGitStatus({ upstreamSha: "upstream-two", behind: 3 });
    const runAutoUpdate = createAutoUpdateSuccessMock();
    const cfg = { update: { channel: "dev" as const, auto: { enabled: true } } };

    await runGatewayUpdateCheck({
      cfg,
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
      activeWorkInspectors: idleActiveWorkInspectors(),
      runAutoUpdate,
    });

    expect(getUpdateAvailable()).toMatchObject({ upstreamSha: "upstream-two" });
    expect(getUpdateSchedule()?.target).toMatchObject({ upstreamSha: "upstream-two" });
    expect(getUpdateSchedule()?.campaign).toBeUndefined();
    expect(runAutoUpdate).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + 60 * 60 * 1000 + 1);
    await runGatewayUpdateCheck({
      cfg,
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
      activeWorkInspectors: idleActiveWorkInspectors(),
      runAutoUpdate,
    });

    expect(getUpdateSchedule()?.campaign?.state).toBe("countdown");
    expect(runAutoUpdate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runAutoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "dev",
        devTarget: expect.objectContaining({ upstreamSha: "upstream-two" }),
      }),
    );
  });

  it("supersedes and clears dev git campaigns from fresh git facts", async () => {
    mockDevGitStatus({ upstreamSha: "upstream-one" });
    const runAutoUpdate = createAutoUpdateSuccessMock();
    const cfg = { update: { channel: "dev" as const, auto: { enabled: true } } };

    await runGatewayUpdateCheck({
      cfg,
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
      activeWorkInspectors: idleActiveWorkInspectors(),
      runAutoUpdate,
    });
    const firstId = getUpdateSchedule()?.campaign?.id;
    mockDevGitStatus({ upstreamSha: "upstream-two", behind: 3 });
    await runGatewayUpdateCheck({
      cfg,
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
      activeWorkInspectors: idleActiveWorkInspectors(),
      runAutoUpdate,
    });
    expect(getUpdateSchedule()?.campaign?.id).not.toBe(firstId);
    expect(getUpdateSchedule()?.target).toMatchObject({ upstreamSha: "upstream-two" });

    mockDevGitStatus({ upstreamSha: "upstream-two", behind: 0 });
    await runGatewayUpdateCheck({
      cfg,
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
      activeWorkInspectors: idleActiveWorkInspectors(),
      runAutoUpdate,
    });
    expect(getUpdateAvailable()).toBeNull();
    expect(getUpdateSchedule()?.target).toBeUndefined();
    expect(getUpdateSchedule()?.campaign).toBeUndefined();
  });

  it("schedules enabled dev git checks hourly", async () => {
    mockDevGitStatus();
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const stop = scheduleGatewayUpdateCheck({
      cfg: { update: { channel: "dev", auto: { enabled: true } } },
      log: { info: vi.fn() },
      isNixMode: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(checkUpdateStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 - 1);
    expect(checkUpdateStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(checkUpdateStatus).toHaveBeenCalledTimes(2);
    stop();
    process.env.NODE_ENV = previousNodeEnv;
  });

  it("defers stable auto-update until rollout window is due", async () => {
    mockPackageUpdateStatus("latest", "2.0.0");

    const runAutoUpdate = vi.fn().mockResolvedValue({
      ok: true,
      code: 0,
    });
    const stableAutoConfig = {
      update: {
        channel: "stable" as const,
        auto: {
          enabled: true,
        },
      },
    };

    await runGatewayUpdateCheck({
      cfg: stableAutoConfig,
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
      activeWorkInspectors: idleActiveWorkInspectors(),
      runAutoUpdate,
    });
    expect(runAutoUpdate).not.toHaveBeenCalled();

    vi.setSystemTime(new Date("2026-01-18T07:00:00Z"));
    await runGatewayUpdateCheck({
      cfg: stableAutoConfig,
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
      activeWorkInspectors: idleActiveWorkInspectors(),
      runAutoUpdate,
    });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(runAutoUpdate).toHaveBeenCalledTimes(1);
    expect(runAutoUpdate).toHaveBeenCalledWith({
      channel: "stable",
      timeoutMs: 45 * 60 * 1000,
      restartDrainTimeoutMs: 300_000,
      root: "/opt/openclaw",
      packageTargetVersion: "2.0.0",
    });
  });

  it("runs beta auto-update checks hourly when enabled", async () => {
    mockPackageUpdateStatus("beta", "2.0.0-beta.1");
    const runAutoUpdate = createAutoUpdateSuccessMock();
    await runAutoUpdateCheckWithDefaults({
      cfg: createBetaAutoUpdateConfig(),
      runAutoUpdate,
    });

    expect(runAutoUpdate).toHaveBeenCalledTimes(1);
    expect(runAutoUpdate).toHaveBeenCalledWith({
      channel: "beta",
      timeoutMs: 45 * 60 * 1000,
      restartDrainTimeoutMs: 300_000,
      root: "/opt/openclaw",
      packageTargetVersion: "2.0.0-beta.1",
    });
  });

  it("runs auto-update when checkOnStart is false but auto-update is enabled", async () => {
    mockPackageUpdateStatus("beta", "2.0.0-beta.1");
    const runAutoUpdate = createAutoUpdateSuccessMock();

    await runAutoUpdateCheckWithDefaults({
      cfg: createBetaAutoUpdateConfig({ checkOnStart: false }),
      runAutoUpdate,
    });

    expect(runAutoUpdate).toHaveBeenCalledTimes(1);
  });

  it("honors OPENCLAW_NO_AUTO_UPDATE for configured auto-updates", async () => {
    mockPackageUpdateStatus("beta", "2.0.0-beta.1");
    process.env.OPENCLAW_NO_AUTO_UPDATE = "1";
    const log = { info: vi.fn() };
    const runAutoUpdate = createAutoUpdateSuccessMock();

    await runGatewayUpdateCheck({
      cfg: createBetaAutoUpdateConfig(),
      log,
      isNixMode: false,
      allowInTests: true,
      runAutoUpdate,
    });

    expect(runAutoUpdate).not.toHaveBeenCalled();
    const disabledLogCall = log.info.mock.calls.find(
      ([message]) => message === "auto-update disabled by OPENCLAW_NO_AUTO_UPDATE",
    );
    expect(disabledLogCall).toEqual([
      "auto-update disabled by OPENCLAW_NO_AUTO_UPDATE",
      {
        version: "2.0.0-beta.1",
        tag: "beta",
      },
    ]);
  });

  it("delegates configured auto-updates to an external supervisor", async () => {
    mockPackageUpdateStatus("beta", "2.0.0-beta.1");
    process.env.OPENCLAW_SUPERVISOR_MODE = "external";
    const log = { info: vi.fn() };
    const runAutoUpdate = createAutoUpdateSuccessMock();

    await runGatewayUpdateCheck({
      cfg: createBetaAutoUpdateConfig(),
      log,
      isNixMode: false,
      allowInTests: true,
      runAutoUpdate,
    });

    expect(runAutoUpdate).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith("auto-update delegated to external supervisor", {
      version: "2.0.0-beta.1",
      tag: "beta",
      reason: "external-supervisor-update-required",
    });
  });

  it("uses current runtime + entrypoint for default auto-update command execution", async () => {
    mockPackageInstallStatus();
    mockNpmChannelTag("beta", "2.0.0-beta.1");
    vi.mocked(runCommandWithTimeout).mockResolvedValue({
      stdout: "{}",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    });

    const originalArgv = process.argv.slice();
    process.argv = [process.execPath, "/opt/openclaw/dist/entry.js"];
    try {
      await runAutoUpdateCheckWithDefaults({
        cfg: createBetaAutoUpdateConfig(),
      });
    } finally {
      process.argv = originalArgv;
    }

    expect(runCommandWithTimeout).toHaveBeenCalledTimes(1);
    expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(detectRespawnSupervisorMock).toHaveBeenCalledWith(process.env, process.platform, {
      includeLinuxOpenClawGatewayServiceMarker: true,
    });
    const [argv, options] = requireFirstRunCommandCall();
    expect(argv).toEqual([
      process.execPath,
      "/opt/openclaw/dist/entry.js",
      "update",
      "--yes",
      "--channel",
      "beta",
      "--tag",
      "2.0.0-beta.1",
      "--json",
    ]);
    expect(typeof options).toBe("object");
    if (typeof options !== "object") {
      throw new Error("expected command options object");
    }
    expect(options.timeoutMs).toBe(45 * 60 * 1000);
    expect(options.env).toBeUndefined();
  });

  it("hands supervised auto-updates to a detached service handoff before restarting", async () => {
    const installRoot = path.join(tempDir, "pnpm-store-target");
    const installOwner = path.join(tempDir, "pnpm-linked-owner");
    await fs.mkdir(installRoot);
    await fs.symlink(installRoot, installOwner, "dir");
    mockPackageInstallStatus(installOwner);
    mockNpmChannelTag("beta", "2.0.0-beta.1");
    detectRespawnSupervisorMock.mockReturnValue("launchd");
    startManagedServiceUpdateHandoffMock.mockResolvedValueOnce({
      status: "started",
      pid: 12345,
      command: "openclaw update --yes --channel beta --tag 2.0.0-beta.1 --timeout 2700",
      logPath: "/tmp/openclaw-handoff.log",
    });
    const log = { info: vi.fn() };

    await runGatewayUpdateCheck({
      cfg: createBetaAutoUpdateConfig(),
      log,
      isNixMode: false,
      allowInTests: true,
      activeWorkInspectors: idleActiveWorkInspectors(),
    });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(runCommandWithTimeout).not.toHaveBeenCalled();
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({
        root: installOwner,
        timeoutMs: 45 * 60 * 1000,
        restartDrainTimeoutMs: 300_000,
        channel: "beta",
        tag: "2.0.0-beta.1",
        restartDelayMs: 0,
        supervisor: "launchd",
        handoffId: expect.any(String),
        meta: {
          handoffId: expect.any(String),
          note: "background auto-update",
        },
      }),
    );
    const handoffCalls = startManagedServiceUpdateHandoffMock.mock.calls as unknown as Array<
      [
        {
          handoffId?: string;
          meta?: { handoffId?: string };
        },
      ]
    >;
    const [handoffParams] = handoffCalls[0] ?? [];
    expect(handoffParams?.meta?.handoffId).toBe(handoffParams?.handoffId);
    expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledWith({
      delayMs: 0,
      reason: "update.auto",
      skipCooldown: true,
      skipDeferral: true,
    });
    expect(log.info).toHaveBeenCalledWith(
      "update campaign waiting-for-idle",
      expect.objectContaining({
        campaignId: expect.any(String),
        channel: "beta",
        target: "2.0.0-beta.1",
      }),
    );
    expect(log.info).toHaveBeenCalledWith("auto-update handoff started", {
      channel: "beta",
      version: "2.0.0-beta.1",
      tag: "beta",
      forced: false,
      command: "openclaw update --yes --channel beta --tag 2.0.0-beta.1 --timeout 2700",
      logPath: "/tmp/openclaw-handoff.log",
    });
    expect(getUpdateSchedule()?.campaign?.state).toBe("applying");
  });

  it("does not restart after a managed auto-update handoff spawn failure", async () => {
    mockPackageInstallStatus();
    mockNpmChannelTag("beta", "2.0.0-beta.1");
    detectRespawnSupervisorMock.mockReturnValue("launchd");
    startManagedServiceUpdateHandoffMock.mockRejectedValueOnce(
      Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
    );
    const log = { info: vi.fn() };

    await runGatewayUpdateCheck({
      cfg: createBetaAutoUpdateConfig(),
      log,
      isNixMode: false,
      allowInTests: true,
      activeWorkInspectors: idleActiveWorkInspectors(),
    });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith("auto-update attempt failed", {
      channel: "beta",
      version: "2.0.0-beta.1",
      tag: "beta",
      forced: false,
      reason: "Error: spawn ENOENT",
    });
    expect(log.info).toHaveBeenCalledWith(
      "update campaign ended",
      expect.objectContaining({
        campaignId: expect.any(String),
        channel: "beta",
      }),
    );
    expect(getUpdateSchedule()?.campaign).toBeUndefined();
  });

  it("does not schedule another restart when auto-update joins an active handoff", async () => {
    mockPackageInstallStatus();
    mockNpmChannelTag("beta", "2.0.0-beta.1");
    detectRespawnSupervisorMock.mockReturnValue("launchd");
    startManagedServiceUpdateHandoffMock.mockResolvedValueOnce({
      status: "joined",
      pid: 12345,
      command: "openclaw update --yes --channel beta --timeout 2700",
      logPath: "/tmp/openclaw-handoff.log",
      handoffId: "handoff-existing",
    });

    await runAutoUpdateCheckWithDefaults({
      cfg: createBetaAutoUpdateConfig(),
    });

    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
  });

  it("uses managed systemd handoff for Linux gateway service auto-updates", async () => {
    mockPackageInstallStatus();
    mockNpmChannelTag("beta", "2.0.0-beta.1");
    detectRespawnSupervisorMock.mockReturnValue("systemd");

    await runAutoUpdateCheckWithDefaults({
      cfg: createBetaAutoUpdateConfig(),
    });

    expect(runCommandWithTimeout).not.toHaveBeenCalled();
    expect(detectRespawnSupervisorMock).toHaveBeenCalledWith(process.env, process.platform, {
      includeLinuxOpenClawGatewayServiceMarker: true,
    });
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({
        root: "/opt/openclaw",
        timeoutMs: 45 * 60 * 1000,
        channel: "beta",
        tag: "2.0.0-beta.1",
        restartDelayMs: 2000,
        supervisor: "systemd",
      }),
    );
    expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledWith({
      delayMs: 2000,
      reason: "update.auto",
      skipCooldown: true,
      skipDeferral: true,
    });
  });

  it("scheduleGatewayUpdateCheck returns a cleanup function", () => {
    mockPackageUpdateStatus("latest", "2.0.0");

    const stop = scheduleGatewayUpdateCheck({
      cfg: { update: { channel: "stable" } },
      log: { info: vi.fn() },
      isNixMode: false,
    });
    stop();
  });

  it("schedules an initial and recurring 24-hour extended-stable hint check with cleanup", async () => {
    mockPackageUpdateStatus("extended-stable", "2.0.0");
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const stop = scheduleGatewayUpdateCheck({
      cfg: { update: { channel: "extended-stable" } },
      log: { info: vi.fn() },
      isNixMode: false,
    });

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(resolveNpmChannelTag).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(resolveNpmChannelTag).toHaveBeenCalledTimes(2);

      stop();
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(resolveNpmChannelTag).toHaveBeenCalledTimes(2);
    } finally {
      stop();
      process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it("does not schedule extended-stable polling when checkOnStart is false", async () => {
    const stop = scheduleGatewayUpdateCheck({
      cfg: { update: { channel: "extended-stable", checkOnStart: false } },
      log: { info: vi.fn() },
      isNixMode: false,
    });

    await vi.advanceTimersByTimeAsync(48 * 60 * 60 * 1000);

    expect(resolveOpenClawPackageRoot).not.toHaveBeenCalled();
    expect(checkUpdateStatus).not.toHaveBeenCalled();
    expect(resolveNpmChannelTag).not.toHaveBeenCalled();
    stop();
  });

  it("refreshes the remote catalog every six hours and stops with gateway cleanup", async () => {
    const stop = scheduleGatewayUpdateCheck({
      cfg: { update: { channel: "extended-stable", checkOnStart: false } },
      log: { info: vi.fn() },
      isNixMode: false,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(refreshRemoteModelCatalogMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
    expect(refreshRemoteModelCatalogMock).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
    expect(refreshRemoteModelCatalogMock).toHaveBeenCalledTimes(2);
  });

  it("aborts an in-flight remote catalog refresh during cleanup", async () => {
    let capturedSignal: AbortSignal | undefined;
    refreshRemoteModelCatalogMock.mockImplementationOnce(
      async ({ signal }) =>
        await new Promise((resolve) => {
          capturedSignal = signal;
          signal?.addEventListener(
            "abort",
            () => resolve({ status: "error", error: "aborted", providers: 0, models: 0 }),
            { once: true },
          );
        }),
    );
    const stop = scheduleGatewayUpdateCheck({
      cfg: { update: { channel: "extended-stable", checkOnStart: false } },
      log: { info: vi.fn() },
      isNixMode: false,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(capturedSignal?.aborted).toBe(false);
    stop();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("uses the remaining stored TTL after a fresh startup check", async () => {
    refreshRemoteModelCatalogMock.mockResolvedValueOnce({
      status: "fresh",
      providers: 1,
      models: 1,
      generatedAt: 1_753_500_000_000,
      nextCheckInMs: 1_000,
    });
    const stop = scheduleGatewayUpdateCheck({
      cfg: { update: { channel: "extended-stable", checkOnStart: false } },
      log: { info: vi.fn() },
      isNixMode: false,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(refreshRemoteModelCatalogMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(refreshRemoteModelCatalogMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshRemoteModelCatalogMock).toHaveBeenCalledTimes(2);
    stop();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
