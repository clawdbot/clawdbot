import type { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { vi } from "vitest";
import type { handleQaInbound } from "./inbound.js";

type HandleQaInboundParams = Parameters<typeof handleQaInbound>[0];

export function createQaInboundParams(
  overrides: {
    accountConfig?: HandleQaInboundParams["account"]["config"];
    message?: Partial<HandleQaInboundParams["message"]>;
  } = {},
): HandleQaInboundParams {
  return {
    channelId: "qa-channel",
    channelLabel: "QA Channel",
    account: {
      accountId: "default",
      enabled: true,
      configured: true,
      baseUrl: "http://127.0.0.1:43123",
      botUserId: "openclaw",
      botDisplayName: "OpenClaw QA",
      pollTimeoutMs: 250,
      config: {
        allowFrom: ["*"],
        ...overrides.accountConfig,
      },
    },
    config: {},
    message: {
      id: "msg-1",
      accountId: "default",
      direction: "inbound",
      conversation: { kind: "direct", id: "alice" },
      senderId: "alice",
      senderName: "Alice",
      text: "ping",
      timestamp: 1_777_000_000_000,
      reactions: [],
      ...overrides.message,
    },
  };
}

export function firstRunAssembledParams(runtime: ReturnType<typeof createPluginRuntimeMock>) {
  const call = vi.mocked(runtime.channel.inbound.dispatch).mock.calls[0];
  if (!call) {
    throw new Error("expected assembled turn call");
  }
  return call[0];
}
