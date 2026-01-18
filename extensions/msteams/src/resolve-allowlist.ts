import { GRAPH_ROOT } from "./attachments/shared.js";
import { loadMSTeamsSdkWithAuth } from "./sdk.js";
import { resolveMSTeamsCredentials } from "./token.js";

type GraphUser = {
  id?: string;
  displayName?: string;
  userPrincipalName?: string;
  mail?: string;
};

type GraphGroup = {
  id?: string;
  displayName?: string;
};

type GraphChannel = {
  id?: string;
  displayName?: string;
};

type GraphResponse<T> = { value?: T[] };

export type MSTeamsChannelResolution = {
  input: string;
  resolved: boolean;
  teamId?: string;
  teamName?: string;
  channelId?: string;
  channelName?: string;
  note?: string;
};

export type MSTeamsUserResolution = {
  input: string;
  resolved: boolean;
  id?: string;
  name?: string;
  note?: string;
};

function readAccessToken(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const token =
      (value as { accessToken?: unknown }).accessToken ?? (value as { token?: unknown }).token;
    return typeof token === "string" ? token : null;
  }
  return null;
}

function stripProviderPrefix(raw: string): string {
  return raw.replace(/^(msteams|teams):/i, "");
}

export function normalizeMSTeamsMessagingTarget(raw: string): string | undefined {
  let trimmed = raw.trim();
  if (!trimmed) return undefined;
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
  return stripProviderPrefix(raw).replace(/^(user|conversation):/i, "").trim();
}

export function parseMSTeamsConversationId(raw: string): string | null {
  const trimmed = stripProviderPrefix(raw).trim();
  if (!/^conversation:/i.test(trimmed)) return null;
  const id = trimmed.slice("conversation:".length).trim();
  return id;
}

function normalizeMSTeamsTeamKey(raw: string): string | undefined {
  const trimmed = stripProviderPrefix(raw).replace(/^team:/i, "").trim();
  return trimmed || undefined;
}

function normalizeMSTeamsChannelKey(raw?: string | null): string | undefined {
  const trimmed = raw?.trim().replace(/^#/, "").trim() ?? "";
  return trimmed || undefined;
}

export function parseMSTeamsTeamChannelInput(raw: string): { team?: string; channel?: string } {
  const trimmed = stripProviderPrefix(raw).trim();
  if (!trimmed) return {};
  const parts = trimmed.split("/");
  const team = normalizeMSTeamsTeamKey(parts[0] ?? "");
  const channel = parts.length > 1 ? normalizeMSTeamsChannelKey(parts.slice(1).join("/")) : undefined;
  return {
    ...(team ? { team } : {}),
    ...(channel ? { channel } : {}),
  };
}

export function parseMSTeamsTeamEntry(
  raw: string,
): { teamKey: string; channelKey?: string } | null {
  const { team, channel } = parseMSTeamsTeamChannelInput(raw);
  if (!team) return null;
  return {
    teamKey: team,
    ...(channel ? { channelKey: channel } : {}),
  };
}

function normalizeQuery(value?: string | null): string {
  return value?.trim() ?? "";
}

function escapeOData(value: string): string {
  return value.replace(/'/g, "''");
}

async function fetchGraphJson<T>(params: {
  token: string;
  path: string;
  headers?: Record<string, string>;
}): Promise<T> {
  const res = await fetch(`${GRAPH_ROOT}${params.path}`, {
    headers: {
      Authorization: `Bearer ${params.token}`,
      ...(params.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Graph ${params.path} failed (${res.status}): ${text || "unknown error"}`);
  }
  return (await res.json()) as T;
}

async function resolveGraphToken(cfg: unknown): Promise<string> {
  const creds = resolveMSTeamsCredentials((cfg as { channels?: { msteams?: unknown } })?.channels?.msteams);
  if (!creds) throw new Error("MS Teams credentials missing");
  const { sdk, authConfig } = await loadMSTeamsSdkWithAuth(creds);
  const tokenProvider = new sdk.MsalTokenProvider(authConfig);
  const token = await tokenProvider.getAccessToken("https://graph.microsoft.com/.default");
  const accessToken = readAccessToken(token);
  if (!accessToken) throw new Error("MS Teams graph token unavailable");
  return accessToken;
}

async function listTeamsByName(token: string, query: string): Promise<GraphGroup[]> {
  const escaped = escapeOData(query);
  const filter = `resourceProvisioningOptions/Any(x:x eq 'Team') and startsWith(displayName,'${escaped}')`;
  const path = `/groups?$filter=${encodeURIComponent(filter)}&$select=id,displayName`;
  const res = await fetchGraphJson<GraphResponse<GraphGroup>>({ token, path });
  return res.value ?? [];
}

async function listChannelsForTeam(token: string, teamId: string): Promise<GraphChannel[]> {
  const path = `/teams/${encodeURIComponent(teamId)}/channels?$select=id,displayName`;
  const res = await fetchGraphJson<GraphResponse<GraphChannel>>({ token, path });
  return res.value ?? [];
}

export async function resolveMSTeamsChannelAllowlist(params: {
  cfg: unknown;
  entries: string[];
}): Promise<MSTeamsChannelResolution[]> {
  const token = await resolveGraphToken(params.cfg);
  const results: MSTeamsChannelResolution[] = [];

  for (const input of params.entries) {
    const { team, channel } = parseMSTeamsTeamChannelInput(input);
    if (!team) {
      results.push({ input, resolved: false });
      continue;
    }
    const teams =
      /^[0-9a-fA-F-]{16,}$/.test(team) ? [{ id: team, displayName: team }] : await listTeamsByName(token, team);
    if (teams.length === 0) {
      results.push({ input, resolved: false, note: "team not found" });
      continue;
    }
    const teamMatch = teams[0];
    const teamId = teamMatch.id?.trim();
    const teamName = teamMatch.displayName?.trim() || team;
    if (!teamId) {
      results.push({ input, resolved: false, note: "team id missing" });
      continue;
    }
    if (!channel) {
      results.push({
        input,
        resolved: true,
        teamId,
        teamName,
        note: teams.length > 1 ? "multiple teams; chose first" : undefined,
      });
      continue;
    }
    const channels = await listChannelsForTeam(token, teamId);
    const channelMatch =
      channels.find((item) => item.id === channel) ??
      channels.find(
        (item) => item.displayName?.toLowerCase() === channel.toLowerCase(),
      ) ??
      channels.find(
        (item) => item.displayName?.toLowerCase().includes(channel.toLowerCase() ?? ""),
      );
    if (!channelMatch?.id) {
      results.push({ input, resolved: false, note: "channel not found" });
      continue;
    }
    results.push({
      input,
      resolved: true,
      teamId,
      teamName,
      channelId: channelMatch.id,
      channelName: channelMatch.displayName ?? channel,
      note: channels.length > 1 ? "multiple channels; chose first" : undefined,
    });
  }

  return results;
}

export async function resolveMSTeamsUserAllowlist(params: {
  cfg: unknown;
  entries: string[];
}): Promise<MSTeamsUserResolution[]> {
  const token = await resolveGraphToken(params.cfg);
  const results: MSTeamsUserResolution[] = [];

  for (const input of params.entries) {
    const query = normalizeQuery(normalizeMSTeamsUserInput(input));
    if (!query) {
      results.push({ input, resolved: false });
      continue;
    }
    if (/^[0-9a-fA-F-]{16,}$/.test(query)) {
      results.push({ input, resolved: true, id: query });
      continue;
    }
    let users: GraphUser[] = [];
    if (query.includes("@")) {
      const escaped = escapeOData(query);
      const filter = `(mail eq '${escaped}' or userPrincipalName eq '${escaped}')`;
      const path = `/users?$filter=${encodeURIComponent(filter)}&$select=id,displayName,mail,userPrincipalName`;
      const res = await fetchGraphJson<GraphResponse<GraphUser>>({ token, path });
      users = res.value ?? [];
    } else {
      const path = `/users?$search=${encodeURIComponent(`"displayName:${query}"`)}&$select=id,displayName,mail,userPrincipalName&$top=10`;
      const res = await fetchGraphJson<GraphResponse<GraphUser>>({
        token,
        path,
        headers: { ConsistencyLevel: "eventual" },
      });
      users = res.value ?? [];
    }
    const match = users[0];
    if (!match?.id) {
      results.push({ input, resolved: false });
      continue;
    }
    results.push({
      input,
      resolved: true,
      id: match.id,
      name: match.displayName ?? undefined,
      note: users.length > 1 ? "multiple matches; chose first" : undefined,
    });
  }

  return results;
}
