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

  it("waits until the qa-channel default account is connected and ready", async () => {
    const transport = createQaChannelTransport(createQaBusState());
    const statuses = [
      { accountId: "default", connected: false, lifecycle: "stopped", running: false },
      { accountId: "default", connected: false, lifecycle: "starting", running: true },
      { accountId: "default", connected: true, lifecycle: "starting", running: true },
      { accountId: "default", connected: true, lifecycle: "blocked", running: true },
      {
        accountId: "default",
        connected: true,
        lifecycle: "ready",
        restartPending: true,
        running: true,
      },
      {
        accountId: "default",
        connected: true,
        lifecycle: "ready",
        restartPending: false,
        running: true,
      },
    ];
    const call = vi.fn(async () => ({
      channelAccounts: { "qa-channel": [statuses.shift()] },
    }));

    await transport.waitReady({
      gateway: { call },
      timeoutMs: 2_000,
      pollIntervalMs: 1,
    });

    expect(call).toHaveBeenCalledTimes(6);
  });

  it("does not report another running account as the default account", async () => {
    const transport = createQaChannelTransport(createQaBusState());
    const call = vi.fn().mockResolvedValue({
      channelAccounts: {
        "qa-channel": [{ accountId: "other", running: true, restartPending: false }],
      },
    });

    await expect(
      transport.waitReady({ gateway: { call }, timeoutMs: 5, pollIntervalMs: 1 }),
    ).rejects.toThrow('qa-channel account "default" not reported; available accounts: other');
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
      'timed out after 5ms waiting for qa-channel ready; last status: {"accountId":"default","running":false,"connected":null,"lifecycle":null,"restartPending":true,"lastError":null}',
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

  it("keeps outbound verdicts bound to the selected account", async () => {
    const state = createQaBusState();
    const transport = createQaChannelTransport(state);
    const conversation = { id: "alice", kind: "direct" as const };

    state.addOutboundMessage({
      accountId: "other",
      to: "dm:alice",
      text: "QA-ACCOUNT-OK",
    });
    state.addOutboundMessage({
      accountId: "other",
      to: "dm:alice",
      text: "⚠️ agent failed before reply: foreign account failure",
    });
    const expected = state.addOutboundMessage({
      accountId: "default",
      to: "dm:alice",
      text: "QA-ACCOUNT-OK",
    });

    await expect(
      transport.waitForOutbound({ conversation, textIncludes: "QA-ACCOUNT-OK", timeoutMs: 50 }),
    ).resolves.toMatchObject({ accountId: "default", id: expected.id });
  });

  it("does not accept deleted previews as visible outbound replies", async () => {
    const state = createQaBusState();
    const transport = createQaChannelTransport(state);
    const preview = state.addOutboundMessage({
      to: "dm:alice",
      text: "QA-VISIBLE-FINAL-OK",
    });
    state.deleteMessage({ messageId: preview.id });
    const final = state.addOutboundMessage({
      to: "dm:alice",
      text: "QA-VISIBLE-FINAL-OK",
    });

    await expect(
      transport.waitForOutbound({
        conversation: { id: "alice", kind: "direct" },
        textIncludes: "QA-VISIBLE-FINAL-OK",
        timeoutMs: 50,
      }),
    ).resolves.toMatchObject({ id: final.id });
  });

  it("ignores another account's failure while waiting for a condition", async () => {
    const state = createQaBusState();
    const transport = createQaChannelTransport(state);

    await expect(
      transport.waitForCondition(async () => {
        state.addOutboundMessage({
          accountId: "other",
          to: "dm:alice",
          text: "⚠️ agent failed before reply: foreign account failure",
        });
        return "owned condition completed";
      }, 50),
    ).resolves.toBe("owned condition completed");
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
