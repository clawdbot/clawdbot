// Line tests cover probe plugin behavior.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { getBotInfoMock, getWebhookEndpointMock, MessagingApiClientMock } = vi.hoisted(() => {
  const getBotInfo = vi.fn();
  const getWebhookEndpoint = vi.fn();
  return {
    getBotInfoMock: getBotInfo,
    getWebhookEndpointMock: getWebhookEndpoint,
    MessagingApiClientMock: vi.fn(function () {
      return { getBotInfo, getWebhookEndpoint };
    }),
  };
});

vi.mock("@line/bot-sdk", () => ({
  messagingApi: { MessagingApiClient: MessagingApiClientMock },
}));

let probeModule: typeof import("./probe.js");

describe("probeLineBot", () => {
  beforeAll(async () => {
    probeModule = await import("./probe.js");
  });

  afterAll(() => {
    vi.doUnmock("@line/bot-sdk");
    vi.resetModules();
  });

  beforeEach(() => {
    getBotInfoMock.mockReset();
    getWebhookEndpointMock.mockReset();
    getBotInfoMock.mockResolvedValue({ displayName: "Bot", userId: "U1", basicId: "@bot" });
  });

  it.each([
    { active: true, expected: "active" },
    { active: false, expected: "disabled" },
  ] as const)(
    "reports a registered webhook that is active=$active",
    async ({ active, expected }) => {
      getWebhookEndpointMock.mockResolvedValue({
        endpoint: "https://gateway.example/line/webhook",
        active,
      });

      const result = await probeLineBotUnderTest();

      // LINE returns the registered URL; the probe deliberately does not carry it,
      // because it would then reach logs and status output with no action to take on it.
      expect(result.webhook).toEqual({ status: expected });
    },
  );

  it("reports an unregistered webhook when LINE answers 404", async () => {
    getWebhookEndpointMock.mockRejectedValue(
      Object.assign(new Error("Not found"), { status: 404 }),
    );

    expect((await probeLineBotUnderTest()).webhook).toEqual({ status: "unset" });
  });

  // Any other failure is not evidence about the webhook, so the probe stays silent
  // rather than letting status claim the webhook is either fine or broken.
  it("leaves the webhook unreported when the endpoint call fails for another reason", async () => {
    getWebhookEndpointMock.mockRejectedValue(Object.assign(new Error("nope"), { status: 500 }));

    const result = await probeLineBotUnderTest();

    expect(result.ok).toBe(true);
    expect(result.webhook).toBeUndefined();
  });

  // The webhook lookup is an optional extra inside the probe's deadline. If it could
  // spend that deadline, a healthy token would be reported as a broken channel.
  it("does not let a webhook lookup that never settles fail the probe", async () => {
    vi.useFakeTimers();
    getWebhookEndpointMock.mockReturnValue(new Promise(() => {}));
    try {
      const pending = probeLineBotUnderTest();
      await vi.advanceTimersByTimeAsync(6000);
      const result = await pending;

      expect(result.ok).toBe(true);
      expect(result.webhook).toBeUndefined();
      expect(result.bot?.userId).toBe("U1");
    } finally {
      vi.useRealTimers();
    }
  });

  // The outer deadline is already running when the lookup starts. Given the exact
  // remainder it would come due on the same tick as the outer timer, and whichever
  // fires first decides whether a healthy identity result is reported as a failure.
  // Only a slow identity call reaches that tie, so the hanging-lookup case above
  // cannot cover it.
  it("keeps the probe healthy when the identity call already spent most of the deadline", async () => {
    vi.useFakeTimers();
    getBotInfoMock.mockImplementation(
      async () =>
        await new Promise((resolve) => {
          setTimeout(() => {
            resolve({ displayName: "Bot", userId: "U1", basicId: "@bot" });
          }, 4000);
        }),
    );
    getWebhookEndpointMock.mockReturnValue(new Promise(() => {}));
    try {
      const pending = probeLineBotUnderTest();
      await vi.advanceTimersByTimeAsync(6000);
      const result = await pending;

      expect(result.ok).toBe(true);
      expect(result.webhook).toBeUndefined();
      expect(result.bot?.userId).toBe("U1");
    } finally {
      vi.useRealTimers();
    }
  });

  // The early return is load-bearing, not defensive: withTimeout treats a budget of 0 or
  // less as "no timeout at all", so without it a lookup started with no time left would
  // wait forever and spend the outer deadline — the same inversion the margin prevents.
  it("skips the webhook lookup when the identity call left no room for it", async () => {
    vi.useFakeTimers();
    getBotInfoMock.mockImplementation(
      async () =>
        await new Promise((resolve) => {
          setTimeout(() => {
            resolve({ displayName: "Bot", userId: "U1", basicId: "@bot" });
          }, 4900);
        }),
    );
    getWebhookEndpointMock.mockReturnValue(new Promise(() => {}));
    try {
      const pending = probeLineBotUnderTest();
      await vi.advanceTimersByTimeAsync(6000);
      const result = await pending;

      expect(result.ok).toBe(true);
      expect(result.webhook).toBeUndefined();
      expect(getWebhookEndpointMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still fails the probe when the bot identity call fails", async () => {
    getBotInfoMock.mockRejectedValue(new Error("bad token"));

    const result = await probeLineBotUnderTest();

    expect(result.ok).toBe(false);
    expect(getWebhookEndpointMock).not.toHaveBeenCalled();
  });

  async function probeLineBotUnderTest() {
    return await probeModule.probeLineBot("channel-access-token", 5000);
  }
});
