import type { WorktreeRecord } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";

export async function createManagedWorktree(
  client: Pick<GatewayBrowserClient, "request">,
  params: { repoRoot: string; name?: string; baseRef?: string },
): Promise<WorktreeRecord> {
  const name = params.name?.trim();
  const baseRef = params.baseRef?.trim();
  return client.request<WorktreeRecord>("worktrees.create", {
    repoRoot: params.repoRoot.trim(),
    ...(name ? { name } : {}),
    ...(baseRef ? { baseRef } : {}),
  });
}
