// Msteams plugin module implements resolve allowlist behavior.
import { mapAllowlistResolutionInputs } from "openclaw/plugin-sdk/allow-from";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { MSTeamsConfig } from "../runtime-api.js";
import { findGraphUsersByExactIdentity } from "./graph-users.js";
import {
  listChannelsForTeamWithPageInfo,
  listTeamsByNameWithPageInfo,
  normalizeQuery,
  resolveGraphToken,
  type GraphChannel,
  type GraphGroup,
  type GraphUser,
} from "./graph.js";

type MSTeamsChannelResolution = {
  input: string;
  resolved: boolean;
  teamId?: string;
  graphTeamId?: string;
  teamName?: string;
  channelId?: string;
  channelName?: string;
  note?: string;
};

type MSTeamsUserResolution = {
  input: string;
  resolved: boolean;
  id?: string;
  name?: string;
  note?: string;
};

type StableMSTeamsTeamIdMode = "bot-framework" | "graph";

function normalizeExactMatch(value?: string | null): string {
  return normalizeLowercaseStringOrEmpty(value ?? "");
}

function uniqueItemsById<T extends { id?: string }>(items: T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of items) {
    const id = item.id?.trim();
    if (id && !byId.has(id)) {
      byId.set(id, item);
    }
  }
  return [...byId.values()];
}

function findExactTeams(items: GraphGroup[], query: string): GraphGroup[] {
  const normalized = normalizeExactMatch(query);
  return uniqueItemsById(
    items.filter((item) => normalizeExactMatch(item.displayName) === normalized),
  );
}

function findExactChannels(items: GraphChannel[], query: string): GraphChannel[] {
  const normalized = normalizeExactMatch(query);
  return uniqueItemsById(
    items.filter((item) => normalizeExactMatch(item.displayName) === normalized),
  );
}

function findExactUsers(items: GraphUser[], query: string): GraphUser[] {
  const normalized = normalizeExactMatch(query);
  return uniqueItemsById(
    items.filter((item) =>
      [item.displayName, item.mail, item.userPrincipalName].some(
        (value) => normalizeExactMatch(value) === normalized,
      ),
    ),
  );
}

function isStableMSTeamsUserId(raw: string): boolean {
  return /^[0-9a-fA-F-]{16,}$/.test(normalizeMSTeamsUserInput(raw));
}

function normalizeStaticMSTeamsAllowEntry(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "*" || /^accessGroup:/i.test(trimmed)) {
    return trimmed;
  }
  const id = normalizeMSTeamsUserInput(trimmed);
  return isStableMSTeamsUserId(id) ? id : undefined;
}

export function projectStableMSTeamsUserAllowlist(entries?: string[]): string[] | undefined {
  if (!entries) {
    return undefined;
  }
  const projected = entries
    .map((entry) => normalizeStaticMSTeamsAllowEntry(entry))
    .filter((entry): entry is string => Boolean(entry));
  return [...new Map(projected.map((entry) => [normalizeExactMatch(entry), entry])).values()];
}

function stripProviderPrefix(raw: string): string {
  return raw.replace(/^(msteams|teams):/i, "");
}

export function normalizeMSTeamsMessagingTarget(raw: string): string | undefined {
  let trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  trimmed = stripProviderPrefix(trimmed).trim();
  if (/^conversation:/i.test(trimmed)) {
    const id = trimmed.slice("conversation:".length).trim();
    return id ? `conversation:${id}` : undefined;
  }
  if (/^user:/i.test(trimmed)) {
    const id = trimmed.slice("user:".length).trim();
    return id ? `user:${id}` : undefined;
  }
  return trimmed || undefined;
}

export function normalizeMSTeamsUserInput(raw: string): string {
  return stripProviderPrefix(raw)
    .replace(/^(user|conversation):/i, "")
    .trim();
}

export function parseMSTeamsConversationId(raw: string): string | null {
  const trimmed = stripProviderPrefix(raw).trim();
  if (!/^conversation:/i.test(trimmed)) {
    return null;
  }
  const id = trimmed.slice("conversation:".length).trim();
  return id;
}

/**
 * Detect whether a raw target string is a supported Microsoft Teams
 * conversation id.
 *
 * Accepts both prefixed and bare formats:
 * - `conversation:<id>` — explicit conversation prefix
 * - `19:abc@thread.tacv2` / `19:abc@thread.skype` — channel / legacy group
 * - `19:{userId}_{appId}@unq.gbl.spaces` — Graph 1:1 chat thread format
 * - `a:1xxx` — Bot Framework personal (1:1) chat id
 * - `8:orgid:xxx` — Bot Framework org-scoped personal chat id
 */
export function looksLikeMSTeamsConversationId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  if (/^conversation:/i.test(trimmed)) {
    return true;
  }
  // Bare Bot Framework / Graph conversation id formats.
  // Channel / group ids always start with `19:` and include an `@thread.*`
  // suffix (`@thread.tacv2` or the legacy `@thread.skype`). Personal chat
  // ids come in three shapes: `a:1...` (Bot Framework), `8:orgid:...`
  // (org-scoped Bot Framework), and `19:{userId}_{appId}@unq.gbl.spaces`
  // (Graph API 1:1 chat thread). Bot Framework user ids use `29:...`.
  if (/^19:.+@thread\.(tacv2|skype)$/i.test(trimmed)) {
    return true;
  }
  if (/^19:.+@unq\.gbl\.spaces$/i.test(trimmed)) {
    return true;
  }
  if (/^a:1[A-Za-z0-9_-]+$/i.test(trimmed)) {
    return true;
  }
  if (/^8:orgid:[A-Za-z0-9-]+$/i.test(trimmed)) {
    return true;
  }
  // Fallback: anything containing @thread is still treated as a conversation
  // id so the current matches for tenant-specific suffixes remain accepted.
  return /@thread\b/i.test(trimmed);
}

/**
 * Detect conversation ids plus stable user ids that explicit-target delivery
 * can forward verbatim to the channel adapter.
 */
export function looksLikeMSTeamsTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (looksLikeMSTeamsConversationId(trimmed)) {
    return true;
  }
  if (/^user:/i.test(trimmed)) {
    // Only treat as an id when the value after `user:` looks like a UUID;
    // display names must fall through to directory lookup.
    const id = trimmed.slice("user:".length).trim();
    return /^[0-9a-fA-F-]{16,}$/.test(id);
  }
  return /^29:[A-Za-z0-9_-]+$/i.test(trimmed);
}

function normalizeMSTeamsTeamKey(raw: string): string | undefined {
  const trimmed = stripProviderPrefix(raw)
    .replace(/^team:/i, "")
    .trim();
  return trimmed || undefined;
}

function normalizeMSTeamsChannelKey(raw?: string | null): string | undefined {
  const trimmed = raw?.trim().replace(/^#/, "").trim() ?? "";
  return trimmed || undefined;
}

function normalizeMSTeamsConversationTargetId(raw: string): string {
  const trimmed = stripProviderPrefix(raw).trim();
  return parseMSTeamsConversationId(trimmed) ?? trimmed;
}

function looksLikeMSTeamsThreadConversationId(raw: string): boolean {
  const normalized = normalizeMSTeamsConversationTargetId(raw);
  return /^19:.+@thread\./i.test(normalized);
}

function isStableMSTeamsTeamKey(raw: string): boolean {
  return /^[0-9a-fA-F-]{16,}$/.test(raw.trim()) || looksLikeMSTeamsThreadConversationId(raw);
}

function projectStableMSTeamsChannels(
  channels: NonNullable<MSTeamsConfig["teams"]>[string]["channels"],
) {
  const projected: NonNullable<typeof channels> = {};
  for (const [channelKey, channelConfig] of Object.entries(channels ?? {})) {
    if (channelKey === "*") {
      projected[channelKey] = channelConfig;
      continue;
    }
    if (looksLikeMSTeamsThreadConversationId(channelKey)) {
      projected[normalizeMSTeamsConversationTargetId(channelKey)] = channelConfig;
    }
  }
  return projected;
}

export function projectStableMSTeamsTeamsConfig(
  teams: MSTeamsConfig["teams"],
): NonNullable<MSTeamsConfig["teams"]> | undefined {
  if (!teams) {
    return undefined;
  }
  const projected: NonNullable<MSTeamsConfig["teams"]> = {};
  for (const [teamKey, teamConfig] of Object.entries(teams)) {
    if (teamKey !== "*" && !isStableMSTeamsTeamKey(teamKey)) {
      continue;
    }
    const stableKey = teamKey === "*" ? teamKey : normalizeMSTeamsConversationTargetId(teamKey);
    projected[stableKey] = {
      ...teamConfig,
      channels: projectStableMSTeamsChannels(teamConfig.channels),
    };
  }
  return projected;
}

export function parseMSTeamsTeamChannelInput(raw: string): { team?: string; channel?: string } {
  const trimmed = stripProviderPrefix(raw).trim();
  if (!trimmed) {
    return {};
  }
  const parts = trimmed.split("/");
  const team = normalizeMSTeamsTeamKey(parts[0] ?? "");
  const channel =
    parts.length > 1 ? normalizeMSTeamsChannelKey(parts.slice(1).join("/")) : undefined;
  return {
    ...(team ? { team } : {}),
    ...(channel ? { channel } : {}),
  };
}

export function parseMSTeamsTeamEntry(
  raw: string,
): { teamKey: string; channelKey?: string } | null {
  const { team, channel } = parseMSTeamsTeamChannelInput(raw);
  if (!team) {
    return null;
  }
  return {
    teamKey: team,
    ...(channel ? { channelKey: channel } : {}),
  };
}

export async function resolveMSTeamsChannelAllowlist(params: {
  cfg: unknown;
  entries: string[];
  teamIdMode?: StableMSTeamsTeamIdMode;
}): Promise<MSTeamsChannelResolution[]> {
  let tokenPromise: Promise<string> | undefined;
  const getToken = () => {
    tokenPromise ??= resolveGraphToken(params.cfg);
    return tokenPromise;
  };
  return await mapAllowlistResolutionInputs({
    inputs: params.entries,
    mapInput: async (input): Promise<MSTeamsChannelResolution> => {
      const { team, channel } = parseMSTeamsTeamChannelInput(input);
      if (!team) {
        return { input, resolved: false };
      }
      if (looksLikeMSTeamsThreadConversationId(team)) {
        const teamId = normalizeMSTeamsConversationTargetId(team);
        if (!channel) {
          return { input, resolved: true, teamId, teamName: teamId };
        }
        if (!looksLikeMSTeamsThreadConversationId(channel)) {
          return {
            input,
            resolved: false,
            teamId,
            teamName: teamId,
            note: "channel id required for conversation-id team",
          };
        }
        const channelId = normalizeMSTeamsConversationTargetId(channel);
        return {
          input,
          resolved: true,
          teamId,
          teamName: teamId,
          channelId,
          channelName: channelId,
        };
      }
      const token = await getToken();
      let teamMatch: GraphGroup;
      if (/^[0-9a-fA-F-]{16,}$/.test(team)) {
        teamMatch = { id: team, displayName: team };
      } else {
        const result = await listTeamsByNameWithPageInfo(token, team);
        if (result.truncated) {
          return { input, resolved: false, note: "team lookup incomplete" };
        }
        const exactTeams = findExactTeams(result.items, team);
        if (exactTeams.length === 0) {
          return { input, resolved: false, note: "team not found" };
        }
        if (exactTeams.length > 1) {
          return { input, resolved: false, note: "team name is ambiguous" };
        }
        teamMatch = exactTeams[0];
      }
      const graphTeamId = teamMatch.id?.trim();
      const teamName = teamMatch.displayName?.trim() || team;
      if (!graphTeamId) {
        return { input, resolved: false, note: "team id missing" };
      }
      const needsChannels = params.teamIdMode !== "graph" || Boolean(channel);
      if (!needsChannels) {
        return {
          input,
          resolved: true,
          teamId: graphTeamId,
          graphTeamId,
          teamName,
        };
      }
      let teamChannels: GraphChannel[];
      try {
        const result = await listChannelsForTeamWithPageInfo(token, graphTeamId);
        if (result.truncated) {
          return { input, resolved: false, note: "channel lookup incomplete" };
        }
        teamChannels = result.items;
      } catch {
        return { input, resolved: false, note: "channel lookup failed" };
      }
      const generalChannels = findExactChannels(teamChannels, "general");
      if (params.teamIdMode !== "graph" && generalChannels.length !== 1) {
        return {
          input,
          resolved: false,
          graphTeamId,
          teamName,
          note:
            generalChannels.length > 1
              ? "General channel is ambiguous"
              : "General channel not found",
        };
      }
      const teamId = generalChannels[0]?.id?.trim() || graphTeamId;
      if (!channel) {
        return {
          input,
          resolved: true,
          teamId,
          graphTeamId,
          teamName,
        };
      }
      const channelById = teamChannels.find((item) => item.id === channel);
      const exactChannels = channelById ? [channelById] : findExactChannels(teamChannels, channel);
      if (exactChannels.length === 0) {
        return { input, resolved: false, note: "channel not found" };
      }
      if (exactChannels.length > 1) {
        return { input, resolved: false, note: "channel name is ambiguous" };
      }
      const channelMatch = exactChannels[0];
      if (!channelMatch?.id) {
        return { input, resolved: false, note: "channel id missing" };
      }
      return {
        input,
        resolved: true,
        teamId,
        graphTeamId,
        teamName,
        channelId: channelMatch.id,
        channelName: channelMatch.displayName ?? channel,
      };
    },
  });
}

export async function resolveMSTeamsTeamsConfig(params: {
  cfg: unknown;
  teamIdMode: StableMSTeamsTeamIdMode;
  teams: NonNullable<MSTeamsConfig["teams"]>;
}): Promise<{
  teams: NonNullable<MSTeamsConfig["teams"]>;
  mapping: string[];
  unresolved: string[];
}> {
  const entries: Array<{ input: string; teamKey: string; channelKey?: string }> = [];
  const unresolved: string[] = [];
  for (const [teamKey, teamCfg] of Object.entries(params.teams)) {
    if (teamKey === "*") {
      for (const channelKey of Object.keys(teamCfg?.channels ?? {})) {
        if (channelKey !== "*" && !looksLikeMSTeamsThreadConversationId(channelKey)) {
          unresolved.push(`${teamKey}/${channelKey}`);
        }
      }
      continue;
    }
    const channelKeys = Object.keys(teamCfg?.channels ?? {}).filter((key) => key !== "*");
    if (channelKeys.length === 0) {
      entries.push({ input: teamKey, teamKey });
      continue;
    }
    for (const channelKey of channelKeys) {
      entries.push({
        input: `${teamKey}/${channelKey}`,
        teamKey,
        channelKey,
      });
    }
  }
  if (entries.length === 0) {
    return {
      teams: projectStableMSTeamsTeamsConfig(params.teams) ?? {},
      mapping: [],
      unresolved,
    };
  }

  const resolved = await resolveMSTeamsChannelAllowlist({
    cfg: params.cfg,
    entries: entries.map((entry) => entry.input),
    teamIdMode: params.teamIdMode,
  });
  const mapping: string[] = [];
  const teams = projectStableMSTeamsTeamsConfig(params.teams) ?? {};

  resolved.forEach((entry, index) => {
    const source = entries[index];
    if (!source) {
      return;
    }
    const sourceTeam = params.teams[source.teamKey] ?? {};
    const resolvedTeamId = params.teamIdMode === "graph" ? entry.graphTeamId : entry.teamId;
    if (!entry.resolved || !resolvedTeamId) {
      unresolved.push(entry.input);
      return;
    }
    mapping.push(
      entry.channelId
        ? `${entry.input}→${resolvedTeamId}/${entry.channelId}`
        : `${entry.input}→${resolvedTeamId}`,
    );
    const existing = teams[resolvedTeamId] ?? {};
    const { channels: _sourceChannels, ...sourceTeamPolicy } = sourceTeam;
    const mergedChannels = {
      ...projectStableMSTeamsChannels(sourceTeam.channels),
      ...existing.channels,
    };
    const mergedTeam = { ...sourceTeamPolicy, ...existing, channels: mergedChannels };
    teams[resolvedTeamId] = mergedTeam;
    if (source.channelKey && entry.channelId) {
      const sourceChannel = sourceTeam.channels?.[source.channelKey];
      if (sourceChannel) {
        teams[resolvedTeamId] = {
          ...mergedTeam,
          channels: {
            ...mergedChannels,
            [entry.channelId]: {
              ...sourceChannel,
              ...mergedChannels?.[entry.channelId],
            },
          },
        };
      }
    }
  });

  return { teams, mapping, unresolved };
}

export async function resolveMSTeamsUserAllowlist(params: {
  cfg: unknown;
  entries: string[];
}): Promise<MSTeamsUserResolution[]> {
  let tokenPromise: Promise<string> | undefined;
  const getToken = () => {
    tokenPromise ??= resolveGraphToken(params.cfg);
    return tokenPromise;
  };
  return await mapAllowlistResolutionInputs({
    inputs: params.entries,
    mapInput: async (input): Promise<MSTeamsUserResolution> => {
      const query = normalizeQuery(normalizeMSTeamsUserInput(input));
      if (!query) {
        return { input, resolved: false };
      }
      if (/^[0-9a-fA-F-]{16,}$/.test(query)) {
        return { input, resolved: true, id: query };
      }
      const result = await findGraphUsersByExactIdentity({
        token: await getToken(),
        query,
      });
      if (result.truncated) {
        return { input, resolved: false, note: "user lookup incomplete" };
      }
      const users = findExactUsers(result.items, query);
      if (users.length === 0) {
        return { input, resolved: false, note: "user not found" };
      }
      if (users.length > 1) {
        return { input, resolved: false, note: "user identity is ambiguous" };
      }
      const match = users[0];
      return {
        input,
        resolved: true,
        id: match.id,
        name: match.displayName ?? undefined,
      };
    },
  });
}
