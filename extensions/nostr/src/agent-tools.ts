import { Type } from "@sinclair/typebox";
import type { ChannelAgentTool } from "clawdbot/plugin-sdk";
import { nip19 } from "nostr-tools";
import {
  connectBunker,
  disconnectBunker,
  getBunkerConnection,
  getFirstBunkerConnection,
  getAllBunkerConnections,
  hasAnyBunkerConnected,
  loadPersistedState,
  stripBunkerSecret,
  BunkerAuthUrlError,
} from "./bunker-store.js";
import {
  postNote,
  postReaction,
  postRepost,
  fetchEvents,
  postArticle,
} from "./bunker-actions.js";
import { getSharedPool, normalizePubkey } from "./nostr-bus.js";
import { getNostrRuntime } from "./runtime.js";
import { resolveNostrAccount } from "./types.js";

/** Default account ID for single-account usage */
const DEFAULT_ACCOUNT_ID = "default";

/**
 * Normalize an event ID to hex format (accepts note1 bech32 or hex).
 */
function normalizeEventIdToHex(id: string): string {
  const trimmed = id.trim();
  if (trimmed.startsWith("note1") || trimmed.startsWith("nevent1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type === "note") {
      return decoded.data;
    }
    if (decoded.type === "nevent") {
      return decoded.data.id;
    }
    throw new Error("Invalid note/nevent identifier");
  }
  // Assume hex
  if (!/^[a-f0-9]{64}$/i.test(trimmed)) {
    throw new Error("Event ID must be 64 hex characters or note1/nevent1 format");
  }
  return trimmed.toLowerCase();
}

// ============================================================================
// Details types for structured tool results
// ============================================================================

interface NostrConnectDetails {
  connected: boolean;
  userPubkey?: string;
  relays?: string[];
  error?: string;
  authUrl?: string;
}

interface NostrPostDetails {
  posted: boolean;
  eventId?: string;
  pubkey?: string;
  publishedTo?: string[];
  failedRelays?: Array<{ relay: string; error: string }>;
  error?: string;
  isReply?: boolean;
}

interface NostrReactionDetails {
  reacted: boolean;
  eventId?: string;
  pubkey?: string;
  reaction?: string;
  targetEventId?: string;
  publishedTo?: string[];
  failedRelays?: Array<{ relay: string; error: string }>;
  error?: string;
}

interface NostrRepostDetails {
  reposted: boolean;
  eventId?: string;
  pubkey?: string;
  repostedEventId?: string;
  kind?: number;
  publishedTo?: string[];
  failedRelays?: Array<{ relay: string; error: string }>;
  error?: string;
}

interface NostrFetchDetails {
  fetched: boolean;
  events?: Array<{
    id: string;
    pubkey: string;
    content: string;
    kind: number;
    created_at: number;
    tags: string[][];
    sig: string;
  }>;
  relaysQueried?: string[];
  error?: string;
}

interface NostrArticleDetails {
  posted: boolean;
  eventId?: string;
  pubkey?: string;
  title?: string;
  identifier?: string;
  kind?: number;
  publishedTo?: string[];
  failedRelays?: Array<{ relay: string; error: string }>;
  error?: string;
}

interface NostrDisconnectDetails {
  wasConnected: boolean;
}

interface NostrStatusDetails {
  connected: boolean;
  userPubkey?: string;
  bunkerPubkey?: string;
  relays?: string[];
  connectedAt?: number;
  bunkerIndex?: number;
}

// ============================================================================
// Tool creation functions
// ============================================================================

export function createNostrAgentTools(): ChannelAgentTool[] {
  return [
    createNostrConnectTool(),
    createNostrPostTool(),
    createNostrReactTool(),
    createNostrRepostTool(),
    createNostrFetchTool(),
    createNostrArticleTool(),
    createNostrDisconnectTool(),
    createNostrStatusTool(),
  ];
}

function createNostrConnectTool(): ChannelAgentTool {
  return {
    name: "nostr_connect",
    label: "Nostr Connect",
    description:
      "Connect a Nostr identity via NIP-46 bunker URL. If no URL provided, uses the first bunkerAccount from config or reconnects using persisted state. User can provide bunker:// URL from their signer app (Amber, nsec.app, etc.).",
    parameters: Type.Object({
      bunkerUrl: Type.Optional(
        Type.String({
          description:
            "bunker:// URL from the user's Nostr signer app (optional if configured in channel settings)",
        })
      ),
      bunkerIndex: Type.Optional(
        Type.Number({
          description: "Index of the bunker account to connect (default: 0)",
        })
      ),
    }),
    execute: async (_toolCallId, args) => {
      const { bunkerUrl: argBunkerUrl, bunkerIndex = 0 } = args as {
        bunkerUrl?: string;
        bunkerIndex?: number;
      };

      const accountId = DEFAULT_ACCOUNT_ID;

      try {
        // Load persisted state first - this has the last successful connection
        const persistedState = loadPersistedState(accountId, bunkerIndex);

        // Priority: arg > persisted state > config
        let bunkerUrl = argBunkerUrl;
        if (!bunkerUrl && persistedState?.lastBunkerUrl) {
          bunkerUrl = persistedState.lastBunkerUrl;
        }
        if (!bunkerUrl) {
          const runtime = getNostrRuntime();
          const cfg = runtime.config.loadConfig();
          const account = resolveNostrAccount({ cfg });
          bunkerUrl = account.bunkerAccounts[bunkerIndex]?.bunkerUrl;
        }

        if (!bunkerUrl) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No bunker URL provided and none configured. Please provide a bunker:// URL or configure one in channel settings.",
              },
            ],
            details: {
              connected: false,
              error: "No bunker URL available",
            } satisfies NostrConnectDetails,
          };
        }

        // Check if this is a reconnect to the same bunker (same URL minus secret)
        const strippedUrl = stripBunkerSecret(bunkerUrl);
        const isInitialConnection =
          !persistedState?.lastBunkerUrl || strippedUrl !== persistedState.lastBunkerUrl;

        const pool = getSharedPool();
        const { connection: conn, isReconnect } = await connectBunker({
          accountId,
          bunkerIndex,
          bunkerUrl,
          pool,
          isInitialConnection,
        });

        const reconnectMsg = isReconnect ? " (reconnected)" : "";

        // Save bunkerUrl to main config for persistence
        // Strip secret since it's one-time use (NIP-46) and already consumed
        const urlWithoutSecret = stripBunkerSecret(bunkerUrl);
        try {
          const runtime = getNostrRuntime();
          const cfg = runtime.config.loadConfig();
          const account = resolveNostrAccount({ cfg });
          const bunkerAccounts = [...account.bunkerAccounts];

          // Ensure bunkerIndex exists
          while (bunkerAccounts.length <= bunkerIndex) {
            bunkerAccounts.push({ bunkerUrl: "" });
          }

          // Update the specific bunker account
          bunkerAccounts[bunkerIndex] = {
            ...bunkerAccounts[bunkerIndex],
            bunkerUrl: urlWithoutSecret,
            userPubkey: conn.userPubkey,
            connectedAt: conn.connectedAt,
          };

          // Write back to config
          const channels = (cfg.channels ?? {}) as Record<string, unknown>;
          const nostrConfig = (channels.nostr ?? {}) as Record<string, unknown>;
          await runtime.config.writeConfigFile({
            ...cfg,
            channels: {
              ...channels,
              nostr: {
                ...nostrConfig,
                bunkerAccounts,
              },
            },
          });
        } catch {
          // Config write is best-effort; connection still succeeded
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Connected to Nostr${reconnectMsg}! You can now post as ${conn.userPubkey.slice(0, 8)}... (${conn.relays.length} relay(s))`,
            },
          ],
          details: {
            connected: true,
            userPubkey: conn.userPubkey,
            relays: conn.relays,
          } satisfies NostrConnectDetails,
        };
      } catch (err) {
        // Special handling for auth_url - bunker needs user approval
        if (err instanceof BunkerAuthUrlError) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Your Nostr signer requires approval. Please open this URL to authorize the connection:\n\n${err.authUrl}\n\nAfter approving in your signer app, ask me to connect again.`,
              },
            ],
            details: {
              connected: false,
              error: "auth_url_required",
              authUrl: err.authUrl,
            } satisfies NostrConnectDetails,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to connect bunker: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: {
            connected: false,
            error: err instanceof Error ? err.message : String(err),
          } satisfies NostrConnectDetails,
        };
      }
    },
  };
}

function createNostrPostTool(): ChannelAgentTool {
  return {
    name: "nostr_post",
    label: "Nostr Post",
    description:
      "Post a kind:1 note to Nostr using the connected bunker identity. Supports NIP-10 reply threading. Requires nostr_connect first.",
    parameters: Type.Object({
      content: Type.String({
        description: "The text content of the note to post",
      }),
      relays: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Optional relay URLs to publish to (defaults to bunker relays)",
        })
      ),
      // NIP-10 reply threading
      replyTo: Type.Optional(
        Type.String({
          description: "Event ID to reply to (hex or note1... format)",
        })
      ),
      replyToPubkey: Type.Optional(
        Type.String({
          description:
            "Pubkey of the reply target author (required if replyTo is set)",
        })
      ),
      rootEvent: Type.Optional(
        Type.String({
          description:
            "Root event ID of thread (if different from replyTo, for deep replies)",
        })
      ),
      rootPubkey: Type.Optional(
        Type.String({
          description: "Pubkey of the root event author",
        })
      ),
      mentions: Type.Optional(
        Type.Array(Type.String(), {
          description: "Additional pubkeys to mention in the note",
        })
      ),
      bunkerIndex: Type.Optional(
        Type.Number({
          description: "Index of the bunker account to use (default: first connected)",
        })
      ),
    }),
    execute: async (_toolCallId, args) => {
      const {
        content,
        relays,
        replyTo,
        replyToPubkey,
        rootEvent,
        rootPubkey,
        mentions,
        bunkerIndex,
      } = args as {
        content: string;
        relays?: string[];
        replyTo?: string;
        replyToPubkey?: string;
        rootEvent?: string;
        rootPubkey?: string;
        mentions?: string[];
        bunkerIndex?: number;
      };

      try {
        const pool = getSharedPool();
        const result = await postNote({
          accountId: DEFAULT_ACCOUNT_ID,
          bunkerIndex,
          content,
          pool,
          relays,
          replyTo: replyTo ? normalizeEventIdToHex(replyTo) : undefined,
          replyToPubkey: replyToPubkey ? normalizePubkey(replyToPubkey) : undefined,
          rootEvent: rootEvent ? normalizeEventIdToHex(rootEvent) : undefined,
          rootPubkey: rootPubkey ? normalizePubkey(rootPubkey) : undefined,
          mentions: mentions?.map(normalizePubkey),
        });

        const successCount = result.publishedTo.length;
        const failCount = result.failedRelays.length;
        const isReply = Boolean(replyTo);

        return {
          content: [
            {
              type: "text" as const,
              text: `Posted ${isReply ? "reply" : "note"} ${result.eventId.slice(0, 8)}... to ${successCount} relay(s)${failCount > 0 ? ` (${failCount} failed)` : ""}`,
            },
          ],
          details: {
            posted: true,
            eventId: result.eventId,
            pubkey: result.pubkey,
            publishedTo: result.publishedTo,
            failedRelays: result.failedRelays,
            isReply,
          } satisfies NostrPostDetails,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to post: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: {
            posted: false,
            error: err instanceof Error ? err.message : String(err),
          } satisfies NostrPostDetails,
        };
      }
    },
  };
}

function createNostrReactTool(): ChannelAgentTool {
  return {
    name: "nostr_react",
    label: "Nostr React",
    description:
      'React to a Nostr event with a like (+), dislike (-), or emoji. Creates a kind:7 reaction event per NIP-25. Requires nostr_connect first.',
    parameters: Type.Object({
      eventId: Type.String({
        description: "Event ID to react to (hex or note1... format)",
      }),
      eventPubkey: Type.String({
        description: "Pubkey of the event author (required per NIP-25)",
      }),
      reaction: Type.Optional(
        Type.String({
          description:
            'The reaction: "+" for like (default), "-" for dislike, or any emoji',
        })
      ),
      eventKind: Type.Optional(
        Type.Number({
          description: "Kind of the event being reacted to (default: 1)",
        })
      ),
      relays: Type.Optional(
        Type.Array(Type.String(), {
          description: "Optional relay URLs to publish to",
        })
      ),
      bunkerIndex: Type.Optional(
        Type.Number({
          description: "Index of the bunker account to use (default: first connected)",
        })
      ),
    }),
    execute: async (_toolCallId, args) => {
      const { eventId, eventPubkey, reaction, eventKind, relays, bunkerIndex } = args as {
        eventId: string;
        eventPubkey: string;
        reaction?: string;
        eventKind?: number;
        relays?: string[];
        bunkerIndex?: number;
      };

      try {
        const pool = getSharedPool();
        const result = await postReaction({
          accountId: DEFAULT_ACCOUNT_ID,
          bunkerIndex,
          eventId: normalizeEventIdToHex(eventId),
          eventPubkey: normalizePubkey(eventPubkey),
          eventKind,
          reaction: reaction ?? "+",
          pool,
          relays,
        });

        const successCount = result.publishedTo.length;
        const failCount = result.failedRelays.length;

        return {
          content: [
            {
              type: "text" as const,
              text: `Reacted "${result.reaction}" to ${eventId.slice(0, 8)}... (${successCount} relay(s)${failCount > 0 ? `, ${failCount} failed` : ""})`,
            },
          ],
          details: {
            reacted: true,
            eventId: result.eventId,
            pubkey: result.pubkey,
            reaction: result.reaction,
            targetEventId: result.targetEventId,
            publishedTo: result.publishedTo,
            failedRelays: result.failedRelays,
          } satisfies NostrReactionDetails,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to react: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: {
            reacted: false,
            error: err instanceof Error ? err.message : String(err),
          } satisfies NostrReactionDetails,
        };
      }
    },
  };
}

function createNostrRepostTool(): ChannelAgentTool {
  return {
    name: "nostr_repost",
    label: "Nostr Repost",
    description:
      "Repost/boost a Nostr event. Creates a kind:6 repost (for notes) or kind:16 generic repost (for other kinds) per NIP-18. Requires nostr_connect first.",
    parameters: Type.Object({
      eventId: Type.String({
        description: "Event ID to repost (hex or note1... format)",
      }),
      eventPubkey: Type.String({
        description: "Pubkey of the event author",
      }),
      eventKind: Type.Optional(
        Type.Number({
          description:
            "Kind of the event being reposted (default: 1). Determines if kind:6 or kind:16 is used.",
        })
      ),
      relays: Type.Optional(
        Type.Array(Type.String(), {
          description: "Optional relay URLs to publish to",
        })
      ),
      bunkerIndex: Type.Optional(
        Type.Number({
          description: "Index of the bunker account to use (default: first connected)",
        })
      ),
    }),
    execute: async (_toolCallId, args) => {
      const { eventId, eventPubkey, eventKind, relays, bunkerIndex } = args as {
        eventId: string;
        eventPubkey: string;
        eventKind?: number;
        relays?: string[];
        bunkerIndex?: number;
      };

      try {
        const pool = getSharedPool();
        const result = await postRepost({
          accountId: DEFAULT_ACCOUNT_ID,
          bunkerIndex,
          eventId: normalizeEventIdToHex(eventId),
          eventPubkey: normalizePubkey(eventPubkey),
          eventKind,
          pool,
          relays,
        });

        const successCount = result.publishedTo.length;
        const failCount = result.failedRelays.length;

        return {
          content: [
            {
              type: "text" as const,
              text: `Reposted ${eventId.slice(0, 8)}... as kind:${result.kind} (${successCount} relay(s)${failCount > 0 ? `, ${failCount} failed` : ""})`,
            },
          ],
          details: {
            reposted: true,
            eventId: result.eventId,
            pubkey: result.pubkey,
            repostedEventId: result.repostedEventId,
            kind: result.kind,
            publishedTo: result.publishedTo,
            failedRelays: result.failedRelays,
          } satisfies NostrRepostDetails,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to repost: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: {
            reposted: false,
            error: err instanceof Error ? err.message : String(err),
          } satisfies NostrRepostDetails,
        };
      }
    },
  };
}

function createNostrFetchTool(): ChannelAgentTool {
  return {
    name: "nostr_fetch",
    label: "Nostr Fetch",
    description:
      "Fetch and search Nostr events from relays. Can fetch by event ID, author pubkey, kinds, hashtags, mentions, or full-text search (NIP-50, relay dependent).",
    parameters: Type.Object({
      eventId: Type.Optional(
        Type.String({
          description: "Fetch specific event by ID (hex or note1... format)",
        })
      ),
      pubkey: Type.Optional(
        Type.String({
          description: "Fetch events by author (npub or hex pubkey)",
        })
      ),
      kinds: Type.Optional(
        Type.Array(Type.Number(), {
          description: "Filter by event kinds (default: [1] for notes)",
        })
      ),
      search: Type.Optional(
        Type.String({
          description: "NIP-50 full-text search query (relay dependent)",
        })
      ),
      hashtag: Type.Optional(
        Type.String({
          description: 'Filter by hashtag (without # prefix, e.g., "nostr")',
        })
      ),
      mentions: Type.Optional(
        Type.String({
          description: "Filter by mentioned pubkey",
        })
      ),
      limit: Type.Optional(
        Type.Number({
          description: "Max events to return (default: 10)",
        })
      ),
      since: Type.Optional(
        Type.Number({
          description: "Unix timestamp - only events after this time",
        })
      ),
      until: Type.Optional(
        Type.Number({
          description: "Unix timestamp - only events before this time",
        })
      ),
      relays: Type.Optional(
        Type.Array(Type.String(), {
          description: "Optional relay URLs to query",
        })
      ),
      bunkerIndex: Type.Optional(
        Type.Number({
          description: "Index of the bunker account to use for relay list (default: first connected)",
        })
      ),
    }),
    execute: async (_toolCallId, args) => {
      const {
        eventId,
        pubkey,
        kinds,
        search,
        hashtag,
        mentions,
        limit,
        since,
        until,
        relays,
        bunkerIndex,
      } = args as {
        eventId?: string;
        pubkey?: string;
        kinds?: number[];
        search?: string;
        hashtag?: string;
        mentions?: string;
        limit?: number;
        since?: number;
        until?: number;
        relays?: string[];
        bunkerIndex?: number;
      };

      try {
        const pool = getSharedPool();

        // Build NIP-01 filter with normalized inputs
        const filter: Record<string, unknown> = {};

        if (eventId) {
          filter.ids = [normalizeEventIdToHex(eventId)];
        }
        if (pubkey) {
          filter.authors = [normalizePubkey(pubkey)];
        }
        if (kinds && kinds.length > 0) {
          filter.kinds = kinds;
        } else if (!eventId) {
          // Default to kind:1 notes if not fetching by ID
          filter.kinds = [1];
        }
        if (search) {
          filter.search = search;
        }
        if (hashtag) {
          filter["#t"] = [hashtag];
        }
        if (mentions) {
          filter["#p"] = [normalizePubkey(mentions)];
        }
        if (since) {
          filter.since = since;
        }
        if (until) {
          filter.until = until;
        }
        filter.limit = limit ?? 10;

        const result = await fetchEvents({
          accountId: DEFAULT_ACCOUNT_ID,
          bunkerIndex,
          filter: filter as Parameters<typeof fetchEvents>[0]["filter"],
          pool,
          relays,
        });

        const events = result.events.map((e) => ({
          id: e.id,
          pubkey: e.pubkey,
          content: e.content,
          kind: e.kind,
          created_at: e.created_at,
          tags: e.tags,
          sig: e.sig,
        }));

        return {
          content: [
            {
              type: "text" as const,
              text: `Fetched ${events.length} event(s) from ${result.relaysQueried.length} relay(s)\n\n${JSON.stringify(events, null, 2)}`,
            },
          ],
          details: {
            fetched: true,
            events,
            relaysQueried: result.relaysQueried,
          } satisfies NostrFetchDetails,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to fetch: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: {
            fetched: false,
            error: err instanceof Error ? err.message : String(err),
          } satisfies NostrFetchDetails,
        };
      }
    },
  };
}

function createNostrArticleTool(): ChannelAgentTool {
  return {
    name: "nostr_article",
    label: "Nostr Article",
    description:
      "Post a long-form article (kind:30023) to Nostr per NIP-23. Supports markdown content, title, summary, image, and hashtags. Can also create drafts (kind:30024). Requires nostr_connect first.",
    parameters: Type.Object({
      title: Type.String({
        description: "Article title",
      }),
      content: Type.String({
        description: "Article content in markdown format",
      }),
      identifier: Type.String({
        description:
          'd-tag identifier for the article (used for updates/replacements, e.g., "my-first-article")',
      }),
      summary: Type.Optional(
        Type.String({
          description: "Short summary/excerpt of the article",
        })
      ),
      image: Type.Optional(
        Type.String({
          description: "Header/cover image URL",
        })
      ),
      hashtags: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Hashtags for the article (without # prefix)',
        })
      ),
      isDraft: Type.Optional(
        Type.Boolean({
          description:
            "If true, creates a draft (kind:30024) instead of published article (kind:30023)",
        })
      ),
      relays: Type.Optional(
        Type.Array(Type.String(), {
          description: "Optional relay URLs to publish to",
        })
      ),
      bunkerIndex: Type.Optional(
        Type.Number({
          description: "Index of the bunker account to use (default: first connected)",
        })
      ),
    }),
    execute: async (_toolCallId, args) => {
      const { title, content, identifier, summary, image, hashtags, isDraft, relays, bunkerIndex } =
        args as {
          title: string;
          content: string;
          identifier: string;
          summary?: string;
          image?: string;
          hashtags?: string[];
          isDraft?: boolean;
          relays?: string[];
          bunkerIndex?: number;
        };

      try {
        const pool = getSharedPool();
        const result = await postArticle({
          accountId: DEFAULT_ACCOUNT_ID,
          bunkerIndex,
          title,
          content,
          identifier,
          summary,
          image,
          hashtags,
          isDraft,
          pool,
          relays,
        });

        const successCount = result.publishedTo.length;
        const failCount = result.failedRelays.length;
        const typeLabel = isDraft ? "draft" : "article";

        return {
          content: [
            {
              type: "text" as const,
              text: `Posted ${typeLabel} "${title}" (${result.eventId.slice(0, 8)}...) to ${successCount} relay(s)${failCount > 0 ? ` (${failCount} failed)` : ""}`,
            },
          ],
          details: {
            posted: true,
            eventId: result.eventId,
            pubkey: result.pubkey,
            title: result.title,
            identifier: result.identifier,
            kind: result.kind,
            publishedTo: result.publishedTo,
            failedRelays: result.failedRelays,
          } satisfies NostrArticleDetails,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to post article: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: {
            posted: false,
            error: err instanceof Error ? err.message : String(err),
          } satisfies NostrArticleDetails,
        };
      }
    },
  };
}

function createNostrDisconnectTool(): ChannelAgentTool {
  return {
    name: "nostr_disconnect",
    label: "Nostr Disconnect",
    description: "Disconnect a Nostr bunker session. Defaults to first connected bunker.",
    parameters: Type.Object({
      bunkerIndex: Type.Optional(
        Type.Number({
          description: "Index of the bunker account to disconnect (default: 0)",
        })
      ),
    }),
    execute: async (_toolCallId, args) => {
      const { bunkerIndex = 0 } = args as { bunkerIndex?: number };

      const wasConnected = hasAnyBunkerConnected(DEFAULT_ACCOUNT_ID);
      await disconnectBunker(DEFAULT_ACCOUNT_ID, bunkerIndex);

      return {
        content: [
          {
            type: "text" as const,
            text: wasConnected
              ? `Disconnected bunker ${bunkerIndex} from Nostr.`
              : "No bunker was connected.",
          },
        ],
        details: {
          wasConnected,
        } satisfies NostrDisconnectDetails,
      };
    },
  };
}

function createNostrStatusTool(): ChannelAgentTool {
  return {
    name: "nostr_status",
    label: "Nostr Status",
    description: "Check the current Nostr bunker connection status.",
    parameters: Type.Object({
      bunkerIndex: Type.Optional(
        Type.Number({
          description: "Index of the bunker account to check (default: shows first connected)",
        })
      ),
    }),
    execute: async (_toolCallId, args) => {
      const { bunkerIndex } = args as { bunkerIndex?: number };

      const conn = bunkerIndex !== undefined
        ? getBunkerConnection(DEFAULT_ACCOUNT_ID, bunkerIndex)
        : getFirstBunkerConnection(DEFAULT_ACCOUNT_ID);

      if (!conn) {
        // Check if any bunkers are configured
        const allConns = getAllBunkerConnections(DEFAULT_ACCOUNT_ID);
        if (allConns.length > 0) {
          const connList = allConns.map((c) => `  ${c.bunkerIndex}: ${c.userPubkey.slice(0, 8)}...`).join("\n");
          return {
            content: [
              {
                type: "text" as const,
                text: `${allConns.length} bunker(s) connected:\n${connList}`,
              },
            ],
            details: {
              connected: true,
              userPubkey: allConns[0].userPubkey,
              bunkerPubkey: allConns[0].bunkerPubkey,
              relays: allConns[0].relays,
              connectedAt: allConns[0].connectedAt,
              bunkerIndex: allConns[0].bunkerIndex,
            } satisfies NostrStatusDetails,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: "No Nostr bunker connected. Use nostr_connect to connect.",
            },
          ],
          details: {
            connected: false,
          } satisfies NostrStatusDetails,
        };
      }

      const connectedAgo = Math.floor((Date.now() - conn.connectedAt) / 1000);
      return {
        content: [
          {
            type: "text" as const,
            text: `Connected as ${conn.userPubkey.slice(0, 8)}... via ${conn.relays.length} relay(s) (connected ${connectedAgo}s ago, bunker index: ${conn.bunkerIndex})`,
          },
        ],
        details: {
          connected: true,
          userPubkey: conn.userPubkey,
          bunkerPubkey: conn.bunkerPubkey,
          relays: conn.relays,
          connectedAt: conn.connectedAt,
          bunkerIndex: conn.bunkerIndex,
        } satisfies NostrStatusDetails,
      };
    },
  };
}
