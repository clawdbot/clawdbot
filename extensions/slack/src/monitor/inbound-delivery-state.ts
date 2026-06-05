// Slack plugin module implements inbound delivery state behavior.
import { resolveGlobalDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
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

type SlackInboundDeliveryStore = {
  register(
    key: string,
    value: SlackInboundDeliveryRecord,
    opts?: { ttlMs?: number },
  ): Promise<void>;
  lookup(key: string): Promise<SlackInboundDeliveryRecord | undefined>;
};

const deliveredMessages = resolveGlobalDedupeCache(SLACK_INBOUND_DELIVERIES_KEY, {
  ttlMs: TTL_MS,
  maxSize: MAX_ENTRIES,
});

let persistentStore: SlackInboundDeliveryStore | undefined;
let persistentStoreDisabled = false;

function makeKey(accountId: string, channelId: string, ts: string): string {
  return `${accountId}:${channelId}:${ts}`;
}

function reportPersistentInboundDeliveryError(error: unknown): void {
  try {
    getOptionalSlackRuntime()
      ?.logging.getChildLogger({ plugin: "slack", feature: "inbound-delivery-state" })
      .warn("Slack persistent inbound delivery state failed", { error: String(error) });
  } catch {
    // Best effort only: persistent state must never break Slack message handling.
  }
}

function disablePersistentInboundDelivery(error: unknown): void {
  persistentStoreDisabled = true;
  persistentStore = undefined;
  reportPersistentInboundDeliveryError(error);
}

function getPersistentInboundDeliveryStore(): SlackInboundDeliveryStore | undefined {
  if (persistentStoreDisabled) {
    return undefined;
  }
  if (persistentStore) {
    return persistentStore;
  }
  const runtime = getOptionalSlackRuntime();
  if (!runtime) {
    return undefined;
  }
  try {
    persistentStore = runtime.state.openKeyedStore<SlackInboundDeliveryRecord>({
      namespace: PERSISTENT_NAMESPACE,
      maxEntries: PERSISTENT_MAX_ENTRIES,
      defaultTtlMs: TTL_MS,
    });
    return persistentStore;
  } catch (error) {
    disablePersistentInboundDelivery(error);
    return undefined;
  }
}

async function lookupPersistentInboundDelivery(key: string): Promise<boolean> {
  const store = getPersistentInboundDeliveryStore();
  if (!store) {
    return false;
  }
  try {
    return Boolean(await store.lookup(key));
  } catch (error) {
    disablePersistentInboundDelivery(error);
    return false;
  }
}

async function rememberPersistentInboundDelivery(key: string, deliveredAt: number): Promise<void> {
  const store = getPersistentInboundDeliveryStore();
  if (!store) {
    return;
  }
  try {
    await store.register(key, { deliveredAt });
  } catch (error) {
    disablePersistentInboundDelivery(error);
  }
}

export async function hasSlackInboundMessageDelivery(params: {
  accountId: string;
  channelId: string | undefined;
  ts: string | undefined;
}): Promise<boolean> {
  if (!params.accountId || !params.channelId || !params.ts) {
    return false;
  }
  const key = makeKey(params.accountId, params.channelId, params.ts);
  if (deliveredMessages.peek(key)) {
    return true;
  }
  const found = await lookupPersistentInboundDelivery(key);
  if (found) {
    deliveredMessages.check(key);
  }
  return found;
}

export async function recordSlackInboundMessageDeliveries(params: {
  accountId: string;
  messages: readonly SlackMessageEvent[];
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
    keys.add(makeKey(params.accountId, message.channel, message.ts));
  }
  if (keys.size === 0) {
    return;
  }
  for (const key of keys) {
    deliveredMessages.check(key, deliveredAt);
  }
  await Promise.all(Array.from(keys, (key) => rememberPersistentInboundDelivery(key, deliveredAt)));
}

export function clearSlackInboundDeliveryStateForTest(): void {
  deliveredMessages.clear();
  persistentStore = undefined;
  persistentStoreDisabled = false;
}
