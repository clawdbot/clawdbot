import type { GatewayBrowserClient } from "../../api/gateway.ts";

export type ClawHubSearchResult = {
  score: number;
  slug: string;
  installRef?: string;
  displayName: string;
  summary?: string;
  icon?: string | null;
  version?: string;
  updatedAt?: number;
  trustState?: "not-scanned-by-clawhub";
};

export const CLAWHUB_NOT_SCANNED_LABEL = "Not scanned by ClawHub";

/** Results ClawHub has not scanned say so before the operator acts on them. */
export function clawHubTrustLabel(result: ClawHubSearchResult): string | undefined {
  return result.trustState === "not-scanned-by-clawhub" ? CLAWHUB_NOT_SCANNED_LABEL : undefined;
}

/**
 * Reference the operator actually picked. Several publishers can share one slug, and ClawHub
 * answers a bare slug with 409 AMBIGUOUS_SKILL_SLUG, so detail and install must send this.
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
