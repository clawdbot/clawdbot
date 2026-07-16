// Mattermost plugin module owns replay-guarded post processing.
import { createChannelReplayGuard } from "openclaw/plugin-sdk/persistent-dedupe";

const RECENT_MATTERMOST_MESSAGE_TTL_MS = 5 * 60_000;
const RECENT_MATTERMOST_MESSAGE_MAX = 2000;
function buildMattermostInboundReplayKeys(params: {
  accountId: string;
  messageIds: string[];
}): string[] {
  return params.messageIds.map((id) => (id.trim() ? `${params.accountId}:${id.trim()}` : ""));
}

function createMattermostInboundReplayGuard() {
  return createChannelReplayGuard<{ accountId: string; messageIds: string[] }>({
    dedupe: {
      ttlMs: RECENT_MATTERMOST_MESSAGE_TTL_MS,
      memoryMaxSize: RECENT_MATTERMOST_MESSAGE_MAX,
    },
    buildReplayKey: buildMattermostInboundReplayKeys,
  });
}

type MattermostInboundReplayGuard = ReturnType<typeof createMattermostInboundReplayGuard>;
const recentInboundMessages = createMattermostInboundReplayGuard();

export async function processMattermostReplayGuardedPost(params: {
  accountId: string;
  messageIds: string[];
  handlePost: () => Promise<void>;
  replayGuard?: MattermostInboundReplayGuard;
}): Promise<"processed" | "duplicate"> {
  const replayGuard = params.replayGuard ?? recentInboundMessages;
  const event = {
    accountId: params.accountId,
    messageIds: params.messageIds,
  };
  const result = await replayGuard.processGuarded(event, params.handlePost, {
    onError: "commit",
  });
  return result.kind === "processed" ? "processed" : "duplicate";
}
