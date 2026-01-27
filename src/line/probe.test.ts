import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
const { getBotInfoMock, MessagingApiClientMock } = vi.hoisted(() => {
  const getBotInfoMock = vi.fn();
  const MessagingApiClientMock = vi.fn(function () {
    return { getBotInfo: getBotInfoMock };
  });
  return { getBotInfoMock, MessagingApiClientMock };
});

vi.mock("@line/bot-sdk", () => ({
  messagingApi: { MessagingApiClient: MessagingApiClientMock },
}));

let probeLineBot: typeof import("./probe.js").probeLineBot;

afterEach(() => {
  vi.useRealTimers();
  getBotInfoMock.mockReset();
});

describe("probeLineBot", () => {
  beforeAll(async () => {
    ({ probeLineBot } = await import("./probe.js"));
  });

  it("returns timeout when bot info stalls", async () => {
    vi.useFakeTimers();
    getBotInfoMock.mockImplementation(() => new Promise(() => {}));

    const probePromise = probeLineBot("token", 10);
    await vi.advanceTimersByTimeAsync(20);
    const result = await probePromise;

    expect(result.ok).toBe(false);
    expect(result.error).toBe("timeout");
  });

  it("returns bot info when available", async () => {
    getBotInfoMock.mockResolvedValue({
      displayName: "Moltbot",
      userId: "U123",
      basicId: "@moltbot",
      pictureUrl: "https://example.com/bot.png",
    });

    const result = await probeLineBot("token", 50);

    expect(result.ok).toBe(true);
    expect(result.bot?.userId).toBe("U123");
  });
});
