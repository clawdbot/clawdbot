// Discord plugin module implements channel actions behavior.
import { createUnionActionGate } from "openclaw/plugin-sdk/channel-actions";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  ChannelMessageToolDiscovery,
  ChannelMessageToolSchemaContribution,
} from "openclaw/plugin-sdk/channel-contract";
import type { DiscordActionConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { extractToolSend } from "openclaw/plugin-sdk/tool-send";
import { Type } from "typebox";
import { inspectDiscordAccount } from "./account-inspect.js";
import { createDiscordActionGate, listDiscordAccountIds } from "./accounts.js";
import { coerceDiscordComponentParam, readDiscordComponentSpec } from "./components.js";
import { withDiscordInboundEventDeliveryMetadata } from "./inbound-event-delivery.js";
import { isTrustedRequesterGuildAdminAction } from "./trusted-requester-actions.js";

const localExecutionActions = new Set<ChannelMessageActionName>([
  "send",
  "poll",
  "upload-file",
  "thread-reply",
  "sticker",
  "emoji-upload",
  "sticker-upload",
  "event-create",
]);

function resolveDiscordActionExecutionMode({ action }: { action: ChannelMessageActionName }) {
  return localExecutionActions.has(action) ? "local" : "gateway";
}

const loadDiscordChannelActionsRuntime = createLazyRuntimeModule(
  () => import("./channel-actions.runtime.js"),
);

function listDiscoverableDiscordAccounts(cfg: OpenClawConfig) {
  return listDiscordAccountIds(cfg)
    .map((accountId) => inspectDiscordAccount({ cfg, accountId }))
    .filter((account) => account.enabled && account.configured);
}

function resolveDiscordActionDiscovery(cfg: OpenClawConfig) {
  const accounts = listDiscoverableDiscordAccounts(cfg);
  if (accounts.length === 0) {
    return null;
  }
  const unionGate = createUnionActionGate(accounts, (account) =>
    createDiscordActionGate({
      cfg,
      accountId: account.accountId,
    }),
  );
  return {
    isEnabled: (key: keyof DiscordActionConfig, defaultValue = true) =>
      unionGate(key, defaultValue),
  };
}

function resolveScopedDiscordActionDiscovery(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}) {
  if (!params.accountId) {
    return resolveDiscordActionDiscovery(params.cfg);
  }
  const account = inspectDiscordAccount({ cfg: params.cfg, accountId: params.accountId });
  if (!account.enabled || !account.configured) {
    return null;
  }
  const gate = createDiscordActionGate({
    cfg: params.cfg,
    accountId: account.accountId,
  });
  return {
    isEnabled: (key: keyof DiscordActionConfig, defaultValue = true) => gate(key, defaultValue),
  };
}

function describeDiscordMessageTool({
  cfg,
  accountId,
}: Parameters<
  NonNullable<ChannelMessageActionAdapter["describeMessageTool"]>
>[0]): ChannelMessageToolDiscovery {
  const discovery = resolveScopedDiscordActionDiscovery({ cfg, accountId });
  if (!discovery) {
    return {
      actions: [],
      capabilities: [],
      schema: null,
    };
  }
  const actions = new Set<ChannelMessageActionName>(["send"]);
  if (discovery.isEnabled("polls")) {
    actions.add("poll");
  }
  if (discovery.isEnabled("reactions")) {
    actions.add("react");
    actions.add("reactions");
    actions.add("emoji-list");
  }
  if (discovery.isEnabled("messages")) {
    actions.add("upload-file");
    actions.add("read");
    actions.add("edit");
    actions.add("delete");
  }
  if (discovery.isEnabled("pins")) {
    actions.add("pin");
    actions.add("unpin");
    actions.add("list-pins");
  }
  if (discovery.isEnabled("permissions")) {
    actions.add("permissions");
  }
  if (discovery.isEnabled("threads")) {
    actions.add("thread-create");
    actions.add("thread-list");
    actions.add("thread-reply");
  }
  if (discovery.isEnabled("search")) {
    actions.add("search");
  }
  if (discovery.isEnabled("stickers")) {
    actions.add("sticker");
  }
  if (discovery.isEnabled("memberInfo")) {
    actions.add("member-info");
  }
  if (discovery.isEnabled("roleInfo")) {
    actions.add("role-info");
  }
  if (discovery.isEnabled("emojiUploads")) {
    actions.add("emoji-upload");
  }
  if (discovery.isEnabled("stickerUploads")) {
    actions.add("sticker-upload");
  }
  if (discovery.isEnabled("roles", false)) {
    actions.add("role-add");
    actions.add("role-remove");
  }
  if (discovery.isEnabled("channelInfo")) {
    actions.add("channel-info");
    actions.add("channel-list");
  }
  if (discovery.isEnabled("channels")) {
    actions.add("channel-create");
    actions.add("channel-edit");
    actions.add("channel-delete");
    actions.add("channel-move");
    actions.add("category-create");
    actions.add("category-edit");
    actions.add("category-delete");
  }
  if (discovery.isEnabled("voiceStatus")) {
    actions.add("voice-status");
  }
  if (discovery.isEnabled("events")) {
    actions.add("event-list");
    actions.add("event-create");
  }
  if (discovery.isEnabled("moderation", false)) {
    actions.add("timeout");
    actions.add("kick");
    actions.add("ban");
  }
  if (discovery.isEnabled("presence", false)) {
    actions.add("set-presence");
  }
  const schema: ChannelMessageToolSchemaContribution[] = [];
  if (actions.has("react")) {
    schema.push({
      actions: ["react", "reactions"],
      properties: {
        emoji: Type.Optional(
          Type.String({
            description: `Unicode emoji or custom name:id (also <:name:id> / <a:name:id>).${actions.has("emoji-list") ? ' Use action:"emoji-list" for server emojis.' : ""}`,
          }),
        ),
      },
    });
  }
  if (actions.has("send")) {
    schema.push({
      actions: ["send"],
      visibility: "all-configured",
      properties: {
        components: Type.Optional(
          Type.Object(
            {
              blocks: Type.Optional(
                Type.Array(Type.Unknown(), {
                  description:
                    "Discord Components V2 blocks such as text, buttons, selects, media, containers, and separators.",
                }),
              ),
              modal: Type.Optional(
                Type.Object(
                  {},
                  {
                    additionalProperties: true,
                    description: "Optional Discord modal triggered by generated components.",
                  },
                ),
              ),
            },
            {
              additionalProperties: true,
              description:
                "Discord Components V2 payload for send actions. Accepts the same object consumed by the Discord components adapter.",
            },
          ),
        ),
      },
    });
  }
  return {
    actions: Array.from(actions),
    capabilities: ["presentation"],
    schema,
  };
}

export const discordMessageActions: ChannelMessageActionAdapter = {
  providerOwnedReadGates: true,
  // Credential-only Discord actions run in the gateway when one is available.
  // Send/file-style actions stay local because core owns their thread, media,
  // component, and client-local payload semantics.
  resolveExecutionMode: resolveDiscordActionExecutionMode,
  describeMessageTool: describeDiscordMessageTool,
  supportsAction: ({ action }) => action !== "poll",
  requiresTrustedRequesterSender: ({ action, toolContext }) =>
    Boolean(toolContext) && isTrustedRequesterGuildAdminAction(action),
  extractToolSend: ({ args }) => {
    const action = normalizeOptionalString(args.action) ?? "";
    if (action === "sendMessage") {
      return extractToolSend(args, "sendMessage");
    }
    if (action === "threadReply") {
      const channelId = normalizeOptionalString(args.channelId) ?? "";
      return channelId ? { to: `channel:${channelId}` } : null;
    }
    return null;
  },
  prepareSendPayload: ({ ctx, payload }) => {
    if (ctx.action !== "send") {
      return null;
    }
    const payloadWithDeliveryMetadata = withDiscordInboundEventDeliveryMetadata(payload, {
      sessionKey: ctx.sessionKey,
      inboundEventKind: ctx.inboundEventKind,
    });
    const rawComponents = coerceDiscordComponentParam(ctx.params.components);
    if (typeof rawComponents === "function") {
      return null;
    }
    const componentSpec =
      rawComponents && typeof rawComponents === "object" && !Array.isArray(rawComponents)
        ? readDiscordComponentSpec(rawComponents)
        : undefined;
    const nativeComponents = Array.isArray(rawComponents) ? rawComponents : undefined;
    const embeds = Array.isArray(ctx.params.embeds) ? ctx.params.embeds : undefined;
    if ((componentSpec || nativeComponents) && embeds?.length) {
      return null;
    }
    const filename = normalizeOptionalString(ctx.params.filename);
    if (!componentSpec && !nativeComponents && !embeds?.length && !filename) {
      return payloadWithDeliveryMetadata;
    }
    const discordData =
      payloadWithDeliveryMetadata.channelData?.discord &&
      typeof payloadWithDeliveryMetadata.channelData.discord === "object" &&
      !Array.isArray(payloadWithDeliveryMetadata.channelData.discord)
        ? (payloadWithDeliveryMetadata.channelData.discord as Record<string, unknown>)
        : {};
    return {
      ...payloadWithDeliveryMetadata,
      channelData: {
        ...payloadWithDeliveryMetadata.channelData,
        discord: {
          ...discordData,
          ...(componentSpec ? { components: componentSpec } : {}),
          ...(nativeComponents ? { components: nativeComponents } : {}),
          ...(embeds?.length ? { embeds } : {}),
          ...(filename ? { filename } : {}),
        },
      },
    };
  },
  handleAction: async ({
    action,
    params,
    cfg,
    accountId,
    requesterAccountId,
    requesterSenderId,
    senderIsOwner,
    toolContext,
    mediaAccess,
    mediaLocalRoots,
    mediaReadFile,
    sessionKey,
    inboundEventKind,
    conversationReadOrigin,
    reply,
  }) => {
    return await (
      await loadDiscordChannelActionsRuntime()
    ).handleDiscordMessageAction({
      action,
      params,
      cfg,
      accountId,
      requesterSenderId,
      senderIsOwner,
      toolContext,
      mediaAccess,
      mediaLocalRoots,
      mediaReadFile,
      ...(sessionKey ? { sessionKey } : {}),
      ...(inboundEventKind ? { inboundEventKind } : {}),
      ...(requesterAccountId ? { requesterAccountId } : {}),
      ...(conversationReadOrigin ? { conversationReadOrigin } : {}),
      ...(reply ? { reply } : {}),
    });
  },
};
