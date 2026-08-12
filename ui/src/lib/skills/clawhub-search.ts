import type { GatewayBrowserClient } from "../../api/gateway.ts";

export type ClawHubSearchResult = {
  score: number;
  slug: string;
  ownerHandle?: string | null;
  displayName: string;
  summary?: string;
  icon?: string | null;
  version?: string;
  updatedAt?: number;
};

export function clawHubSkillReference(result: Pick<ClawHubSearchResult, "slug" | "ownerHandle">) {
  const ownerHandle = result.ownerHandle?.trim().toLowerCase();
  return ownerHandle ? `@${ownerHandle}/${result.slug}` : result.slug;
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
