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

const { sendFailureNotificationAnnounce } = await import("./delivery.js");

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

    expect(mocks.resolveDeliveryTarget).toHaveBeenCalledWith(cfg, "main", {
      channel: "telegram",
      to: "123",
      accountId: "bot-a",
    });
    expect(mocks.buildOutboundSessionContext).toHaveBeenCalledWith({
      cfg,
      agentId: "main",
      sessionKey: "cron:job-1:failure",
    });
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg,
        channel: "telegram",
        to: "123",
        accountId: "bot-a",
        threadId: 42,
        payloads: [{ text: "Cron failed" }],
        session: { kind: "session" },
        identity: { kind: "identity" },
        bestEffort: false,
        deps: { kind: "deps" },
        abortSignal: expect.any(AbortSignal),
      }),
    );
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

    expect(mocks.resolveDeliveryTarget).toHaveBeenCalledWith({} as never, "main", {
      channel: "telegram",
      to: undefined,
      accountId: undefined,
      sessionKey: "agent:main:telegram:direct:123:thread:99",
    });
    expect(mocks.buildOutboundSessionContext).toHaveBeenCalledWith({
      cfg: {},
      agentId: "main",
      sessionKey: "agent:main:telegram:direct:123:thread:99",
    });
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

    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: "send failed",
        channel: "telegram",
        to: "123",
      }),
      "cron: failure destination announce failed",
    );
  });
});
