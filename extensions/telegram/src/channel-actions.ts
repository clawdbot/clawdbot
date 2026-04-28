import {
  createUnionActionGate,
  listTokenSourcedAccounts,
  resolveReactionMessageId,
} from "openclaw/plugin-sdk/channel-actions";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  ChannelMessageToolDiscovery,
  ChannelMessageToolSchemaContribution,
} from "openclaw/plugin-sdk/channel-contract";
import type { TelegramActionConfig } from "openclaw/plugin-sdk/config-types";
import { readStringValue } from "openclaw/plugin-sdk/text-runtime";
import { extractToolSend } from "openclaw/plugin-sdk/tool-send";
import {
  createTelegramActionGate,
  listEnabledTelegramAccounts,
  resolveTelegramAccount,
  resolveTelegramPollActionGateState,
} from "./accounts.js";
import { isTelegramInlineButtonsEnabled } from "./inline-buttons.js";
import { createTelegramPollExtraToolSchemas } from "./message-tool-schema.js";

let telegramActionRuntimePromise: Promise<typeof import("./action-runtime.js")> | null = null;

async function loadTelegramActionRuntime() {
  telegramActionRuntimePromise ??= import("./action-runtime.js");
  return await telegramActionRuntimePromise;
}

export const telegramMessageActionRuntime = {
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

function resolveTelegramMessageActionName(action: ChannelMessageActionName) {
  return TELEGRAM_MESSAGE_ACTION_MAP[action as keyof typeof TELEGRAM_MESSAGE_ACTION_MAP];
}

function resolveTelegramActionDiscovery(cfg: Parameters<typeof listEnabledTelegramAccounts>[0]) {
  const accounts = listTokenSourcedAccounts(listEnabledTelegramAccounts(cfg));
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
  cfg: Parameters<typeof listEnabledTelegramAccounts>[0];
  accountId?: string | null;
}) {
  if (!params.accountId) {
    return resolveTelegramActionDiscovery(params.cfg);
  }
  const account = resolveTelegramAccount({ cfg: params.cfg, accountId: params.accountId });
  if (!account.enabled || account.tokenSource === "none") {
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
  return {
    actions: Array.from(actions),
    capabilities: discovery.buttonsEnabled ? ["presentation", "delivery-pin"] : ["delivery-pin"],
    schema,
  };
}

export const telegramMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: describeTelegramMessageTool,
  resolveExecutionMode: () => "gateway",
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
  handleAction: async ({ action, params, cfg, accountId, mediaLocalRoots, toolContext }) => {
    const telegramAction = resolveTelegramMessageActionName(action);
    if (!telegramAction) {
      throw new Error(`Unsupported Telegram action: ${action}`);
    }
    return await telegramMessageActionRuntime.handleTelegramAction(
      {
        ...params,
        action: telegramAction,
        accountId: accountId ?? undefined,
        ...(action === "react"
          ? {
              messageId: resolveReactionMessageId({ args: params, toolContext }),
            }
          : {}),
      },
      cfg,
      { mediaLocalRoots },
    );
  },
};
