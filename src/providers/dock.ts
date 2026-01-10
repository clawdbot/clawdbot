import type { ClawdbotConfig } from "../config/config.js";
import { resolveDiscordAccount } from "../discord/accounts.js";
import { resolveIMessageAccount } from "../imessage/accounts.js";
import { resolveSignalAccount } from "../signal/accounts.js";
import { resolveSlackAccount } from "../slack/accounts.js";
import { resolveTelegramAccount } from "../telegram/accounts.js";
import { normalizeE164 } from "../utils.js";
import { resolveWhatsAppAccount } from "../web/accounts.js";
import { normalizeWhatsAppTarget } from "../whatsapp/normalize.js";
import {
  resolveDiscordGroupRequireMention,
  resolveIMessageGroupRequireMention,
  resolveSlackGroupRequireMention,
  resolveTelegramGroupRequireMention,
  resolveWhatsAppGroupRequireMention,
} from "./plugins/group-mentions.js";
import type {
  ProviderCapabilities,
  ProviderCommandAdapter,
  ProviderElevatedAdapter,
  ProviderGroupAdapter,
  ProviderId,
  ProviderMentionAdapter,
  ProviderThreadingAdapter,
} from "./plugins/types.js";
import { CHAT_PROVIDER_ORDER } from "./registry.js";

export type ProviderDock = {
  id: ProviderId;
  capabilities: ProviderCapabilities;
  commands?: ProviderCommandAdapter;
  outbound?: {
    textChunkLimit?: number;
  };
  streaming?: ProviderDockStreaming;
  elevated?: ProviderElevatedAdapter;
  config?: {
    resolveAllowFrom?: (params: {
      cfg: ClawdbotConfig;
      accountId?: string | null;
    }) => Array<string | number> | undefined;
    formatAllowFrom?: (params: {
      cfg: ClawdbotConfig;
      accountId?: string | null;
      allowFrom: Array<string | number>;
    }) => string[];
  };
  groups?: ProviderGroupAdapter;
  mentions?: ProviderMentionAdapter;
  threading?: ProviderThreadingAdapter;
};

type ProviderDockStreaming = {
  blockStreamingCoalesceDefaults?: {
    minChars?: number;
    idleMs?: number;
  };
};

const formatLower = (allowFrom: Array<string | number>) =>
  allowFrom
    .map((entry) => String(entry).trim())
    .filter(Boolean)
    .map((entry) => entry.toLowerCase());

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Provider docks: lightweight provider metadata/behavior for shared code paths.
//
// Rules:
// - keep this module *light* (no monitors, probes, puppeteer/web login, etc)
// - OK: config readers, allowFrom formatting, mention stripping patterns, threading defaults
// - shared code should import from here (and from `src/providers/registry.ts`), not from the plugins registry
//
// Adding a provider:
// - add a new entry to `DOCKS`
// - keep it cheap; push heavy logic into `src/providers/plugins/<id>.ts` or provider modules
const DOCKS: Record<ProviderId, ProviderDock> = {
  telegram: {
    id: "telegram",
    capabilities: {
      chatTypes: ["direct", "group", "channel", "thread"],
      nativeCommands: true,
      blockStreaming: true,
    },
    outbound: { textChunkLimit: 4000 },
    config: {
      resolveAllowFrom: ({ cfg, accountId }) =>
        (resolveTelegramAccount({ cfg, accountId }).config.allowFrom ?? []).map(
          (entry) => String(entry),
        ),
      formatAllowFrom: ({ allowFrom }) =>
        allowFrom
          .map((entry) => String(entry).trim())
          .filter(Boolean)
          .map((entry) => entry.replace(/^(telegram|tg):/i, ""))
          .map((entry) => entry.toLowerCase()),
    },
    groups: {
      resolveRequireMention: resolveTelegramGroupRequireMention,
    },
    threading: {
      resolveReplyToMode: ({ cfg }) => cfg.telegram?.replyToMode ?? "first",
    },
  },
  whatsapp: {
    id: "whatsapp",
    capabilities: {
      chatTypes: ["direct", "group"],
      polls: true,
      reactions: true,
      media: true,
    },
    commands: {
      enforceOwnerForCommands: true,
      skipWhenConfigEmpty: true,
    },
    outbound: { textChunkLimit: 4000 },
    config: {
      resolveAllowFrom: ({ cfg, accountId }) =>
        resolveWhatsAppAccount({ cfg, accountId }).allowFrom ?? [],
      formatAllowFrom: ({ allowFrom }) =>
        allowFrom
          .map((entry) => String(entry).trim())
          .filter((entry): entry is string => Boolean(entry))
          .map((entry) =>
            entry === "*" ? entry : normalizeWhatsAppTarget(entry),
          )
          .filter((entry): entry is string => Boolean(entry)),
    },
    groups: {
      resolveRequireMention: resolveWhatsAppGroupRequireMention,
      resolveGroupIntroHint: () =>
        "WhatsApp IDs: SenderId is the participant JID; [message_id: ...] is the message id for reactions (use SenderId as participant).",
    },
    mentions: {
      stripPatterns: ({ ctx }) => {
        const selfE164 = (ctx.To ?? "").replace(/^whatsapp:/, "");
        if (!selfE164) return [];
        const escaped = escapeRegExp(selfE164);
        return [escaped, `@${escaped}`];
      },
    },
  },
  discord: {
    id: "discord",
    capabilities: {
      chatTypes: ["direct", "channel", "thread"],
      polls: true,
      reactions: true,
      media: true,
      nativeCommands: true,
      threads: true,
    },
    outbound: { textChunkLimit: 2000 },
    streaming: {
      blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
    },
    elevated: {
      allowFromFallback: ({ cfg }) => cfg.discord?.dm?.allowFrom,
    },
    config: {
      resolveAllowFrom: ({ cfg, accountId }) =>
        (
          resolveDiscordAccount({ cfg, accountId }).config.dm?.allowFrom ?? []
        ).map((entry) => String(entry)),
      formatAllowFrom: ({ allowFrom }) => formatLower(allowFrom),
    },
    groups: {
      resolveRequireMention: resolveDiscordGroupRequireMention,
    },
    mentions: {
      stripPatterns: () => ["<@!?\\d+>"],
    },
    threading: {
      resolveReplyToMode: ({ cfg }) => cfg.discord?.replyToMode ?? "off",
    },
  },
  slack: {
    id: "slack",
    capabilities: {
      chatTypes: ["direct", "channel", "thread"],
      reactions: true,
      media: true,
      nativeCommands: true,
      threads: true,
    },
    outbound: { textChunkLimit: 4000 },
    streaming: {
      blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
    },
    config: {
      resolveAllowFrom: ({ cfg, accountId }) =>
        (resolveSlackAccount({ cfg, accountId }).dm?.allowFrom ?? []).map(
          (entry) => String(entry),
        ),
      formatAllowFrom: ({ allowFrom }) => formatLower(allowFrom),
    },
    groups: {
      resolveRequireMention: resolveSlackGroupRequireMention,
    },
    threading: {
      resolveReplyToMode: ({ cfg, accountId }) =>
        resolveSlackAccount({ cfg, accountId }).replyToMode ?? "off",
      allowTagsWhenOff: true,
      buildToolContext: ({ cfg, accountId, context, hasRepliedRef }) => {
        const configuredReplyToMode =
          resolveSlackAccount({ cfg, accountId }).replyToMode ?? "off";
        const effectiveReplyToMode = context.ThreadLabel
          ? "all"
          : configuredReplyToMode;
        return {
          currentChannelId: context.To?.startsWith("channel:")
            ? context.To.slice("channel:".length)
            : undefined,
          currentThreadTs: context.ReplyToId,
          replyToMode: effectiveReplyToMode,
          hasRepliedRef,
        };
      },
    },
  },
  signal: {
    id: "signal",
    capabilities: {
      chatTypes: ["direct", "group"],
      reactions: true,
      media: true,
    },
    outbound: { textChunkLimit: 4000 },
    streaming: {
      blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
    },
    config: {
      resolveAllowFrom: ({ cfg, accountId }) =>
        (resolveSignalAccount({ cfg, accountId }).config.allowFrom ?? []).map(
          (entry) => String(entry),
        ),
      formatAllowFrom: ({ allowFrom }) =>
        allowFrom
          .map((entry) => String(entry).trim())
          .filter(Boolean)
          .map((entry) =>
            entry === "*" ? "*" : normalizeE164(entry.replace(/^signal:/i, "")),
          )
          .filter(Boolean),
    },
  },
  imessage: {
    id: "imessage",
    capabilities: {
      chatTypes: ["direct", "group"],
      reactions: true,
      media: true,
    },
    outbound: { textChunkLimit: 4000 },
    config: {
      resolveAllowFrom: ({ cfg, accountId }) =>
        (resolveIMessageAccount({ cfg, accountId }).config.allowFrom ?? []).map(
          (entry) => String(entry),
        ),
      formatAllowFrom: ({ allowFrom }) =>
        allowFrom.map((entry) => String(entry).trim()).filter(Boolean),
    },
    groups: {
      resolveRequireMention: resolveIMessageGroupRequireMention,
    },
  },
  msteams: {
    id: "msteams",
    capabilities: {
      chatTypes: ["direct", "channel", "thread"],
      polls: true,
      threads: true,
      media: true,
    },
    outbound: { textChunkLimit: 4000 },
    config: {
      resolveAllowFrom: ({ cfg }) => cfg.msteams?.allowFrom ?? [],
      formatAllowFrom: ({ allowFrom }) => formatLower(allowFrom),
    },
  },
};

export function listProviderDocks(): ProviderDock[] {
  return CHAT_PROVIDER_ORDER.map((id) => DOCKS[id]);
}

export function getProviderDock(id: ProviderId): ProviderDock | undefined {
  return DOCKS[id];
}
