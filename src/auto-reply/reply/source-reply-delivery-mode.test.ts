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

  it("treats native commands as explicit replies in groups", () => {
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: emptyConfig,
        ctx: { ChatType: "group", CommandSource: "native" },
      }),
    ).toBe("automatic");
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
    expect(
      resolveSourceReplyVisibilityPolicy({
        cfg: emptyConfig,
        ctx: { ChatType: "direct" },
        sendPolicy: "allow",
      }),
    ).toMatchObject({
      sourceReplyDeliveryMode: "automatic",
      sendPolicyDenied: false,
      suppressAutomaticSourceDelivery: false,
      suppressDelivery: false,
      suppressHookUserDelivery: false,
      suppressHookReplyLifecycle: false,
      suppressTyping: false,
      deliverySuppressionReason: "",
    });
  });

  it("suppresses automatic source delivery for default group turns without suppressing typing", () => {
    expect(
      resolveSourceReplyVisibilityPolicy({
        cfg: emptyConfig,
        ctx: { ChatType: "group" },
        sendPolicy: "allow",
      }),
    ).toMatchObject({
      sourceReplyDeliveryMode: "message_tool_only",
      sendPolicyDenied: false,
      suppressAutomaticSourceDelivery: true,
      suppressDelivery: true,
      suppressHookUserDelivery: true,
      suppressHookReplyLifecycle: false,
      suppressTyping: false,
      deliverySuppressionReason: "sourceReplyDeliveryMode: message_tool_only",
    });
  });

  it("keeps native command replies visible in groups", () => {
    expect(
      resolveSourceReplyVisibilityPolicy({
        cfg: emptyConfig,
        ctx: { ChatType: "group", CommandSource: "native" },
        sendPolicy: "allow",
      }),
    ).toMatchObject({
      sourceReplyDeliveryMode: "automatic",
      suppressAutomaticSourceDelivery: false,
      suppressDelivery: false,
      suppressHookReplyLifecycle: false,
      suppressTyping: false,
    });
  });

  it("keeps configured automatic group delivery visible", () => {
    expect(
      resolveSourceReplyVisibilityPolicy({
        cfg: automaticGroupReplyConfig,
        ctx: { ChatType: "channel" },
        sendPolicy: "allow",
      }),
    ).toMatchObject({
      sourceReplyDeliveryMode: "automatic",
      suppressAutomaticSourceDelivery: false,
      suppressDelivery: false,
      suppressHookReplyLifecycle: false,
      suppressTyping: false,
    });
  });

  it("supports explicit message-tool-only delivery for direct chats without suppressing typing", () => {
    expect(
      resolveSourceReplyVisibilityPolicy({
        cfg: emptyConfig,
        ctx: { ChatType: "direct" },
        requested: "message_tool_only",
        sendPolicy: "allow",
      }),
    ).toMatchObject({
      sourceReplyDeliveryMode: "message_tool_only",
      suppressAutomaticSourceDelivery: true,
      suppressDelivery: true,
      suppressHookReplyLifecycle: false,
      suppressTyping: false,
      deliverySuppressionReason: "sourceReplyDeliveryMode: message_tool_only",
    });
  });

  it("lets sendPolicy deny suppress delivery and typing", () => {
    expect(
      resolveSourceReplyVisibilityPolicy({
        cfg: emptyConfig,
        ctx: { ChatType: "group" },
        sendPolicy: "deny",
      }),
    ).toMatchObject({
      sourceReplyDeliveryMode: "message_tool_only",
      sendPolicyDenied: true,
      suppressDelivery: true,
      suppressHookUserDelivery: true,
      suppressHookReplyLifecycle: true,
      suppressTyping: true,
      deliverySuppressionReason: "sendPolicy: deny",
    });
  });

  it("keeps explicit typing suppression separate from delivery suppression", () => {
    expect(
      resolveSourceReplyVisibilityPolicy({
        cfg: emptyConfig,
        ctx: { ChatType: "direct" },
        sendPolicy: "allow",
        explicitSuppressTyping: true,
      }),
    ).toMatchObject({
      sourceReplyDeliveryMode: "automatic",
      suppressDelivery: false,
      suppressHookUserDelivery: false,
      suppressHookReplyLifecycle: true,
      suppressTyping: true,
    });
  });

  it("keeps ACP child user delivery suppression separate from source delivery", () => {
    expect(
      resolveSourceReplyVisibilityPolicy({
        cfg: emptyConfig,
        ctx: { ChatType: "direct" },
        sendPolicy: "allow",
        suppressAcpChildUserDelivery: true,
      }),
    ).toMatchObject({
      sourceReplyDeliveryMode: "automatic",
      suppressDelivery: false,
      suppressHookUserDelivery: true,
      suppressHookReplyLifecycle: true,
      suppressTyping: false,
    });
  });
  it("keeps delivery automatic when message-tool-only mode cannot send visibly", () => {
    expect(
      resolveSourceReplyVisibilityPolicy({
        cfg: emptyConfig,
        ctx: { ChatType: "group" },
        sendPolicy: "allow",
        messageToolAvailable: false,
      }),
    ).toMatchObject({
      sourceReplyDeliveryMode: "automatic",
      suppressAutomaticSourceDelivery: false,
      suppressDelivery: false,
      suppressHookUserDelivery: false,
      deliverySuppressionReason: "",
    });
    expect(
      resolveSourceReplyVisibilityPolicy({
        cfg: emptyConfig,
        ctx: { ChatType: "channel" },
        requested: "message_tool_only",
        sendPolicy: "allow",
        messageToolAvailable: false,
      }),
    ).toMatchObject({
      sourceReplyDeliveryMode: "automatic",
      suppressAutomaticSourceDelivery: false,
      suppressDelivery: false,
      deliverySuppressionReason: "",
    });
  });
});
