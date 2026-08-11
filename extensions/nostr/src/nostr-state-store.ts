// Nostr plugin module implements nostr state store behavior.
import { getNostrRuntime } from "./runtime.js";
import { normalizeNostrStateAccountId } from "./state-account-id.js";

const STORE_VERSION = 2;
const PROFILE_STATE_VERSION = 1;

type NostrBusState = {
  version: 2;
  /** Unix timestamp (seconds) of the last processed event */
  lastProcessedAt: number | null;
  /** Gateway startup timestamp (seconds) - events before this are old */
  gatewayStartedAt: number | null;
  /** Retired replay-guard seed, cleared after durable ingress tombstone migration. */
  recentEventIds: string[];
};

/** Profile publish state (separate from bus state) */
type NostrProfileState = {
  version: 1;
  /** Unix timestamp (seconds) of last successful profile publish */
  lastPublishedAt: number | null;
  /** Event ID of the last published profile */
  lastPublishedEventId: string | null;
  /** Per-relay publish results from last attempt */
  lastPublishResults: Record<string, "ok" | "failed" | "timeout"> | null;
};

function openNostrBusStateStore(env?: NodeJS.ProcessEnv) {
  return getNostrRuntime().state.openKeyedStore<NostrBusState>({
    namespace: "bus-state",
    maxEntries: 256,
    ...(env ? { env } : {}),
  });
}

function openNostrProfileStateStore(env?: NodeJS.ProcessEnv) {
  return getNostrRuntime().state.openKeyedStore<NostrProfileState>({
    namespace: "profile-state",
    maxEntries: 256,
    ...(env ? { env } : {}),
  });
}

export async function readNostrBusState(params: {
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<NostrBusState | null> {
  return (
    (await openNostrBusStateStore(params.env).lookup(
      normalizeNostrStateAccountId(params.accountId),
    )) ?? null
  );
}

export async function writeNostrBusState(params: {
  accountId?: string;
  lastProcessedAt: number;
  gatewayStartedAt: number;
  recentEventIds?: string[];
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const payload: NostrBusState = {
    version: STORE_VERSION,
    lastProcessedAt: params.lastProcessedAt,
    gatewayStartedAt: params.gatewayStartedAt,
    recentEventIds: (params.recentEventIds ?? []).filter((x): x is string => typeof x === "string"),
  };
  await openNostrBusStateStore(params.env).register(
    normalizeNostrStateAccountId(params.accountId),
    payload,
  );
}

/**
 * Determine the `since` timestamp for subscription.
 * Returns the later of: lastProcessedAt or gatewayStartedAt (both from state),
 * falling back to `now` for fresh starts.
 */
export function computeSinceTimestamp(
  state: NostrBusState | null,
  nowSec: number = Math.floor(Date.now() / 1000),
): number {
  if (!state) {
    return nowSec;
  }

  // Use the most recent timestamp we have
  const candidates = [state.lastProcessedAt, state.gatewayStartedAt].filter(
    (t): t is number => t !== null && t > 0,
  );

  if (candidates.length === 0) {
    return nowSec;
  }
  return Math.max(...candidates);
}

// ============================================================================
// Profile State Management
// ============================================================================

export async function readNostrProfileState(params: {
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<NostrProfileState | null> {
  return (
    (await openNostrProfileStateStore(params.env).lookup(
      normalizeNostrStateAccountId(params.accountId),
    )) ?? null
  );
}

export async function writeNostrProfileState(params: {
  accountId?: string;
  lastPublishedAt: number;
  lastPublishedEventId: string;
  lastPublishResults: Record<string, "ok" | "failed" | "timeout">;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const payload: NostrProfileState = {
    version: PROFILE_STATE_VERSION,
    lastPublishedAt: params.lastPublishedAt,
    lastPublishedEventId: params.lastPublishedEventId,
    lastPublishResults: params.lastPublishResults,
  };
  await openNostrProfileStateStore(params.env).register(
    normalizeNostrStateAccountId(params.accountId),
    payload,
  );
}
