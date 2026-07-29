// Feishu plugin module implements monitor.bot identity behavior.
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { RuntimeEnv } from "../runtime-api.js";
import { waitForAbortableDelay } from "./async.js";
import { fetchBotIdentityForMonitor, type FeishuMonitorBotIdentity } from "./monitor.startup.js";
import { setFeishuBotIdentityState } from "./monitor.state.js";
import type { ResolvedFeishuAccount } from "./types.js";

// Delays must be >= PROBE_ERROR_TTL_MS (60s) so each retry makes a real network request
// instead of silently hitting the probe error cache.
const BOT_IDENTITY_RETRY_DELAYS_MS = [60_000, 120_000, 300_000, 600_000, 900_000];

export function applyBotIdentityState(
  accountId: string,
  identity: FeishuMonitorBotIdentity,
): FeishuMonitorBotIdentity {
  const botOpenId = normalizeOptionalString(identity.botOpenId);
  const botName = normalizeOptionalString(identity.botName);

  setFeishuBotIdentityState(accountId, { botOpenId: botOpenId ?? "", botName });

  return { botOpenId, botName, source: botOpenId ? identity.source : undefined };
}

async function retryBotIdentityProbe(
  account: ResolvedFeishuAccount,
  accountId: string,
  runtime: RuntimeEnv | undefined,
  abortSignal: AbortSignal | undefined,
): Promise<void> {
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  const nextDelays = BOT_IDENTITY_RETRY_DELAYS_MS.slice(1)[Symbol.iterator]();
  for (const [i, delayMs] of BOT_IDENTITY_RETRY_DELAYS_MS.entries()) {
    if (abortSignal?.aborted) {
      return;
    }

    const delayElapsed = await waitForAbortableDelay(delayMs, abortSignal);
    if (!delayElapsed) {
      return;
    }

    const identity = await fetchBotIdentityForMonitor(account, {
      runtime,
      abortSignal,
      allowCachedFallback: false,
    });
    if (normalizeOptionalString(identity.botOpenId) && identity.source === "provider") {
      const resolved = applyBotIdentityState(accountId, identity);
      log(
        `feishu[${accountId}]: bot open_id recovered via background retry: ${resolved.botOpenId}`,
      );
      return;
    }

    const nextDelayResult = nextDelays.next();
    const nextDelay = nextDelayResult.done ? undefined : nextDelayResult.value;
    error(
      `feishu[${accountId}]: bot identity background retry ${i + 1}/${BOT_IDENTITY_RETRY_DELAYS_MS.length} failed` +
        (nextDelay ? `; next attempt in ${nextDelay / 1000}s` : ""),
    );
  }

  error(
    `feishu[${accountId}]: bot identity background retry exhausted; requireMention group messages may be skipped until restart`,
  );
}

export function startBotIdentityRecovery(params: {
  account: ResolvedFeishuAccount;
  accountId: string;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  currentSource?: FeishuMonitorBotIdentity["source"];
}): void {
  const { account, accountId, runtime, abortSignal, currentSource } = params;
  const log = runtime?.log ?? console.log;

  const identityState = currentSource === "cache" ? "loaded from cache" : "unknown";
  log(
    `feishu[${accountId}]: bot open_id ${identityState}; starting background provider refresh (delays: ${BOT_IDENTITY_RETRY_DELAYS_MS.map((delay) => `${delay / 1000}s`).join(", ")})`,
  );
  if (currentSource !== "cache") {
    log(
      `feishu[${accountId}]: requireMention group messages stay gated until bot identity recovery succeeds`,
    );
  }

  void retryBotIdentityProbe(account, accountId, runtime, abortSignal);
}
