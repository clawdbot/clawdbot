import type { SessionsCatalogStartTerminalResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createManagedWorktree } from "../../lib/worktrees/create-worktree.ts";

export async function startNewSessionInTerminal(
  client: GatewayBrowserClient,
  params: {
    catalogId: string;
    agentId: string;
    cwd: string;
    execNode: string;
    initialMessage: string;
    worktree: boolean;
    worktreeName: string;
    baseRef: string;
  },
  isCurrent: () => boolean,
): Promise<SessionsCatalogStartTerminalResult | null> {
  let cwd = params.cwd;
  if (params.worktree) {
    const created = await createManagedWorktree(client, {
      repoRoot: cwd,
      name: params.worktreeName,
      baseRef: params.baseRef,
    });
    if (!isCurrent()) {
      return null;
    }
    cwd = created.path;
  }
  return client.request<SessionsCatalogStartTerminalResult>("sessions.catalog.startTerminal", {
    catalogId: params.catalogId,
    ...(params.execNode ? { hostId: `node:${params.execNode}` } : {}),
    agentId: params.agentId,
    cwd,
    ...(params.initialMessage ? { initialMessage: params.initialMessage } : {}),
  });
}
