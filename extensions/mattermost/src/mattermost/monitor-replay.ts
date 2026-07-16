// Mattermost plugin module owns replay-guarded post processing.
import { createClaimableDedupe, type ClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";

const RECENT_MATTERMOST_MESSAGE_TTL_MS = 5 * 60_000;
const RECENT_MATTERMOST_MESSAGE_MAX = 2000;
const recentInboundMessages = createClaimableDedupe({
  ttlMs: RECENT_MATTERMOST_MESSAGE_TTL_MS,
  memoryMaxSize: RECENT_MATTERMOST_MESSAGE_MAX,
});

function buildMattermostInboundReplayKeys(params: {
  accountId: string;
  messageIds: string[];
}): string[] {
  return uniqueStrings(params.messageIds.map((id) => `${params.accountId}:${id.trim()}`)).filter(
    (key) => !key.endsWith(":"),
  );
}

export async function processMattermostReplayGuardedPost(params: {
  accountId: string;
  messageIds: string[];
  handlePost: () => Promise<void>;
  replayGuard?: ClaimableDedupe;
}): Promise<"processed" | "duplicate"> {
  const replayGuard = params.replayGuard ?? recentInboundMessages;
  const replayKeys = buildMattermostInboundReplayKeys({
    accountId: params.accountId,
    messageIds: params.messageIds,
  });
  if (replayKeys.length === 0) {
    await params.handlePost();
    return "processed";
  }

  const claimedKeys: string[] = [];
  for (const replayKey of replayKeys) {
    const claim = await replayGuard.claim(replayKey);
    if (claim.kind === "claimed") {
      claimedKeys.push(replayKey);
    }
  }
  if (claimedKeys.length === 0) {
    return "duplicate";
  }

  try {
    await params.handlePost();
    await Promise.all(claimedKeys.map((replayKey) => replayGuard.commit(replayKey)));
    return "processed";
  } catch (error) {
    await Promise.all(claimedKeys.map((replayKey) => replayGuard.commit(replayKey)));
    throw error;
  }
}
