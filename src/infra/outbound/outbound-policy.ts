import { normalizeTargetForProvider } from "./target-normalization.js";
import type {
  ChannelId,
  ChannelMessageActionName,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.js";
import type { MoltbotConfig } from "../../config/config.js";
import { getChannelMessageAdapter } from "./channel-adapters.js";
import { formatTargetDisplay, lookupDirectoryDisplay } from "./target-resolver.js";

export type CrossContextDecoration = {
  prefix: string;
  suffix: string;
  embeds?: unknown[];
};

const CONTEXT_GUARDED_ACTIONS = new Set<ChannelMessageActionName>([
  "send",
  "poll",
  "reply",
  "sendWithEffect",
  "sendAttachment",
  "thread-create",
  "thread-reply",
  "sticker",
]);

const CONTEXT_MARKER_ACTIONS = new Set<ChannelMessageActionName>([
  "send",
  "poll",
  "reply",
  "sendWithEffect",
  "sendAttachment",
  "thread-reply",
  "sticker",
]);

function resolveContextGuardTarget(
  action: ChannelMessageActionName,
  params: Record<string, unknown>,
): string | undefined {
  if (!CONTEXT_GUARDED_ACTIONS.has(action)) return undefined;

  if (action === "thread-reply" || action === "thread-create") {
    if (typeof params.channelId === "string") return params.channelId;
    if (typeof params.to === "string") return params.to;
    return undefined;
  }

  if (typeof params.to === "string") return params.to;
  if (typeof params.channelId === "string") return params.channelId;
  return undefined;
}

function normalizeTarget(channel: ChannelId, raw: string): string | undefined {
  return normalizeTargetForProvider(channel, raw) ?? raw.trim().toLowerCase();
}

function isCrossContextTarget(params: {
  channel: ChannelId;
  target: string;
  toolContext?: ChannelThreadingToolContext;
}): boolean {
  const currentTarget = params.toolContext?.currentChannelId?.trim();
  if (!currentTarget) return false;
  const normalizedTarget = normalizeTarget(params.channel, params.target);
  const normalizedCurrent = normalizeTarget(params.channel, currentTarget);
  if (!normalizedTarget || !normalizedCurrent) return false;
  return normalizedTarget !== normalizedCurrent;
}

export function enforceCrossContextPolicy(params: {
  channel: ChannelId;
  action: ChannelMessageActionName;
  args: Record<string, unknown>;
  toolContext?: ChannelThreadingToolContext;
  cfg: MoltbotConfig;
}): void {
  const currentTarget = params.toolContext?.currentChannelId?.trim();
  if (!currentTarget) return;
  if (!CONTEXT_GUARDED_ACTIONS.has(params.action)) return;

  if (params.cfg.tools?.message?.allowCrossContextSend) return;

  const currentProvider = params.toolContext?.currentChannelProvider;
  const allowWithinProvider =
    params.cfg.tools?.message?.crossContext?.allowWithinProvider !== false;
  const allowAcrossProviders =
    params.cfg.tools?.message?.crossContext?.allowAcrossProviders === true;

  if (currentProvider && currentProvider !== params.channel) {
    if (!allowAcrossProviders) {
      throw new Error(
        `Cross-context messaging denied: action=${params.action} target provider "${params.channel}" while bound to "${currentProvider}".`,
      );
    }
    return;
  }

  if (allowWithinProvider) return;

  const target = resolveContextGuardTarget(params.action, params.args);
  if (!target) return;

  if (!isCrossContextTarget({ channel: params.channel, target, toolContext: params.toolContext })) {
    return;
  }

  throw new Error(
    `Cross-context messaging denied: action=${params.action} target="${target}" while bound to "${currentTarget}" (channel=${params.channel}).`,
  );
}

export async function buildCrossContextDecoration(params: {
  cfg: MoltbotConfig;
  channel: ChannelId;
  target: string;
  toolContext?: ChannelThreadingToolContext;
  accountId?: string | null;
}): Promise<CrossContextDecoration | null> {
  if (!params.toolContext?.currentChannelId) return null;
  // Skip decoration for direct tool sends (agent composing, not forwarding)
  if (params.toolContext.skipCrossContextDecoration) return null;
  if (!isCrossContextTarget(params)) return null;

  const markerConfig = params.cfg.tools?.message?.crossContext?.marker;
  if (markerConfig?.enabled === false) return null;

  const currentName =
    (await lookupDirectoryDisplay({
      cfg: params.cfg,
      channel: params.channel,
      targetId: params.toolContext.currentChannelId,
      accountId: params.accountId ?? undefined,
    })) ?? params.toolContext.currentChannelId;
  // Don't force group formatting here; currentChannelId can be a DM or a group.
  const originLabel = formatTargetDisplay({
    channel: params.channel,
    target: params.toolContext.currentChannelId,
    display: currentName,
  });
  const prefixTemplate = markerConfig?.prefix ?? "[from {channel}] ";
  const suffixTemplate = markerConfig?.suffix ?? "";
  const prefix = prefixTemplate.replaceAll("{channel}", originLabel);
  const suffix = suffixTemplate.replaceAll("{channel}", originLabel);

  const adapter = getChannelMessageAdapter(params.channel);
  const embeds = adapter.supportsEmbeds
    ? (adapter.buildCrossContextEmbeds?.(originLabel) ?? undefined)
    : undefined;

  return { prefix, suffix, embeds };
}

export function shouldApplyCrossContextMarker(action: ChannelMessageActionName): boolean {
  return CONTEXT_MARKER_ACTIONS.has(action);
}

export function applyCrossContextDecoration(params: {
  message: string;
  decoration: CrossContextDecoration;
  preferEmbeds: boolean;
}): { message: string; embeds?: unknown[]; usedEmbeds: boolean } {
  const useEmbeds = params.preferEmbeds && params.decoration.embeds?.length;
  if (useEmbeds) {
    return { message: params.message, embeds: params.decoration.embeds, usedEmbeds: true };
  }
  const message = `${params.decoration.prefix}${params.message}${params.decoration.suffix}`;
  return { message, usedEmbeds: false };
}
