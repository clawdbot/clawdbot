import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";

describe("qa channel transport", () => {
  it("creates gateway action config for qa-channel", () => {
    const transport = createQaChannelTransport(createQaBusState());

    expect(
      transport.createGatewayConfig({
        baseUrl: "http://127.0.0.1:43123",
      }),
    ).toEqual({
      channels: {
        "qa-channel": {
          enabled: true,
          baseUrl: "http://127.0.0.1:43123",
          botUserId: "openclaw",
          botDisplayName: "OpenClaw QA",
          allowFrom: ["*"],
          pollTimeoutMs: 250,
        },
      },
      messages: {
        groupChat: {
          mentionPatterns: ["\\b@?openclaw\\b"],
          visibleReplies: "automatic",
        },
      },
    });
  });

  it("builds agent delivery params for qa-channel replies", () => {
    const transport = createQaChannelTransport(createQaBusState());

    expect(transport.buildAgentDelivery({ target: "dm:qa-operator" })).toEqual({
      channel: "qa-channel",
      replyChannel: "qa-channel",
      replyTo: "dm:qa-operator",
    });
  });

  it("waits until the qa-channel default account is running", async () => {
    const transport = createQaChannelTransport(createQaBusState());
    const call = vi
      .fn()
      .mockResolvedValueOnce({
        channelAccounts: {
          "qa-channel": [{ accountId: "default", running: false }],
        },
      })
      .mockResolvedValueOnce({
        channelAccounts: {
          "qa-channel": [{ accountId: "default", running: true, restartPending: false }],
        },
      });

    await transport.waitReady({
      gateway: { call },
      timeoutMs: 2_000,
      pollIntervalMs: 1,
    });

    expect(call).toHaveBeenCalledTimes(2);
  });

  it("surfaces the last reported qa-channel account status on timeout", async () => {
    const transport = createQaChannelTransport(createQaBusState());
    const call = vi.fn().mockResolvedValue({
      channelAccounts: {
        "qa-channel": [{ accountId: "default", running: false, restartPending: true }],
      },
    });

    await expect(
      transport.waitReady({
        gateway: { call },
        timeoutMs: 5,
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow(
      'timed out after 5ms waiting for qa-channel ready; last status: {"accountId":"default","running":false,"restartPending":true}',
    );
  });

  it("surfaces the last probe error on timeout", async () => {
    const transport = createQaChannelTransport(createQaBusState());
    const call = vi.fn().mockRejectedValue(new Error("channels.status exploded"));

    await expect(
      transport.waitReady({
        gateway: { call },
        timeoutMs: 5,
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow("last probe error: channels.status exploded");
  });

  it("inherits the shared normalized message capabilities", async () => {
    const transport = createQaChannelTransport(createQaBusState());

    const inbound = await transport.capabilities.sendInboundMessage({
      accountId: "default",
      conversation: { id: "dm:qa-operator", kind: "direct" },
      senderId: "qa-operator",
      text: "hello from the operator",
    });

    expect(transport.capabilities.getNormalizedMessageState().messages).toHaveLength(1);
    expect(
      await transport.capabilities.readNormalizedMessage({
        messageId: inbound.id,
      }),
    ).toMatchObject({
      id: inbound.id,
      text: "hello from the operator",
    });
  });

  it("inherits the shared failure-aware wait helper", async () => {
    const transport = createQaChannelTransport(createQaBusState());
    let injected = false;

    await expect(
      transport.capabilities.waitForCondition(
        async () => {
          if (!injected) {
            injected = true;
            await transport.capabilities.injectOutboundMessage({
              accountId: "default",
              to: "dm:qa-operator",
              text: "⚠️ agent failed before reply: synthetic failure for wait helper",
            });
          }
          return undefined;
        },
        50,
        10,
      ),
    ).rejects.toThrow("synthetic failure for wait helper");
  });

  it("captures a fresh failure cursor for each wait helper call", async () => {
    const transport = createQaChannelTransport(createQaBusState());

    await transport.capabilities.injectOutboundMessage({
      accountId: "default",
      to: "dm:qa-operator",
      text: "⚠️ agent failed before reply: stale failure should not leak",
    });

    await expect(transport.capabilities.waitForCondition(async () => "ok", 50, 10)).resolves.toBe(
      "ok",
    );
  });
});
