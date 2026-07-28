// Whatsapp tests cover channel outbound plugin behavior.
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { MessagePresentationAction } from "openclaw/plugin-sdk/interactive-runtime";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { whatsappApprovalCapability } from "./approval-native.js";
import { cacheInboundMessageMeta } from "./quoted-message.js";

const hoisted = vi.hoisted(() => ({
  sendMessageWhatsApp: vi.fn(async () => ({ messageId: "wa-1", toJid: "jid" })),
  sendPollWhatsApp: vi.fn(async () => ({ messageId: "poll-1", toJid: "jid" })),
}));

vi.mock("./send.js", () => ({
  sendMessageWhatsApp: hoisted.sendMessageWhatsApp,
  sendPollWhatsApp: hoisted.sendPollWhatsApp,
}));

vi.mock("./runtime.js", () => ({
  getWhatsAppRuntime: () => ({
    logging: {
      shouldLogVerbose: () => false,
    },
  }),
  getOptionalWhatsAppRuntime: () => undefined,
}));

let whatsappChannelOutbound: typeof import("./channel-outbound.js").whatsappChannelOutbound;
let clearWhatsAppApprovalReactionTargetsForTest: typeof import("./approval-reactions.js").clearWhatsAppApprovalReactionTargetsForTest;
let resolveWhatsAppApprovalReactionTargetWithPersistence: typeof import("./approval-reactions.js").resolveWhatsAppApprovalReactionTargetWithPersistence;

type ApprovalAction = Extract<MessagePresentationAction, { type: "approval" }>;

describe("whatsappChannelOutbound", () => {
  beforeAll(async () => {
    ({ whatsappChannelOutbound } = await import("./channel-outbound.js"));
    ({
      clearWhatsAppApprovalReactionTargetsForTest,
      resolveWhatsAppApprovalReactionTargetWithPersistence,
    } = await import("./approval-reactions.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    clearWhatsAppApprovalReactionTargetsForTest();
  });

  it.each([
    {
      approvalKind: "exec" as const,
      approvalId: "plugin:exec-owned-id",
      messageId: "wa-forwarded-exec",
      request: {
        id: "plugin:exec-owned-id",
        request: {
          command: "printf exec",
          agentId: "main",
          allowedDecisions: ["allow-once", "deny"],
        },
        createdAtMs: 1_000,
        expiresAtMs: 61_000,
      } satisfies ExecApprovalRequest,
    },
    {
      approvalKind: "plugin" as const,
      approvalId: "plain-plugin-id",
      messageId: "wa-forwarded-plugin",
      request: {
        id: "plain-plugin-id",
        request: {
          title: "Plugin approval",
          description: "Allow the plugin action",
          allowedDecisions: ["allow-once", "deny"],
        },
        createdAtMs: 1_000,
        expiresAtMs: 61_000,
      } satisfies PluginApprovalRequest,
    },
  ])(
    "binds generic target-mode $approvalKind approvals to actual WhatsApp delivery results",
    async ({ approvalId, approvalKind, messageId, request }) => {
      const renderPresentation = whatsappChannelOutbound.renderPresentation;
      const afterDeliverPayload = whatsappChannelOutbound.afterDeliverPayload;
      const cfg = {
        approvals: {
          [approvalKind]: {
            enabled: true,
            mode: "targets" as const,
            targets: [{ channel: "whatsapp", to: "configured-target" }],
          },
        },
      } as OpenClawConfig;
      const target = {
        channel: "whatsapp",
        to: "configured-target",
        source: "target" as const,
      };
      const payload =
        approvalKind === "exec"
          ? whatsappApprovalCapability.render?.exec?.buildPendingPayload?.({
              cfg,
              request: request as ExecApprovalRequest,
              target,
              nowMs: 1_000,
            })
          : whatsappApprovalCapability.render?.plugin?.buildPendingPayload?.({
              cfg,
              request: request as PluginApprovalRequest,
              target,
              nowMs: 1_000,
            });
      if (!renderPresentation || !afterDeliverPayload || !payload || !payload.presentation) {
        throw new Error("WhatsApp approval delivery hooks unavailable");
      }

      const rendered = await renderPresentation({
        payload,
        presentation: payload.presentation,
        ctx: {
          cfg,
          to: "configured-target",
          text: payload.text ?? "",
          payload,
        },
      });
      if (!rendered) {
        throw new Error("Expected a typed WhatsApp approval payload");
      }
      const { presentation: _presentation, ...deliveredPayload } = rendered;
      await afterDeliverPayload({
        cfg,
        target: { channel: "whatsapp", to: "configured-target" },
        payload: deliveredPayload,
        results: [
          {
            channel: "whatsapp",
            messageId,
            receipt: {
              primaryPlatformMessageId: messageId,
              platformMessageIds: [messageId],
              parts: [
                {
                  platformMessageId: messageId,
                  kind: "text",
                  index: 0,
                  raw: {
                    channel: "whatsapp",
                    messageId,
                    toJid: "15551230000@s.whatsapp.net",
                  },
                },
              ],
              sentAt: 1_000,
            },
          },
        ],
      });

      await expect(
        resolveWhatsAppApprovalReactionTargetWithPersistence({
          accountId: "default",
          remoteJid: "15551230000@s.whatsapp.net",
          messageId,
          reactionKey: "👍",
        }),
      ).resolves.toEqual({ approvalId, approvalKind, decision: "allow-once" });
    },
  );

  it.each([
    {
      name: "approval kind",
      mutate: (action: ApprovalAction): ApprovalAction => ({
        ...action,
        approvalKind: action.approvalKind === "exec" ? "plugin" : "exec",
      }),
    },
    {
      name: "approval id",
      mutate: (action: ApprovalAction): ApprovalAction => ({
        ...action,
        approvalId: `${action.approvalId}-other`,
      }),
    },
    {
      name: "allowed decision",
      mutate: (action: ApprovalAction): ApprovalAction => ({
        ...action,
        decision: "allow-always",
      }),
    },
  ])("fails closed when typed $name disagrees with approval metadata", async ({ mutate }) => {
    const renderPresentation = whatsappChannelOutbound.renderPresentation;
    const afterDeliverPayload = whatsappChannelOutbound.afterDeliverPayload;
    const cfg = {
      approvals: {
        exec: {
          enabled: true,
          mode: "targets" as const,
          targets: [{ channel: "whatsapp", to: "configured-target" }],
        },
      },
    } as OpenClawConfig;
    const payload = whatsappApprovalCapability.render?.exec?.buildPendingPayload?.({
      cfg,
      request: {
        id: "exec-mismatch",
        request: {
          command: "printf mismatch",
          allowedDecisions: ["allow-once", "deny"],
        },
        createdAtMs: 1_000,
        expiresAtMs: 61_000,
      } satisfies ExecApprovalRequest,
      target: { channel: "whatsapp", to: "configured-target", source: "target" },
      nowMs: 1_000,
    });
    if (!renderPresentation || !afterDeliverPayload || !payload || !payload.presentation) {
      throw new Error("WhatsApp approval delivery hooks unavailable");
    }
    let mutated = false;
    const presentation = {
      ...payload.presentation,
      blocks: payload.presentation.blocks.map((block) => {
        if (block.type !== "buttons") {
          return block;
        }
        return {
          ...block,
          buttons: block.buttons.map((button) => {
            if (mutated || button.action?.type !== "approval") {
              return button;
            }
            mutated = true;
            return { ...button, action: mutate(button.action) };
          }),
        };
      }),
    };
    await expect(
      renderPresentation({
        payload: { ...payload, presentation },
        presentation,
        ctx: {
          cfg,
          to: "configured-target",
          text: payload.text ?? "",
          payload,
        },
      }),
    ).resolves.toBeNull();

    await afterDeliverPayload({
      cfg,
      target: { channel: "whatsapp", to: "configured-target" },
      payload,
      results: [
        {
          channel: "whatsapp",
          messageId: "wa-mismatched",
          toJid: "15551230000@s.whatsapp.net",
        },
      ],
    });
    await expect(
      resolveWhatsAppApprovalReactionTargetWithPersistence({
        accountId: "default",
        remoteJid: "15551230000@s.whatsapp.net",
        messageId: "wa-mismatched",
        reactionKey: "👍",
      }),
    ).resolves.toBeNull();
  });

  it.each([
    {
      name: "kind header changes",
      rewrite: (text: string) => text.replace("Exec approval required", "Plugin approval required"),
    },
    {
      name: "id header changes",
      rewrite: (text: string) => text.replace("**ID:** exec-visible-mismatch", "**ID:** other-id"),
    },
    {
      name: "id header disappears",
      rewrite: (text: string) => text.replace("**ID:** exec-visible-mismatch\n", ""),
    },
    {
      name: "reaction decisions change",
      rewrite: (text: string) => text.replace("👍 Allow Once", "♾️ Allow Always"),
    },
  ])("fails closed when the visible approval $name", async ({ rewrite }) => {
    const renderPresentation = whatsappChannelOutbound.renderPresentation;
    const afterDeliverPayload = whatsappChannelOutbound.afterDeliverPayload;
    const cfg = {
      approvals: {
        exec: {
          enabled: true,
          mode: "targets" as const,
          targets: [{ channel: "whatsapp", to: "configured-target" }],
        },
      },
    } as OpenClawConfig;
    const payload = whatsappApprovalCapability.render?.exec?.buildPendingPayload?.({
      cfg,
      request: {
        id: "exec-visible-mismatch",
        request: {
          command: "printf mismatch",
          allowedDecisions: ["allow-once", "deny"],
        },
        createdAtMs: 1_000,
        expiresAtMs: 61_000,
      } satisfies ExecApprovalRequest,
      target: { channel: "whatsapp", to: "configured-target", source: "target" },
      nowMs: 1_000,
    });
    if (!renderPresentation || !afterDeliverPayload || !payload || !payload.presentation) {
      throw new Error("WhatsApp approval delivery hooks unavailable");
    }
    const rewrittenPayload = { ...payload, text: rewrite(payload.text ?? "") };

    await expect(
      renderPresentation({
        payload: rewrittenPayload,
        presentation: payload.presentation,
        ctx: {
          cfg,
          to: "configured-target",
          text: rewrittenPayload.text,
          payload: rewrittenPayload,
        },
      }),
    ).resolves.toBeNull();

    await afterDeliverPayload({
      cfg,
      target: { channel: "whatsapp", to: "configured-target" },
      payload: rewrittenPayload,
      results: [
        {
          channel: "whatsapp",
          messageId: "wa-visible-mismatch",
          toJid: "15551230000@s.whatsapp.net",
        },
      ],
    });
    await expect(
      resolveWhatsAppApprovalReactionTargetWithPersistence({
        accountId: "default",
        remoteJid: "15551230000@s.whatsapp.net",
        messageId: "wa-visible-mismatch",
        reactionKey: "👍",
      }),
    ).resolves.toBeNull();
  });

  it("drops leading blank lines but preserves intentional indentation", () => {
    expect(
      whatsappChannelOutbound.normalizePayload?.({
        payload: { text: "\n \n    indented" },
      }),
    ).toEqual({
      text: "    indented",
    });
  });

  it("keeps XML sanitizer normalization idempotent", () => {
    const raw = [
      "<function_calls>",
      '  <invoke name="send_message">',
      '    <parameter name="text">hidden</parameter>',
      "  </invoke>",
      "</function_calls>",
      "After",
    ].join("\n");
    const once = whatsappChannelOutbound.normalizePayload?.({ payload: { text: raw } });
    const twice = whatsappChannelOutbound.normalizePayload?.({ payload: { text: once?.text } });

    expect(once?.text).toBe("After");
    expect(twice?.text).toBe("After");
  });

  it("drops whitespace-only text after XML sanitizer removal", () => {
    const raw = [
      "  <function_calls>",
      '    <invoke name="send_message">',
      '      <parameter name="text">hidden</parameter>',
      "    </invoke>",
      "  </function_calls>",
    ].join("\n");

    expect(whatsappChannelOutbound.normalizePayload?.({ payload: { text: raw } })).toEqual({
      text: "",
    });
  });

  it("sanitizes XML tool payloads before plain HTML stripping", () => {
    const raw = [
      "Before",
      "<function_calls>",
      '  <invoke name="send_message">',
      '    <parameter name="text">hidden</parameter>',
      "  </invoke>",
      "</function_calls>",
      "After",
    ].join("\n");

    expect(whatsappChannelOutbound.sanitizeText?.({ text: raw, payload: { text: raw } })).toBe(
      "Before\n\nAfter",
    );
  });

  it("preserves indentation for live text sends", async () => {
    await whatsappChannelOutbound.sendText!({
      cfg: {},
      to: "5511999999999@c.us",
      text: "\n \n    indented",
    });

    expect(hoisted.sendMessageWhatsApp).toHaveBeenCalledWith("5511999999999@c.us", "    indented", {
      verbose: false,
      cfg: {},
      accountId: undefined,
      gifPlayback: undefined,
      preserveLeadingWhitespace: true,
    });
  });

  it("uses the live WhatsApp sender for quoted text replies", async () => {
    const legacySend = vi.fn(async () => ({ messageId: "legacy-1", toJid: "legacy-jid" }));
    cacheInboundMessageMeta("default", "5511999999999@c.us", "reply-live-1", {
      body: "original live body",
      fromMe: false,
      participant: "5511999999999@s.whatsapp.net",
    });

    await whatsappChannelOutbound.sendText!({
      cfg: {},
      to: "5511999999999@c.us",
      text: "quoted reply",
      replyToId: "reply-live-1",
      deps: {
        whatsapp: legacySend,
      },
    });

    expect(legacySend).not.toHaveBeenCalled();
    expect(hoisted.sendMessageWhatsApp).toHaveBeenCalledWith("5511999999999@c.us", "quoted reply", {
      verbose: false,
      cfg: {},
      accountId: undefined,
      gifPlayback: undefined,
      quotedMessageKey: {
        id: "reply-live-1",
        remoteJid: "5511999999999@c.us",
        fromMe: false,
        participant: "5511999999999@s.whatsapp.net",
        messageText: "original live body",
      },
      preserveLeadingWhitespace: true,
    });
  });

  it("uses the live WhatsApp sender for quoted media replies", async () => {
    const legacySend = vi.fn(async () => ({ messageId: "legacy-1", toJid: "legacy-jid" }));
    cacheInboundMessageMeta("default", "5511999999999@c.us", "reply-media-1", {
      body: "original media body",
      fromMe: false,
      participant: "5511999999999@s.whatsapp.net",
    });

    await whatsappChannelOutbound.sendMedia!({
      cfg: {},
      to: "5511999999999@c.us",
      text: "quoted image",
      mediaUrl: "/tmp/photo.png",
      replyToId: "reply-media-1",
      deps: {
        whatsapp: legacySend,
      },
    });

    expect(legacySend).not.toHaveBeenCalled();
    expect(hoisted.sendMessageWhatsApp).toHaveBeenCalledWith("5511999999999@c.us", "quoted image", {
      verbose: false,
      cfg: {},
      mediaUrl: "/tmp/photo.png",
      mediaAccess: undefined,
      mediaLocalRoots: undefined,
      mediaReadFile: undefined,
      accountId: undefined,
      gifPlayback: undefined,
      forceDocument: undefined,
      quotedMessageKey: {
        id: "reply-media-1",
        remoteJid: "5511999999999@c.us",
        fromMe: false,
        participant: "5511999999999@s.whatsapp.net",
        messageText: "original media body",
      },
      preserveLeadingWhitespace: true,
    });
  });

  it("rejects non-WhatsApp provider-prefixed outbound targets", () => {
    const result = whatsappChannelOutbound.resolveTarget?.({
      to: "telegram:1234567890",
      allowFrom: [],
      mode: undefined,
    });

    expect(result?.ok).toBe(false);
    expect(hoisted.sendMessageWhatsApp).not.toHaveBeenCalled();
  });

  it("preserves indentation for payload delivery", async () => {
    await whatsappChannelOutbound.sendPayload!({
      cfg: {},
      to: "5511999999999@c.us",
      text: "",
      payload: { text: "\n \n    indented" },
    });

    expect(hoisted.sendMessageWhatsApp).toHaveBeenCalledWith("5511999999999@c.us", "    indented", {
      verbose: false,
      cfg: {},
      accountId: undefined,
      gifPlayback: undefined,
      onDeliveryResult: expect.any(Function),
      preserveLeadingWhitespace: true,
    });
  });
});
