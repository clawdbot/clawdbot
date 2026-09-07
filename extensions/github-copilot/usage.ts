// Github Copilot plugin module implements usage behavior.
import { buildCopilotIdeHeaders } from "openclaw/plugin-sdk/provider-auth";
import {
  ProviderJsonParseError,
  readProviderJsonResponse,
} from "openclaw/plugin-sdk/provider-http";
import {
  buildUsageErrorSnapshot,
  buildUsageHttpErrorSnapshot,
  fetchJson,
  clampPercent,
  PROVIDER_LABELS,
  type ProviderUsageSnapshot,
  type UsageWindow,
} from "openclaw/plugin-sdk/provider-usage";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { PUBLIC_GITHUB_COPILOT_DOMAIN } from "./domain.js";

type CopilotUsageResponse = {
  quota_snapshots?: {
    premium_interactions?: { percent_remaining?: number | null };
    chat?: { percent_remaining?: number | null };
  };
  copilot_plan?: string;
};

export async function fetchCopilotUsage(
  token: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
  githubDomain: string = PUBLIC_GITHUB_COPILOT_DOMAIN,
): Promise<ProviderUsageSnapshot> {
  const res = await fetchJson(
    `https://api.${githubDomain}/copilot_internal/user`,
    {
      headers: {
        Authorization: `token ${token}`,
        ...buildCopilotIdeHeaders({ includeApiVersion: true }),
      },
    },
    timeoutMs,
    fetchFn,
  );

  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return buildUsageHttpErrorSnapshot({
      provider: "github-copilot",
      status: res.status,
    });
  }

  let payload: unknown;
  try {
    payload = await readProviderJsonResponse<unknown>(res, "github-copilot-usage");
  } catch (error) {
    // Keep bounded-reader failures visible while normalizing malformed provider JSON.
    if (error instanceof ProviderJsonParseError) {
      return buildUsageErrorSnapshot("github-copilot", "Malformed usage response");
    }
    throw error;
  }
  const data = isRecord(payload) ? (payload as CopilotUsageResponse) : {};
  const windows: UsageWindow[] = [];

  if (data.quota_snapshots?.premium_interactions) {
    const remaining = data.quota_snapshots.premium_interactions.percent_remaining;
    windows.push({
      label: "Premium",
      usedPercent: clampPercent(100 - (remaining ?? 0)),
    });
  }

  if (data.quota_snapshots?.chat) {
    const remaining = data.quota_snapshots.chat.percent_remaining;
    windows.push({
      label: "Chat",
      usedPercent: clampPercent(100 - (remaining ?? 0)),
    });
  }

  return {
    provider: "github-copilot",
    displayName: PROVIDER_LABELS["github-copilot"],
    windows,
    plan: data.copilot_plan,
  };
}
