import type { WebClient } from "@slack/web-api";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { createSlackWebClient } from "./client.js";
import {
  collectSlackCursorItems,
  resolveSlackAllowlistEntries,
} from "./resolve-allowlist-common.js";

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
  if (!trimmed) {
    return {};
  }
  const mention = trimmed.match(/^<#([A-Z0-9]+)(?:\|([^>]+))?>$/i);
  if (mention) {
    const id = mention[1]?.toUpperCase();
    const name = mention[2]?.trim();
    return { id, name };
  }
  const prefixed = trimmed.replace(/^(slack:|channel:)/i, "");
  if (/^[CG][A-Z0-9]+$/i.test(prefixed)) {
    return { id: prefixed.toUpperCase() };
  }
  const name = prefixed.replace(/^#/, "").trim();
  return name ? { name } : {};
}

async function listSlackChannels(client: WebClient): Promise<SlackChannelLookup[]> {
  return collectSlackCursorItems({
    fetchPage: async (cursor) =>
      (await client.conversations.list({
        types: "public_channel,private_channel",
        exclude_archived: false,
        limit: 1000,
        cursor,
      })) as SlackListResponse,
    collectPageItems: (res) =>
      (res.channels ?? [])
        .map((channel) => {
          const id = channel.id?.trim();
          const name = channel.name?.trim();
          if (!id || !name) {
            return null;
          }
          return {
            id,
            name,
            archived: Boolean(channel.is_archived),
            isPrivate: Boolean(channel.is_private),
          } satisfies SlackChannelLookup;
        })
        .filter(Boolean) as SlackChannelLookup[],
  });
}

function resolveByName(
  name: string,
  channels: SlackChannelLookup[],
): SlackChannelLookup | undefined {
  const target = normalizeLowercaseStringOrEmpty(name);
  if (!target) {
    return undefined;
  }
  const matches = channels.filter(
    (channel) => normalizeLowercaseStringOrEmpty(channel.name) === target,
  );
  if (matches.length === 0) {
    return undefined;
  }
  const active = matches.find((channel) => !channel.archived);
  return active ?? matches[0];
}

export async function resolveSlackChannelAllowlist(params: {
  token: string;
  entries: string[];
  client?: WebClient;
}): Promise<SlackChannelResolution[]> {
  const client = params.client ?? createSlackWebClient(params.token);
  const channels = await listSlackChannels(client);
  return resolveSlackAllowlistEntries<
    { id?: string; name?: string },
    SlackChannelLookup,
    SlackChannelResolution
  >({
    entries: params.entries,
    lookup: channels,
    parseInput: parseSlackChannelMention,
    findById: (lookup, id) => lookup.find((channel) => channel.id === id),
    buildIdResolved: ({ input, parsed, match }) => ({
      input,
      resolved: true,
      id: parsed.id,
      name: match?.name ?? parsed.name,
      archived: match?.archived,
    }),
    resolveNonId: ({ input, parsed, lookup }) => {
      if (!parsed.name) {
        return undefined;
      }
      const match = resolveByName(parsed.name, lookup);
      if (!match) {
        return undefined;
      }
      return {
        input,
        resolved: true,
        id: match.id,
        name: match.name,
        archived: match.archived,
      };
    },
    buildUnresolved: (input) => ({ input, resolved: false }),
  });
}
