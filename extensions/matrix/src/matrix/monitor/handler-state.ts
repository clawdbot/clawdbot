import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import {
  isFutureDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import type { CoreConfig } from "../../types.js";
import {
  resolveMatrixAccountAllowlistConfig,
  resolveMatrixAccountConfig,
} from "../account-config.js";
import {
  resolveMatrixMonitorLiveUserAllowlist,
  type MatrixResolvedAllowlistEntry,
} from "./config.js";
import type { PluginRuntime, RuntimeEnv } from "./runtime-api.js";

const ALLOW_FROM_STORE_CACHE_TTL_MS = 30_000;
const PAIRING_REPLY_COOLDOWN_MS = 5 * 60_000;
const MAX_TRACKED_PAIRING_REPLY_SENDERS = 512;

export function createMatrixHandlerState(config: {
  core: PluginRuntime;
  accountId: string;
  runtime: RuntimeEnv;
  allowFromResolvedEntries: readonly MatrixResolvedAllowlistEntry[];
  groupAllowFromResolvedEntries: readonly MatrixResolvedAllowlistEntry[];
  resolveLiveUserAllowlist: typeof resolveMatrixMonitorLiveUserAllowlist;
}) {
  const {
    core,
    accountId,
    runtime,
    allowFromResolvedEntries,
    groupAllowFromResolvedEntries,
    resolveLiveUserAllowlist,
  } = config;

  let cachedStoreAllowFrom: {
    value: string[];
    expiresAtMs: number;
  } | null = null;
  type LiveAllowlistCacheEntry = { signature: string; entries: string[] };
  let liveDmAllowlistCache: LiveAllowlistCacheEntry | null = null;
  let liveGroupAllowlistCache: LiveAllowlistCacheEntry | null = null;
  const resolveCachedLiveAllowlist = async (paramsValue: {
    cfg: CoreConfig;
    entries?: ReadonlyArray<string | number>;
    failClosedOnUnresolved?: boolean;
    startupResolvedEntries?: readonly MatrixResolvedAllowlistEntry[];
    cache: LiveAllowlistCacheEntry | null;
    updateCache: (next: LiveAllowlistCacheEntry) => void;
  }): Promise<string[]> => {
    const accountConfigLocal = resolveMatrixAccountConfig({ cfg: paramsValue.cfg, accountId });
    const signature = JSON.stringify({
      entries: (paramsValue.entries ?? []).map((entry) => String(entry).trim()),
      failClosedOnUnresolved: paramsValue.failClosedOnUnresolved === true,
      dangerouslyAllowNameMatching: isDangerousNameMatchingEnabled(accountConfigLocal),
    });
    if (paramsValue.cache?.signature === signature) {
      return paramsValue.cache.entries;
    }
    const entries = await resolveLiveUserAllowlist({
      cfg: paramsValue.cfg,
      accountId,
      entries: paramsValue.entries,
      failClosedOnUnresolved: paramsValue.failClosedOnUnresolved,
      startupResolvedEntries: paramsValue.startupResolvedEntries,
      runtime,
    });
    const next = { signature, entries };
    paramsValue.updateCache(next);
    return entries;
  };
  const pairingReplySentAtMsBySender = new Map<string, number>();
  const resolveLiveAccountAllowlists = async () => {
    const liveCfg = core.config.current() as CoreConfig;
    const liveAccountAllowlists = resolveMatrixAccountAllowlistConfig({
      cfg: liveCfg,
      accountId,
    });
    const liveDmAllowFrom = await resolveCachedLiveAllowlist({
      cfg: liveCfg,
      entries: liveAccountAllowlists.dmAllowFrom,
      startupResolvedEntries: allowFromResolvedEntries,
      cache: liveDmAllowlistCache,
      updateCache: (next) => {
        liveDmAllowlistCache = next;
      },
    });
    const liveGroupAllowFrom = await resolveCachedLiveAllowlist({
      cfg: liveCfg,
      entries: liveAccountAllowlists.groupAllowFrom,
      failClosedOnUnresolved: true,
      startupResolvedEntries: groupAllowFromResolvedEntries,
      cache: liveGroupAllowlistCache,
      updateCache: (next) => {
        liveGroupAllowlistCache = next;
      },
    });
    return { liveCfg, liveDmAllowFrom, liveGroupAllowFrom };
  };
  const readStoreAllowFrom = async (): Promise<string[]> => {
    const now = Date.now();
    if (
      cachedStoreAllowFrom &&
      isFutureDateTimestampMs(cachedStoreAllowFrom.expiresAtMs, { nowMs: now })
    ) {
      return cachedStoreAllowFrom.value;
    }
    cachedStoreAllowFrom = null;
    const value = await core.channel.pairing
      .readAllowFromStore({
        channel: "matrix",
        env: process.env,
        accountId,
      })
      .catch(() => []);
    const expiresAtMs = resolveExpiresAtMsFromDurationMs(ALLOW_FROM_STORE_CACHE_TTL_MS, {
      nowMs: now,
    });
    cachedStoreAllowFrom = expiresAtMs === undefined ? null : { value, expiresAtMs };
    return value;
  };

  const shouldSendPairingReply = (senderId: string, created: boolean): boolean => {
    const now = Date.now();
    if (created) {
      pairingReplySentAtMsBySender.set(senderId, now);
      return true;
    }
    const lastSentAtMs = pairingReplySentAtMsBySender.get(senderId);
    if (typeof lastSentAtMs === "number" && now - lastSentAtMs < PAIRING_REPLY_COOLDOWN_MS) {
      return false;
    }
    pairingReplySentAtMsBySender.set(senderId, now);
    if (pairingReplySentAtMsBySender.size > MAX_TRACKED_PAIRING_REPLY_SENDERS) {
      const oldestSender = pairingReplySentAtMsBySender.keys().next().value;
      if (typeof oldestSender === "string") {
        pairingReplySentAtMsBySender.delete(oldestSender);
      }
    }
    return true;
  };

  return {
    resolveLiveAccountAllowlists,
    readStoreAllowFrom,
    shouldSendPairingReply,
  };
}
