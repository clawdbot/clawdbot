// Slack dispatch dedupe: a PERMANENT logical-identity layer above the durable
// ingress queue, not a leftover to delete on drain adoption. Slack emits BOTH
// a `message` and an `app_mention` Events API event (distinct event_ids) for
// one mention post, so the queue's event_id tombstones cannot dedupe the twin.
// Only the logical (team, channel, ts) key catches it. Claims commit at turn
// adoption and release on gated/failed dispatch so the surviving twin can
// still run the same gate without ever producing a second visible reply.
import {
  createChannelReplayGuard,
  runClaimableDedupeClaimLoop,
  type ChannelReplayClaimHandle,
} from "openclaw/plugin-sdk/persistent-dedupe";

// 24h/20k mirrors the retired persistent inbound-delivery state so the twin
// window also survives restarts while claimed rows sit in drain retry backoff.
const SLACK_MESSAGE_DISPATCH_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
const SLACK_MESSAGE_DISPATCH_DEDUPE_MEMORY_MAX_ENTRIES = 20_000;
const SLACK_MESSAGE_DISPATCH_DEDUPE_STATE_MAX_ENTRIES = 20_000;
const SLACK_MESSAGE_DISPATCH_DEDUPE_NAMESPACE = "global";
const SLACK_MESSAGE_DISPATCH_DEDUPE_NAMESPACE_PREFIX = "slack.message-dispatch-dedupe";
const SLACK_MESSAGE_DISPATCH_DEDUPE_STATE_PLUGIN_ID = "slack-message-dispatch-dedupe";

export type SlackMessageDispatchReplayClaim = ChannelReplayClaimHandle;

type SlackMessageDispatchClaimResult =
  | { kind: "claimed"; handle: SlackMessageDispatchReplayClaim }
  | { kind: "duplicate" };

export function buildSlackMessageDispatchReplayKey(params: {
  accountId: string;
  channelId: string | undefined;
  ts: string | undefined;
  teamId?: string | undefined;
}): string | null {
  const channelId = params.channelId?.trim();
  const ts = params.ts?.trim();
  if (!channelId || !ts) {
    return null;
  }
  const teamId = params.teamId?.trim();
  return JSON.stringify(["message", params.accountId, teamId ?? "", channelId, ts]);
}

export function createSlackMessageDispatchReplayGuard(
  params: {
    onDiskError?: (error: unknown) => void;
  } = {},
) {
  return createChannelReplayGuard<{ keys: readonly string[] }>({
    dedupe: {
      ttlMs: SLACK_MESSAGE_DISPATCH_DEDUPE_TTL_MS,
      memoryMaxSize: SLACK_MESSAGE_DISPATCH_DEDUPE_MEMORY_MAX_ENTRIES,
      pluginId: SLACK_MESSAGE_DISPATCH_DEDUPE_STATE_PLUGIN_ID,
      namespacePrefix: SLACK_MESSAGE_DISPATCH_DEDUPE_NAMESPACE_PREFIX,
      stateMaxEntries: SLACK_MESSAGE_DISPATCH_DEDUPE_STATE_MAX_ENTRIES,
      ...(params.onDiskError ? { onDiskError: params.onDiskError } : {}),
    },
    buildReplayKey: (event) => event.keys,
    namespace: () => SLACK_MESSAGE_DISPATCH_DEDUPE_NAMESPACE,
  });
}

export type SlackMessageDispatchReplayGuard = ReturnType<
  typeof createSlackMessageDispatchReplayGuard
>;

/** Claim one logical message key; an in-flight sibling claim settles to duplicate. */
export async function claimSlackMessageDispatchReplay(params: {
  guard: SlackMessageDispatchReplayGuard;
  key: string;
}): Promise<SlackMessageDispatchClaimResult> {
  const claim = await runClaimableDedupeClaimLoop(
    () => params.guard.claim({ keys: [params.key] }),
    (_error, rejectionCount) => rejectionCount <= 1,
  );
  return claim.kind === "claimed"
    ? { kind: "claimed", handle: claim.handle }
    : { kind: "duplicate" };
}
