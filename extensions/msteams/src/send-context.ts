// Msteams plugin module implements send context behavior.
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  resolveChannelMediaMaxBytes,
  type MSTeamsConfig,
  type MSTeamsReplyStyle,
  type OpenClawConfig,
  type PluginRuntime,
} from "../runtime-api.js";
import type { MSTeamsAccessTokenProvider } from "./attachments/types.js";
import {
  describeBotFrameworkServiceUrlHost,
  isAllowedBotFrameworkServiceUrl,
  normalizeBotFrameworkServiceUrl,
} from "./bot-framework-service-url.js";
import {
  resolveMSTeamsSdkCloudOptions,
  validateMSTeamsProactiveServiceUrlBoundary,
  type MSTeamsSdkCloudOptions,
} from "./cloud.js";
import { createMSTeamsConversationStoreState } from "./conversation-store-state.js";
import type {
  MSTeamsConversationStore,
  StoredConversationReference,
} from "./conversation-store.js";
import { formatUnknownError } from "./errors.js";
import { resolveMSTeamsReplyPolicy, resolveMSTeamsRouteConfig } from "./policy.js";
import { getMSTeamsRuntime } from "./runtime.js";
import type { MSTeamsApp } from "./sdk.js";
import { createMSTeamsTokenProvider, loadMSTeamsSdkWithAuth } from "./sdk.js";
import { resolveMSTeamsCredentials } from "./token.js";

type MSTeamsConversationType = "personal" | "groupChat" | "channel";

export type MSTeamsProactiveContext = {
  appId: string;
  conversationId: string;
  ref: StoredConversationReference;
  app: MSTeamsApp;
  log: ReturnType<PluginRuntime["logging"]["getChildLogger"]>;
  /** The type of conversation: personal (1:1), groupChat, or channel */
  conversationType: MSTeamsConversationType;
  /** Reply style resolved for proactive text/media sends. */
  replyStyle: MSTeamsReplyStyle;
  /** Teams SDK cloud/service endpoint used to validate proactive sends. */
  sdkCloudOptions: MSTeamsSdkCloudOptions;
  /** Token provider for Graph API / SharePoint operations */
  tokenProvider: MSTeamsAccessTokenProvider;
  /** SharePoint site ID for file uploads in group chats/channels */
  sharePointSiteId?: string;
  /** Resolved media max bytes from config (default: 100MB) */
  mediaMaxBytes?: number;
};

function resolveMSTeamsProactiveReplyStyle(params: {
  cfg?: MSTeamsConfig;
  conversationId: string;
  ref: StoredConversationReference;
  conversationType: MSTeamsConversationType;
}): MSTeamsReplyStyle {
  const threadRootId = params.ref.threadId ?? params.ref.activityId;
  if (params.conversationType !== "channel" || !threadRootId) {
    return "top-level";
  }

  const routeConfig = resolveMSTeamsRouteConfig({
    cfg: params.cfg,
    teamId: params.ref.teamId,
    conversationId: params.conversationId,
    allowNameMatching: false,
  });
  const { replyStyle } = resolveMSTeamsReplyPolicy({
    isDirectMessage: false,
    globalConfig: params.cfg,
    teamConfig: routeConfig.teamConfig,
    channelConfig: routeConfig.channelConfig,
  });
  return replyStyle;
}

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

  const store = createMSTeamsConversationStoreState();

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

  if (ref.serviceUrl && !isAllowedBotFrameworkServiceUrl(ref.serviceUrl)) {
    try {
      await store.remove(conversationId);
    } catch (err) {
      log.warn?.("failed to remove blocked msteams conversation reference", {
        conversationId,
        error: formatUnknownError(err),
      });
    }
    throw new Error(
      `Stored Microsoft Teams conversation reference has blocked serviceUrl host: ${describeBotFrameworkServiceUrlHost(ref.serviceUrl)}. ` +
        `The bot must receive a new message from this conversation before it can send proactively.`,
    );
  }
  const safeRef = ref.serviceUrl
    ? { ...ref, serviceUrl: normalizeBotFrameworkServiceUrl(ref.serviceUrl) }
    : ref;

  // Safety check: when the caller targeted a specific user (DM), verify the
  // resolved conversation is actually a personal DM.  Without this guard a
  // stale or mismatched conversation store could route a private DM reply
  // into a shared channel or group chat -- see #54520.
  if (recipient.type === "user") {
    const resolvedType = normalizeLowercaseStringOrEmpty(
      safeRef.conversation?.conversationType ?? "",
    );
    if (resolvedType && resolvedType !== "personal") {
      throw new Error(
        `Conversation reference for user:${recipient.id} resolved to a ${resolvedType} ` +
          `conversation (${conversationId}) instead of a personal DM. ` +
          `The bot must receive a DM from this user before it can send proactively.`,
      );
    }
  }
  const sdkCloudOptions = resolveMSTeamsSdkCloudOptions(msteamsCfg);
  const { app } = await loadMSTeamsSdkWithAuth(creds, sdkCloudOptions);
  validateMSTeamsProactiveServiceUrlBoundary({
    cloud: sdkCloudOptions.cloud,
    conversationId,
    storedServiceUrl: safeRef.serviceUrl,
    configuredServiceUrl: sdkCloudOptions.serviceUrl,
  });

  // Create token provider adapter for Graph API / SharePoint operations
  const tokenProvider: MSTeamsAccessTokenProvider = createMSTeamsTokenProvider(app);

  // Determine conversation type from stored reference
  const storedConversationType = normalizeLowercaseStringOrEmpty(
    safeRef.conversation?.conversationType ?? "",
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
  const replyStyle = resolveMSTeamsProactiveReplyStyle({
    cfg: msteamsCfg,
    conversationId,
    ref: safeRef,
    conversationType,
  });

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
    ref: safeRef,
    app,
    log,
    conversationType,
    replyStyle,
    sdkCloudOptions,
    tokenProvider,
    sharePointSiteId,
    mediaMaxBytes,
  };
}
