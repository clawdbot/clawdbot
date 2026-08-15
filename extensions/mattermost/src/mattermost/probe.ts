// Mattermost plugin module implements probe behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromPrivateNetworkOptIn,
  type LookupFn,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { runChannelProbe } from "openclaw/plugin-sdk/text-utility-runtime";
import { normalizeMattermostBaseUrl, readMattermostError, type MattermostUser } from "./client.js";
import type { BaseProbeResult } from "./runtime-api.js";

type MattermostProbe = BaseProbeResult & {
  status?: number | null;
  elapsedMs?: number | null;
  bot?: MattermostUser;
};

/** Optional test hooks so probe can exercise the real guarded-fetch owner. */
type ProbeMattermostDeps = {
  fetchImpl?: typeof fetch;
  lookupFn?: LookupFn;
};

export async function probeMattermost(
  baseUrl: string,
  botToken: string,
  timeoutMs = 2500,
  allowPrivateNetwork = false,
  deps?: ProbeMattermostDeps,
): Promise<MattermostProbe> {
  const normalized = normalizeMattermostBaseUrl(baseUrl);
  if (!normalized) {
    return { ok: false, error: "baseUrl missing" };
  }
  const url = `${normalized}/api/v4/users/me`;
  return await runChannelProbe(
    undefined,
    async ({ elapsedMs }) => {
      // Guard-owned timeoutMs covers DNS/proxy preflight; init.signal alone does not.
      const resolvedTimeoutMs = timeoutMs > 0 ? resolveTimerTimeoutMs(timeoutMs, 2500) : undefined;
      const { response: res, release } = await fetchWithSsrFGuard({
        url,
        init: {
          headers: { Authorization: `Bearer ${botToken}` },
        },
        auditContext: "mattermost-probe",
        policy: ssrfPolicyFromPrivateNetworkOptIn(allowPrivateNetwork),
        ...(resolvedTimeoutMs !== undefined ? { timeoutMs: resolvedTimeoutMs } : {}),
        ...(deps?.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps?.lookupFn ? { lookupFn: deps.lookupFn } : {}),
      });
      const requestElapsedMs = elapsedMs();
      try {
        if (!res.ok) {
          const detail = await readMattermostError(res);
          return {
            ok: false,
            status: res.status,
            error: detail || res.statusText,
            elapsedMs: requestElapsedMs,
          };
        }
        const bot = await readProviderJsonResponse<MattermostUser>(
          res,
          "Mattermost probe /users/me",
        );
        return {
          ok: true,
          status: res.status,
          elapsedMs: requestElapsedMs,
          bot,
        };
      } finally {
        await release();
      }
    },
    (error) => ({
      ok: false,
      status: null,
      error: formatErrorMessage(error),
    }),
  );
}
