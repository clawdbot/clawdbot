// Delivery failure notification tests cover alerts emitted after delivery failures.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveDeliveryTarget: vi.fn(),
  deliverOutboundPayloads: vi.fn(),
  resolveAgentOutboundIdentity: vi.fn().mockReturnValue({ kind: "identity" }),
  buildOutboundSessionContext: vi.fn().mockReturnValue({ kind: "session" }),
  createOutboundSendDeps: vi.fn().mockReturnValue({ kind: "deps" }),
  warn: vi.fn(),
}));

vi.mock("./isolated-agent/delivery-target.js", () => ({
  resolveDeliveryTarget: mocks.resolveDeliveryTarget,
}));

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: mocks.deliverOutboundPayloads,
}));

vi.mock("../infra/outbound/identity.js", () => ({
  resolveAgentOutboundIdentity: mocks.resolveAgentOutboundIdentity,
}));

vi.mock("../infra/outbound/session-context.js", () => ({
  buildOutboundSessionContext: mocks.buildOutboundSessionContext,
}));

vi.mock("../cli/outbound-send-deps.js", () => ({
  createOutboundSendDeps: mocks.createOutboundSendDeps,
}));

vi.mock("../logging.js", () => ({
  getChildLogger: vi.fn(() => ({
    warn: mocks.warn,
  })),
}));

const { sendCronAnnouncePayloadStrict, sendFailureNotificationAnnounce } =
  await import("./delivery.js");

type DeliveryRequest = {
  abortSignal?: unknown;
  accountId?: string;
  bestEffort?: boolean;
  cfg?: unknown;
  channel?: string;
  deps?: unknown;
  identity?: unknown;
  payloads?: unknown;
  session?: unknown;
  threadId?: number;
  to?: string;
};

type WarnMeta = { channel?: string; err?: string; to?: string };

function firstDeliveryRequest() {
  const [deliveryRequest] = mocks.deliverOutboundPayloads.mock.calls[0] as [DeliveryRequest];
  return deliveryRequest;
}

function firstWarnCall() {
  return mocks.warn.mock.calls[0] as [WarnMeta, string];
}

describe("sendFailureNotificationAnnounce", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveDeliveryTarget.mockResolvedValue({
      ok: true,
      channel: "telegram",
      to: "123",
      accountId: "bot-a",
      threadId: 42,
      mode: "explicit",
    });
    mocks.deliverOutboundPayloads.mockResolvedValue([{ ok: true }]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers failure alerts to the resolved explicit target with strict send settings", async () => {
    const deps = {} as never;
    const cfg = {} as never;

    await sendFailureNotificationAnnounce(
      deps,
      cfg,
      "main",
      "job-1",
      { channel: "telegram", to: "123", accountId: "bot-a" },
      "Cron failed",
    );

    expect(mocks.resolveDeliveryTarget).toHaveBeenCalledWith(
      cfg,
      "main",
      {
        channel: "telegram",
        to: "123",
        accountId: "bot-a",
      },
      undefined,
    );
    expect(mocks.buildOutboundSessionContext).toHaveBeenCalledWith({
      cfg,
      agentId: "main",
      sessionKey: "cron:job-1:failure",
    });
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    const deliveryRequest = firstDeliveryRequest();
    expect(deliveryRequest.cfg).toBe(cfg);
    expect(deliveryRequest.channel).toBe("telegram");
    expect(deliveryRequest.to).toBe("123");
    expect(deliveryRequest.accountId).toBe("bot-a");
    expect(deliveryRequest.threadId).toBe(42);
    expect(deliveryRequest.payloads).toEqual([{ text: "Cron failed" }]);
    expect(deliveryRequest.session).toEqual({ kind: "session" });
    expect(deliveryRequest.identity).toEqual({ kind: "identity" });
    expect(deliveryRequest.bestEffort).toBe(false);
    expect(deliveryRequest.deps).toEqual({ kind: "deps" });
    expect(deliveryRequest.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("uses sessionKey for delivery-target resolution and outbound context", async () => {
    await sendFailureNotificationAnnounce(
      {} as never,
      {} as never,
      "main",
      "job-1",
      {
        channel: "telegram",
        sessionKey: "agent:main:telegram:direct:123:thread:99",
      },
      "Cron failed",
    );

    expect(mocks.resolveDeliveryTarget).toHaveBeenCalledWith(
      {} as never,
      "main",
      {
        channel: "telegram",
        to: undefined,
        accountId: undefined,
        sessionKey: "agent:main:telegram:direct:123:thread:99",
      },
      undefined,
    );
    expect(mocks.buildOutboundSessionContext).toHaveBeenCalledWith({
      cfg: {},
      agentId: "main",
      sessionKey: "agent:main:telegram:direct:123:thread:99",
    });
  });

  it("can suppress session-thread inheritance for explicit failure destinations", async () => {
    await sendFailureNotificationAnnounce(
      {} as never,
      {} as never,
      "main",
      "job-1",
      {
        channel: "telegram",
        to: "-1001234567890",
        sessionKey: "agent:main:telegram:group:-1001234567890:thread:42",
        inheritSessionThread: false,
      },
      "Cron failed",
    );

    expect(mocks.resolveDeliveryTarget).toHaveBeenCalledWith(
      {},
      "main",
      {
        channel: "telegram",
        to: "-1001234567890",
        accountId: undefined,
        sessionKey: "agent:main:telegram:group:-1001234567890:thread:42",
      },
      { inheritSessionThread: false },
    );
  });

  it("does not begin strict delivery when target resolution settles after cancellation", async () => {
    let resolvePendingTarget: (value: unknown) => void = () => {};
    mocks.resolveDeliveryTarget.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePendingTarget = resolve;
        }),
    );
    const abortController = new AbortController();

    const delivery = sendCronAnnouncePayloadStrict({
      deps: {} as never,
      cfg: {} as never,
      agentId: "main",
      jobId: "job-1",
      target: { channel: "telegram", to: "123" },
      message: "Cron failed",
      abortSignal: abortController.signal,
    });

    abortController.abort(new Error("delivery deadline exceeded"));
    resolvePendingTarget({
      ok: true,
      channel: "telegram",
      to: "123",
      accountId: "bot-a",
      mode: "explicit",
    });

    await expect(delivery).rejects.toThrow("delivery deadline exceeded");
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("does not send when target resolution fails", async () => {
    mocks.resolveDeliveryTarget.mockResolvedValue({
      ok: false,
      error: new Error("target missing"),
    });

    await sendFailureNotificationAnnounce(
      {} as never,
      {} as never,
      "main",
      "job-1",
      { channel: "telegram", to: "123" },
      "Cron failed",
    );

    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledWith(
      { error: "target missing" },
      "cron: failed to resolve failure destination target",
    );
  });

  it("logs thrown target-resolution failures without masking the failed cron run", async () => {
    mocks.resolveDeliveryTarget.mockRejectedValueOnce(new Error("target lookup failed"));

    await expect(
      sendFailureNotificationAnnounce(
        {} as never,
        {} as never,
        "main",
        "job-1",
        { channel: "telegram", to: "123" },
        "Cron failed",
      ),
    ).resolves.toBeUndefined();

    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledWith(
      { err: "target lookup failed", channel: "telegram", to: "123" },
      "cron: failure destination announce failed",
    );
  });

  it("bounds stalled target resolution without starting a late channel send", async () => {
    vi.useFakeTimers();
    let resolvePendingTarget: (value: unknown) => void = () => {};
    mocks.resolveDeliveryTarget.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePendingTarget = resolve;
        }),
    );

    const notification = sendFailureNotificationAnnounce(
      {} as never,
      {} as never,
      "main",
      "job-1",
      { channel: "telegram", to: "123" },
      "Cron failed",
    );

    await vi.advanceTimersByTimeAsync(29_999);
    expect(mocks.warn).not.toHaveBeenCalled();
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(notification).resolves.toBeUndefined();
    expect(mocks.warn).toHaveBeenCalledWith(
      {
        err: "cron: failure destination announcement timed out",
        channel: "telegram",
        to: "123",
      },
      "cron: failure destination announce failed",
    );

    resolvePendingTarget({
      ok: true,
      channel: "telegram",
      to: "123",
      accountId: "bot-a",
      mode: "explicit",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { description: "honors cancellation", honorsCancellation: true },
    { description: "ignores cancellation", honorsCancellation: false },
  ])(
    "bounds a stalled failure notification when its channel $description",
    async ({ honorsCancellation }) => {
      vi.useFakeTimers();
      let deliverySignal: AbortSignal | undefined;
      mocks.deliverOutboundPayloads.mockImplementationOnce(
        ({ abortSignal }: { abortSignal: AbortSignal }) =>
          new Promise<void>((_resolve, reject) => {
            deliverySignal = abortSignal;
            if (honorsCancellation) {
              abortSignal.addEventListener(
                "abort",
                () =>
                  reject(
                    abortSignal.reason instanceof Error
                      ? abortSignal.reason
                      : new Error("failure notification was aborted"),
                  ),
                { once: true },
              );
            }
          }),
      );

      const notification = sendFailureNotificationAnnounce(
        {} as never,
        {} as never,
        "main",
        "job-1",
        { channel: "telegram", to: "123" },
        "Cron failed",
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.deliverOutboundPayloads).toHaveBeenCalledOnce();
      expect(deliverySignal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(29_999);
      expect(deliverySignal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(notification).resolves.toBeUndefined();
      expect(deliverySignal?.aborted).toBe(true);
      expect(mocks.warn).toHaveBeenCalledWith(
        {
          err: "cron: failure destination announcement timed out",
          channel: "telegram",
          to: "123",
        },
        "cron: failure destination announce failed",
      );
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("swallows outbound delivery errors after logging", async () => {
    mocks.deliverOutboundPayloads.mockRejectedValue(new Error("send failed"));

    await expect(
      sendFailureNotificationAnnounce(
        {} as never,
        {} as never,
        "main",
        "job-1",
        { channel: "telegram", to: "123" },
        "Cron failed",
      ),
    ).resolves.toBeUndefined();

    expect(mocks.warn).toHaveBeenCalledTimes(1);
    const [warnMeta, warnMessage] = firstWarnCall();
    expect(warnMeta.err).toBe("send failed");
    expect(warnMeta.channel).toBe("telegram");
    expect(warnMeta.to).toBe("123");
    expect(warnMessage).toBe("cron: failure destination announce failed");
  });
});
