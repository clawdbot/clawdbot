import { resolveSandboxWorkspaceLayoutPaths } from "./src/agents/sandbox/shared.js";

const mk = (
  scope: "session" | "agent" | "shared",
  workspaceAccess: "rw" | "ro",
  rawSessionKey: string,
  sandboxPrincipalId?: string,
) =>
  resolveSandboxWorkspaceLayoutPaths({
    cfg: { scope, workspaceAccess, workspaceRoot: "/tmp/sbx-root" } as never,
    rawSessionKey,
    agentId: "shared",
    workspaceDir: "/tmp/agent-workspace-shared",
    ...(sandboxPrincipalId ? { sandboxPrincipalId } : {}),
  } as never);

for (const scope of ["agent", "session", "shared"] as const) {
  const a1 = mk(scope, "ro", "agent:shared:a1", "guestA");
  const a2 = mk(scope, "ro", "agent:shared:a2", "guestA");
  const b1 = mk(scope, "ro", "agent:shared:b1", "guestB");
  const none = mk(scope, "ro", "agent:shared:maint");
  console.log(
    JSON.stringify({
      scope,
      sameGuest_sharesContainer: a1.scopeKey === a2.scopeKey && a1.workspaceDir === a2.workspaceDir,
      differentGuests_isolated: a1.scopeKey !== b1.scopeKey && a1.workspaceDir !== b1.workspaceDir,
      unstamped_unchanged_key: none.scopeKey,
    }),
  );
}
process.exit(0);
