// Update hold tests cover campaign deferral and its validated schedule response.
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

type UpdateScheduleState =
  import("../../../packages/gateway-protocol/src/index.js").UpdateScheduleState;
type UpdateCampaignState = NonNullable<UpdateScheduleState["campaign"]>;

const holdUpdateCampaignMock = vi.hoisted(() => vi.fn(() => false));
const getUpdateCampaignStateMock = vi.hoisted(() =>
  vi.fn<() => UpdateCampaignState | undefined>(() => undefined),
);
const getUpdateScheduleMock = vi.hoisted(() => vi.fn<() => UpdateScheduleState | null>(() => null));

vi.mock("../../infra/update-campaign.js", () => ({
  gatewayUpdateCampaign: {
    adopt: () => undefined,
    getState: getUpdateCampaignStateMock,
    hold: holdUpdateCampaignMock,
  },
}));

vi.mock("../../infra/update-startup.js", () => ({
  getUpdateAvailable: () => null,
  getUpdateSchedule: getUpdateScheduleMock,
}));

vi.mock("./validation.js", () => ({
  assertValidParams: () => true,
}));

beforeEach(() => {
  holdUpdateCampaignMock.mockReset();
  holdUpdateCampaignMock.mockReturnValue(false);
  getUpdateCampaignStateMock.mockReset();
  getUpdateCampaignStateMock.mockReturnValue(undefined);
  getUpdateScheduleMock.mockReset();
  getUpdateScheduleMock.mockReturnValue(null);
});

async function invokeUpdateHold(
  respond: ReturnType<typeof vi.fn>,
  logInfo = vi.fn(),
): Promise<void> {
  const { updateHandlers } = await import("./update.js");
  await expectDefined(
    updateHandlers["update.hold"],
    'updateHandlers["update.hold"] test invariant',
  )({
    params: {},
    respond,
    client: {
      connId: "conn-1",
      clientIp: "127.0.0.1",
      connect: { client: { id: "control-ui" }, device: { id: "device-1" } },
    },
    context: { logGateway: { info: logInfo } },
  } as never);
}

describe("update.hold", () => {
  it("holds the active campaign and returns the updated schedule", async () => {
    holdUpdateCampaignMock.mockReturnValueOnce(true);
    getUpdateScheduleMock.mockReturnValueOnce({
      channel: "beta",
      autoEnabled: true,
      campaign: {
        id: "campaign-1",
        state: "waiting-for-idle",
        announcedAtMs: 1,
        holdUntilMs: 3_600_001,
        forceAtMs: 4_500_001,
        updatedAtMs: 1,
      },
    });
    getUpdateCampaignStateMock
      .mockReturnValueOnce({
        id: "campaign-1",
        state: "waiting-for-idle",
        announcedAtMs: 1,
        forceAtMs: 900_001,
        updatedAtMs: 1,
      })
      .mockReturnValueOnce({
        id: "campaign-1",
        state: "waiting-for-idle",
        announcedAtMs: 1,
        holdUntilMs: 3_600_001,
        forceAtMs: 4_500_001,
        updatedAtMs: 1,
      });
    const respond = vi.fn();
    const logInfo = vi.fn();

    await invokeUpdateHold(respond, logInfo);

    const result = {
      ok: true,
      schedule: expect.objectContaining({
        campaign: expect.objectContaining({ holdUntilMs: 3_600_001 }),
      }),
    };
    expect(holdUpdateCampaignMock).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(true, result);
    expect(logInfo).toHaveBeenCalledWith(
      expect.stringMatching(
        /^update\.hold granted actor=control-ui .*holdUntilMs=3600001 forceAtMs=4500001$/,
      ),
    );
  });

  it("returns ok=false when there is no active campaign", async () => {
    const respond = vi.fn();
    const logInfo = vi.fn();

    await invokeUpdateHold(respond, logInfo);

    expect(holdUpdateCampaignMock).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(true, { ok: false });
    expect(logInfo).toHaveBeenCalledWith(
      expect.stringMatching(/^update\.hold refused actor=control-ui /),
      { reason: "no campaign" },
    );
  });

  it.each([
    {
      name: "an applying campaign",
      campaign: {
        id: "campaign-1",
        state: "applying" as const,
        announcedAtMs: 1,
        forceAtMs: 900_001,
        updatedAtMs: 1,
      },
      reason: "applying",
    },
    {
      name: "an already-held campaign",
      campaign: {
        id: "campaign-1",
        state: "waiting-for-idle" as const,
        announcedAtMs: 1,
        holdUntilMs: 3_600_001,
        forceAtMs: 4_500_001,
        updatedAtMs: 1,
      },
      reason: "already held",
    },
  ])("logs why $name cannot be held", async ({ campaign, reason }) => {
    getUpdateCampaignStateMock.mockReturnValueOnce(campaign);
    const logInfo = vi.fn();

    await invokeUpdateHold(vi.fn(), logInfo);

    expect(logInfo).toHaveBeenCalledWith(
      expect.stringMatching(/^update\.hold refused actor=control-ui /),
      { reason },
    );
  });
});
