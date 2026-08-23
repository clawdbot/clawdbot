// Strict cron announcement transport tests cover scheduler-authorized alert delivery.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  OutboundDeliveryError,
  PlatformMessageNotDispatchedError,
} from "../infra/outbound/deliver-types.js";

const mocks = vi.hoisted(() => ({
  resolveDeliveryTarget: vi.fn(),
  deliverOutboundPayloads: vi.fn(),
  resolveAgentOutboundIdentity: vi.fn().mockReturnValue({ kind: "identity" }),
  buildOutboundSessionContext: vi.fn().mockReturnValue({ kind: "session" }),
  createOutboundSendDeps: vi.fn().mockReturnValue({ kind: "deps" }),
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

const { sendCronAnnouncePayloadStrict } = await import("./delivery.js");

describe("sendCronAnnouncePayloadStrict", () => {
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

  it("delivers the payload through the resolved target with strict send settings", async () => {
    await sendCronAnnouncePayloadStrict({
      deps: {} as never,
      cfg: {} as never,
      agentId: "main",
      jobId: "job-1",
      target: { channel: "telegram", to: "123", accountId: "bot-a" },
      payload: { text: "Automation failed" },
      abortSignal: new AbortController().signal,
    });

    expect(mocks.resolveDeliveryTarget).toHaveBeenCalledWith(
      {},
      "main",
      { channel: "telegram", to: "123", accountId: "bot-a" },
      undefined,
    );
    expect(mocks.buildOutboundSessionContext).toHaveBeenCalledWith({
      cfg: {},
      agentId: "main",
      sessionKey: "cron:job-1:failure",
    });
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "123",
        accountId: "bot-a",
        threadId: 42,
        payloads: [{ text: "Automation failed" }],
        bestEffort: false,
      }),
    );
  });

  it("does not begin delivery when target resolution settles after cancellation", async () => {
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
      payload: { text: "Automation failed" },
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

  it.each(["raw-partial", "wrapped-partial", "failed-after-send"] as const)(
    "preserves recipient-reached evidence across a %s failure",
    async (failureKind) => {
      const rejectedChunk = new PlatformMessageNotDispatchedError(
        "second chunk was never dispatched",
        {
          cause: Object.assign(new Error("connect ECONNREFUSED"), {
            code: "ECONNREFUSED",
            syscall: "connect",
          }),
        },
      );
      const firstChunk = { channel: "telegram" as const, messageId: "already-delivered" };
      const deliveryError =
        failureKind === "wrapped-partial"
          ? new OutboundDeliveryError("delivery failed after the first chunk", {
              cause: rejectedChunk,
              results: [firstChunk],
              stage: "platform_send",
            })
          : rejectedChunk;
      mocks.deliverOutboundPayloads.mockImplementationOnce(
        async (params: { onPayloadDeliveryOutcome?: (outcome: unknown) => void }) => {
          if (failureKind === "wrapped-partial") {
            throw deliveryError;
          }
          params.onPayloadDeliveryOutcome?.({
            index: 0,
            status: "failed",
            error: deliveryError,
            sentBeforeError: true,
            stage: "platform_send",
          });
          return failureKind === "raw-partial" ? [firstChunk] : [];
        },
      );
      const onDeliveryAttempt = vi.fn();

      await expect(
        sendCronAnnouncePayloadStrict({
          deps: {} as never,
          cfg: {} as never,
          agentId: "main",
          jobId: "job-1",
          target: { channel: "telegram", to: "123" },
          payload: { text: "Automation failed" },
          abortSignal: new AbortController().signal,
          onDeliveryAttempt,
        }),
      ).rejects.toThrow(deliveryError.message);

      expect(onDeliveryAttempt).toHaveBeenCalledExactlyOnceWith(true);
      expect(mocks.deliverOutboundPayloads).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      name: "target resolution",
      arrange: () =>
        mocks.resolveDeliveryTarget.mockResolvedValueOnce({
          ok: false,
          error: new Error("target unavailable"),
        }),
      error: "target unavailable",
    },
    {
      name: "channel delivery",
      arrange: () => mocks.deliverOutboundPayloads.mockRejectedValueOnce(new Error("send failed")),
      error: "send failed",
    },
  ])("rejects $name failures", async ({ arrange, error }) => {
    arrange();

    await expect(
      sendCronAnnouncePayloadStrict({
        deps: {} as never,
        cfg: {} as never,
        agentId: "main",
        jobId: "job-1",
        target: { channel: "telegram", to: "123" },
        payload: { text: "Automation failed" },
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow(error);
  });
});
