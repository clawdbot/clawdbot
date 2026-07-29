// Telegram plugin module implements channel actions behavior.
import {
  createUnionActionGate,
  listTokenSourcedAccounts,
  readStringParam,
  resolveReactionMessageId,
} from "openclaw/plugin-sdk/channel-actions";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  ChannelMessageToolDiscovery,
  ChannelMessageToolSchemaContribution,
} from "openclaw/plugin-sdk/channel-contract";
import type { TelegramActionConfig } from "openclaw/plugin-sdk/config-contracts";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { readStringValue } from "openclaw/plugin-sdk/string-coerce-runtime";
import { extractToolSend } from "openclaw/plugin-sdk/tool-send";
import { inspectTelegramAccount } from "./account-inspect.js";
import {
  createTelegramActionGate,
  listTelegramAccountIds,
  resolveTelegramPollActionGateState,
} from "./accounts.js";
import { isTelegramInlineButtonsEnabled } from "./inline-buttons.js";
import {
  createTelegramPollExtraToolSchemas,
  createTelegramRichSendExtraToolSchemas,
} from "./message-tool-schema.js";

const loadTelegramActionRuntime = createLazyRuntimeModule(() => import("./action-runtime.js"));

const telegramMessageActionRuntime = {
  handleTelegramAction: async (
    ...args: Parameters<typeof import("./action-runtime.js").handleTelegramAction>
  ): ReturnType<typeof import("./action-runtime.js").handleTelegramAction> => {
    const { handleTelegramAction } = await loadTelegramActionRuntime();
    return await handleTelegramAction(...args);
  },
};

const TELEGRAM_MESSAGE_ACTION_MAP = {
  delete: "deleteMessage",
  edit: "editMessage",
  poll: "poll",
  react: "react",
  send: "sendMessage",
  sticker: "sendSticker",
  "sticker-search": "searchSticker",
  "topic-create": "createForumTopic",
  "topic-edit": "editForumTopic",
} as const satisfies Partial<Record<ChannelMessageActionName, string>>;

const TELEGRAM_TOOL_DELIVERY_ACTIONS = new Set([
  "createForumTopic",
  "delete",
  "deleteMessage",
  "edit",
  "editForumTopic",
  "editMessage",
  "poll",
  "react",
  "send",
  "sendMessage",
  "sendSticker",
  "sticker",
  "topic-create",
  "topic-edit",
]);

function resolveTelegramMessageActionName(action: ChannelMessageActionName) {
  return TELEGRAM_MESSAGE_ACTION_MAP[action as keyof typeof TELEGRAM_MESSAGE_ACTION_MAP];
}

function prepareTelegramSendPayload({
  ctx,
  payload,
}: Parameters<NonNullable<ChannelMessageActionAdapter["prepareSendPayload"]>>[0]) {
  if (
    ctx.action !== "send" ||
    (!payload.presentation && !payload.location && payload.videoAsNote !== true)
  ) {
    return null;
  }
  const quoteText = readStringParam(ctx.params, "quoteText");
  if (!quoteText) {
    return payload;
  }
  const rawTelegramData = payload.channelData?.telegram;
  const telegramData =
    rawTelegramData && typeof rawTelegramData === "object" && !Array.isArray(rawTelegramData)
      ? (rawTelegramData as Record<string, unknown>)
      : {};
  return {
    ...payload,
    channelData: {
      ...payload.channelData,
      telegram: { ...telegramData, quoteText },
    },
  };
}

function resolveTelegramActionDiscovery(cfg: Parameters<typeof listTelegramAccountIds>[0]) {
  const inspected = listTelegramAccountIds(cfg)
    .map((accountId) => inspectTelegramAccount({ cfg, accountId }))
    .filter((account) => account.enabled && account.configured);
  const accounts = listTokenSourcedAccounts(inspected);
  if (accounts.length === 0) {
    return null;
  }
  const unionGate = createUnionActionGate(accounts, (account) =>
    createTelegramActionGate({
      cfg,
      accountId: account.accountId,
    }),
  );
  const pollEnabled = accounts.some((account) => {
    const accountGate = createTelegramActionGate({
      cfg,
      accountId: account.accountId,
    });
    return resolveTelegramPollActionGateState(accountGate).enabled;
  });
  const buttonsEnabled = accounts.some((account) =>
    isTelegramInlineButtonsEnabled({ cfg, accountId: account.accountId }),
  );
  return {
    isEnabled: (key: keyof TelegramActionConfig, defaultValue = true) =>
      unionGate(key, defaultValue),
    pollEnabled,
    buttonsEnabled,
  };
}

function resolveScopedTelegramActionDiscovery(params: {
  cfg: Parameters<typeof listTelegramAccountIds>[0];
  accountId?: string | null;
}) {
  if (!params.accountId) {
    return resolveTelegramActionDiscovery(params.cfg);
  }
  const account = inspectTelegramAccount({ cfg: params.cfg, accountId: params.accountId });
  if (!account.enabled || !account.configured || account.tokenSource === "none") {
    return null;
  }
  const gate = createTelegramActionGate({
    cfg: params.cfg,
    accountId: account.accountId,
  });
  return {
    isEnabled: (key: keyof TelegramActionConfig, defaultValue = true) => gate(key, defaultValue),
    pollEnabled: resolveTelegramPollActionGateState(gate).enabled,
    buttonsEnabled: isTelegramInlineButtonsEnabled({
      cfg: params.cfg,
      accountId: account.accountId,
    }),
  };
}

function describeTelegramMessageTool({
  cfg,
  accountId,
}: Parameters<
  NonNullable<ChannelMessageActionAdapter["describeMessageTool"]>
>[0]): ChannelMessageToolDiscovery {
  const discovery = resolveScopedTelegramActionDiscovery({ cfg, accountId });
  if (!discovery) {
    return {
      actions: [],
      capabilities: [],
      schema: null,
    };
  }
  const actions = new Set<ChannelMessageActionName>(["send"]);
  if (discovery.pollEnabled) {
    actions.add("poll");
  }
  if (discovery.isEnabled("reactions")) {
    actions.add("react");
  }
  if (discovery.isEnabled("deleteMessage")) {
    actions.add("delete");
  }
  if (discovery.isEnabled("editMessage")) {
    actions.add("edit");
  }
  if (discovery.isEnabled("sticker", false)) {
    actions.add("sticker");
    actions.add("sticker-search");
  }
  if (discovery.isEnabled("createForumTopic")) {
    actions.add("topic-create");
  }
  if (discovery.isEnabled("editForumTopic")) {
    actions.add("topic-edit");
  }
  const schema: ChannelMessageToolSchemaContribution[] = [];
  if (discovery.pollEnabled) {
    schema.push({
      properties: createTelegramPollExtraToolSchemas(),
      visibility: "all-configured",
    });
  }
  if (discovery.isEnabled("sendMessage")) {
    schema.push({
      properties: createTelegramRichSendExtraToolSchemas(),
      visibility: "all-configured",
    });
  }
  return {
    actions: Array.from(actions),
    capabilities: discovery.buttonsEnabled ? ["presentation", "delivery-pin"] : ["delivery-pin"],
    schema,
  };
}

export const telegramMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: describeTelegramMessageTool,
  resolveExecutionMode: () => "gateway",
  messageActionTargetAliases: {
    react: { aliases: ["messageId"], deliveryTargetAliases: [] },
    edit: { aliases: ["messageId"], deliveryTargetAliases: [] },
    delete: { aliases: ["messageId"], deliveryTargetAliases: [] },
  },
  prepareSendPayload: prepareTelegramSendPayload,
  resolveCliActionRequest: ({ action, args }) => {
    if (action !== "thread-create") {
      return { action, args };
    }
    const { threadName, ...rest } = args;
    return {
      action: "topic-create",
      args: {
        ...rest,
        name: readStringValue(threadName),
      },
    };
  },
  extractToolSend: ({ args }) => {
    return extractToolSend(args, "sendMessage");
  },
  isToolDeliveryAction: ({ args }) =>
    typeof args.action === "string" && TELEGRAM_TOOL_DELIVERY_ACTIONS.has(args.action),
  handleAction: async ({
    action,
    params,
    cfg,
    accountId,
    mediaLocalRoots,
    mediaReadFile,
    sessionKey,
    inboundEventKind,
    toolContext,
    conversationReadOrigin,
    requesterAccountId,
    gatewayClientScopes,
  }) => {
    const telegramAction = resolveTelegramMessageActionName(action);
    if (!telegramAction) {
      throw new Error(`Unsupported Telegram action: ${action}`);
    }
    const {
      conversationReadOrigin: _modelConversationReadOrigin,
      requesterAccountId: _modelRequesterAccountId,
      toolContext: _modelToolContext,
      ...runtimeParams
    } = params;
    return await telegramMessageActionRuntime.handleTelegramAction(
      {
        // Authority stays in the host-owned options object below. Model tool
        // arguments with these names must never reach the runtime as context.
        ...runtimeParams,
        action: telegramAction,
        accountId: accountId ?? undefined,
        ...(action === "react"
          ? {
              messageId: resolveReactionMessageId({ args: runtimeParams, toolContext }),
            }
          : {}),
      },
      cfg,
      {
        mediaLocalRoots,
        mediaReadFile,
        sessionKey,
        inboundEventKind,
        gatewayClientScopes,
        ...(conversationReadOrigin ? { conversationReadOrigin } : {}),
        ...(requesterAccountId ? { requesterAccountId } : {}),
        ...(toolContext ? { toolContext } : {}),
      },
    );
  },
};
