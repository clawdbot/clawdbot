// Feishu plugin module implements monitor.startup behavior.
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { RuntimeEnv } from "../runtime-api.js";
import { resolveStartupProbeTimeoutMs } from "./monitor-startup-timeout.js";
import { probeFeishu } from "./probe.js";
import type { ResolvedFeishuAccount } from "./types.js";

const FEISHU_STARTUP_BOT_INFO_TIMEOUT_MS = resolveStartupProbeTimeoutMs();

type FetchBotOpenIdOptions = {
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
};

export type FeishuMonitorBotIdentity = {
  botOpenId?: string;
  botName?: string;
};

function isTimeoutErrorMessage(message: string | undefined): boolean {
  const lower = normalizeLowercaseStringOrEmpty(message);
  return lower.includes("timeout") || lower.includes("timed out");
}

function isAbortErrorMessage(message: string | undefined): boolean {
  return normalizeLowercaseStringOrEmpty(message).includes("aborted");
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
  if (result.ok) {
    return { botOpenId: result.botOpenId, botName: result.botName };
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
  return {};
}
