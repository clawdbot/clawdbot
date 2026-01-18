import { WebClient } from "@slack/web-api";

export type SlackChannelLookup = {
  id: string;
  name: string;
  archived: boolean;
  isPrivate: boolean;
};

export type SlackChannelResolution = {
  input: string;
  resolved: boolean;
  id?: string;
  name?: string;
  archived?: boolean;
};

type SlackListResponse = {
  channels?: Array<{
    id?: string;
    name?: string;
    is_archived?: boolean;
    is_private?: boolean;
  }>;
  response_metadata?: { next_cursor?: string };
};

function parseSlackChannelMention(raw: string): { id?: string; name?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const mention = trimmed.match(/^<#([A-Z0-9]+)(?:\|([^>]+))?>$/i);
  if (mention) {
    const id = mention[1]?.toUpperCase();
    const name = mention[2]?.trim();
    return { id, name };
  }
  const prefixed = trimmed.replace(/^(slack:|channel:)/i, "");
  if (/^[CG][A-Z0-9]+$/i.test(prefixed)) return { id: prefixed.toUpperCase() };
  const name = prefixed.replace(/^#/, "").trim();
  return name ? { name } : {};
}

async function listSlackChannels(client: WebClient): Promise<SlackChannelLookup[]> {
  const channels: SlackChannelLookup[] = [];
  let cursor: string | undefined;
  do {
    const res = (await client.conversations.list({
      types: "public_channel,private_channel",
      exclude_archived: false,
      limit: 1000,
      cursor,
    })) as SlackListResponse;
    for (const channel of res.channels ?? []) {
      const id = channel.id?.trim();
      const name = channel.name?.trim();
      if (!id || !name) continue;
      channels.push({
        id,
        name,
        archived: Boolean(channel.is_archived),
        isPrivate: Boolean(channel.is_private),
      });
    }
    const next = res.response_metadata?.next_cursor?.trim();
    cursor = next ? next : undefined;
  } while (cursor);
  return channels;
}

function resolveByName(
  name: string,
  channels: SlackChannelLookup[],
): SlackChannelLookup | undefined {
  const target = name.trim().toLowerCase();
  if (!target) return undefined;
  const matches = channels.filter((channel) => channel.name.toLowerCase() === target);
  if (matches.length === 0) return undefined;
  const active = matches.find((channel) => !channel.archived);
  return active ?? matches[0];
}

export async function resolveSlackChannelAllowlist(params: {
  token: string;
  entries: string[];
  client?: WebClient;
}): Promise<SlackChannelResolution[]> {
  const client = params.client ?? new WebClient(params.token);
  const channels = await listSlackChannels(client);
  const results: SlackChannelResolution[] = [];

  for (const input of params.entries) {
    const parsed = parseSlackChannelMention(input);
    if (parsed.id) {
      const match = channels.find((channel) => channel.id === parsed.id);
      results.push({
        input,
        resolved: true,
        id: parsed.id,
        name: match?.name ?? parsed.name,
        archived: match?.archived,
      });
      continue;
    }
    if (parsed.name) {
      const match = resolveByName(parsed.name, channels);
      if (match) {
        results.push({
          input,
          resolved: true,
          id: match.id,
          name: match.name,
          archived: match.archived,
        });
        continue;
      }
    }
    results.push({ input, resolved: false });
  }

  return results;
}
