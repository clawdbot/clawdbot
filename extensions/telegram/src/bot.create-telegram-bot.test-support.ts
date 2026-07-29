import type { TelegramBotInfo } from "./bot-info.js";

type DispatchReplyWithBufferedBlockDispatcher =
  typeof import("openclaw/plugin-sdk/reply-dispatch-runtime").dispatchReplyWithBufferedBlockDispatcher;
type DispatchChannelInboundTurn =
  typeof import("openclaw/plugin-sdk/channel-inbound").dispatchChannelInboundTurn;

export const telegramBotInfoForTest = {
  id: 9_876_543_210,
  is_bot: true,
  first_name: "OpenClaw",
  username: "openclaw_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  can_manage_bots: false,
  supports_inline_queries: false,
  supports_join_request_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
} satisfies TelegramBotInfo;

export function createTelegramNativeCommandTestDeps(
  dispatchReply: DispatchReplyWithBufferedBlockDispatcher,
): { dispatchChannelInboundTurn: DispatchChannelInboundTurn } {
  return {
    dispatchChannelInboundTurn: async (plan) => {
      const dispatchResult = await dispatchReply({
        ctx: plan.ctxPayload,
        cfg: plan.cfg,
        dispatcherOptions: {
          ...plan.dispatcherOptions,
          deliver:
            "deliverWithProviderMessageSending" in plan.delivery
              ? plan.delivery.deliverWithProviderMessageSending
              : plan.delivery.deliver,
          onError: plan.delivery.onError,
        },
        replyOptions: plan.replyOptions,
      });
      return {
        admission: { kind: "dispatch" },
        dispatched: true,
        ctxPayload: plan.ctxPayload,
        routeSessionKey: plan.route.sessionKey,
        dispatchResult,
      };
    },
  };
}
