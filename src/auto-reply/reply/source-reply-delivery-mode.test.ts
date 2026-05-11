import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveSourceReplyDeliveryMode,
  resolveSourceReplyVisibilityPolicy,
} from "./source-reply-delivery-mode.js";

const emptyConfig = {} as OpenClawConfig;
const automaticGroupReplyConfig = {
  messages: {
    groupChat: {
      visibleReplies: "automatic",
    },
  },
} as const satisfies OpenClawConfig;
const globalToolOnlyReplyConfig = {
  messages: {
    visibleReplies: "message_tool",
  },
} as const satisfies OpenClawConfig;

function expectPolicyFields(
  policy: ReturnType<typeof resolveSourceReplyVisibilityPolicy>,
  fields: Partial<ReturnType<typeof resolveSourceReplyVisibilityPolicy>>,
): void {
  for (const [key, value] of Object.entries(fields)) {
    expect(policy[key as keyof typeof policy]).toBe(value);
  }
}

describe("resolveSourceReplyDeliveryMode", () => {
  it("defaults groups and channels to message-tool-only delivery", () => {
    expect(resolveSourceReplyDeliveryMode({ cfg: emptyConfig, ctx: { ChatType: "channel" } })).toBe(
      "message_tool_only",
    );
    expect(resolveSourceReplyDeliveryMode({ cfg: emptyConfig, ctx: { ChatType: "group" } })).toBe(
      "message_tool_only",
    );
    expect(resolveSourceReplyDeliveryMode({ cfg: emptyConfig, ctx: { ChatType: "direct" } })).toBe(
      "automatic",
    );
  });

  it("honors config and explicit requested mode", () => {
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: automaticGroupReplyConfig,
        ctx: { ChatType: "group" },
      }),
    ).toBe("automatic");
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: emptyConfig,
        ctx: { ChatType: "channel" },
        requested: "automatic",
      }),
    ).toBe("automatic");
  });

  it("allows message-tool-only delivery for any source chat via global config", () => {
    for (const ChatType of ["direct", "group", "channel"] as const) {
      expect(
        resolveSourceReplyDeliveryMode({ cfg: globalToolOnlyReplyConfig, ctx: { ChatType } }),
      ).toBe("message_tool_only");
    }
  });

  it("allows harnesses to default direct chats to message-tool-only delivery", () => {
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: emptyConfig,
        ctx: { ChatType: "direct" },
        defaultVisibleReplies: "message_tool",
      }),
    ).toBe("message_tool_only");
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: { messages: { visibleReplies: "automatic" } },
        ctx: { ChatType: "direct" },
        defaultVisibleReplies: "message_tool",
      }),
    ).toBe("automatic");
  });

  it("lets group/channel config override the global visible reply mode", () => {
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: {
          messages: {
            visibleReplies: "message_tool",
            groupChat: { visibleReplies: "automatic" },
          },
        },
        ctx: { ChatType: "channel" },
      }),
    ).toBe("automatic");
  });

  it("treats native and authorized text commands as explicit replies in groups", () => {
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: emptyConfig,
        ctx: { ChatType: "group", CommandSource: "native" },
      }),
    ).toBe("automatic");
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: emptyConfig,
        ctx: {
          ChatType: "group",
          CommandSource: "text",
          CommandAuthorized: true,
          CommandBody: "/status",
        },
      }),
    ).toBe("automatic");
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: emptyConfig,
        ctx: {
          ChatType: "group",
          CommandSource: "text",
          CommandAuthorized: false,
          CommandBody: "/status",
        },
      }),
    ).toBe("message_tool_only");
  });

  it("falls back to automatic when message tool is unavailable", () => {
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: emptyConfig,
        ctx: { ChatType: "group" },
        messageToolAvailable: false,
      }),
    ).toBe("automatic");
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: globalToolOnlyReplyConfig,
        ctx: { ChatType: "direct" },
        messageToolAvailable: false,
      }),
    ).toBe("automatic");
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: emptyConfig,
        ctx: { ChatType: "channel" },
        requested: "message_tool_only",
        messageToolAvailable: false,
      }),
    ).toBe("automatic");
  });

  it("keeps message-tool-only delivery when message tool availability is unknown", () => {
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: emptyConfig,
        ctx: { ChatType: "group" },
        messageToolAvailable: true,
      }),
    ).toBe("message_tool_only");
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: emptyConfig,
        ctx: { ChatType: "channel" },
      }),
    ).toBe("message_tool_only");
  });
});

describe("resolveSourceReplyVisibilityPolicy", () => {
  it("allows direct automatic delivery without suppressing typing", () => {
    expectPolicyFields(
      resolveSourceReplyVisibilityPolicy({
        cfg: emptyConfig,
        ctx: { ChatType: "direct" },
        sendPolicy: "allow",
      }),
      {
        sourceReplyDeliveryMode: "automatic",
        sendPolicyDenied: false,
        suppressAutomaticSourceDelivery: false,
        suppressDelivery: false,
        suppressHookUserDelivery: false,
        suppressHookReplyLifecycle: false,
        suppressTyping: false,
        deliverySuppressionReason: "",
      },
    );
  });

  it("suppresses automatic source delivery for default group turns without suppressing typing", () => {
    expectPolicyFields(
      resolveSourceReplyVisibilityPolicy({
        cfg: emptyConfig,
        ctx: { ChatType: "group" },
        sendPolicy: "allow",
      }),
      {
        sourceReplyDeliveryMode: "message_tool_only",
        sendPolicyDenied: false,
        suppressAutomaticSourceDelivery: true,
        suppressDelivery: true,
        suppressHookUserDelivery: true,
        suppressHookReplyLifecycle: false,
        suppressTyping: false,
        deliverySuppressionReason: "sourceReplyDeliveryMode: message_tool_only",
      },
    );
  });

  it("keeps native and authorized text command replies visible in groups", () => {
    for (const ctx of [
      { ChatType: "group", CommandSource: "native" },
      {
        ChatType: "group",
        CommandSource: "text",
        CommandAuthorized: true,
        CommandBody: "/status",
      },
    ] as const) {
      expectPolicyFields(
        resolveSourceReplyVisibilityPolicy({
          cfg: emptyConfig,
          ctx,
          sendPolicy: "allow",
        }),
        {
          sourceReplyDeliveryMode: "automatic",
          suppressAutomaticSourceDelivery: false,
          suppressDelivery: false,
          suppressHookReplyLifecycle: false,
          suppressTyping: false,
        },
      );
    }
  });

  it("keeps configured automatic group delivery visible", () => {
    expectPolicyFields(
      resolveSourceReplyVisibilityPolicy({
        cfg: automaticGroupReplyConfig,
        ctx: { ChatType: "channel" },
        sendPolicy: "allow",
      }),
      {
        sourceReplyDeliveryMode: "automatic",
        suppressAutomaticSourceDelivery: false,
        suppressDelivery: false,
        suppressHookReplyLifecycle: false,
        suppressTyping: false,
      },
    );
  });

  it("supports explicit message-tool-only delivery for direct chats without suppressing typing", () => {
    expectPolicyFields(
      resolveSourceReplyVisibilityPolicy({
        cfg: emptyConfig,
        ctx: { ChatType: "direct" },
        requested: "message_tool_only",
        sendPolicy: "allow",
      }),
      {
        sourceReplyDeliveryMode: "message_tool_only",
        suppressAutomaticSourceDelivery: true,
        suppressDelivery: true,
        suppressHookReplyLifecycle: false,
        suppressTyping: false,
        deliverySuppressionReason: "sourceReplyDeliveryMode: message_tool_only",
      },
    );
  });

  it("lets sendPolicy deny suppress delivery and typing", () => {
    expectPolicyFields(
      resolveSourceReplyVisibilityPolicy({
        cfg: emptyConfig,
        ctx: { ChatType: "group" },
        sendPolicy: "deny",
      }),
      {
        sourceReplyDeliveryMode: "message_tool_only",
        sendPolicyDenied: true,
        suppressDelivery: true,
        suppressHookUserDelivery: true,
        suppressHookReplyLifecycle: true,
        suppressTyping: true,
        deliverySuppressionReason: "sendPolicy: deny",
      },
    );
  });

  it("keeps explicit typing suppression separate from delivery suppression", () => {
    expectPolicyFields(
      resolveSourceReplyVisibilityPolicy({
        cfg: emptyConfig,
        ctx: { ChatType: "direct" },
        sendPolicy: "allow",
        explicitSuppressTyping: true,
      }),
      {
        sourceReplyDeliveryMode: "automatic",
        suppressDelivery: false,
        suppressHookUserDelivery: false,
        suppressHookReplyLifecycle: true,
        suppressTyping: true,
      },
    );
  });

  it("keeps ACP child user delivery suppression separate from source delivery", () => {
    expectPolicyFields(
      resolveSourceReplyVisibilityPolicy({
        cfg: emptyConfig,
        ctx: { ChatType: "direct" },
        sendPolicy: "allow",
        suppressAcpChildUserDelivery: true,
      }),
      {
        sourceReplyDeliveryMode: "automatic",
        suppressDelivery: false,
        suppressHookUserDelivery: true,
        suppressHookReplyLifecycle: true,
        suppressTyping: false,
      },
    );
  });
  it("keeps delivery automatic when message-tool-only mode cannot send visibly", () => {
    expectPolicyFields(
      resolveSourceReplyVisibilityPolicy({
        cfg: emptyConfig,
        ctx: { ChatType: "group" },
        sendPolicy: "allow",
        messageToolAvailable: false,
      }),
      {
        sourceReplyDeliveryMode: "automatic",
        suppressAutomaticSourceDelivery: false,
        suppressDelivery: false,
        suppressHookUserDelivery: false,
        deliverySuppressionReason: "",
      },
    );
    expectPolicyFields(
      resolveSourceReplyVisibilityPolicy({
        cfg: emptyConfig,
        ctx: { ChatType: "channel" },
        requested: "message_tool_only",
        sendPolicy: "allow",
        messageToolAvailable: false,
      }),
      {
        sourceReplyDeliveryMode: "automatic",
        suppressAutomaticSourceDelivery: false,
        suppressDelivery: false,
        deliverySuppressionReason: "",
      },
    );
  });
});
