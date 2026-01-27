import { resolveChannelMediaMaxBytes, type MoltbotConfig, type PluginRuntime } from "clawdbot/plugin-sdk";
import type { MSTeamsAccessTokenProvider } from "./attachments/types.js";
import type {
  MSTeamsConversationStore,
  StoredConversationReference,
} from "./conversation-store.js";
import { createMSTeamsConversationStoreFs } from "./conversation-store-fs.js";
import type { MSTeamsAdapter } from "./messenger.js";
import { getMSTeamsRuntime } from "./runtime.js";
import { createMSTeamsAdapter, loadMSTeamsSdkWithAuth } from "./sdk.js";
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
    if (ref) return { conversationId: recipient.id, ref };
    return null;
  }

  const found = await recipient.store.findByUserId(recipient.id);
  if (!found) return null;
  return { conversationId: found.conversationId, ref: found.reference };
}

export async function resolveMSTeamsSendContext(params: {
  cfg: MoltbotConfig;
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
  const core = getMSTeamsRuntime();
  const log = core.logging.getChildLogger({ name: "msteams:send" });

  const { sdk, authConfig } = await loadMSTeamsSdkWithAuth(creds);
  const adapter = createMSTeamsAdapter(authConfig, sdk);

  // Create token provider for Graph API / OneDrive operations
  const tokenProvider = new sdk.MsalTokenProvider(authConfig) as MSTeamsAccessTokenProvider;

  // Determine conversation type from stored reference
  const storedConversationType = ref.conversation?.conversationType?.toLowerCase() ?? "";
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
  };
}
