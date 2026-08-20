// update.run campaign tests cover failure release and concurrent campaign ownership.
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateScheduleState } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RespawnSupervisor } from "../../infra/supervisor-markers.js";
import type { UpdateCampaignController } from "../../infra/update-campaign.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { withEnvAsync } from "../../test-utils/env.js";

let currentCampaignId: string | undefined;
let updateSchedule: UpdateScheduleState | null;
let updateChannel: "stable" | "beta" | "dev" | null;
const versionMock = vi.hoisted(() => ({ value: "1.0.0" }));
type UpdateCampaignAdoption = NonNullable<ReturnType<UpdateCampaignController["adopt"]>>;

const adoptCampaignMock = vi.fn<() => UpdateCampaignAdoption | undefined>(() => ({
  campaignId: "campaign-1",
  target: { kind: "package", version: "2.0.0" },
}));
const clearCampaignMock = vi.fn();
const getCampaignStateMock = vi.fn(() =>
  currentCampaignId
    ? {
        id: currentCampaignId,
        state: "applying" as const,
        announcedAtMs: 1,
        forceAtMs: 2,
        updatedAtMs: 1,
      }
    : undefined,
);
const runGatewayUpdateMock =
  vi.fn<typeof import("../../infra/update-runner.js").runGatewayUpdate>();
const runGatewayUpdatePreflightMock =
  vi.fn<typeof import("../../infra/update-runner.js").runGatewayUpdatePreflight>();
type UpdateInstallSurface = Awaited<
  ReturnType<typeof import("../../infra/update-runner.js").resolveUpdateInstallSurface>
>;
const resolveUpdateInstallSurfaceMock = vi.fn<() => Promise<UpdateInstallSurface>>();
const detectRespawnSupervisorMock = vi.fn<() => RespawnSupervisor | null>();
const startManagedServiceUpdateHandoffMock = vi.fn<
  typeof import("../../infra/update-managed-service-handoff.js").startManagedServiceUpdateHandoff
>(async () => ({
  status: "started" as const,
  pid: 12345,
  command: "openclaw update --yes --timeout 1800",
  logPath: "/tmp/openclaw-update-run-handoff/handoff.log",
  handoffId: "handoff-1",
}));
const scheduleGatewaySigusr1RestartMock = vi.fn(() => ({ scheduled: true }));
const logGatewayInfoMock = vi.fn();

vi.mock("../../../packages/gateway-protocol/src/index.js", () => ({
  validateUpdateRunParams: () => true,
}));

vi.mock("../../config/commands.flags.js", () => ({
  isRestartEnabled: () => true,
}));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: async () => ({ valid: false }),
}));

vi.mock("../../config/sessions.js", () => ({
  extractDeliveryInfo: () => ({}),
}));

vi.mock("../../infra/gateway-supervision.js", () => ({
  EXTERNAL_SUPERVISOR_UPDATE_REQUIRED_REASON: "external-supervisor-update-required",
  isGatewayExternallySupervised: () => false,
}));

vi.mock("../../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRoot: async () => "/tmp/openclaw",
}));

vi.mock("../../infra/package-json.js", () => ({
  readPackageVersion: async () => "1.0.0",
}));

vi.mock("../../infra/restart-sentinel.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/restart-sentinel.js")>(
    "../../infra/restart-sentinel.js",
  );
  return {
    ...actual,
    writeRestartSentinel: async () => undefined,
  };
});

vi.mock("../../infra/restart.js", () => ({
  resolveGatewayRestartDeferralTimeoutMs: () => 300_000,
  scheduleGatewaySigusr1Restart: scheduleGatewaySigusr1RestartMock,
}));

vi.mock("../../infra/supervisor-markers.js", () => ({
  detectRespawnSupervisor: detectRespawnSupervisorMock,
}));

vi.mock("../../infra/update-campaign.js", () => ({
  gatewayUpdateCampaign: {
    adopt: adoptCampaignMock,
    clear: clearCampaignMock,
    getState: getCampaignStateMock,
  },
}));

vi.mock("../../infra/update-channels.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/update-channels.js")>(
    "../../infra/update-channels.js",
  );
  return { ...actual, normalizeUpdateChannel: () => updateChannel };
});

vi.mock("../../infra/update-managed-service-handoff.js", () => ({
  buildManagedServiceHandoffUnavailableMessage: () => "handoff unavailable",
  formatManagedServiceUpdateCommand: () => "openclaw update --yes",
  startManagedServiceUpdateHandoff: startManagedServiceUpdateHandoffMock,
}));

vi.mock("../../infra/update-post-core-finalize.js", () => ({
  foldPostCoreFinalizeIntoResult: (result: UpdateRunResult) => result,
  runPostCoreFinalizeAfterGatewayUpdate: async () => ({
    status: "skipped" as const,
    reason: "not-git-update",
  }),
}));

vi.mock("../../infra/update-runner.js", () => ({
  resolveUpdateInstallSurface: resolveUpdateInstallSurfaceMock,
  runGatewayUpdate: runGatewayUpdateMock,
  runGatewayUpdatePreflight: runGatewayUpdatePreflightMock,
}));

vi.mock("../../infra/update-startup.js", () => ({
  getUpdateAvailable: () => null,
  getUpdateSchedule: () => updateSchedule,
}));

vi.mock("../../version.js", () => ({
  get VERSION() {
    return versionMock.value;
  },
}));

vi.mock("../server-restart-sentinel.js", () => ({
  getLatestUpdateRestartSentinel: () => null,
  recordLatestUpdateRestartSentinel: () => undefined,
  refreshLatestUpdateRestartSentinel: async () => null,
}));

vi.mock("./restart-request.js", () => ({
  parseRestartRequestParams: () => ({}),
}));

vi.mock("./validation.js", () => ({
  assertValidParams: () => true,
}));

const failedUpdate: UpdateRunResult = {
  status: "error",
  mode: "git",
  reason: "build-failed",
  steps: [],
  durationMs: 100,
};

beforeEach(() => {
  currentCampaignId = "campaign-1";
  updateSchedule = null;
  updateChannel = null;
  versionMock.value = "1.0.0";
  adoptCampaignMock.mockReset();
  adoptCampaignMock.mockReturnValue({
    campaignId: "campaign-1",
    target: { kind: "package", version: "2.0.0" },
  });
  clearCampaignMock.mockClear();
  getCampaignStateMock.mockClear();
  runGatewayUpdateMock.mockReset();
  runGatewayUpdateMock.mockResolvedValue(failedUpdate);
  runGatewayUpdatePreflightMock.mockReset();
  runGatewayUpdatePreflightMock.mockResolvedValue(undefined);
  resolveUpdateInstallSurfaceMock.mockReset();
  resolveUpdateInstallSurfaceMock.mockResolvedValue({
    kind: "git",
    mode: "git",
    root: "/tmp/openclaw",
    packageRoot: "/tmp/openclaw",
  });
  detectRespawnSupervisorMock.mockReset();
  detectRespawnSupervisorMock.mockReturnValue(null);
  startManagedServiceUpdateHandoffMock.mockClear();
  scheduleGatewaySigusr1RestartMock.mockClear();
  logGatewayInfoMock.mockClear();
});

function setDevCampaignSchedule(upstreamSha = "frozen-upstream-sha"): void {
  updateChannel = "dev";
  adoptCampaignMock.mockReturnValue({
    campaignId: "campaign-1",
    target: {
      kind: "git",
      upstreamRef: "origin/main",
      upstreamSha,
      commitsBehind: 3,
    },
  });
  updateSchedule = {
    channel: "dev",
    autoEnabled: true,
    install: { kind: "git" },
    target: {
      kind: "git",
      upstreamRef: "origin/main",
      upstreamSha,
      commitsBehind: 3,
    },
    campaign: {
      id: "campaign-1",
      state: "waiting-for-idle",
      announcedAtMs: 1,
      forceAtMs: 2,
      updatedAtMs: 1,
    },
  };
}

async function invokeUpdateRun(): Promise<void> {
  const { updateHandlers } = await import("./update.js");
  await expectDefined(
    updateHandlers["update.run"],
    'updateHandlers["update.run"] test invariant',
  )({
    params: {},
    respond: () => undefined,
    client: {
      connId: "conn-1",
      clientIp: "127.0.0.1",
      connect: { client: { id: "control-ui" }, device: { id: "device-1" } },
    },
    context: {
      getRuntimeConfig: () => ({ update: {} }) as OpenClawConfig,
      logGateway: { info: logGatewayInfoMock },
    },
  } as never);
}

describe("update.run campaign ownership", () => {
  it("pins a directly applied package campaign to its announced version", async () => {
    updateChannel = "beta";
    resolveUpdateInstallSurfaceMock.mockResolvedValueOnce({
      kind: "package-root",
      mode: "unknown",
      root: "/tmp/openclaw",
      packageRoot: "/tmp/openclaw",
    });

    await invokeUpdateRun();

    expect(runGatewayUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "beta", tag: "2.0.0" }),
    );
    expect(logGatewayInfoMock).toHaveBeenCalledWith(
      expect.stringMatching(/^update\.run adopted campaign campaign-1 actor=control-ui /),
      { target: { kind: "package", version: "2.0.0" } },
    );
  });

  it("pins a managed package campaign handoff to its announced version", async () => {
    updateChannel = "beta";
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
    resolveUpdateInstallSurfaceMock.mockResolvedValueOnce({
      kind: "global",
      mode: "npm",
      root: "/tmp/openclaw",
      packageRoot: "/tmp/openclaw",
    });

    await withEnvAsync({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, invokeUpdateRun);

    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "beta", tag: "2.0.0" }),
    );
  });

  it("keeps a configless extended-stable package install on that channel", async () => {
    versionMock.value = "2026.6.33";
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
    resolveUpdateInstallSurfaceMock.mockResolvedValueOnce({
      kind: "global",
      mode: "npm",
      root: "/tmp/openclaw",
      packageRoot: "/tmp/openclaw",
    });

    await withEnvAsync({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, invokeUpdateRun);

    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "extended-stable" }),
    );
  });

  it("keeps a plain package update on the moving configured channel", async () => {
    updateChannel = "beta";
    adoptCampaignMock.mockReturnValueOnce(undefined);
    resolveUpdateInstallSurfaceMock.mockResolvedValueOnce({
      kind: "package-root",
      mode: "unknown",
      root: "/tmp/openclaw",
      packageRoot: "/tmp/openclaw",
    });

    await invokeUpdateRun();

    expect(runGatewayUpdateMock).toHaveBeenCalledWith(expect.objectContaining({ channel: "beta" }));
    expect(runGatewayUpdateMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ tag: expect.anything() }),
    );
  });

  it("pins a directly applied dev campaign to its announced commit", async () => {
    setDevCampaignSchedule();

    await invokeUpdateRun();

    expect(runGatewayUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "dev",
        devTarget: {
          mode: "tracked",
          upstreamRef: "origin/main",
          upstreamSha: "frozen-upstream-sha",
        },
      }),
    );
  });

  it("pins a managed dev campaign handoff to its announced commit", async () => {
    setDevCampaignSchedule();
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");

    await withEnvAsync({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, invokeUpdateRun);

    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({
        devTarget: {
          mode: "tracked",
          upstreamRef: "origin/main",
          upstreamSha: "frozen-upstream-sha",
        },
      }),
    );
  });

  it("does not pin a plain dev update without a campaign", async () => {
    updateChannel = "dev";
    adoptCampaignMock.mockReturnValueOnce(undefined);

    await invokeUpdateRun();

    expect(runGatewayUpdateMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ devTarget: expect.anything() }),
    );
  });

  it("does not add a pin environment to a non-campaign managed handoff", async () => {
    updateChannel = "dev";
    adoptCampaignMock.mockReturnValueOnce(undefined);
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");

    await withEnvAsync({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, invokeUpdateRun);

    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ env: expect.anything() }),
    );
  });

  it("clears the campaign adopted by a failed update", async () => {
    await invokeUpdateRun();

    expect(adoptCampaignMock).toHaveBeenCalledOnce();
    expect(clearCampaignMock).toHaveBeenCalledOnce();
    expect(logGatewayInfoMock).toHaveBeenCalledWith("update.run failed; adopted campaign cleared", {
      campaignId: "campaign-1",
    });
  });

  it("does not clear a campaign that update.run did not adopt", async () => {
    setDevCampaignSchedule();
    adoptCampaignMock.mockReturnValueOnce(undefined);

    await invokeUpdateRun();

    expect(getCampaignStateMock).not.toHaveBeenCalled();
    expect(clearCampaignMock).not.toHaveBeenCalled();
    expect(runGatewayUpdateMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ devTarget: expect.anything() }),
    );
  });

  it("does not clear a replacement campaign when the adopted update fails", async () => {
    const deferredUpdate = createDeferred<UpdateRunResult>();
    runGatewayUpdateMock.mockReturnValueOnce(deferredUpdate.promise);
    const updateRun = invokeUpdateRun();
    await vi.waitFor(() => {
      expect(adoptCampaignMock).toHaveBeenCalledOnce();
      expect(runGatewayUpdateMock).toHaveBeenCalledOnce();
    });
    expect(getCampaignStateMock).not.toHaveBeenCalled();
    currentCampaignId = "campaign-2";
    deferredUpdate.resolve(failedUpdate);

    await updateRun;

    expect(getCampaignStateMock).toHaveBeenCalledOnce();
    expect(clearCampaignMock).not.toHaveBeenCalled();
    expect(logGatewayInfoMock).not.toHaveBeenCalledWith(
      "update.run failed; adopted campaign cleared",
      expect.anything(),
    );
  });

  it("keeps the adopted campaign while a successful update restarts", async () => {
    runGatewayUpdateMock.mockResolvedValueOnce({
      status: "ok",
      mode: "git",
      steps: [],
      durationMs: 100,
    });

    await invokeUpdateRun();

    expect(clearCampaignMock).not.toHaveBeenCalled();
  });

  it("keeps the adopted campaign after a managed-service handoff starts", async () => {
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
    resolveUpdateInstallSurfaceMock.mockResolvedValueOnce({
      kind: "global",
      mode: "npm",
      root: "/tmp/openclaw",
      packageRoot: "/tmp/openclaw",
    });

    await withEnvAsync({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, invokeUpdateRun);

    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledOnce();
    expect(clearCampaignMock).not.toHaveBeenCalled();
  });
});
