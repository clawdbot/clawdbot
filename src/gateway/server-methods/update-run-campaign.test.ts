// update.run campaign tests cover failure release and concurrent campaign ownership.
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RespawnSupervisor } from "../../infra/supervisor-markers.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { createDeferred } from "../../test-utils/deferred.js";
import { withEnvAsync } from "../../test-utils/env.js";

let currentCampaignId: string | undefined;
const adoptCampaignMock = vi.fn(() => true);
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
const runGatewayUpdateMock = vi.fn<() => Promise<UpdateRunResult>>();
type UpdateInstallSurface = Awaited<
  ReturnType<typeof import("../../infra/update-runner.js").resolveUpdateInstallSurface>
>;
const resolveUpdateInstallSurfaceMock = vi.fn<() => Promise<UpdateInstallSurface>>();
const detectRespawnSupervisorMock = vi.fn<() => RespawnSupervisor | null>();
const startManagedServiceUpdateHandoffMock = vi.fn(async () => ({
  status: "started" as const,
  pid: 12345,
  command: "openclaw update --yes --timeout 1800",
  logPath: "/tmp/openclaw-update-run-handoff/handoff.log",
  handoffId: "handoff-1",
}));
const scheduleGatewaySigusr1RestartMock = vi.fn(() => ({ scheduled: true }));

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

vi.mock("../../infra/update-channels.js", () => ({
  normalizeUpdateChannel: () => null,
}));

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
}));

vi.mock("../../infra/update-startup.js", () => ({
  getUpdateAvailable: () => null,
  getUpdateSchedule: () => null,
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
  adoptCampaignMock.mockReset();
  adoptCampaignMock.mockReturnValue(true);
  clearCampaignMock.mockClear();
  getCampaignStateMock.mockClear();
  runGatewayUpdateMock.mockReset();
  runGatewayUpdateMock.mockResolvedValue(failedUpdate);
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
});

async function invokeUpdateRun(): Promise<void> {
  const { updateHandlers } = await import("./update.js");
  await expectDefined(
    updateHandlers["update.run"],
    'updateHandlers["update.run"] test invariant',
  )({
    params: {},
    respond: () => undefined,
    context: { getRuntimeConfig: () => ({ update: {} }) as OpenClawConfig },
  } as never);
}

describe("update.run campaign ownership", () => {
  it("clears the campaign adopted by a failed update", async () => {
    await invokeUpdateRun();

    expect(adoptCampaignMock).toHaveBeenCalledOnce();
    expect(clearCampaignMock).toHaveBeenCalledOnce();
  });

  it("does not clear a campaign that update.run did not adopt", async () => {
    adoptCampaignMock.mockReturnValueOnce(false);

    await invokeUpdateRun();

    expect(getCampaignStateMock).not.toHaveBeenCalled();
    expect(clearCampaignMock).not.toHaveBeenCalled();
  });

  it("does not clear a replacement campaign when the adopted update fails", async () => {
    const deferredUpdate = createDeferred<UpdateRunResult>();
    runGatewayUpdateMock.mockReturnValueOnce(deferredUpdate.promise);
    const updateRun = invokeUpdateRun();
    await vi.waitFor(() => {
      expect(adoptCampaignMock).toHaveBeenCalledOnce();
      expect(getCampaignStateMock).toHaveBeenCalledOnce();
      expect(runGatewayUpdateMock).toHaveBeenCalledOnce();
    });
    currentCampaignId = "campaign-2";
    deferredUpdate.resolve(failedUpdate);

    await updateRun;

    expect(getCampaignStateMock).toHaveBeenCalledTimes(2);
    expect(clearCampaignMock).not.toHaveBeenCalled();
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
