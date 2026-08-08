// Update hold tests cover campaign deferral and its validated schedule response.
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

type UpdateScheduleState =
  import("../../../packages/gateway-protocol/src/index.js").UpdateScheduleState;

const holdUpdateCampaignMock = vi.hoisted(() => vi.fn(() => false));
const getUpdateScheduleMock = vi.hoisted(() => vi.fn<() => UpdateScheduleState | null>(() => null));
const validateUpdateHoldResultMock = vi.hoisted(() => vi.fn(() => true));

vi.mock("../../infra/update-campaign.js", () => ({
  gatewayUpdateCampaign: {
    adopt: () => undefined,
    hold: holdUpdateCampaignMock,
  },
}));

vi.mock("../../infra/update-startup.js", () => ({
  getUpdateAvailable: () => null,
  getUpdateSchedule: getUpdateScheduleMock,
}));

vi.mock("../../../packages/gateway-protocol/src/index.js", () => ({
  validateUpdateHoldParams: () => true,
  validateUpdateHoldResult: validateUpdateHoldResultMock,
  validateUpdateRunParams: () => true,
  validateUpdateStatusParams: () => true,
  validateUpdateStatusResult: () => true,
}));

vi.mock("./validation.js", () => ({
  assertValidParams: () => true,
}));

beforeEach(() => {
  holdUpdateCampaignMock.mockReset();
  holdUpdateCampaignMock.mockReturnValue(false);
  getUpdateScheduleMock.mockReset();
  getUpdateScheduleMock.mockReturnValue(null);
  validateUpdateHoldResultMock.mockClear();
});

async function invokeUpdateHold(respond: ReturnType<typeof vi.fn>) {
  const { updateHandlers } = await import("./update.js");
  await expectDefined(
    updateHandlers["update.hold"],
    'updateHandlers["update.hold"] test invariant',
  )({ params: {}, respond } as never);
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
    const respond = vi.fn();

    await invokeUpdateHold(respond);

    const result = {
      ok: true,
      schedule: expect.objectContaining({
        campaign: expect.objectContaining({ holdUntilMs: 3_600_001 }),
      }),
    };
    expect(holdUpdateCampaignMock).toHaveBeenCalledOnce();
    expect(validateUpdateHoldResultMock).toHaveBeenCalledWith(result);
    expect(respond).toHaveBeenCalledWith(true, result);
  });

  it("returns ok=false when there is no active campaign", async () => {
    const respond = vi.fn();

    await invokeUpdateHold(respond);

    expect(holdUpdateCampaignMock).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(true, { ok: false });
  });
});
