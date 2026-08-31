// Feishu plugin module implements probe behavior.
import { createHash } from "node:crypto";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import { raceWithTimeoutAndAbort } from "./async.js";
import { createFeishuClient, type FeishuClientCredentials } from "./client.js";
import type { FeishuProbeResult } from "./types.js";

/** Cache probe results to reduce repeated health-check calls.
 * Gateway health checks call probeFeishu() every minute; without caching this
 * burns ~43,200 calls/month, easily exceeding Feishu's free-tier quota.
 * Successful bot info is effectively static, while failures are cached briefly
 * to avoid hammering the API during transient outages. */
const probeCache = new Map<string, { result: FeishuProbeResult; expiresAt: number }>();
const PROBE_SUCCESS_TTL_MS = 10 * 60 * 1000; // 10 minutes
const PROBE_ERROR_TTL_MS = 60 * 1000; // 1 minute
const MAX_PROBE_CACHE_SIZE = 64;
const FEISHU_PROBE_REQUEST_TIMEOUT_MS = 10_000;
type ProbeFeishuOptions = {
  timeoutMs?: number;
  abortSignal?: AbortSignal;
};

type FeishuBotInfoResponse = {
  code: number;
  msg?: string;
  bot?: { app_name?: string; open_id?: string };
  data?: { bot?: { app_name?: string; open_id?: string } };
};

type FeishuAiAgentRegistrationResponse = {
  code: number;
};

type FeishuRequestClient = ReturnType<typeof createFeishuClient> & {
  request(params: {
    method: "GET" | "POST";
    url: string;
    data?: Record<string, unknown>;
    timeout: number;
  }): Promise<FeishuBotInfoResponse | FeishuAiAgentRegistrationResponse>;
};

type FeishuAiAgentRegistrationResult =
  | { ok: true }
  | {
      ok: false;
      reason: "missing-credentials" | "aborted" | "timeout" | "api-error" | "request-error";
    };

function buildProbeCacheKey(creds: FeishuClientCredentials): string {
  // Account ids survive config reloads. Bind cached health and identity to the
  // complete credentials so a reconfigured account must perform a fresh probe.
  const identity = [creds.accountId ?? null, creds.appId, creds.appSecret, creds.domain ?? null];
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

function setCachedProbeResult(
  cacheKey: string,
  result: FeishuProbeResult,
  ttlMs: number,
): FeishuProbeResult {
  const expiresAt = resolveExpiresAtMsFromDurationMs(ttlMs);
  if (expiresAt === undefined) {
    probeCache.delete(cacheKey);
    return result;
  }
  probeCache.set(cacheKey, { result, expiresAt });
  if (probeCache.size > MAX_PROBE_CACHE_SIZE) {
    const oldest = probeCache.keys().next().value;
    if (oldest !== undefined) {
      probeCache.delete(oldest);
    }
  }
  return result;
}

export async function probeFeishu(
  creds?: FeishuClientCredentials,
  options: ProbeFeishuOptions = {},
): Promise<FeishuProbeResult> {
  if (!creds?.appId || !creds?.appSecret) {
    return {
      ok: false,
      error: "missing credentials (appId, appSecret)",
    };
  }
  if (options.abortSignal?.aborted) {
    return {
      ok: false,
      appId: creds.appId,
      error: "probe aborted",
    };
  }

  const timeoutMs = options.timeoutMs ?? FEISHU_PROBE_REQUEST_TIMEOUT_MS;

  // Return cached result if still valid for this exact configured identity.
  const cacheKey = buildProbeCacheKey(creds);
  const cached = probeCache.get(cacheKey);
  if (cached) {
    const now = asDateTimestampMs(Date.now());
    const expiresAt = asDateTimestampMs(cached.expiresAt);
    if (now !== undefined && expiresAt !== undefined && expiresAt > now) {
      return cached.result;
    }
    probeCache.delete(cacheKey);
  }

  try {
    const client = createFeishuClient(creds) as FeishuRequestClient;
    // Bot identity is required for mention and self-message filtering. Keep it on the
    // standard bot-info API so optional AI-agent registration cannot gate the channel.
    const responseResult = await raceWithTimeoutAndAbort<FeishuBotInfoResponse>(
      client.request({
        method: "GET",
        url: "/open-apis/bot/v3/info",
        timeout: timeoutMs,
      }) as Promise<FeishuBotInfoResponse>,
      {
        timeoutMs,
        abortSignal: options.abortSignal,
      },
    );

    if (responseResult.status === "aborted") {
      return {
        ok: false,
        appId: creds.appId,
        error: "probe aborted",
      };
    }
    if (responseResult.status === "timeout") {
      return setCachedProbeResult(
        cacheKey,
        {
          ok: false,
          appId: creds.appId,
          error: `probe timed out after ${timeoutMs}ms`,
        },
        PROBE_ERROR_TTL_MS,
      );
    }

    const response = responseResult.value;
    if (options.abortSignal?.aborted) {
      return {
        ok: false,
        appId: creds.appId,
        error: "probe aborted",
      };
    }

    if (response.code !== 0) {
      return setCachedProbeResult(
        cacheKey,
        {
          ok: false,
          appId: creds.appId,
          error: `API error: ${response.msg || `code ${response.code}`}`,
        },
        PROBE_ERROR_TTL_MS,
      );
    }

    const botInfo = response.bot ?? response.data?.bot;
    if (!botInfo?.open_id) {
      return setCachedProbeResult(
        cacheKey,
        {
          ok: false,
          appId: creds.appId,
          error: "API response missing bot open_id",
        },
        PROBE_ERROR_TTL_MS,
      );
    }
    return setCachedProbeResult(
      cacheKey,
      {
        ok: true,
        appId: creds.appId,
        botName: botInfo.app_name,
        botOpenId: botInfo.open_id,
      },
      PROBE_SUCCESS_TTL_MS,
    );
  } catch (err) {
    return setCachedProbeResult(
      cacheKey,
      {
        ok: false,
        appId: creds.appId,
        error: formatErrorMessage(err),
      },
      PROBE_ERROR_TTL_MS,
    );
  }
}

/**
 * Preserve Feishu's optional AI-agent registration without coupling it to health or
 * identity. Monitor startup calls this once per account and never awaits it.
 */
export async function registerFeishuAiAgent(
  creds?: FeishuClientCredentials,
  options: ProbeFeishuOptions = {},
): Promise<FeishuAiAgentRegistrationResult> {
  if (!creds?.appId || !creds?.appSecret) {
    return { ok: false, reason: "missing-credentials" };
  }
  if (options.abortSignal?.aborted) {
    return { ok: false, reason: "aborted" };
  }

  const timeoutMs = options.timeoutMs ?? FEISHU_PROBE_REQUEST_TIMEOUT_MS;
  try {
    const client = createFeishuClient(creds) as FeishuRequestClient;
    const responseResult = await raceWithTimeoutAndAbort<FeishuAiAgentRegistrationResponse>(
      client.request({
        method: "POST",
        url: "/open-apis/bot/v1/openclaw_bot/ping",
        data: { needBotInfo: true },
        timeout: timeoutMs,
      }) as Promise<FeishuAiAgentRegistrationResponse>,
      { timeoutMs, abortSignal: options.abortSignal },
    );
    if (responseResult.status === "aborted" || options.abortSignal?.aborted) {
      return { ok: false, reason: "aborted" };
    }
    if (responseResult.status === "timeout") {
      return { ok: false, reason: "timeout" };
    }
    return responseResult.value.code === 0 ? { ok: true } : { ok: false, reason: "api-error" };
  } catch {
    return { ok: false, reason: "request-error" };
  }
}
