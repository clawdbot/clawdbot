// Msteams plugin module implements policy behavior.
import {
  resolveScopeToolsPolicy,
  scopeKey,
  type ScopeTree,
} from "openclaw/plugin-sdk/channel-policy";
import type {
  AllowlistMatch,
  ChannelGroupContext,
  GroupToolPolicyConfig,
  MSTeamsChannelConfig,
  MSTeamsConfig,
  MSTeamsReplyStyle,
  MSTeamsTeamConfig,
} from "../runtime-api.js";
import {
  buildChannelKeyCandidates,
  normalizeChannelSlug,
  resolveAllowlistMatchSimple,
  resolveChannelEntryMatchWithFallback,
  resolveNestedAllowlistDecision,
} from "../runtime-api.js";

type MSTeamsResolvedRouteConfig = {
  teamConfig?: MSTeamsTeamConfig;
  channelConfig?: MSTeamsChannelConfig;
  allowlistConfigured: boolean;
  allowed: boolean;
  teamKey?: string;
  channelKey?: string;
  channelMatchKey?: string;
  channelMatchSource?: "direct" | "wildcard";
};

// Length-prefixed segments keep arbitrary config keys, including slashes, collision-free.
const teamScopeKey = (teamKey: string) => scopeKey(["team", teamKey]);
const channelScopeKey = (teamKey: string, channelKey: string) =>
  scopeKey(["team", teamKey], ["channel", channelKey]);

function buildMSTeamsToolPolicyTree(teams: MSTeamsConfig["teams"]): ScopeTree {
  const scopes: ScopeTree["scopes"] = {};
  for (const [teamKey, team] of Object.entries(teams ?? {})) {
    scopes[teamScopeKey(teamKey)] = {
      tools: team.tools,
      toolsBySender: team.toolsBySender,
    };
    for (const [channelKey, channel] of Object.entries(team.channels ?? {})) {
      scopes[channelScopeKey(teamKey, channelKey)] = {
        tools: channel.tools,
        toolsBySender: channel.toolsBySender,
      };
    }
  }
  return { scopes };
}

function resolveMSTeamsToolPolicyScope(params: {
  cfg: MSTeamsConfig;
  groupSpace?: string | null;
  groupId?: string | null;
}) {
  const teams = params.cfg.teams ?? {};
  const tree = buildMSTeamsToolPolicyTree(teams);
  // Each level selects one whole entry, so exact matches hide that level's wildcard.
  // Selected channel fields then cascade into selected team fields through the path.
  const teamMatch = resolveChannelEntryMatchWithFallback({
    entries: teams,
    keys: buildChannelKeyCandidates(params.groupSpace?.trim()),
    wildcardKey: "*",
    normalizeKey: normalizeChannelSlug,
  });
  const matchedTeamKey = teamMatch.matchKey ?? teamMatch.key;
  if (teamMatch.entry && matchedTeamKey) {
    const channelMatch = resolveChannelEntryMatchWithFallback({
      entries: teamMatch.entry.channels ?? {},
      keys: buildChannelKeyCandidates(params.groupId?.trim()),
      wildcardKey: "*",
      normalizeKey: normalizeChannelSlug,
    });
    const matchedChannelKey = channelMatch.matchKey ?? channelMatch.key;
    return {
      tree,
      path: [
        teamScopeKey(matchedTeamKey),
        ...(channelMatch.entry && matchedChannelKey
          ? [channelScopeKey(matchedTeamKey, matchedChannelKey)]
          : []),
      ],
    };
  }
  return { tree, path: [] };
}

function resolveMSTeamsCrossTeamScanScope(params: { cfg: MSTeamsConfig; groupId?: string | null }) {
  const teams = params.cfg.teams ?? {};
  const tree = buildMSTeamsToolPolicyTree(teams);
  const groupId = params.groupId?.trim();
  if (!groupId) {
    return { tree, path: [] };
  }
  const channelCandidates = buildChannelKeyCandidates(groupId);
  // The first channel match in team insertion order owns the path.
  for (const [teamKey, team] of Object.entries(teams)) {
    const channelMatch = resolveChannelEntryMatchWithFallback({
      entries: team.channels ?? {},
      keys: channelCandidates,
      wildcardKey: "*",
      normalizeKey: normalizeChannelSlug,
    });
    const matchedChannelKey = channelMatch.matchKey ?? channelMatch.key;
    if (channelMatch.entry && matchedChannelKey) {
      return {
        tree,
        path: [teamScopeKey(teamKey), channelScopeKey(teamKey, matchedChannelKey)],
      };
    }
  }
  return { tree, path: [] };
}

export function resolveMSTeamsRouteConfig(params: {
  cfg?: MSTeamsConfig;
  teamId?: string | null | undefined;
  teamName?: string | null | undefined;
  conversationId?: string | null | undefined;
  channelName?: string | null | undefined;
  allowNameMatching?: boolean;
}): MSTeamsResolvedRouteConfig {
  const teamId = params.teamId?.trim();
  const teamName = params.teamName?.trim();
  const conversationId = params.conversationId?.trim();
  const channelName = params.channelName?.trim();
  const teams = params.cfg?.teams ?? {};
  const allowlistConfigured = Object.keys(teams).length > 0;
  const teamCandidates = buildChannelKeyCandidates(
    teamId,
    params.allowNameMatching ? teamName : undefined,
    params.allowNameMatching && teamName ? normalizeChannelSlug(teamName) : undefined,
  );
  const teamMatch = resolveChannelEntryMatchWithFallback({
    entries: teams,
    keys: teamCandidates,
    wildcardKey: "*",
    normalizeKey: normalizeChannelSlug,
  });
  const teamConfig = teamMatch.entry;
  const channels = teamConfig?.channels ?? {};
  const channelAllowlistConfigured = Object.keys(channels).length > 0;
  const channelCandidates = buildChannelKeyCandidates(
    conversationId,
    params.allowNameMatching ? channelName : undefined,
    params.allowNameMatching && channelName ? normalizeChannelSlug(channelName) : undefined,
  );
  const channelMatch = resolveChannelEntryMatchWithFallback({
    entries: channels,
    keys: channelCandidates,
    wildcardKey: "*",
    normalizeKey: normalizeChannelSlug,
  });
  const channelConfig = channelMatch.entry;

  const allowed = resolveNestedAllowlistDecision({
    outerConfigured: allowlistConfigured,
    outerMatched: Boolean(teamConfig),
    innerConfigured: channelAllowlistConfigured,
    innerMatched: Boolean(channelConfig),
  });

  return {
    teamConfig,
    channelConfig,
    allowlistConfigured,
    allowed,
    teamKey: teamMatch.matchKey ?? teamMatch.key,
    channelKey: channelMatch.matchKey ?? channelMatch.key,
    channelMatchKey: channelMatch.matchKey,
    channelMatchSource:
      channelMatch.matchSource === "direct" || channelMatch.matchSource === "wildcard"
        ? channelMatch.matchSource
        : undefined,
  };
}

export function resolveMSTeamsGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  const cfg = params.cfg.channels?.msteams;
  if (!cfg) {
    return undefined;
  }
  const scope = resolveMSTeamsToolPolicyScope({
    cfg,
    groupSpace: params.groupSpace,
    groupId: params.groupId,
  });
  // No messageProvider: channel-prefixed sender keys were historically dead here.
  const senderScope = {
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  };
  const resolved = resolveScopeToolsPolicy({ ...scope, ...senderScope });
  if (resolved !== undefined) {
    return resolved;
  }
  // Parity with the legacy resolver: a matched team that yields no policy falls
  // through to the cross-team channel scan, but a matched CHANNEL never does.
  if (scope.path.length > 1) {
    return undefined;
  }
  const scanScope = resolveMSTeamsCrossTeamScanScope({ cfg, groupId: params.groupId });
  return resolveScopeToolsPolicy({ ...scanScope, ...senderScope });
}

type MSTeamsReplyPolicy = {
  requireMention: boolean;
  replyStyle: MSTeamsReplyStyle;
};

type MSTeamsAllowlistMatch = AllowlistMatch<"wildcard" | "id" | "name">;

export function resolveMSTeamsAllowlistMatch(params: {
  allowFrom: ReadonlyArray<string | number>;
  senderId: string;
  senderName?: string | null;
  allowNameMatching?: boolean;
}): MSTeamsAllowlistMatch {
  return resolveAllowlistMatchSimple(params);
}

export function resolveMSTeamsReplyPolicy(params: {
  isDirectMessage: boolean;
  globalConfig?: MSTeamsConfig;
  teamConfig?: MSTeamsTeamConfig;
  channelConfig?: MSTeamsChannelConfig;
}): MSTeamsReplyPolicy {
  if (params.isDirectMessage) {
    return { requireMention: false, replyStyle: "thread" };
  }

  const requireMention =
    params.channelConfig?.requireMention ??
    params.teamConfig?.requireMention ??
    params.globalConfig?.requireMention ??
    true;

  const explicitReplyStyle =
    params.channelConfig?.replyStyle ??
    params.teamConfig?.replyStyle ??
    params.globalConfig?.replyStyle;

  const replyStyle: MSTeamsReplyStyle =
    explicitReplyStyle ?? (requireMention ? "thread" : "top-level");

  return { requireMention, replyStyle };
}
