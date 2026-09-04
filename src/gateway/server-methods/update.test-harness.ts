import { beforeAll, beforeEach, vi } from "vitest";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../config/types.openclaw.js";
import type { RestartSentinelPayload } from "../../infra/restart-sentinel.js";
import type { RespawnSupervisor } from "../../infra/supervisor-markers.js";
import type { UpdateChannel } from "../../infra/update-channels.js";

export const sentinelState: {
  capturedPayload?: RestartSentinelPayload;
  restartSentinelWriteError: Error | null;
} = { restartSentinelWriteError: null };

export const runGatewayUpdateMock =
  vi.fn<typeof import("../../infra/update-runner.js").runGatewayUpdate>();
export const runGatewayUpdatePreflightMock =
  vi.fn<typeof import("../../infra/update-runner.js").runGatewayUpdatePreflight>();
export const resolveUpdateInstallSurfaceMock =
  vi.fn<typeof import("../../infra/update-runner.js").resolveUpdateInstallSurface>();
export const initializeGatewayUpdateStatusMock =
  vi.fn<typeof import("../../infra/update-startup.js").initializeGatewayUpdateStatus>();
const getLatestUpdateRestartSentinelMock = vi.fn<() => RestartSentinelPayload | null>(() => null);
const refreshLatestUpdateRestartSentinelMock = vi.fn<() => Promise<RestartSentinelPayload | null>>(
  async () => null,
);
export const recordLatestUpdateRestartSentinelMock = vi.fn();
export const isRestartEnabledMock = vi.fn(() => true);
const readPackageVersionMock = vi.fn(async () => "1.0.0");
const versionMock = vi.hoisted(() => ({ value: "1.0.0" }));
export const detectRespawnSupervisorMock = vi.fn<() => RespawnSupervisor | null>(() => null);
export const normalizeUpdateChannelMock = vi.fn((): UpdateChannel | null => null);
export const getUpdateAvailableMock = vi.fn(
  () =>
    null as {
      currentVersion: string;
      latestVersion: string;
      channel: string;
    } | null,
);
const getUpdateScheduleMock = vi.fn<
  () => import("../../../packages/gateway-protocol/src/index.js").UpdateScheduleState | null
>(() => null);
const refreshGatewayUpdateStatusMock = vi.fn(async () => {});
type UpdateCampaignAdoption = ReturnType<
  import("../../infra/update-campaign.js").UpdateCampaignController["adopt"]
>;
export const adoptUpdateCampaignMock = vi.fn<() => UpdateCampaignAdoption>(() => ({
  status: "absent",
}));
export const readConfigFileSnapshotMock = vi.fn<() => Promise<ConfigFileSnapshot>>();
export const startManagedServiceUpdateHandoffMock = vi.fn<
  typeof import("../../infra/update-managed-service-handoff.js").startManagedServiceUpdateHandoff
>(async (params) => ({
  status: "started",
  pid: 12345,
  command: "openclaw update --yes --timeout 1800",
  logPath: "/tmp/openclaw-update-run-handoff/handoff.log",
  handoffId: params?.handoffId ?? "handoff-default",
  installRoot: params?.root ?? "/tmp/openclaw",
}));

export const sendGatewayLifecycleNoticeMock = vi.fn(async () => true);
export const resolveGatewayLifecycleNoticeRouteMock = vi.fn(
  ({
    deliveryContext,
    threadId,
  }: {
    deliveryContext?: { channel?: string; to?: string; accountId?: string };
    threadId?: string;
  }) =>
    deliveryContext?.channel === "slack" && deliveryContext.to
      ? { ...deliveryContext, channel: "slack", to: deliveryContext.to, threadId }
      : undefined,
);
vi.mock("../server-restart-sentinel-notice.js", () => ({
  sendGatewayLifecycleNotice: sendGatewayLifecycleNoticeMock,
  resolveGatewayLifecycleNoticeRoute: resolveGatewayLifecycleNoticeRouteMock,
}));

export const scheduleGatewaySigusr1RestartMock = vi.fn(
  (
    _opts?: Parameters<typeof import("../../infra/restart.js").scheduleGatewaySigusr1Restart>[0],
  ) => ({ scheduled: true }),
);

export const runPostCoreFinalizeAfterGatewayUpdateMock = vi.fn<
  typeof import("../../infra/update-post-core-finalize.js").runPostCoreFinalizeAfterGatewayUpdate
>(async () => ({ status: "skipped", reason: "not-git-update" }));

export type UpdateRunPayload = {
  ok: boolean;
  ackDelivered: boolean;
  result?: { status?: string; reason?: string; mode?: string };
  handoff?: { status?: string; command?: string; message?: string };
  sentinel?: { persisted?: boolean };
  restart?: unknown;
};

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => ({ update: {} }),
  readConfigFileSnapshot: readConfigFileSnapshotMock,
}));

vi.mock("../../config/commands.flags.js", () => ({ isRestartEnabled: isRestartEnabledMock }));

vi.mock("../../config/sessions.js", () => ({
  extractDeliveryInfo: (sessionKey: string | undefined) => {
    if (!sessionKey) {
      return { deliveryContext: undefined, threadId: undefined };
    }
    // Simulate a threaded Slack session
    if (sessionKey.includes(":thread:")) {
      return {
        deliveryContext: { channel: "slack", to: "slack:C0123ABC", accountId: "workspace-1" },
        threadId: "1234567890.123456",
      };
    }
    return {
      deliveryContext: { channel: "webchat", to: "webchat:user-123", accountId: "default" },
      threadId: undefined,
    };
  },
}));

vi.mock("../../infra/restart-sentinel.js", async () => {
  const actual = await vi.importActual("../../infra/restart-sentinel.js");
  return {
    ...(actual as Record<string, unknown>),
    writeRestartSentinel: async (payload: RestartSentinelPayload) => {
      if (sentinelState.restartSentinelWriteError) {
        throw sentinelState.restartSentinelWriteError;
      }
      sentinelState.capturedPayload = payload;
    },
  };
});

vi.mock("../../infra/restart.js", async () => ({
  ...(await vi.importActual<typeof import("../../infra/restart.js")>("../../infra/restart.js")),
  scheduleGatewaySigusr1Restart: scheduleGatewaySigusr1RestartMock,
}));

vi.mock("../../infra/package-json.js", () => ({ readPackageVersion: readPackageVersionMock }));

vi.mock("../../version.js", () => ({
  get VERSION() {
    return versionMock.value;
  },
}));

vi.mock("../../infra/supervisor-markers.js", () => ({
  detectRespawnSupervisor: detectRespawnSupervisorMock,
}));

vi.mock("../../infra/update-channels.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/update-channels.js")>(
    "../../infra/update-channels.js",
  );
  return { ...actual, normalizeUpdateChannel: normalizeUpdateChannelMock };
});

vi.mock("../../infra/update-startup.js", () => ({
  getUpdateAvailable: getUpdateAvailableMock,
  getUpdateSchedule: getUpdateScheduleMock,
  initializeGatewayUpdateStatus: initializeGatewayUpdateStatusMock,
  refreshGatewayUpdateStatus: refreshGatewayUpdateStatusMock,
}));

vi.mock("../../infra/update-campaign.js", () => ({
  gatewayUpdateCampaign: { adopt: adoptUpdateCampaignMock },
}));

vi.mock("../../infra/update-runner.js", () => ({
  resolveUpdateInstallSurface: resolveUpdateInstallSurfaceMock,
  runGatewayUpdate: runGatewayUpdateMock,
  runGatewayUpdatePreflight: runGatewayUpdatePreflightMock,
}));

// Keep the real `foldPostCoreFinalizeIntoResult` so the restart-gate behavior on
// finalize failure is exercised; only stub the subprocess-spawning finalizer.
vi.mock("../../infra/update-post-core-finalize.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/update-post-core-finalize.js")>(
    "../../infra/update-post-core-finalize.js",
  );
  return {
    ...actual,
    runPostCoreFinalizeAfterGatewayUpdate: runPostCoreFinalizeAfterGatewayUpdateMock,
  };
});

vi.mock("../../../packages/gateway-protocol/src/index.js", () => ({
  validateUpdateStatusParams: () => true,
  validateUpdateStatusResult: () => true,
  validateUpdateRunParams: () => true,
}));

vi.mock("../server-restart-sentinel.js", () => ({
  getLatestUpdateRestartSentinel: getLatestUpdateRestartSentinelMock,
  recordLatestUpdateRestartSentinel: recordLatestUpdateRestartSentinelMock,
  refreshLatestUpdateRestartSentinel: refreshLatestUpdateRestartSentinelMock,
}));

vi.mock("./restart-request.js", () => ({
  parseRestartRequestParams: (params: Record<string, unknown>) => ({
    sessionKey: params.sessionKey,
    deliveryContext: params.deliveryContext,
    threadId: params.threadId,
    note: params.note,
    continuationMessage: params.continuationMessage,
    restartDelayMs: params.restartDelayMs,
  }),
}));

vi.mock("../../infra/update-managed-service-handoff.js", async () => ({
  ...(await vi.importActual<typeof import("../../infra/update-managed-service-handoff.js")>(
    "../../infra/update-managed-service-handoff.js",
  )),
  startManagedServiceUpdateHandoff: startManagedServiceUpdateHandoffMock,
}));

vi.mock("./validation.js", () => ({
  assertValidParams: () => true,
}));

beforeAll(async () => {
  await import("./update.js");
});

beforeEach(() => {
  sendGatewayLifecycleNoticeMock.mockReset();
  sendGatewayLifecycleNoticeMock.mockResolvedValue(true);
  resolveGatewayLifecycleNoticeRouteMock.mockClear();
  sentinelState.capturedPayload = undefined;
  sentinelState.restartSentinelWriteError = null;
  isRestartEnabledMock.mockReset();
  isRestartEnabledMock.mockReturnValue(true);
  readPackageVersionMock.mockClear();
  readPackageVersionMock.mockResolvedValue("1.0.0");
  versionMock.value = "1.0.0";
  normalizeUpdateChannelMock.mockReset();
  normalizeUpdateChannelMock.mockReturnValue(null);
  getUpdateAvailableMock.mockReset();
  getUpdateAvailableMock.mockReturnValue(null);
  getUpdateScheduleMock.mockReset();
  getUpdateScheduleMock.mockReturnValue(null);
  adoptUpdateCampaignMock.mockReset();
  adoptUpdateCampaignMock.mockReturnValue({ status: "absent" });
  readConfigFileSnapshotMock.mockReset();
  readConfigFileSnapshotMock.mockResolvedValue({
    path: "/tmp/openclaw.json",
    exists: true,
    raw: "{}",
    parsed: {},
    resolved: {} as OpenClawConfig,
    sourceConfig: {} as OpenClawConfig,
    valid: true,
    config: {} as OpenClawConfig,
    runtimeConfig: {} as OpenClawConfig,
    issues: [],
    warnings: [],
    legacyIssues: [],
  });
  detectRespawnSupervisorMock.mockReset();
  detectRespawnSupervisorMock.mockReturnValue(null);
  runGatewayUpdateMock.mockClear();
  runGatewayUpdateMock.mockResolvedValue({
    status: "ok",
    mode: "npm",
    after: { version: "2.0.0" },
    steps: [],
    durationMs: 100,
  });
  runGatewayUpdatePreflightMock.mockReset();
  runGatewayUpdatePreflightMock.mockResolvedValue(undefined);
  resolveUpdateInstallSurfaceMock.mockReset();
  resolveUpdateInstallSurfaceMock.mockImplementation(async ({ root, installKind }) =>
    root && installKind === "git"
      ? { kind: "git", mode: "git", root, packageRoot: root }
      : root && installKind === "package"
        ? { kind: "package-root", mode: "unknown", root, packageRoot: root }
        : { kind: "missing", mode: "unknown" },
  );
  initializeGatewayUpdateStatusMock.mockReset();
  initializeGatewayUpdateStatusMock.mockResolvedValue({
    root: "/tmp/openclaw",
    status: { root: "/tmp/openclaw", installKind: "git", packageManager: "pnpm" },
    installReceipt: null,
  });
  getLatestUpdateRestartSentinelMock.mockClear();
  refreshLatestUpdateRestartSentinelMock.mockClear();
  refreshLatestUpdateRestartSentinelMock.mockResolvedValue(null);
  recordLatestUpdateRestartSentinelMock.mockClear();
  startManagedServiceUpdateHandoffMock.mockClear();
  startManagedServiceUpdateHandoffMock.mockImplementation(async (params) => ({
    status: "started",
    pid: 12345,
    command: "openclaw update --yes --timeout 1800",
    logPath: "/tmp/openclaw-update-run-handoff/handoff.log",
    handoffId: params?.handoffId ?? "handoff-default",
    installRoot: params?.root ?? "/tmp/openclaw",
  }));
  scheduleGatewaySigusr1RestartMock.mockClear();
  scheduleGatewaySigusr1RestartMock.mockReturnValue({ scheduled: true });
  runPostCoreFinalizeAfterGatewayUpdateMock.mockClear();
  runPostCoreFinalizeAfterGatewayUpdateMock.mockResolvedValue({
    status: "skipped",
    reason: "not-git-update",
  });
});
