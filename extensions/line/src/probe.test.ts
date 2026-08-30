// LINE probe tests cover identity reporting and allowance enrichment bounds.
import { describe, expect, it, vi } from "vitest";

const { getBotInfoMock, getMessageQuotaMock, getMessageQuotaConsumptionMock } = vi.hoisted(() => ({
  getBotInfoMock: vi.fn(),
  getMessageQuotaMock: vi.fn(),
  getMessageQuotaConsumptionMock: vi.fn(),
}));

vi.mock("@line/bot-sdk", () => ({
  messagingApi: {
    MessagingApiClient: class {
      getBotInfo = getBotInfoMock;
      getMessageQuota = getMessageQuotaMock;
      getMessageQuotaConsumption = getMessageQuotaConsumptionMock;
    },
  },
}));

const { probeLineBot } = await import("./probe.js");

describe("probeLineBot", () => {
  const identity = {
    displayName: "bot",
    userId: "U0",
    basicId: "@bot",
    pictureUrl: undefined,
  };

  it("reports the allowance beside the bot identity", async () => {
    getBotInfoMock.mockResolvedValue(identity);
    getMessageQuotaMock.mockResolvedValue({ type: "limited", value: 200 });
    getMessageQuotaConsumptionMock.mockResolvedValue({ totalUsage: 70 });

    await expect(probeLineBot("token", 5000)).resolves.toMatchObject({
      ok: true,
      quota: { kind: "limited", limit: 200, used: 70 },
    });
  });

  it("stays healthy when the allowance endpoint stalls", async () => {
    // The shared probe timeout covers the whole callback, so an allowance read
    // that never answers must not turn a bot that already identified itself into
    // a failed probe.
    getBotInfoMock.mockResolvedValue(identity);
    getMessageQuotaMock.mockImplementation(() => new Promise(() => {}));
    getMessageQuotaConsumptionMock.mockResolvedValue({ totalUsage: 70 });

    const result = await probeLineBot("token", 300);

    expect(result.ok).toBe(true);
    expect(result.quota).toBeUndefined();
    expect(result.bot?.basicId).toBe("@bot");
  });

  it("reports a failure when the bot identity itself cannot be read", async () => {
    getBotInfoMock.mockRejectedValue(new Error("401 - Unauthorized"));

    await expect(probeLineBot("token", 5000)).resolves.toMatchObject({ ok: false });
  });
});
