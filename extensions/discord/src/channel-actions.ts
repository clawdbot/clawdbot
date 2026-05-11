import { createUnionActionGate } from "openclaw/plugin-sdk/channel-actions";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  ChannelMessageToolDiscovery,
} from "openclaw/plugin-sdk/channel-contract";
import type { DiscordActionConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { extractToolSend } from "openclaw/plugin-sdk/tool-send";
import { inspectDiscordAccount } from "./account-inspect.js";
import { createDiscordActionGate, listDiscordAccountIds } from "./accounts.js";
import { readDiscordComponentSpec } from "./components.js";

let discordChannelActionsRuntimePromise:
  | Promise<typeof import("./channel-actions.runtime.js")>
  | undefined;

async function loadDiscordChannelActionsRuntime() {
  discordChannelActionsRuntimePromise ??= import("./channel-actions.runtime.js");
  return await discordChannelActionsRuntimePromise;
}

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
  return {
    actions: Array.from(actions),
    capabilities: ["presentation"],
  };
}

export const discordMessageActions: ChannelMessageActionAdapter = {
  resolveExecutionMode: ({ action }) =>
    action === "read" || action === "search" ? "gateway" : "local",
  describeMessageTool: describeDiscordMessageTool,
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
    const rawComponents = ctx.params.components;
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
      return payload;
    }
    const discordData =
      payload.channelData?.discord &&
      typeof payload.channelData.discord === "object" &&
      !Array.isArray(payload.channelData.discord)
        ? (payload.channelData.discord as Record<string, unknown>)
        : {};
    return {
      ...payload,
      channelData: {
        ...payload.channelData,
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
    requesterSenderId,
    toolContext,
    mediaAccess,
    mediaLocalRoots,
    mediaReadFile,
  }) => {
    return await (
      await loadDiscordChannelActionsRuntime()
    ).handleDiscordMessageAction({
      action,
      params,
      cfg,
      accountId,
      requesterSenderId,
      toolContext,
      mediaAccess,
      mediaLocalRoots,
      mediaReadFile,
    });
  },
};
