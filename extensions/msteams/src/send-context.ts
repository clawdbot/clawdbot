import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import {
  resolveChannelMediaMaxBytes,
  type OpenClawConfig,
  type PluginRuntime,
} from "../runtime-api.js";
import type { MSTeamsAccessTokenProvider } from "./attachments/types.js";
import { createMSTeamsConversationStoreFs } from "./conversation-store-fs.js";
import type {
  MSTeamsConversationStore,
  StoredConversationReference,
} from "./conversation-store.js";
import { formatUnknownError } from "./errors.js";
import { resolveGraphChatId } from "./graph-upload.js";
import type { MSTeamsAdapter } from "./messenger.js";
import { getMSTeamsRuntime } from "./runtime.js";
import { createMSTeamsAdapter, createMSTeamsTokenProvider, loadMSTeamsSdkWithAuth } from "./sdk.js";
import { resolveMSTeamsCredentials } from "./token.js";

export type MSTeamsConversationType = "personal" | "groupChat" | "channel";

export type MSTeamsProactiveContext = {
  appId: string;
  conversationId: string;
  ref: StoredConversationReference;
  adapter: MSTeamsAdapter;
  log: ReturnType<PluginRuntime["logging"]["getChildLogger"]>;
  /** The type of conversation: personal (1:1), groupChat, or channel */
  conversationType: MSTeamsConversationType;
  /** Token provider for Graph API / OneDrive operations */
  tokenProvider: MSTeamsAccessTokenProvider;
  /** SharePoint site ID for file uploads in group chats/channels */
  sharePointSiteId?: string;
  /** Resolved media max bytes from config (default: 100MB) */
  mediaMaxBytes?: number;
  /**
   * Graph API-native chat ID for this conversation.
   * Bot Framework personal DM IDs (`a:1xxx` / `8:orgid:xxx`) cannot be used directly
   * with Graph chat endpoints. This field holds the resolved `19:xxx` format ID.
   * Null if resolution failed or not applicable.
   */
  graphChatId?: string | null;
};

/**
 * Parse the target value into a conversation reference lookup key.
 * Supported formats:
 * - conversation:19:abc@thread.tacv2 → lookup by conversation ID
 * - user:aad-object-id → lookup by user AAD object ID
 * - 19:abc@thread.tacv2 → direct conversation ID
 */
function parseRecipient(to: string): {
  type: "conversation" | "user";
  id: string;
} {
  const trimmed = to.trim();
  const finalize = (type: "conversation" | "user", id: string) => {
    const normalized = id.trim();
    if (!normalized) {
      throw new Error(`Invalid target value: missing ${type} id`);
    }
    return { type, id: normalized };
  };
  if (trimmed.startsWith("conversation:")) {
    return finalize("conversation", trimmed.slice("conversation:".length));
  }
  if (trimmed.startsWith("user:")) {
    return finalize("user", trimmed.slice("user:".length));
  }
  // Assume it's a conversation ID if it looks like one
  if (trimmed.startsWith("19:") || trimmed.includes("@thread")) {
    return finalize("conversation", trimmed);
  }
  // Otherwise treat as user ID
  return finalize("user", trimmed);
}

/**
 * Find a stored conversation reference for the given recipient.
 */
async function findConversationReference(recipient: {
  type: "conversation" | "user";
  id: string;
  store: MSTeamsConversationStore;
}): Promise<{
  conversationId: string;
  ref: StoredConversationReference;
} | null> {
  if (recipient.type === "conversation") {
    const ref = await recipient.store.get(recipient.id);
    if (ref) {
      return { conversationId: recipient.id, ref };
    }
    return null;
  }

  const found = await recipient.store.findPreferredDmByUserId(recipient.id);
  if (!found) {
    return null;
  }
  return { conversationId: found.conversationId, ref: found.reference };
}

export async function resolveMSTeamsSendContext(params: {
  cfg: OpenClawConfig;
  to: string;
}): Promise<MSTeamsProactiveContext> {
  const msteamsCfg = params.cfg.channels?.msteams;

  if (!msteamsCfg?.enabled) {
    throw new Error("msteams provider is not enabled");
  }

  const creds = resolveMSTeamsCredentials(msteamsCfg);
  if (!creds) {
    throw new Error("msteams credentials not configured");
  }

  const store = createMSTeamsConversationStoreFs();

  // Parse recipient and find conversation reference
  const recipient = parseRecipient(params.to);
  const found = await findConversationReference({ ...recipient, store });

  if (!found) {
    throw new Error(
      `No conversation reference found for ${recipient.type}:${recipient.id}. ` +
        `The bot must receive a message from this conversation before it can send proactively.`,
    );
  }

  const { conversationId, ref } = found;

  // Safety check: when the caller targeted a specific user (DM), verify the
  // resolved conversation is actually a personal DM.  Without this guard a
  // stale or mismatched conversation store could route a private DM reply
  // into a shared channel or group chat -- see #54520.
  if (recipient.type === "user") {
    const resolvedType = normalizeLowercaseStringOrEmpty(ref.conversation?.conversationType ?? "");
    if (resolvedType && resolvedType !== "personal") {
      throw new Error(
        `Conversation reference for user:${recipient.id} resolved to a ${resolvedType} ` +
          `conversation (${conversationId}) instead of a personal DM. ` +
          `The bot must receive a DM from this user before it can send proactively.`,
      );
    }
  }
  const core = getMSTeamsRuntime();
  const log = core.logging.getChildLogger({ name: "msteams:send" });

  const { sdk, app } = await loadMSTeamsSdkWithAuth(creds);
  const adapter = createMSTeamsAdapter(app, sdk);

  // Create token provider adapter for Graph API / OneDrive operations
  const tokenProvider: MSTeamsAccessTokenProvider = createMSTeamsTokenProvider(app);

  // Determine conversation type from stored reference
  const storedConversationType = normalizeLowercaseStringOrEmpty(
    ref.conversation?.conversationType ?? "",
  );
  let conversationType: MSTeamsConversationType;
  if (storedConversationType === "personal") {
    conversationType = "personal";
  } else if (storedConversationType === "channel") {
    conversationType = "channel";
  } else {
    // groupChat, or unknown defaults to groupChat behavior
    conversationType = "groupChat";
  }

  // Get SharePoint site ID from config (required for file uploads in group chats/channels)
  const sharePointSiteId = msteamsCfg.sharePointSiteId;

  // Resolve media max bytes from config
  const mediaMaxBytes = resolveChannelMediaMaxBytes({
    cfg: params.cfg,
    resolveChannelLimitMb: ({ cfg }) => cfg.channels?.msteams?.mediaMaxMb,
  });

  // Resolve Graph API-native chat ID if needed for SharePoint per-user sharing.
  // Bot Framework personal DM conversation IDs (e.g. `a:1xxx` or `8:orgid:xxx`) cannot
  // be used directly with Graph /chats/{chatId} endpoints — the Graph API requires the
  // `19:xxx@thread.tacv2` or `19:xxx@unq.gbl.spaces` format.
  // We check the cached value first, then resolve via Graph API and cache for future sends.
  let graphChatId: string | null | undefined = ref.graphChatId ?? undefined;
  if (graphChatId === undefined && sharePointSiteId) {
    // Only resolve when SharePoint is configured (the only place chatId matters currently)
    try {
      const resolved = await resolveGraphChatId({
        botFrameworkConversationId: conversationId,
        userAadObjectId: ref.user?.aadObjectId,
        tokenProvider,
      });
      graphChatId = resolved;

      // Cache in the conversation store so subsequent sends skip the Graph lookup.
      // NOTE: We intentionally do NOT cache null results. Transient Graph API failures
      // (network, 401, rate limit) should be retried on subsequent sends rather than
      // permanently blocking file uploads for this conversation.
      if (resolved) {
        await store.upsert(conversationId, { ...ref, graphChatId: resolved });
      } else {
        log.warn?.("could not resolve Graph chat ID; file uploads may fail for this conversation", {
          conversationId,
        });
      }
    } catch (err) {
      log.warn?.(
        "failed to resolve Graph chat ID; file uploads may fall back to Bot Framework ID",
        {
          conversationId,
          error: formatUnknownError(err),
        },
      );
      graphChatId = null;
    }
  }

  return {
    appId: creds.appId,
    conversationId,
    ref,
    adapter: adapter as unknown as MSTeamsAdapter,
    log,
    conversationType,
    tokenProvider,
    sharePointSiteId,
    mediaMaxBytes,
    graphChatId,
  };
}
