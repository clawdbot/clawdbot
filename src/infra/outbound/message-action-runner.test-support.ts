import { vi } from "vitest";
import type {
  ChannelDirectoryEntryKind,
  ChannelMessageActionName,
  ChannelMessagingAdapter,
  ChannelOutboundAdapter,
  ChannelPlugin,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";

type RunMessageAction = typeof import("./message-action-runner.js").runMessageAction;

const runFixtureMessageAction: RunMessageAction = async (...args) =>
  (await import("./message-action-runner.js")).runMessageAction(...args);

/** Workspace-style config fixture used by message action runner tests. */
export const workspaceConfig = {
  channels: {
    workspace: {
      botToken: "workspace-test",
      appToken: "workspace-app-test",
    },
  },
} as OpenClawConfig;

/** Direct-chat config fixture that allows any sender. */
export const directChatConfig = {
  channels: {
    directchat: {
      allowFrom: ["*"],
    },
  },
} as OpenClawConfig;

export const directOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendText: async () => ({ channel: "test", messageId: "test" }),
};

export const runDryAction = (params: {
  cfg: OpenClawConfig;
  action: ChannelMessageActionName;
  actionParams: Record<string, unknown>;
  toolContext?: Record<string, unknown>;
  abortSignal?: AbortSignal;
  sandboxRoot?: string;
  agentId?: string;
}) =>
  runFixtureMessageAction({
    cfg: params.cfg,
    action: params.action,
    params: params.actionParams as never,
    toolContext: params.toolContext as never,
    dryRun: true,
    abortSignal: params.abortSignal,
    sandboxRoot: params.sandboxRoot,
    agentId: params.agentId,
  });

export const runDrySend = (params: {
  cfg: OpenClawConfig;
  actionParams: Record<string, unknown>;
  toolContext?: Record<string, unknown>;
  abortSignal?: AbortSignal;
  sandboxRoot?: string;
  agentId?: string;
}) =>
  runDryAction({
    ...params,
    action: "send",
  });

type ResolvedTestTarget = { to: string; kind: ChannelDirectoryEntryKind };

function normalizeWorkspaceTarget(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("#")) {
    return trimmed.slice(1).trim();
  }
  if (/^channel:/i.test(trimmed)) {
    return trimmed.replace(/^channel:/i, "").trim();
  }
  if (/^user:/i.test(trimmed)) {
    return trimmed.replace(/^user:/i, "").trim();
  }
  const mention = trimmed.match(/^<@([A-Z0-9]+)>$/i);
  if (mention?.[1]) {
    return mention[1];
  }
  return trimmed;
}

// Test plugins model token-gated workspace sends without booting real channel runtimes.
function hasChannelBotToken(channelConfig: unknown): boolean {
  if (channelConfig == null || typeof channelConfig !== "object" || Array.isArray(channelConfig)) {
    return false;
  }
  const token = (channelConfig as Record<string, unknown>).botToken;
  return typeof token === "string" && Boolean(token.trim());
}

function createConfiguredTestPlugin(params: {
  id: string;
  isConfigured: (cfg: OpenClawConfig) => boolean;
  normalizeTarget: (raw: string) => string | undefined;
  resolveTarget: (input: string) => ResolvedTestTarget | null;
}): ChannelPlugin {
  const messaging: ChannelMessagingAdapter = {
    normalizeTarget: params.normalizeTarget,
    targetResolver: {
      looksLikeId: (raw) => Boolean(params.resolveTarget(raw.trim())),
      hint: "<id>",
      resolveTarget: async (resolverParams) => {
        const resolved = params.resolveTarget(resolverParams.input);
        return resolved ? { ...resolved, source: "normalized" } : null;
      },
    },
    inferTargetChatType: (inferParams) =>
      params.resolveTarget(inferParams.to)?.kind === "user" ? "direct" : "group",
  };
  return {
    ...createChannelTestPluginBase({
      id: params.id,
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({ enabled: true }),
        isConfigured: (_account, cfg) => params.isConfigured(cfg),
      },
    }),
    outbound: directOutbound,
    messaging,
  };
}

export const workspaceTestPlugin = createConfiguredTestPlugin({
  id: "workspace",
  isConfigured: (cfg) => hasChannelBotToken(cfg.channels?.workspace),
  normalizeTarget: (raw) => normalizeWorkspaceTarget(raw) || undefined,
  resolveTarget: (input) => {
    const normalized = normalizeWorkspaceTarget(input);
    if (!normalized) {
      return null;
    }
    if (/^[A-Z0-9]+$/i.test(normalized)) {
      const kind = /^U/i.test(normalized) ? "user" : "group";
      return { to: normalized, kind };
    }
    return null;
  },
});

export const forumTestPlugin = createConfiguredTestPlugin({
  id: "forum",
  isConfigured: (cfg) => hasChannelBotToken(cfg.channels?.forum),
  normalizeTarget: (raw) => raw.trim() || undefined,
  resolveTarget: (input) => {
    const normalized = input.trim();
    if (!normalized) {
      return null;
    }
    return {
      to: normalized.replace(/^forum:/i, ""),
      kind: normalized.startsWith("@") ? "user" : "group",
    };
  },
});

export const directChatTestPlugin = createConfiguredTestPlugin({
  id: "directchat",
  isConfigured: (cfg) => Boolean(cfg.channels?.directchat),
  normalizeTarget: (raw) => raw.trim() || undefined,
  resolveTarget: (input) => {
    const normalized = input.trim();
    if (!normalized) {
      return null;
    }
    return {
      to: normalized,
      kind: normalized.endsWith("@g.us") ? "group" : "user",
    };
  },
});

type ChannelActionHandler = NonNullable<NonNullable<ChannelPlugin["actions"]>["handleAction"]>;

const testchatConfig = {
  channels: {
    testchat: {
      enabled: true,
    },
  },
} as OpenClawConfig;

function createReplyActionPlugin(handleAction: ChannelActionHandler): ChannelPlugin {
  return {
    id: "testchat",
    meta: {
      id: "testchat",
      label: "Test Chat",
      selectionLabel: "Test Chat",
      docsPath: "/channels/testchat",
      blurb: "Reply action test plugin.",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({ enabled: true }),
      isConfigured: () => true,
    },
    outbound: {
      deliveryMode: "direct",
      sendText: async () => ({ channel: "testchat", messageId: "m-send-1" }),
    },
    messaging: {
      targetResolver: {
        looksLikeId: () => true,
      },
    },
    actions: {
      describeMessageTool: () => ({ actions: ["reply", "poll"] }),
      supportsAction: ({ action }) => action === "reply" || action === "poll",
      handleAction,
    },
  };
}

export function registerReplyPlugin() {
  const payload = { ok: true, messageId: "m-reply-1", repliedTo: "platform-guid-1" };
  const handleAction = vi.fn(async () => ({
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    details: payload,
  }));
  setActivePluginRegistry(
    createTestRegistry([
      { pluginId: "testchat", source: "test", plugin: createReplyActionPlugin(handleAction) },
    ]),
  );
  return handleAction;
}

export async function runReplyAction(params: {
  actionParams: Record<string, unknown>;
  currentMessageId?: string | number;
}) {
  const toolContext = {
    currentChannelProvider: "testchat" as const,
    currentChannelId: "direct:user-1",
    ...(params.currentMessageId !== undefined ? { currentMessageId: params.currentMessageId } : {}),
  };
  return await runFixtureMessageAction({
    cfg: testchatConfig,
    action: "reply",
    params: { channel: "testchat", ...params.actionParams },
    toolContext,
    messageActionAuthorization: {
      requesterAccountId: "default",
      toolContext,
    },
    sessionKey: "agent:main:testchat:direct:user-1",
    defaultAccountId: "default",
    sourceReplyDeliveryMode: "message_tool_only",
    dryRun: false,
  });
}

export async function runCurrentConversationPollAction(params: { to: string }) {
  const toolContext = {
    currentChannelProvider: "testchat" as const,
    currentChannelId: "direct:user-1",
    currentMessageId: "1783",
  };
  return await runFixtureMessageAction({
    cfg: testchatConfig,
    action: "poll",
    params: {
      channel: "testchat",
      to: params.to,
      pollQuestion: "Preferred default?",
      pollOption: ["Tell me right away", "Only important"],
    },
    toolContext,
    messageActionAuthorization: {
      requesterAccountId: "default",
      toolContext,
    },
    sessionKey: "agent:main:testchat:direct:user-1",
    defaultAccountId: "default",
    sourceReplyDeliveryMode: "message_tool_only",
    dryRun: false,
  });
}

/** Returns a bootstrap registry mock for message-action alias tests. */
export function createPinboardMessageActionBootstrapRegistryMock() {
  const resolveIMessageTarget = ({ args }: { args: Record<string, unknown> }) => {
    if (typeof args.chatGuid === "string") {
      return `chat_guid:${args.chatGuid}`;
    }
    if (typeof args.chatId === "number" || typeof args.chatId === "string") {
      return `chat_id:${args.chatId}`;
    }
    return typeof args.chatIdentifier === "string"
      ? `chat_identifier:${args.chatIdentifier}`
      : undefined;
  };
  return (channel: string) => {
    if (channel === "pinboard") {
      return {
        actions: {
          messageActionTargetAliases: {
            read: { aliases: ["messageId"] },
            pin: { aliases: ["messageId"] },
            unpin: { aliases: ["messageId"] },
            "list-pins": { aliases: ["chatId"] },
            "channel-info": { aliases: ["chatId"] },
          },
        },
      };
    }
    if (channel === "imessage") {
      return {
        actions: {
          messageActionTargetAliases: {
            react: {
              aliases: ["chatGuid", "chatIdentifier", "chatId", "messageId"],
              deliveryTargetAliases: ["chatGuid", "chatIdentifier", "chatId"],
              resolveDeliveryTarget: resolveIMessageTarget,
            },
            edit: {
              aliases: ["chatGuid", "chatIdentifier", "chatId", "messageId"],
              deliveryTargetAliases: ["chatGuid", "chatIdentifier", "chatId"],
              resolveDeliveryTarget: resolveIMessageTarget,
            },
            unsend: {
              aliases: ["chatGuid", "chatIdentifier", "chatId", "messageId"],
              deliveryTargetAliases: ["chatGuid", "chatIdentifier", "chatId"],
              resolveDeliveryTarget: resolveIMessageTarget,
            },
            "upload-file": { aliases: ["chatGuid", "chatIdentifier", "chatId"] },
            poll: {
              aliases: ["chatGuid", "chatIdentifier", "chatId"],
              deliveryTargetAliases: ["chatGuid", "chatIdentifier", "chatId"],
              resolveDeliveryTarget: resolveIMessageTarget,
            },
            "poll-vote": {
              aliases: ["chatGuid", "chatIdentifier", "chatId", "pollId", "messageId"],
              deliveryTargetAliases: ["chatGuid", "chatIdentifier", "chatId"],
              resolveDeliveryTarget: resolveIMessageTarget,
            },
          },
        },
      };
    }
    return undefined;
  };
}
