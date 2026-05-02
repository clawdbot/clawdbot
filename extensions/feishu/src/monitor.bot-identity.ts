import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { RuntimeEnv } from "../runtime-api.js";
import { waitForAbortableDelay } from "./async.js";
import { fetchBotIdentityForMonitor, type FeishuMonitorBotIdentity } from "./monitor.startup.js";
import { botNames, botOpenIds } from "./monitor.state.js";
import type { ResolvedFeishuAccount } from "./types.js";

// Delays must be >= PROBE_ERROR_TTL_MS (60s) so each retry makes a real network request
// instead of silently hitting the probe error cache.
const BOT_IDENTITY_RETRY_DELAYS_MS = [60_000, 120_000, 300_000, 600_000, 900_000];

export function applyBotIdentityState(
  accountId: string,
  identity: FeishuMonitorBotIdentity,
): { botOpenId?: string; botName?: string } {
  const botOpenId = normalizeOptionalString(identity.botOpenId);
  const botName = normalizeOptionalString(identity.botName);

  botOpenIds.set(accountId, botOpenId ?? "");
  if (botName) {
    botNames.set(accountId, botName);
  } else {
    botNames.delete(accountId);
  }

  return { botOpenId, botName };
}

async function retryBotIdentityProbe(
  account: ResolvedFeishuAccount,
  accountId: string,
  runtime: RuntimeEnv | undefined,
  abortSignal: AbortSignal | undefined,
): Promise<void> {
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  for (let i = 0; i < BOT_IDENTITY_RETRY_DELAYS_MS.length; i += 1) {
    if (abortSignal?.aborted) {
      return;
    }

    const delayElapsed = await waitForAbortableDelay(BOT_IDENTITY_RETRY_DELAYS_MS[i], abortSignal);
    if (!delayElapsed) {
      return;
    }

    const identity = await fetchBotIdentityForMonitor(account, { runtime, abortSignal });
    const resolved = applyBotIdentityState(accountId, identity);
    if (resolved.botOpenId) {
      log(
        `feishu[${accountId}]: bot open_id recovered via background retry: ${resolved.botOpenId}`,
      );
      return;
    }

    const nextDelay = BOT_IDENTITY_RETRY_DELAYS_MS[i + 1];
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
}): void {
  const { account, accountId, runtime, abortSignal } = params;
  const log = runtime?.log ?? console.log;

  log(
    `feishu[${accountId}]: bot open_id unknown; starting background retry (delays: ${BOT_IDENTITY_RETRY_DELAYS_MS.map((delay) => `${delay / 1000}s`).join(", ")})`,
  );
  log(
    `feishu[${accountId}]: requireMention group messages stay gated until bot identity recovery succeeds`,
  );

  void retryBotIdentityProbe(account, accountId, runtime, abortSignal);
}
