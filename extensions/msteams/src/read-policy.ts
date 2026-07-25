import { ToolAuthorizationError } from "openclaw/plugin-sdk/channel-actions";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawConfig } from "../runtime-api.js";
import { isDangerousNameMatchingEnabled, resolveDefaultGroupPolicy } from "../runtime-api.js";
import { listChannelsForTeamWithPageInfo, resolveGraphToken } from "./graph.js";
import { resolveMSTeamsRouteConfig } from "./policy.js";
import {
  normalizeMSTeamsMessagingTarget,
  looksLikeMSTeamsConversationId,
  resolveMSTeamsChannelAllowlist,
  resolveMSTeamsTeamsConfig,
  resolveMSTeamsUserAllowlist,
} from "./resolve-allowlist.js";

type MSTeamsReadContext = Pick<
  ChannelMessageActionContext,
  "accountId" | "conversationReadOrigin" | "requesterAccountId" | "toolContext"
>;

function normalizeTarget(raw?: string | null): string {
  return raw ? (normalizeMSTeamsMessagingTarget(raw) ?? "") : "";
}

function sameAccount(ctx: MSTeamsReadContext): boolean {
  const requested = normalizeOptionalString(ctx.accountId) ?? "default";
  const requester = normalizeOptionalString(ctx.requesterAccountId);
  return requester !== undefined && requester === requested;
}

export function isCurrentMSTeamsReadTarget(params: {
  ctx: MSTeamsReadContext;
  target: string;
}): boolean {
  if (
    normalizeOptionalString(params.ctx.toolContext?.currentChannelProvider)?.toLowerCase() !==
      "msteams" ||
    !sameAccount(params.ctx)
  ) {
    return false;
  }
  const candidates = [
    params.ctx.toolContext?.currentChannelId,
    params.ctx.toolContext?.currentMessagingTarget,
    params.ctx.toolContext?.currentGraphChannelId,
  ];
  const target = normalizeTarget(params.target);
  return candidates.some((candidate) => normalizeTarget(candidate) === target);
}

function normalizeUserTarget(target: string): string {
  return target
    .replace(/^user:/i, "")
    .trim()
    .toLowerCase();
}

function isStableUserId(value: string): boolean {
  return /^[0-9a-f-]{16,}$/i.test(value);
}

async function resolveAllowedDmTarget(
  cfg: OpenClawConfig,
  target: string,
): Promise<string | undefined> {
  const teams = cfg.channels?.msteams;
  if (teams?.dmPolicy === "disabled") {
    return undefined;
  }
  const userId = normalizeUserTarget(target);
  if (!userId) {
    return undefined;
  }
  const allowFrom = teams?.allowFrom ?? [];
  const normalizedEntries = allowFrom.map((entry) =>
    normalizeUserTarget(entry.replace(/^(msteams|teams):/i, "")),
  );
  const allowAll = (teams?.dmPolicy ?? "pairing") === "open" || normalizedEntries.includes("*");
  if (isStableUserId(userId)) {
    return allowAll || normalizedEntries.some((entry) => entry === userId)
      ? `user:${userId}`
      : undefined;
  }
  if (!isDangerousNameMatchingEnabled(teams)) {
    return undefined;
  }
  try {
    const [resolvedTarget, ...resolvedEntries] = await resolveMSTeamsUserAllowlist({
      cfg,
      entries: [userId, ...normalizedEntries.filter((entry) => entry !== "*")],
    });
    if (!resolvedTarget?.resolved || !resolvedTarget.id) {
      return undefined;
    }
    const allowed =
      allowAll ||
      resolvedEntries.some(
        (entry) => entry.resolved && entry.id?.toLowerCase() === resolvedTarget.id?.toLowerCase(),
      );
    return allowed ? `user:${resolvedTarget.id}` : undefined;
  } catch {
    return undefined;
  }
}

async function resolveDirectDmTarget(
  cfg: OpenClawConfig,
  target: string,
): Promise<string | undefined> {
  if (cfg.channels?.msteams?.dmPolicy === "disabled") {
    return undefined;
  }
  const userId = normalizeUserTarget(target);
  if (!userId) {
    return undefined;
  }
  if (isStableUserId(userId)) {
    return `user:${userId}`;
  }
  if (!isDangerousNameMatchingEnabled(cfg.channels?.msteams)) {
    return undefined;
  }
  try {
    const [resolved] = await resolveMSTeamsUserAllowlist({ cfg, entries: [userId] });
    return resolved?.resolved && resolved.id ? `user:${resolved.id}` : undefined;
  } catch {
    return undefined;
  }
}

function resolveMSTeamsReadGroupPolicy(cfg: OpenClawConfig) {
  const teams = cfg.channels?.msteams;
  return teams ? (teams.groupPolicy ?? resolveDefaultGroupPolicy(cfg) ?? "allowlist") : "disabled";
}

function isStableChannelKey(value: string): boolean {
  return /^[0-9a-f-]{16,}$/i.test(value) || /^19:.+@thread\./i.test(value);
}

function isStableGraphTeamId(value: string): boolean {
  return /^[0-9a-f-]{16,}$/i.test(value);
}

function isStableGraphChannelTarget(target: string): boolean {
  const [teamId, channelId] = target.split("/", 2);
  return Boolean(
    teamId && channelId && isStableGraphTeamId(teamId) && isStableChannelKey(channelId),
  );
}

function hasMutableChannelConfig(cfg: OpenClawConfig): boolean {
  const teams = cfg.channels?.msteams?.teams ?? {};
  return Object.entries(teams).some(([teamKey, teamConfig]) => {
    if (teamKey !== "*" && !isStableChannelKey(teamKey)) {
      return true;
    }
    return Object.keys(teamConfig?.channels ?? {}).some(
      (channelKey) => channelKey !== "*" && !isStableChannelKey(channelKey),
    );
  });
}

async function resolveConfiguredBotFrameworkTeamKey(
  cfg: OpenClawConfig,
  graphTeamId: string,
): Promise<string | undefined> {
  const configuredTeams = cfg.channels?.msteams?.teams;
  if (!configuredTeams) {
    return undefined;
  }
  const stableConfiguredKeys = Object.keys(configuredTeams).filter(
    (teamKey) => teamKey !== "*" && /^19:.+@thread\./i.test(teamKey),
  );
  if (stableConfiguredKeys.length === 0) {
    return undefined;
  }
  // Bot Framework identifies a team with a channel conversation id, while
  // Graph reads use the Entra group id. Roster membership proves the mapping
  // without relying on the localized General channel display name.
  const token = await resolveGraphToken(cfg);
  const channelResult = await listChannelsForTeamWithPageInfo(token, graphTeamId);
  if (channelResult.truncated) {
    return undefined;
  }
  const channelIds = new Set(
    channelResult.items
      .map((channel) => channel.id?.trim())
      .filter((channelId): channelId is string => Boolean(channelId)),
  );
  const matches = stableConfiguredKeys.filter((teamKey) => channelIds.has(teamKey));
  return matches.length === 1 ? matches[0] : undefined;
}

async function resolveStableChannelTarget(
  cfg: OpenClawConfig,
  target: string,
): Promise<string | undefined> {
  if (isStableGraphChannelTarget(target)) {
    return target;
  }
  if (!isDangerousNameMatchingEnabled(cfg.channels?.msteams)) {
    return undefined;
  }
  try {
    const [resolved] = await resolveMSTeamsChannelAllowlist({ cfg, entries: [target] });
    return resolved?.resolved && resolved.graphTeamId && resolved.channelId
      ? `${resolved.graphTeamId}/${resolved.channelId}`
      : undefined;
  } catch {
    return undefined;
  }
}

async function resolveAllowedChannelTarget(
  cfg: OpenClawConfig,
  target: string,
): Promise<string | undefined> {
  const teams = cfg.channels?.msteams;
  const groupPolicy = resolveMSTeamsReadGroupPolicy(cfg);
  if (groupPolicy === "disabled") {
    return undefined;
  }
  const [teamId, channelId] = target.split("/", 2);
  if (!teamId || !channelId) {
    return undefined;
  }
  const directRoute = resolveMSTeamsRouteConfig({
    cfg: teams,
    teamId,
    teamName: teamId,
    conversationId: channelId,
    channelName: channelId,
    allowNameMatching: isDangerousNameMatchingEnabled(teams),
  });
  const stableTarget = await resolveStableChannelTarget(cfg, target);
  if (directRoute.allowed) {
    return stableTarget;
  }
  if (!directRoute.allowlistConfigured) {
    return groupPolicy === "open" ? stableTarget : undefined;
  }
  if (!stableTarget || !teams?.teams) {
    return undefined;
  }
  const [stableTeamId, stableChannelId] = stableTarget.split("/", 2);
  if (!stableTeamId || !stableChannelId) {
    return undefined;
  }
  try {
    const botFrameworkTeamKey = await resolveConfiguredBotFrameworkTeamKey(cfg, stableTeamId);
    if (botFrameworkTeamKey) {
      const allowed = resolveMSTeamsRouteConfig({
        cfg: teams,
        teamId: botFrameworkTeamKey,
        conversationId: stableChannelId,
      }).allowed;
      if (allowed) {
        return stableTarget;
      }
    }
    if (!hasMutableChannelConfig(cfg)) {
      return undefined;
    }
    const resolved = await resolveMSTeamsTeamsConfig({
      cfg,
      teamIdMode: "graph",
      teams: teams.teams,
    });
    const allowed = resolveMSTeamsRouteConfig({
      cfg: { ...teams, teams: resolved.teams },
      teamId: stableTeamId,
      conversationId: stableChannelId,
    }).allowed;
    return allowed ? stableTarget : undefined;
  } catch {
    return undefined;
  }
}

function bothUnknownScopesAllowed(cfg: OpenClawConfig): boolean {
  const teams = cfg.channels?.msteams;
  return resolveMSTeamsReadGroupPolicy(cfg) === "open" && (teams?.dmPolicy ?? "pairing") === "open";
}

export async function assertMSTeamsReadTargetAllowed(params: {
  cfg: OpenClawConfig;
  ctx: MSTeamsReadContext;
  target: string;
}): Promise<string> {
  const target = normalizeTarget(params.target);
  const isChannel = target.includes("/");
  const isDm = /^user:/i.test(target);
  const isChat = looksLikeMSTeamsConversationId(target);
  const current = isCurrentMSTeamsReadTarget({ ctx: params.ctx, target });
  const directOperator = params.ctx.conversationReadOrigin === "direct-operator";
  const currentChatType = params.ctx.toolContext?.currentChatType;
  const allowedTarget = directOperator
    ? isChannel
      ? resolveMSTeamsReadGroupPolicy(params.cfg) !== "disabled"
        ? await resolveStableChannelTarget(params.cfg, target)
        : undefined
      : isDm
        ? await resolveDirectDmTarget(params.cfg, target)
        : isChat &&
            resolveMSTeamsReadGroupPolicy(params.cfg) !== "disabled" &&
            params.cfg.channels?.msteams?.dmPolicy !== "disabled"
          ? target
          : undefined
    : current
      ? isChannel
        ? resolveMSTeamsReadGroupPolicy(params.cfg) !== "disabled"
          ? target
          : undefined
        : isDm
          ? params.cfg.channels?.msteams?.dmPolicy !== "disabled"
            ? target
            : undefined
          : currentChatType === "direct"
            ? params.cfg.channels?.msteams?.dmPolicy !== "disabled"
              ? target
              : undefined
            : currentChatType === "group" || currentChatType === "channel"
              ? resolveMSTeamsReadGroupPolicy(params.cfg) !== "disabled"
                ? target
                : undefined
              : resolveMSTeamsReadGroupPolicy(params.cfg) !== "disabled" &&
                  params.cfg.channels?.msteams?.dmPolicy !== "disabled"
                ? target
                : undefined
      : isChannel
        ? await resolveAllowedChannelTarget(params.cfg, target)
        : isDm
          ? await resolveAllowedDmTarget(params.cfg, target)
          : isChat
            ? bothUnknownScopesAllowed(params.cfg)
              ? target
              : undefined
            : false;
  if (!allowedTarget) {
    throw new ToolAuthorizationError("Microsoft Teams read target is not allowed.");
  }
  return allowedTarget;
}

export async function assertMSTeamsTeamEnumerationAllowed(params: {
  cfg: OpenClawConfig;
  ctx?: MSTeamsReadContext;
  teamId: string;
}): Promise<string> {
  const teams = params.cfg.channels?.msteams;
  const groupPolicy = resolveMSTeamsReadGroupPolicy(params.cfg);
  if (groupPolicy === "disabled") {
    throw new ToolAuthorizationError("Microsoft Teams channel list is not allowed.");
  }
  const directRoute = resolveMSTeamsRouteConfig({
    cfg: teams,
    teamId: params.teamId,
    teamName: params.teamId,
    conversationId: "__openclaw_all_channels__",
    allowNameMatching: isDangerousNameMatchingEnabled(teams),
  });
  const stableTeamId = isStableGraphTeamId(params.teamId)
    ? params.teamId
    : isDangerousNameMatchingEnabled(teams)
      ? (
          await resolveMSTeamsChannelAllowlist({
            cfg: params.cfg,
            entries: [params.teamId],
          })
        )[0]?.graphTeamId
      : undefined;
  if (!stableTeamId) {
    throw new ToolAuthorizationError(
      "Microsoft Teams channel list requires access to every channel in the team.",
    );
  }
  if (params.ctx?.conversationReadOrigin === "direct-operator") {
    return stableTeamId;
  }
  let allowed = directRoute.allowlistConfigured ? directRoute.allowed : groupPolicy === "open";
  if (!allowed && teams?.teams) {
    try {
      const botFrameworkTeamKey = await resolveConfiguredBotFrameworkTeamKey(
        params.cfg,
        stableTeamId,
      );
      if (botFrameworkTeamKey) {
        allowed = resolveMSTeamsRouteConfig({
          cfg: teams,
          teamId: botFrameworkTeamKey,
          conversationId: "__openclaw_all_channels__",
        }).allowed;
      }
      if (!allowed && hasMutableChannelConfig(params.cfg)) {
        const resolved = await resolveMSTeamsTeamsConfig({
          cfg: params.cfg,
          teamIdMode: "graph",
          teams: teams.teams,
        });
        allowed = resolveMSTeamsRouteConfig({
          cfg: { ...teams, teams: resolved.teams },
          teamId: stableTeamId,
          conversationId: "__openclaw_all_channels__",
        }).allowed;
      }
    } catch {
      allowed = false;
    }
  }
  if (!allowed) {
    throw new ToolAuthorizationError(
      "Microsoft Teams channel list requires access to every channel in the team.",
    );
  }
  return stableTeamId;
}
