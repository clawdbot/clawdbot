// Mattermost plugin module implements reactions behavior.
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeMattermostMessagingTarget } from "../normalize.js";
import { resolveMattermostAccount } from "./accounts.js";
import {
  createMattermostClient,
  fetchMattermostChannel,
  fetchMattermostMe,
  type MattermostClient,
  type MattermostFetch,
  type MattermostPost,
} from "./client.js";
import type { OpenClawConfig } from "./runtime-api.js";

type ConversationReadInvocationOrigin = NonNullable<
  ChannelMessageActionContext["conversationReadOrigin"]
>;
type Result = { ok: true } | { ok: false; error: string };
type ReactionParams = {
  cfg: OpenClawConfig;
  postId: string;
  emojiName: string;
  accountId?: string | null;
  authorizedTarget?: string;
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  fetchImpl?: MattermostFetch;
};
type ReactionMutation = (client: MattermostClient, params: MutationPayload) => Promise<void>;
type MutationPayload = { userId: string; postId: string; emojiName: string };

const BOT_USER_CACHE_TTL_MS = 10 * 60_000;
const botUserIdCache = new Map<string, { userId: string; expiresAt: number }>();

async function resolveBotUserId(
  client: MattermostClient,
  cacheKey: string,
): Promise<string | null> {
  const rawNow = Date.now();
  const now = asDateTimestampMs(rawNow);
  const cached = botUserIdCache.get(cacheKey);
  if (cached) {
    if (now !== undefined && cached.expiresAt > now) {
      return cached.userId;
    }
    botUserIdCache.delete(cacheKey);
  }
  const me = await fetchMattermostMe(client);
  const userId = me?.id?.trim();
  if (!userId) {
    return null;
  }
  const expiresAt = resolveExpiresAtMsFromDurationMs(BOT_USER_CACHE_TTL_MS, { nowMs: rawNow });
  if (expiresAt !== undefined) {
    botUserIdCache.set(cacheKey, { userId, expiresAt });
  }
  return userId;
}

export async function addMattermostReaction(params: {
  cfg: OpenClawConfig;
  postId: string;
  emojiName: string;
  accountId?: string | null;
  authorizedTarget?: string;
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  fetchImpl?: MattermostFetch;
}): Promise<Result> {
  return runMattermostReaction(params, {
    action: "add",
    mutation: createReaction,
  });
}

export async function removeMattermostReaction(params: {
  cfg: OpenClawConfig;
  postId: string;
  emojiName: string;
  accountId?: string | null;
  authorizedTarget?: string;
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  fetchImpl?: MattermostFetch;
}): Promise<Result> {
  return runMattermostReaction(params, {
    action: "remove",
    mutation: deleteReaction,
  });
}

type AuthorizedReactionTarget = { kind: "channel"; id: string } | { kind: "user"; id: string };

function parseAuthorizedReactionTarget(rawTarget?: string): AuthorizedReactionTarget | null {
  const normalized = rawTarget ? normalizeMattermostMessagingTarget(rawTarget) : undefined;
  if (!normalized) {
    return null;
  }
  if (normalized.startsWith("channel:")) {
    const id = normalized.slice("channel:".length).trim();
    return id ? { kind: "channel", id } : null;
  }
  if (normalized.startsWith("user:")) {
    const id = normalized.slice("user:".length).trim();
    return id ? { kind: "user", id } : null;
  }
  return null;
}

async function authorizeMattermostReactionResource(params: {
  client: MattermostClient;
  cacheKey: string;
  postId: string;
  authorizedTarget?: string;
}): Promise<string | undefined> {
  const target = parseAuthorizedReactionTarget(params.authorizedTarget);
  if (!target) {
    throw new Error(
      "Mattermost delegated reactions require a canonical authorized conversation target.",
    );
  }

  const post = await params.client.request<MattermostPost>(
    `/posts/${encodeURIComponent(params.postId)}`,
  );
  const postChannelId = post.channel_id?.trim();
  if (!postChannelId) {
    throw new Error("Mattermost reaction post is missing its conversation binding.");
  }
  if (target.kind === "channel") {
    if (postChannelId !== target.id) {
      throw new Error("Mattermost reaction post belongs to a different conversation.");
    }
    return undefined;
  }

  const botUserId = await resolveBotUserId(params.client, params.cacheKey);
  if (!botUserId) {
    throw new Error("Mattermost reactions failed: could not resolve bot user id.");
  }
  const channel = await fetchMattermostChannel(params.client, postChannelId);
  // Keep both slots: Mattermost permits self-DMs, so a Set would collapse the
  // duplicate IDs and could authorize a different peer's conversation.
  const participants =
    channel.name
      ?.split("__")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .toSorted() ?? [];
  const authorizedParticipants = [botUserId, target.id].toSorted();
  if (
    channel.type !== "D" ||
    participants.length !== 2 ||
    participants[0] !== authorizedParticipants[0] ||
    participants[1] !== authorizedParticipants[1]
  ) {
    throw new Error("Mattermost reaction post belongs to a different direct conversation.");
  }
  return botUserId;
}

async function runMattermostReaction(
  params: ReactionParams,
  options: {
    action: "add" | "remove";
    mutation: ReactionMutation;
  },
): Promise<Result> {
  const resolved = resolveMattermostAccount({ cfg: params.cfg, accountId: params.accountId });
  const baseUrl = resolved.baseUrl?.trim();
  const botToken = resolved.botToken?.trim();
  if (!baseUrl || !botToken) {
    return { ok: false, error: "Mattermost botToken/baseUrl missing." };
  }

  const client = createMattermostClient({
    baseUrl,
    botToken,
    fetchImpl: params.fetchImpl,
    allowPrivateNetwork: isPrivateNetworkOptInEnabled(resolved.config),
  });

  const cacheKey = `${baseUrl}:${botToken}`;
  try {
    const authorizedUserId =
      params.conversationReadOrigin === "direct-operator"
        ? undefined
        : await authorizeMattermostReactionResource({
            client,
            cacheKey,
            postId: params.postId,
            authorizedTarget: params.authorizedTarget,
          });
    const userId = authorizedUserId ?? (await resolveBotUserId(client, cacheKey));
    if (!userId) {
      return { ok: false, error: "Mattermost reactions failed: could not resolve bot user id." };
    }
    await options.mutation(client, {
      userId,
      postId: params.postId,
      emojiName: params.emojiName,
    });
  } catch (err) {
    return { ok: false, error: `Mattermost ${options.action} reaction failed: ${String(err)}` };
  }

  return { ok: true };
}

async function createReaction(client: MattermostClient, params: MutationPayload): Promise<void> {
  await client.request<Record<string, unknown>>("/reactions", {
    method: "POST",
    body: JSON.stringify({
      user_id: params.userId,
      post_id: params.postId,
      emoji_name: params.emojiName,
    }),
  });
}

async function deleteReaction(client: MattermostClient, params: MutationPayload): Promise<void> {
  const emoji = encodeURIComponent(params.emojiName);
  await client.request<unknown>(
    `/users/${params.userId}/posts/${params.postId}/reactions/${emoji}`,
    {
      method: "DELETE",
    },
  );
}
