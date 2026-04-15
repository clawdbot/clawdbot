import {
  buildUsageHttpErrorSnapshot,
  fetchJson,
  clampPercent,
  PROVIDER_LABELS,
  type ProviderUsageSnapshot,
  type UsageWindow,
} from "openclaw/plugin-sdk/provider-usage";

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
): Promise<ProviderUsageSnapshot> {
  const res = await fetchJson(
    "https://api.github.com/copilot_internal/user",
    {
      headers: {
        Authorization: `token ${token}`,
        "Editor-Version": "vscode/1.96.2",
        "User-Agent": "GitHubCopilotChat/0.26.7",
        "X-Github-Api-Version": "2025-04-01",
      },
    },
    timeoutMs,
    fetchFn,
  );

  if (!res.ok) {
    return buildUsageHttpErrorSnapshot({
      provider: "github-copilot",
      status: res.status,
    });
  }

  const data = (await res.json()) as CopilotUsageResponse;
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
