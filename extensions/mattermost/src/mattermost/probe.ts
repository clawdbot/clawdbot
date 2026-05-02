import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromPrivateNetworkOptIn,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeMattermostBaseUrl, readMattermostError, type MattermostUser } from "./client.js";
import type { BaseProbeResult } from "./runtime-api.js";

type MattermostProbe = BaseProbeResult & {
  status?: number | null;
  elapsedMs?: number | null;
  bot?: MattermostUser;
};

export async function probeMattermost(
  baseUrl: string,
  botToken: string,
  timeoutMs = 2500,
  allowPrivateNetwork = false,
): Promise<MattermostProbe> {
  const normalized = normalizeMattermostBaseUrl(baseUrl);
  if (!normalized) {
    return { ok: false, error: "baseUrl missing" };
  }
  const url = `${normalized}/api/v4/users/me`;
  const start = Date.now();
  const controller = timeoutMs > 0 ? new AbortController() : undefined;
  let timer: NodeJS.Timeout | null = null;
  if (controller) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }
  try {
    const { response: res, release } = await fetchWithSsrFGuard({
      url,
      init: {
        headers: { Authorization: `Bearer ${botToken}` },
        signal: controller?.signal,
      },
      auditContext: "mattermost-probe",
      policy: ssrfPolicyFromPrivateNetworkOptIn(allowPrivateNetwork),
    });
    try {
      const elapsedMs = Date.now() - start;
      if (!res.ok) {
        const detail = await readMattermostError(res);
        return {
          ok: false,
          status: res.status,
          error: detail || res.statusText,
          elapsedMs,
        };
      }
      const bot = (await res.json()) as MattermostUser;
      return {
        ok: true,
        status: res.status,
        elapsedMs,
        bot,
      };
    } finally {
      await release();
    }
  } catch (err) {
    const message = formatErrorMessage(err);
    return {
      ok: false,
      status: null,
      error: message,
      elapsedMs: Date.now() - start,
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
