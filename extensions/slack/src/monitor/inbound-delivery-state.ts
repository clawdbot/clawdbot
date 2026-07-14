// Slack plugin module implements inbound delivery state behavior.
import { createPersistentDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
import { getOptionalSlackRuntime } from "../runtime.js";
import type { SlackMessageEvent } from "../types.js";

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 20_000;
const PERSISTENT_MAX_ENTRIES = 20_000;
const PERSISTENT_NAMESPACE = "slack.inbound-deliveries";
const SLACK_INBOUND_DELIVERIES_KEY = Symbol.for("openclaw.slackInboundDeliveries");

type SlackInboundDeliveryRecord = {
  deliveredAt: number;
};

const deliveredMessages = createPersistentDedupeCache<SlackInboundDeliveryRecord>({
  globalKey: SLACK_INBOUND_DELIVERIES_KEY,
  ttlMs: TTL_MS,
  maxSize: MAX_ENTRIES,
  persistent: {
    namespace: PERSISTENT_NAMESPACE,
    maxEntries: PERSISTENT_MAX_ENTRIES,
    openStore: (options) => getOptionalSlackRuntime()?.state.openKeyedStore(options),
    logError: (error) => {
      try {
        getOptionalSlackRuntime()
          ?.logging.getChildLogger({ plugin: "slack", feature: "inbound-delivery-state" })
          .warn("Slack persistent inbound delivery state failed", { error: String(error) });
      } catch {
        // Best effort only: persistent state must never break Slack message handling.
      }
    },
  },
});

function makeKey(accountId: string, channelId: string, ts: string, teamId?: string): string {
  return `${accountId}:${teamId ? `${teamId}:` : ""}${channelId}:${ts}`;
}

export async function hasSlackInboundMessageDelivery(params: {
  accountId: string;
  channelId: string | undefined;
  ts: string | undefined;
  teamId?: string;
}): Promise<boolean> {
  if (!params.accountId || !params.channelId || !params.ts) {
    return false;
  }
  return await deliveredMessages.lookup(
    makeKey(params.accountId, params.channelId, params.ts, params.teamId),
  );
}

export async function recordSlackInboundMessageDeliveries(params: {
  accountId: string;
  messages: readonly SlackMessageEvent[];
  teamId?: string;
}): Promise<void> {
  if (!params.accountId || params.messages.length === 0) {
    return;
  }
  const deliveredAt = Date.now();
  const keys = new Set<string>();
  for (const message of params.messages) {
    if (!message.channel || !message.ts) {
      continue;
    }
    keys.add(makeKey(params.accountId, message.channel, message.ts, params.teamId));
  }
  await Promise.all(
    Array.from(keys, (key) =>
      deliveredMessages.register(key, { deliveredAt }, { at: deliveredAt }),
    ),
  );
}
