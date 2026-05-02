import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import type { RuntimeEnv } from "../runtime-api.js";
import { probeFeishu } from "./probe.js";
import type { ResolvedFeishuAccount } from "./types.js";

const FEISHU_STARTUP_BOT_INFO_TIMEOUT_DEFAULT_MS = 30_000;
const FEISHU_STARTUP_BOT_INFO_TIMEOUT_ENV = "OPENCLAW_FEISHU_STARTUP_PROBE_TIMEOUT_MS";

function resolveStartupProbeTimeoutMs(): number {
  const raw = process.env[FEISHU_STARTUP_BOT_INFO_TIMEOUT_ENV];
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
    console.warn(
      `[feishu] ${FEISHU_STARTUP_BOT_INFO_TIMEOUT_ENV}="${raw}" is invalid; using default ${FEISHU_STARTUP_BOT_INFO_TIMEOUT_DEFAULT_MS}ms`,
    );
  }
  return FEISHU_STARTUP_BOT_INFO_TIMEOUT_DEFAULT_MS;
}

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
