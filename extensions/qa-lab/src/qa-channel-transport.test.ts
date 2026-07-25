// Qa Lab tests cover qa channel transport plugin behavior.
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
        visibleReplies: "automatic",
        groupChat: {
          mentionPatterns: ["\\b@?openclaw\\b"],
          visibleReplies: "automatic",
        },
      },
    });
  });

  it("maps declared transport policy without inspecting scenario ids", () => {
    const transport = createQaChannelTransport(createQaBusState(), {
      requireGroupMention: true,
      senderAllowlist: ["driver"],
    });

    expect(transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:43123" })).toMatchObject({
      channels: {
        "qa-channel": {
          allowFrom: ["driver"],
          groupAllowFrom: ["driver"],
          groupPolicy: "allowlist",
          groups: { "*": { requireMention: true } },
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

  it("uses the shared normalized message state", async () => {
    const transport = createQaChannelTransport(createQaBusState());

    const inbound = await transport.sendInbound({
      accountId: "default",
      conversation: { id: "dm:qa-operator", kind: "direct" },
      senderId: "qa-operator",
      text: "hello from the operator",
    });

    expect(transport.state.getSnapshot().messages).toHaveLength(1);
    const message = await transport.state.readMessage({
      messageId: inbound.id,
    });
    if (!message) {
      throw new Error("expected normalized QA message");
    }
    expect(message.id).toBe(inbound.id);
    expect(message.text).toBe("hello from the operator");
  });

  it("implements the portable scenario transport actions", async () => {
    const transport = createQaChannelTransport(createQaBusState());
    const conversation = { id: "alice", kind: "direct" as const };

    await transport.sendInbound({
      conversation,
      senderId: "alice",
      text: "hello",
    });
    await transport.state.addOutboundMessage({
      to: "dm:alice",
      text: "QA-PORTABLE-OK",
    });

    await expect(
      transport.waitForOutbound({ conversation, textIncludes: "QA-PORTABLE-OK" }),
    ).resolves.toMatchObject({ text: "QA-PORTABLE-OK" });
    await transport.reset();
    expect(transport.state.getSnapshot().messages).toEqual([]);
  });

  it("injects native commands with transport metadata", async () => {
    const transport = createQaChannelTransport(createQaBusState());

    await transport.sendNativeCommand({
      command: "stop",
      conversation: { id: "alice", kind: "direct" },
      senderId: "alice",
    });

    const [message] = transport.state.getSnapshot().messages;
    expect(message).toMatchObject({
      text: "/stop",
      nativeCommand: { name: "stop" },
    });
  });

  it("inherits the shared failure-aware wait helper", async () => {
    const transport = createQaChannelTransport(createQaBusState());
    let injected = false;

    await expect(
      transport.waitForCondition(
        async () => {
          if (!injected) {
            injected = true;
            await transport.state.addOutboundMessage({
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

    await transport.state.addOutboundMessage({
      accountId: "default",
      to: "dm:qa-operator",
      text: "⚠️ agent failed before reply: stale failure should not leak",
    });

    await expect(transport.waitForCondition(async () => "ok", 50, 10)).resolves.toBe("ok");
  });

  it("keeps oversized wait helper intervals within the timeout", async () => {
    const transport = createQaChannelTransport(createQaBusState());

    await expect(
      transport.waitForCondition(async () => undefined, 5, Number.MAX_SAFE_INTEGER),
    ).rejects.toThrow("timed out after 5ms");
  });
});
