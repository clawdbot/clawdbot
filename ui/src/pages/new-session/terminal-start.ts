import type { SessionsCatalogStartTerminalResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  readSessionMethodAccess,
  type SessionMethodAccess,
} from "../../lib/session-method-access.ts";
import { createManagedWorktree } from "../../lib/worktrees/create-worktree.ts";

export function readNewSessionTerminalStartAccess(
  gateway: Parameters<typeof readSessionMethodAccess>[0],
  worktree: boolean,
): SessionMethodAccess {
  const terminalAccess = readSessionMethodAccess(gateway, {
    method: "sessions.catalog.startTerminal",
    requiredScope: "operator.admin",
  });
  return !terminalAccess.allowed || !worktree
    ? terminalAccess
    : readSessionMethodAccess(gateway, {
        method: "worktrees.create",
        requiredScope: "operator.admin",
      });
}

export async function startNewSessionInTerminal(
  client: GatewayBrowserClient,
  params: {
    catalogId: string;
    agentId: string;
    cwd: string;
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
    agentId: params.agentId,
    cwd,
    ...(params.initialMessage ? { initialMessage: params.initialMessage } : {}),
  });
}
