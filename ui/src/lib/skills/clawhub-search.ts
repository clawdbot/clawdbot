import type { GatewayBrowserClient } from "../../api/gateway.ts";

export type ClawHubSearchResult = {
  score: number;
  slug: string;
  installRef?: string;
  /**
   * Set only for sources ClawHub serves install-only. Absence means the ordinary
   * review-then-install flow, so gateways that predate this field behave as before.
   */
  installOnly?: true;
  trustState?: "not-scanned-by-clawhub";
  displayName: string;
  summary?: string;
  icon?: string | null;
  version?: string;
  updatedAt?: number;
};

/**
 * Reference the operator actually picked. Several publishers can share one slug, and ClawHub
 * answers a bare slug with 409 AMBIGUOUS_SKILL_SLUG, so install must send this.
 * Gateways older than the installRef contract only supply the slug.
 */
export function clawHubSkillRef(result: ClawHubSearchResult): string {
  return result.installRef ?? result.slug;
}

export async function searchClawHub(
  client: GatewayBrowserClient,
  query: string,
  signal?: AbortSignal,
): Promise<ClawHubSearchResult[]> {
  if (!query.trim()) {
    return [];
  }
  const response = await client.request<{ results: ClawHubSearchResult[] }>(
    "skills.search",
    { query, limit: 20 },
    { signal },
  );
  return response?.results ?? [];
}
