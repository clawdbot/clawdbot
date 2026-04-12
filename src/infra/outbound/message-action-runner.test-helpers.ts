import type {
  ChannelDirectoryEntryKind,
  ChannelMessageActionName,
  ChannelMessagingAdapter,
  ChannelOutboundAdapter,
  ChannelPlugin,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import { runMessageAction } from "./message-action-runner.js";

export const slackConfig = {
  channels: {
    slack: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
    },
  },
} as OpenClawConfig;

export const whatsappConfig = {
  channels: {
    whatsapp: {
      allowFrom: ["*"],
    },
  },
} as OpenClawConfig;

export const directOutbound: ChannelOutboundAdapter = { deliveryMode: "direct" };

export const runDryAction = (params: {
  cfg: OpenClawConfig;
  action: ChannelMessageActionName;
  actionParams: Record<string, unknown>;
  toolContext?: Record<string, unknown>;
  abortSignal?: AbortSignal;
  sandboxRoot?: string;
}) =>
  runMessageAction({
    cfg: params.cfg,
    action: params.action,
    params: params.actionParams as never,
    toolContext: params.toolContext as never,
    dryRun: true,
    abortSignal: params.abortSignal,
    sandboxRoot: params.sandboxRoot,
  });

export const runDrySend = (params: {
  cfg: OpenClawConfig;
  actionParams: Record<string, unknown>;
  toolContext?: Record<string, unknown>;
  abortSignal?: AbortSignal;
  sandboxRoot?: string;
}) =>
  runDryAction({
    ...params,
    action: "send",
  });

type ResolvedTestTarget = { to: string; kind: ChannelDirectoryEntryKind };

export function normalizeSlackTarget(raw: string): string {
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

export function createConfiguredTestPlugin(params: {
  id: "slack" | "telegram" | "whatsapp";
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

export const slackTestPlugin = createConfiguredTestPlugin({
  id: "slack",
  isConfigured: (cfg) => Boolean(cfg.channels?.slack?.botToken?.trim()),
  normalizeTarget: (raw) => normalizeSlackTarget(raw) || undefined,
  resolveTarget: (input) => {
    const normalized = normalizeSlackTarget(input);
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

export const telegramTestPlugin = createConfiguredTestPlugin({
  id: "telegram",
  isConfigured: (cfg) => Boolean(cfg.channels?.telegram?.botToken?.trim()),
  normalizeTarget: (raw) => raw.trim() || undefined,
  resolveTarget: (input) => {
    const normalized = input.trim();
    if (!normalized) {
      return null;
    }
    return {
      to: normalized.replace(/^telegram:/i, ""),
      kind: normalized.startsWith("@") ? "user" : "group",
    };
  },
});

export const whatsappTestPlugin = createConfiguredTestPlugin({
  id: "whatsapp",
  isConfigured: (cfg) => Boolean(cfg.channels?.whatsapp),
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
