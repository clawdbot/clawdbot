// update.run campaign tests cover failure release and concurrent campaign ownership.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateScheduleState } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RespawnSupervisor } from "../../infra/supervisor-markers.js";
import type { UpdateCampaignController } from "../../infra/update-campaign.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createTempHomeEnv, type TempHomeEnv } from "../../test-utils/temp-home.js";

let ledgerHome: TempHomeEnv | undefined;
beforeEach(async () => {
  ledgerHome = await createTempHomeEnv("openclaw-update-campaign-rpc-");
});
afterEach(async () => {
  await ledgerHome?.restore();
  ledgerHome = undefined;
});

let currentCampaignId: string | undefined;
let updateSchedule: UpdateScheduleState | null;
let updateChannel: "stable" | "beta" | "dev" | null;
const versionMock = vi.hoisted(() => ({ value: "1.0.0" }));
type UpdateCampaignAdoption = ReturnType<UpdateCampaignController["adopt"]>;

const adoptCampaignMock = vi.fn<() => UpdateCampaignAdoption>(() => ({
  status: "adopted",
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
const resolveUpdateInstallSurfaceMock =
  vi.fn<typeof import("../../infra/update-runner.js").resolveUpdateInstallSurface>();
const initializeGatewayUpdateStatusMock =
  vi.fn<typeof import("../../infra/update-startup.js").initializeGatewayUpdateStatus>();
const detectRespawnSupervisorMock = vi.fn<() => RespawnSupervisor | null>();
const startManagedServiceUpdateHandoffMock = vi.fn<
  typeof import("../../infra/update-managed-service-handoff.js").startManagedServiceUpdateHandoff
>(async () => ({
  status: "started" as const,
  pid: 12345,
  command: "openclaw update --yes --timeout 1800",
  logPath: "/tmp/openclaw-update-run-handoff/handoff.log",
  handoffId: "handoff-1",
  installRoot: "/tmp/openclaw",
}));
const transferManagedServiceUpdateHandoffMock = vi.fn<
  typeof import("../../infra/update-managed-service-handoff.js").transferManagedServiceUpdateHandoff
>(async () => true);
const cancelManagedServiceUpdateHandoffMock = vi.fn<
  typeof import("../../infra/update-managed-service-handoff.js").cancelManagedServiceUpdateHandoff
>(async () => "restored-in-process");
const scheduleGatewaySigusr1RestartMock = vi.fn(() => ({ scheduled: true }));
const logGatewayInfoMock = vi.fn();
const writeRestartSentinelMock = vi.fn(async () => undefined);
const recordLatestUpdateRestartSentinelMock = vi.fn();

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

vi.mock("../../infra/package-json.js", () => ({
  readPackageVersion: async () => "1.0.0",
}));

vi.mock("../../infra/restart-sentinel.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/restart-sentinel.js")>(
    "../../infra/restart-sentinel.js",
  );
  return {
    ...actual,
    writeRestartSentinel: writeRestartSentinelMock,
  };
});

vi.mock("../../infra/restart.js", async () => ({
  ...(await vi.importActual<typeof import("../../infra/restart.js")>("../../infra/restart.js")),
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
  transferManagedServiceUpdateHandoff: transferManagedServiceUpdateHandoffMock,
  cancelManagedServiceUpdateHandoff: cancelManagedServiceUpdateHandoffMock,
}));

vi.mock("../../infra/update-post-core-finalize.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/update-post-core-finalize.js")>(
    "../../infra/update-post-core-finalize.js",
  );
  return {
    ...actual,
    foldPostCoreFinalizeIntoResult: (result: UpdateRunResult) => result,
    runPostCoreFinalizeAfterGatewayUpdate: async () => ({
      status: "skipped" as const,
      reason: "not-git-update",
    }),
  };
});

vi.mock("../../infra/update-runner.js", () => ({
  resolveUpdateInstallSurface: resolveUpdateInstallSurfaceMock,
  runGatewayUpdate: runGatewayUpdateMock,
  runGatewayUpdatePreflight: runGatewayUpdatePreflightMock,
}));

vi.mock("../../infra/update-startup.js", () => ({
  getUpdateAvailable: () => null,
  getUpdateSchedule: () => updateSchedule,
  initializeGatewayUpdateStatus: initializeGatewayUpdateStatusMock,
}));

vi.mock("../../version.js", () => ({
  get VERSION() {
    return versionMock.value;
  },
}));

vi.mock("../server-restart-sentinel.js", () => ({
  getLatestUpdateRestartSentinel: () => null,
  recordLatestUpdateRestartSentinel: recordLatestUpdateRestartSentinelMock,
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
    status: "adopted",
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
  initializeGatewayUpdateStatusMock.mockReset();
  initializeGatewayUpdateStatusMock.mockResolvedValue({
    root: "/tmp/openclaw",
    status: { root: "/tmp/openclaw", installKind: "git", packageManager: "pnpm" },
    installReceipt: null,
  });
  detectRespawnSupervisorMock.mockReset();
  detectRespawnSupervisorMock.mockReturnValue(null);
  startManagedServiceUpdateHandoffMock.mockClear();
  transferManagedServiceUpdateHandoffMock.mockReset().mockResolvedValue(true);
  cancelManagedServiceUpdateHandoffMock.mockReset().mockResolvedValue("restored-in-process");
  scheduleGatewaySigusr1RestartMock.mockClear();
  logGatewayInfoMock.mockClear();
  writeRestartSentinelMock.mockClear();
  recordLatestUpdateRestartSentinelMock.mockClear();
});

function setDevCampaignSchedule(upstreamSha = "frozen-upstream-sha"): void {
  updateChannel = "dev";
  adoptCampaignMock.mockReturnValue({
    status: "adopted",
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

function mockGitInstallStatus(upstreamSha: string, upstreamRef = "origin/main"): void {
  const root = "/tmp/openclaw";
  initializeGatewayUpdateStatusMock.mockResolvedValueOnce({
    root,
    status: {
      root,
      installKind: "git",
      packageManager: "pnpm",
      git: {
        root,
        sha: "0".repeat(40),
        tag: null,
        branch: "main",
        upstream: upstreamRef,
        upstreamSha,
        dirty: false,
        ahead: 0,
        behind: 1,
        fetchOk: true,
      },
    },
    installReceipt: null,
  });
}

function mockPackageInstallSurface(kind: "global" | "package-root"): void {
  const root = "/tmp/openclaw";
  initializeGatewayUpdateStatusMock.mockResolvedValueOnce({
    root,
    status: { root, installKind: "package", packageManager: "npm" },
    installReceipt: null,
  });
  resolveUpdateInstallSurfaceMock.mockResolvedValueOnce(
    kind === "global"
      ? { kind, mode: "npm", root, packageRoot: root }
      : { kind, mode: "unknown", root, packageRoot: root },
  );
}

async function invokeUpdateRun(
  params: Record<string, unknown> = {},
  respond: (ok: boolean, response?: unknown) => void = () => undefined,
): Promise<void> {
  const { updateHandlers } = await import("./update.js");
  await expectDefined(
    updateHandlers["update.run"],
    'updateHandlers["update.run"] test invariant',
  )({
    params,
    respond,
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

async function captureUpdateRun(params: Record<string, unknown>) {
  let response: { ok?: boolean; result?: { status?: string; reason?: string } } | undefined;
  await invokeUpdateRun(params, (_ok, payload) => {
    response = payload as typeof response;
  });
  return response;
}

function expectNoUpdateMutation(): void {
  expect(runGatewayUpdatePreflightMock).not.toHaveBeenCalled();
  expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
  expect(runGatewayUpdateMock).not.toHaveBeenCalled();
  expect(writeRestartSentinelMock).not.toHaveBeenCalled();
  expect(recordLatestUpdateRestartSentinelMock).not.toHaveBeenCalled();
}

describe("update.run campaign ownership", () => {
  it("pins a directly applied package campaign to its announced version", async () => {
    updateChannel = "beta";
    mockPackageInstallSurface("package-root");

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
    mockPackageInstallSurface("global");

    await withEnvAsync({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, invokeUpdateRun);

    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "beta", tag: "2.0.0" }),
    );
  });

  it("keeps a configless extended-stable package install on that channel", async () => {
    versionMock.value = "2026.6.33";
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
    mockPackageInstallSurface("global");

    await withEnvAsync({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, invokeUpdateRun);

    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "extended-stable" }),
    );
  });

  it("keeps a plain package update on the moving configured channel", async () => {
    updateChannel = "beta";
    adoptCampaignMock.mockReturnValueOnce({ status: "absent" });
    mockPackageInstallSurface("package-root");

    await invokeUpdateRun();

    expect(runGatewayUpdateMock).toHaveBeenCalledWith(expect.objectContaining({ channel: "beta" }));
    expect(runGatewayUpdateMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ tag: expect.anything() }),
    );
  });

  it("uses the prepared Git checkout instead of process artifacts", async () => {
    adoptCampaignMock.mockReturnValueOnce({ status: "absent" });
    initializeGatewayUpdateStatusMock.mockResolvedValueOnce({
      root: "/tmp/openclaw-source",
      status: {
        root: "/tmp/openclaw-source",
        installKind: "git",
        packageManager: "pnpm",
      },
      installReceipt: null,
    });
    resolveUpdateInstallSurfaceMock.mockImplementationOnce(async ({ root, installKind }) =>
      root === "/tmp/openclaw-source" && installKind === "git"
        ? { kind: "git", mode: "git", root, packageRoot: root }
        : {
            kind: "global",
            mode: "npm",
            root: "/tmp/openclaw-launcher-package",
            packageRoot: "/tmp/openclaw-launcher-package",
          },
    );
    runGatewayUpdateMock.mockResolvedValueOnce({
      status: "ok",
      mode: "git",
      root: "/tmp/openclaw-source",
      steps: [],
      durationMs: 100,
    });

    await invokeUpdateRun();

    expect(runGatewayUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp/openclaw-source" }),
    );
    expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
  });

  it("rejects a missing prepared root without scanning the process working directory", async () => {
    adoptCampaignMock.mockReturnValueOnce({ status: "absent" });
    initializeGatewayUpdateStatusMock.mockResolvedValueOnce({
      root: null,
      status: { root: null, installKind: "unknown", packageManager: "unknown" },
      installReceipt: null,
    });
    resolveUpdateInstallSurfaceMock.mockResolvedValueOnce({ kind: "missing", mode: "unknown" });

    await invokeUpdateRun();

    expect(runGatewayUpdateMock).not.toHaveBeenCalled();
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

  it("rejects an explicit commit that conflicts with the adopted Git campaign before mutation", async () => {
    const campaignSha = "1234567890abcdef1234567890abcdef12345678";
    setDevCampaignSchedule(campaignSha);
    mockGitInstallStatus(campaignSha);
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
    adoptCampaignMock.mockReturnValueOnce({ status: "mismatch" });

    const response = await captureUpdateRun({
      target: {
        kind: "git",
        upstreamRef: "origin/main",
        upstreamSha: "abcdef1234567890abcdef1234567890abcdef12",
      },
    });

    expect(response?.result).toMatchObject({
      status: "error",
      reason: "update-target-campaign-mismatch",
    });
    expectNoUpdateMutation();
    expect(clearCampaignMock).not.toHaveBeenCalled();

    await invokeUpdateRun();

    expect(adoptCampaignMock).toHaveBeenCalledTimes(2);
    expect(runGatewayUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        devTarget: { mode: "tracked", upstreamRef: "origin/main", upstreamSha: campaignSha },
      }),
    );
  });

  it("coalesces an explicit commit matching the adopted Git campaign", async () => {
    const upstreamSha = "1234567890abcdef1234567890abcdef12345678";
    setDevCampaignSchedule(upstreamSha);
    mockGitInstallStatus(upstreamSha);

    await invokeUpdateRun({ target: { kind: "git", upstreamRef: "origin/main", upstreamSha } });

    expect(runGatewayUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        devTarget: { mode: "tracked", upstreamRef: "origin/main", upstreamSha },
      }),
    );
  });

  describe("explicit Git target binding", () => {
    const requestTarget = {
      kind: "git",
      upstreamRef: "origin/main",
      upstreamSha: "1234567890abcdef1234567890abcdef12345678",
    };
    const newerUpstreamSha = "abcdef1234567890abcdef1234567890abcdef12";
    const trackedTarget = {
      mode: "tracked",
      upstreamRef: requestTarget.upstreamRef,
      upstreamSha: requestTarget.upstreamSha,
    };

    beforeEach(() => {
      updateChannel = "dev";
      adoptCampaignMock.mockReturnValue({ status: "absent" });
    });

    it.each([
      { name: "matching", campaignSha: requestTarget.upstreamSha },
      { name: "conflicting", campaignSha: newerUpstreamSha },
    ])(
      "rejects a $name explicit target while its campaign is applying",
      async ({ campaignSha }) => {
        setDevCampaignSchedule(campaignSha);
        mockGitInstallStatus(campaignSha);
        detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
        adoptCampaignMock.mockReturnValueOnce({ status: "applying" });

        const response = await captureUpdateRun({ target: requestTarget });

        expect(response).toMatchObject({
          ok: false,
          result: { status: "error", reason: "update-campaign-applying" },
        });
        expect(adoptCampaignMock).toHaveBeenCalledWith(trackedTarget);
        expectNoUpdateMutation();
        expect(clearCampaignMock).not.toHaveBeenCalled();
      },
    );

    it("keeps the requested commit through managed preflight and handoff after upstream advances", async () => {
      detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
      mockGitInstallStatus(newerUpstreamSha);

      const response = await captureUpdateRun({ target: requestTarget });

      expect(runGatewayUpdatePreflightMock).toHaveBeenCalledWith(
        "/tmp/openclaw",
        undefined,
        trackedTarget,
      );
      expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
        expect.objectContaining({ devTarget: trackedTarget }),
      );
      expect(response?.ok).toBe(true);
    });

    it("passes the requested commit to a direct Git update", async () => {
      mockGitInstallStatus(newerUpstreamSha);

      await invokeUpdateRun({ target: requestTarget });

      expect(runGatewayUpdateMock).toHaveBeenCalledWith(
        expect.objectContaining({ devTarget: trackedTarget }),
      );
    });

    it.each([
      { name: "short SHA", target: { ...requestTarget, upstreamSha: "1234567" } },
      { name: "nonhex SHA", target: { ...requestTarget, upstreamSha: "g".repeat(40) } },
      { name: "unsafe upstream", target: { ...requestTarget, upstreamRef: "origin/main branch" } },
      { name: "wrong kind", target: { ...requestTarget, kind: "package" } },
      { name: "non-object", target: "origin/main" },
    ])("rejects malformed $name before any update mutation", async ({ target }) => {
      detectRespawnSupervisorMock.mockReturnValueOnce("launchd");

      const response = await captureUpdateRun({ target });

      expect(response?.result).toMatchObject({ status: "error", reason: "invalid-update-target" });
      expectNoUpdateMutation();
      expect(adoptCampaignMock).not.toHaveBeenCalled();
    });

    it("rejects a target for another Git upstream before update mutation", async () => {
      detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
      mockGitInstallStatus(newerUpstreamSha, "upstream/main");

      const response = await captureUpdateRun({ target: requestTarget });

      expect(response?.result).toMatchObject({
        status: "error",
        reason: "update-target-upstream-mismatch",
      });
      expectNoUpdateMutation();
      expect(adoptCampaignMock).not.toHaveBeenCalled();
    });

    it("rejects an exact Git target outside the dev channel before update mutation", async () => {
      updateChannel = "stable";
      detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
      mockGitInstallStatus(newerUpstreamSha);

      const response = await captureUpdateRun({ target: requestTarget });

      expect(response?.result).toMatchObject({
        status: "error",
        reason: "unsupported-update-target",
      });
      expectNoUpdateMutation();
      expect(adoptCampaignMock).not.toHaveBeenCalled();
    });

    it("rejects an exact Git target on a package install before update mutation", async () => {
      detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
      mockPackageInstallSurface("global");

      const response = await captureUpdateRun({ target: requestTarget });

      expect(response?.result).toMatchObject({
        status: "error",
        reason: "unsupported-update-target",
      });
      expectNoUpdateMutation();
      expect(adoptCampaignMock).not.toHaveBeenCalled();
    });
  });

  it("does not pin a plain dev update without a campaign", async () => {
    updateChannel = "dev";
    adoptCampaignMock.mockReturnValueOnce({ status: "absent" });

    await invokeUpdateRun();

    expect(runGatewayUpdateMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ devTarget: expect.anything() }),
    );
  });

  it("does not add a pin environment to a non-campaign managed handoff", async () => {
    updateChannel = "dev";
    adoptCampaignMock.mockReturnValueOnce({ status: "absent" });
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");

    await withEnvAsync({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, invokeUpdateRun);

    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ env: expect.anything() }),
    );
  });

  it("records the failure before ending the adopted campaign", async () => {
    let outcomeWhenCampaignEnded: unknown;
    clearCampaignMock.mockImplementationOnce(() => {
      outcomeWhenCampaignEnded = recordLatestUpdateRestartSentinelMock.mock.calls.at(-1)?.[0];
    });
    await invokeUpdateRun();

    expect(adoptCampaignMock).toHaveBeenCalledOnce();
    expect(clearCampaignMock).toHaveBeenCalledOnce();
    expect(outcomeWhenCampaignEnded).toMatchObject({
      kind: "update",
      status: "error",
      stats: { reason: "build-failed" },
    });
    expect(logGatewayInfoMock).toHaveBeenCalledWith("update.run failed; adopted campaign cleared", {
      campaignId: "campaign-1",
    });
  });

  it("continues without an explicit target when no campaign can be adopted", async () => {
    setDevCampaignSchedule();
    adoptCampaignMock.mockReturnValueOnce({ status: "absent" });

    await invokeUpdateRun();

    expect(getCampaignStateMock).not.toHaveBeenCalled();
    expect(clearCampaignMock).not.toHaveBeenCalled();
    expect(runGatewayUpdateMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ devTarget: expect.anything() }),
    );
  });

  it("rejects an untargeted update while a campaign is applying", async () => {
    setDevCampaignSchedule();
    adoptCampaignMock.mockReturnValueOnce({ status: "applying" });

    const response = await captureUpdateRun({});

    expect(response).toMatchObject({
      ok: false,
      result: { status: "error", reason: "update-campaign-applying" },
    });
    expectNoUpdateMutation();
    expect(getCampaignStateMock).not.toHaveBeenCalled();
    expect(clearCampaignMock).not.toHaveBeenCalled();
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
    expect(writeRestartSentinelMock).not.toHaveBeenCalled();
    expect(recordLatestUpdateRestartSentinelMock).not.toHaveBeenCalled();
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
    mockPackageInstallSurface("global");

    await withEnvAsync({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, invokeUpdateRun);

    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledOnce();
    expect(transferManagedServiceUpdateHandoffMock).toHaveBeenCalledExactlyOnceWith({
      kind: "managed-update-handoff",
      handoffId: "handoff-1",
      installRoot: "/tmp/openclaw",
    });
    expect(cancelManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(clearCampaignMock).not.toHaveBeenCalled();
  });
});
