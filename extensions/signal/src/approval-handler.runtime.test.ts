import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMocks = vi.hoisted(() => ({
  sendTypingSignal: vi.fn(),
  sendMessageSignal: vi.fn(),
}));

vi.mock("./send.js", () => ({
  sendTypingSignal: sendMocks.sendTypingSignal,
  sendMessageSignal: sendMocks.sendMessageSignal,
}));

const { signalApprovalNativeRuntime } = await import("./approval-handler.runtime.js");

describe("Signal approval native runtime", () => {
  beforeEach(() => {
    sendMocks.sendTypingSignal.mockReset().mockResolvedValue(true);
    sendMocks.sendMessageSignal.mockReset().mockResolvedValue({
      messageId: "1700000000000",
      timestamp: 1700000000000,
      receipt: { parts: [] },
    });
  });

  it("uses the live Signal RPC context when delivering approval prompts", async () => {
    const prepared = await signalApprovalNativeRuntime.transport.prepareTarget({
      plannedTarget: { target: { to: "+15551230000" } },
      accountId: "default",
      context: { baseUrl: "http://127.0.0.1:18080", account: "+15550001111" },
    } as never);

    expect(prepared?.target).toMatchObject({
      to: "+15551230000",
      accountId: "default",
      baseUrl: "http://127.0.0.1:18080",
      account: "+15550001111",
    });

    await signalApprovalNativeRuntime.transport.deliverPending({
      cfg: {},
      preparedTarget: prepared!.target,
      pendingPayload: { text: "approval", allowedDecisions: ["allow-once"] },
    } as never);

    expect(sendMocks.sendTypingSignal).toHaveBeenCalledWith("+15551230000", {
      cfg: {},
      accountId: "default",
      baseUrl: "http://127.0.0.1:18080",
      account: "+15550001111",
    });
    expect(sendMocks.sendMessageSignal).toHaveBeenCalledWith("+15551230000", "approval", {
      cfg: {},
      accountId: "default",
      baseUrl: "http://127.0.0.1:18080",
      account: "+15550001111",
      textMode: "plain",
    });
  });

  it("only renders reaction hints when the Signal target author can be bound", async () => {
    const cfg = { channels: { signal: { allowFrom: ["+15551230000"] } } };
    const unbound = await signalApprovalNativeRuntime.transport.prepareTarget({
      plannedTarget: { target: { to: "+15551230000" } },
      accountId: "default",
      context: { baseUrl: "http://127.0.0.1:18080" },
    } as never);

    await signalApprovalNativeRuntime.transport.deliverPending({
      cfg,
      preparedTarget: unbound!.target,
      pendingPayload: {
        text: "Exec approval required\nID: exec-1\n\nReply with: /approve exec-1 allow-once|deny",
        allowedDecisions: ["allow-once", "deny"],
      },
    } as never);

    expect(sendMocks.sendMessageSignal).toHaveBeenLastCalledWith(
      "+15551230000",
      expect.not.stringContaining("React with:"),
      expect.any(Object),
    );

    const bound = await signalApprovalNativeRuntime.transport.prepareTarget({
      plannedTarget: { target: { to: "+15551230000" } },
      accountId: "default",
      context: { baseUrl: "http://127.0.0.1:18080", account: "+15550001111" },
    } as never);

    await signalApprovalNativeRuntime.transport.deliverPending({
      cfg,
      preparedTarget: bound!.target,
      pendingPayload: {
        text: "Exec approval required\nID: exec-1\n\nReply with: /approve exec-1 allow-once|deny",
        allowedDecisions: ["allow-once", "deny"],
      },
    } as never);

    expect(sendMocks.sendMessageSignal).toHaveBeenLastCalledWith(
      "+15551230000",
      expect.stringContaining("React with:\n\n👍 Allow Once\n👎 Deny"),
      expect.any(Object),
    );
  });
});
