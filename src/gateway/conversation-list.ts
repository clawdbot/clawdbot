import type {
  ConversationListItem,
  ConversationListResult,
} from "../../packages/gateway-protocol/src/schema/agent.js";
import type { ChannelDirectoryEntry } from "../channels/plugins/types.core.js";
import {
  buildConversationIdentity,
  type ConversationIdentity,
} from "../config/sessions/conversation-identity.js";
import {
  listConversations,
  registerConversationAddresses,
  type ConversationRecord,
  type ConversationRegistryScope,
} from "../config/sessions/conversation-registry.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveOutboundChannelPlugin } from "../infra/outbound/channel-resolution.js";
import { resolveOutboundSessionRoute } from "../infra/outbound/outbound-session.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { defaultRuntime } from "../runtime.js";

const log = createSubsystemLogger("gateway/conversations");

type ConversationListDeps = {
  listConversations: typeof listConversations;
  registerConversationAddresses: typeof registerConversationAddresses;
  resolveOutboundChannelPlugin: typeof resolveOutboundChannelPlugin;
  resolveOutboundSessionRoute: typeof resolveOutboundSessionRoute;
};

const defaultDeps: ConversationListDeps = {
  listConversations,
  registerConversationAddresses,
  resolveOutboundChannelPlugin,
  resolveOutboundSessionRoute,
};

function resolveConversationScope(params: {
  agentId: string;
  config: OpenClawConfig;
}): ConversationRegistryScope {
  const configuredStore = params.config.session?.store;
  return {
    agentId: params.agentId,
    ...(configuredStore
      ? { storePath: resolveStorePath(configuredStore, { agentId: params.agentId }) }
      : {}),
  };
}

function presentConversation(conversation: ConversationRecord): ConversationListItem {
  return {
    conversationRef: conversation.conversationRef,
    channel: conversation.channel,
    accountId: conversation.accountId,
    kind: conversation.kind,
    target: conversation.target,
    ...(conversation.threadId ? { threadId: conversation.threadId } : {}),
    ...(conversation.label ? { label: conversation.label } : {}),
    firstSeenAt: conversation.firstSeenAt,
    lastSeenAt: conversation.lastSeenAt,
  };
}

async function listLiveDirectoryEntries(params: {
  channel: string;
  accountId: string;
  kind: "peers" | "groups";
  run: () => Promise<ChannelDirectoryEntry[]>;
}): Promise<ChannelDirectoryEntry[]> {
  try {
    return await params.run();
  } catch (error) {
    log.warn("live directory discovery failed; using configured entries", {
      channel: params.channel,
      accountId: params.accountId,
      kind: params.kind,
      error: formatErrorMessage(error),
    });
    return [];
  }
}

async function listDirectoryEntries(params: {
  config: OpenClawConfig;
  accountId: string;
  query?: string;
  limit: number;
  plugin: NonNullable<ReturnType<typeof resolveOutboundChannelPlugin>>;
}): Promise<ChannelDirectoryEntry[]> {
  const input = {
    cfg: params.config,
    accountId: params.accountId,
    ...(params.query ? { query: params.query } : {}),
    limit: params.limit,
    runtime: defaultRuntime,
  };
  const directory = params.plugin.directory;
  const listPeersLive = directory?.listPeersLive;
  const listGroupsLive = directory?.listGroupsLive;
  const [configuredPeers, livePeers, configuredGroups, liveGroups] = await Promise.all([
    directory?.listPeers?.(input) ?? [],
    listPeersLive
      ? listLiveDirectoryEntries({
          channel: params.plugin.id,
          accountId: params.accountId,
          kind: "peers",
          run: () => listPeersLive(input),
        })
      : [],
    directory?.listGroups?.(input) ?? [],
    listGroupsLive
      ? listLiveDirectoryEntries({
          channel: params.plugin.id,
          accountId: params.accountId,
          kind: "groups",
          run: () => listGroupsLive(input),
        })
      : [],
  ]);
  const entries = new Map<string, ChannelDirectoryEntry>();
  for (const entry of [...configuredPeers, ...livePeers, ...configuredGroups, ...liveGroups]) {
    // Live results replace config-only metadata without dropping configured addresses when a
    // transport's live adapter is search-only and returns nothing for an unfiltered listing.
    entries.set(`${entry.kind}\u0000${entry.id.trim()}`, entry);
  }
  return [...entries.values()];
}

async function discoverChannelAddresses(params: {
  config: OpenClawConfig;
  agentId: string;
  channel: string;
  query?: string;
  limit: number;
  scope: ConversationRegistryScope;
  deps: ConversationListDeps;
}): Promise<{ channel: string; discoveredConversationRefs: ReadonlySet<string> }> {
  const plugin = params.deps.resolveOutboundChannelPlugin({
    channel: params.channel,
    cfg: params.config,
  });
  if (!plugin?.directory) {
    return {
      channel: params.channel.trim().toLowerCase(),
      discoveredConversationRefs: new Set(),
    };
  }
  const identities = new Map<string, ConversationIdentity>();
  for (const accountId of new Set(plugin.config.listAccountIds(params.config).filter(Boolean))) {
    const account = plugin.config.resolveAccount(params.config, accountId);
    if (plugin.config.isEnabled?.(account, params.config) === false) {
      continue;
    }
    if (plugin.config.isConfigured && !(await plugin.config.isConfigured(account, params.config))) {
      continue;
    }
    const entries = await listDirectoryEntries({
      config: params.config,
      accountId,
      ...(params.query ? { query: params.query } : {}),
      limit: params.limit,
      plugin,
    });
    for (const entry of entries) {
      const target = entry.id.trim();
      if (!target) {
        continue;
      }
      const display = entry.name?.trim() || entry.handle?.trim() || undefined;
      const route = await params.deps.resolveOutboundSessionRoute({
        cfg: params.config,
        channel: plugin.id,
        plugin,
        agentId: params.agentId,
        accountId,
        target,
        resolvedTarget: {
          to: target,
          kind: entry.kind,
          ...(display ? { display } : {}),
          source: "directory",
          resolutionSource: "directory",
        },
      });
      if (!route) {
        continue;
      }
      const identity = buildConversationIdentity({
        channel: plugin.id,
        accountId,
        kind: route.chatType,
        // Match inbound MsgContext.From; the identity builder removes transport prefixes.
        peerId: route.from,
        deliveryTarget: route.to,
        ...(route.threadId !== undefined ? { threadId: route.threadId } : {}),
        ...(route.peer.kind === "direct"
          ? { nativeDirectUserId: route.peer.id }
          : { nativeChannelId: route.peer.id }),
        ...(display ? { label: display } : {}),
      });
      if (identity) {
        identities.set(identity.conversationRef, identity);
      }
    }
  }
  params.deps.registerConversationAddresses(params.scope, [...identities.values()]);
  return { channel: plugin.id, discoveredConversationRefs: new Set(identities.keys()) };
}

function matchesConversationQuery(conversation: ConversationRecord, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (!query) {
    return true;
  }
  const terms = query.startsWith("@") ? [query, query.slice(1)] : [query];
  const values = [conversation.conversationRef, conversation.target, conversation.label]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());
  return terms.some((term) => term && values.some((value) => value.includes(term)));
}

/** Lists persisted and channel-directory addresses from the Gateway's live plugin runtime. */
export async function runGatewayConversationList(
  params: {
    config: OpenClawConfig;
    agentId: string;
    channel?: string;
    query?: string;
    limit: number;
  },
  deps: ConversationListDeps = defaultDeps,
): Promise<ConversationListResult> {
  const scope = resolveConversationScope(params);
  const query = params.query?.trim() || undefined;
  const discovery = params.channel
    ? await discoverChannelAddresses({
        config: params.config,
        agentId: params.agentId,
        channel: params.channel,
        ...(query ? { query } : {}),
        limit: params.limit,
        scope,
        deps,
      })
    : undefined;
  const conversations = deps.listConversations(scope, {
    ...(query ? {} : { limit: params.limit }),
    ...(discovery ? { channel: discovery.channel } : {}),
  });
  const selected = query
    ? conversations
        .filter(
          (entry) =>
            discovery?.discoveredConversationRefs.has(entry.conversationRef) === true ||
            matchesConversationQuery(entry, query),
        )
        .slice(0, params.limit)
    : conversations;
  return { conversations: selected.map(presentConversation) };
}
