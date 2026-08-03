// Feishu plugin module implements monitor.startup behavior.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { RuntimeEnv } from "../runtime-api.js";
import { readCachedFeishuBotIdentity, writeCachedFeishuBotIdentity } from "./bot-identity-cache.js";
import { resolveStartupProbeTimeoutMs } from "./monitor-startup-timeout.js";
import { probeFeishu, registerFeishuAiAgent } from "./probe.js";
import type { ResolvedFeishuAccount } from "./types.js";

const FEISHU_STARTUP_BOT_INFO_TIMEOUT_MS = resolveStartupProbeTimeoutMs();

type FetchBotOpenIdOptions = {
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  allowCachedFallback?: boolean;
};

export type FeishuMonitorBotIdentity = {
  botOpenId?: string;
  botName?: string;
  source?: "provider" | "cache";
};

function isTimeoutErrorMessage(message: string | undefined): boolean {
  const lower = normalizeLowercaseStringOrEmpty(message);
  return lower.includes("timeout") || lower.includes("timed out");
}

function isAbortErrorMessage(message: string | undefined): boolean {
  return normalizeLowercaseStringOrEmpty(message).includes("aborted");
}

async function writeProviderBotIdentityCache(params: {
  account: ResolvedFeishuAccount;
  botOpenId?: string;
  botName?: string;
  runtime?: RuntimeEnv;
}): Promise<void> {
  try {
    await writeCachedFeishuBotIdentity({
      accountId: params.account.accountId,
      appId: params.account.appId,
      botOpenId: params.botOpenId,
      botName: params.botName,
    });
  } catch {
    params.runtime?.log?.(
      `feishu[${params.account.accountId}]: bot identity cache write failed; continuing startup`,
    );
  }
}

async function readProviderBotIdentityCache(params: {
  account: ResolvedFeishuAccount;
  runtime?: RuntimeEnv;
}): Promise<FeishuMonitorBotIdentity> {
  try {
    const cached = await readCachedFeishuBotIdentity({
      accountId: params.account.accountId,
      appId: params.account.appId,
    });
    if (!cached) {
      return {};
    }
    params.runtime?.log?.(
      `feishu[${params.account.accountId}]: using cached provider-verified bot identity while the fresh probe is unavailable`,
    );
    return { botOpenId: cached.botOpenId, botName: cached.botName, source: "cache" };
  } catch {
    params.runtime?.log?.(
      `feishu[${params.account.accountId}]: bot identity cache read failed; continuing without cached identity`,
    );
    return {};
  }
}

export async function fetchBotIdentityForMonitor(
  account: ResolvedFeishuAccount,
  options: FetchBotOpenIdOptions = {},
): Promise<FeishuMonitorBotIdentity> {
  if (options.abortSignal?.aborted) {
    return {};
  }

  const timeoutMs = options.timeoutMs ?? FEISHU_STARTUP_BOT_INFO_TIMEOUT_MS;
  const result = await probeFeishu(account, {
    timeoutMs,
    abortSignal: options.abortSignal,
  });
  const resultAppId = normalizeOptionalString(result.appId);
  if (result.ok && resultAppId === account.appId) {
    // AI-agent registration is provider metadata, not channel identity. Keep it
    // best-effort so its quota or availability cannot suppress message ingress.
    void registerFeishuAiAgent(account, { abortSignal: options.abortSignal })
      .then((registration) => {
        if (!registration.ok && registration.reason !== "aborted") {
          const log = options.runtime?.log ?? console.log;
          log(
            `feishu[${account.accountId}]: AI-agent registration unavailable (${registration.reason}); continuing with standard bot identity`,
          );
        }
      })
      .catch(() => {
        const log = options.runtime?.log ?? console.log;
        log(
          `feishu[${account.accountId}]: AI-agent registration failed unexpectedly; continuing with standard bot identity`,
        );
      });
    await writeProviderBotIdentityCache({
      account,
      botOpenId: result.botOpenId,
      botName: result.botName,
      runtime: options.runtime,
    });
    return {
      botOpenId: normalizeOptionalString(result.botOpenId),
      botName: normalizeOptionalString(result.botName),
      source: "provider",
    };
  }

  if (result.ok) {
    const log = options.runtime?.log ?? console.log;
    log(
      `feishu[${account.accountId}]: bot info probe returned identity for a different app; ignoring stale result`,
    );
  }

  const probeError = result.error ?? undefined;
  if (options.abortSignal?.aborted || isAbortErrorMessage(probeError)) {
    return {};
  }

  if (isTimeoutErrorMessage(probeError)) {
    const error = options.runtime?.error ?? console.error;
    error(
      `feishu[${account.accountId}]: bot info probe timed out after ${timeoutMs}ms; continuing startup`,
    );
  }
  if (options.allowCachedFallback === false) {
    return {};
  }
  return readProviderBotIdentityCache({ account, runtime: options.runtime });
}
