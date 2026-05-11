import { getChannelPlugin } from "../../channels/plugins/index.js";
import type {
  ChannelId,
  ChannelMessageActionName,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MessageToolsConfig } from "../../config/types.tools.js";
import type { MessagePresentation } from "../../interactive/payload.js";
import { normalizeTargetForProvider } from "./target-normalization.js";
import { formatTargetDisplay, lookupDirectoryDisplay } from "./target-resolver.js";

export type CrossContextPresentationBuilder = (message: string) => MessagePresentation;

export type CrossContextDecoration = {
  prefix: string;
  suffix: string;
  presentationBuilder?: CrossContextPresentationBuilder;
};

const CONTEXT_GUARDED_ACTIONS = new Set<ChannelMessageActionName>([
  "send",
  "poll",
  "reply",
  "sendWithEffect",
  "sendAttachment",
  "upload-file",
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
  "upload-file",
  "thread-reply",
  "sticker",
]);

function resolveContextGuardTarget(
  action: ChannelMessageActionName,
  params: Record<string, unknown>,
): string | undefined {
  if (!CONTEXT_GUARDED_ACTIONS.has(action)) {
    return undefined;
  }

  if (action === "thread-reply" || action === "thread-create") {
    if (typeof params.channelId === "string") {
      return params.channelId;
    }
    if (typeof params.to === "string") {
      return params.to;
    }
    return undefined;
  }

  if (typeof params.to === "string") {
    return params.to;
  }
  if (typeof params.channelId === "string") {
    return params.channelId;
  }
  return undefined;
}

function normalizeTarget(channel: ChannelId, raw: string): string | undefined {
  return normalizeTargetForProvider(channel, raw) ?? raw.trim();
}

function isCrossContextTarget(params: {
  channel: ChannelId;
  target: string;
  toolContext?: ChannelThreadingToolContext;
}): boolean {
  const currentTarget = params.toolContext?.currentChannelId?.trim();
  if (!currentTarget) {
    return false;
  }
  const normalizedTarget = normalizeTarget(params.channel, params.target);
  const normalizedCurrent = normalizeTarget(params.channel, currentTarget);
  if (!normalizedTarget || !normalizedCurrent) {
    return false;
  }
  return normalizedTarget !== normalizedCurrent;
}

function resolveAgentMessageToolsConfig(
  cfg: OpenClawConfig,
  agentId?: string | null,
): MessageToolsConfig | undefined {
  const trimmedAgentId = agentId?.trim();
  const globalConfig = cfg.tools?.message;
  if (!trimmedAgentId) {
    return globalConfig;
  }
  const agentConfig = cfg.agents?.list?.find((entry) => entry.id === trimmedAgentId)?.tools
    ?.message;
  if (!agentConfig) {
    return globalConfig;
  }
  return {
    ...globalConfig,
    ...agentConfig,
    crossContext:
      globalConfig?.crossContext || agentConfig.crossContext
        ? {
            ...globalConfig?.crossContext,
            ...agentConfig.crossContext,
            marker:
              globalConfig?.crossContext?.marker || agentConfig.crossContext?.marker
                ? {
                    ...globalConfig?.crossContext?.marker,
                    ...agentConfig.crossContext?.marker,
                  }
                : undefined,
          }
        : undefined,
    broadcast:
      globalConfig?.broadcast || agentConfig.broadcast
        ? {
            ...globalConfig?.broadcast,
            ...agentConfig.broadcast,
          }
        : undefined,
    actions:
      globalConfig?.actions || agentConfig.actions
        ? {
            ...globalConfig?.actions,
            ...agentConfig.actions,
          }
        : undefined,
  };
}

export function resolveEffectiveMessageToolsConfig(params: {
  cfg: OpenClawConfig;
  agentId?: string | null;
}): MessageToolsConfig | undefined {
  return resolveAgentMessageToolsConfig(params.cfg, params.agentId);
}

export function resolveAllowedMessageActions(params: {
  cfg: OpenClawConfig;
  agentId?: string | null;
}): string[] | undefined {
  const allow = resolveEffectiveMessageToolsConfig(params)?.actions?.allow;
  if (!allow) {
    return undefined;
  }
  const normalized = allow.map((entry) => entry.trim()).filter(Boolean);
  return normalized.length > 0 ? Array.from(new Set(normalized)) : undefined;
}

export function enforceMessageActionAllowlist(params: {
  cfg: OpenClawConfig;
  agentId?: string | null;
  action: ChannelMessageActionName;
}): void {
  const allowed = resolveAllowedMessageActions(params);
  if (!allowed || allowed.includes(params.action)) {
    return;
  }
  throw new Error(`Message action "${params.action}" is disabled for this agent.`);
}

export function enforceCrossContextPolicy(params: {
  channel: ChannelId;
  action: ChannelMessageActionName;
  args: Record<string, unknown>;
  toolContext?: ChannelThreadingToolContext;
  cfg: OpenClawConfig;
  agentId?: string | null;
}): void {
  const currentTarget = params.toolContext?.currentChannelId?.trim();
  if (!currentTarget) {
    return;
  }
  if (!CONTEXT_GUARDED_ACTIONS.has(params.action)) {
    return;
  }

  const messageConfig = resolveEffectiveMessageToolsConfig({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  if (messageConfig?.allowCrossContextSend) {
    return;
  }

  const currentProvider = params.toolContext?.currentChannelProvider;
  const allowWithinProvider = messageConfig?.crossContext?.allowWithinProvider !== false;
  const allowAcrossProviders = messageConfig?.crossContext?.allowAcrossProviders === true;

  if (currentProvider && currentProvider !== params.channel) {
    if (!allowAcrossProviders) {
      throw new Error(
        `Cross-context messaging denied: action=${params.action} target provider "${params.channel}" while bound to "${currentProvider}".`,
      );
    }
    return;
  }

  if (allowWithinProvider) {
    return;
  }

  const target = resolveContextGuardTarget(params.action, params.args);
  if (!target) {
    return;
  }

  if (!isCrossContextTarget({ channel: params.channel, target, toolContext: params.toolContext })) {
    return;
  }

  throw new Error(
    `Cross-context messaging denied: action=${params.action} target="${target}" while bound to "${currentTarget}" (channel=${params.channel}).`,
  );
}

export async function buildCrossContextDecoration(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  target: string;
  toolContext?: ChannelThreadingToolContext;
  accountId?: string | null;
  agentId?: string | null;
}): Promise<CrossContextDecoration | null> {
  if (!params.toolContext?.currentChannelId) {
    return null;
  }
  // Skip decoration for direct tool sends (agent composing, not forwarding)
  if (params.toolContext.skipCrossContextDecoration) {
    return null;
  }
  if (!isCrossContextTarget(params)) {
    return null;
  }

  const markerConfig = resolveEffectiveMessageToolsConfig({
    cfg: params.cfg,
    agentId: params.agentId,
  })?.crossContext?.marker;
  if (markerConfig?.enabled === false) {
    return null;
  }

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

  const buildPresentation = getChannelPlugin(params.channel)?.messaging
    ?.buildCrossContextPresentation;
  const presentationBuilder = buildPresentation
    ? (message: string) =>
        buildPresentation({
          originLabel,
          message,
          cfg: params.cfg,
          accountId: params.accountId ?? undefined,
        })
    : undefined;

  return { prefix, suffix, presentationBuilder };
}

export function shouldApplyCrossContextMarker(action: ChannelMessageActionName): boolean {
  return CONTEXT_MARKER_ACTIONS.has(action);
}

export function applyCrossContextDecoration(params: {
  message: string;
  decoration: CrossContextDecoration;
  preferPresentation: boolean;
}): {
  message: string;
  presentation?: MessagePresentation;
  usedPresentation: boolean;
} {
  const usePresentation = params.preferPresentation && params.decoration.presentationBuilder;
  if (usePresentation) {
    return {
      message: params.message,
      presentation: params.decoration.presentationBuilder?.(params.message),
      usedPresentation: true,
    };
  }
  const message = `${params.decoration.prefix}${params.message}${params.decoration.suffix}`;
  return { message, usedPresentation: false };
}
