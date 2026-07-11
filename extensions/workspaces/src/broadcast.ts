// Single-slot handle for the gateway's broadcast function.
//
// Agent tools must be able to announce `plugin.workspaces.changed` so an open
// Control UI live-updates. They cannot always reach one: the plugin runtime's
// gateway-request scope is an AsyncLocalStorage set around gateway RPC handlers
// and plugin HTTP routes only, so a tool call inside an agent turn that started
// from a channel, cron, or heartbeat sees no scope and would silently skip the
// broadcast — the edit lands on disk but no browser hears about it.
//
// `GatewayBroadcastFn` is server-lifetime (it fans out to every connection), not
// request- or connection-scoped, so remembering the first one a gateway method
// receives is sound. The Control UI calls `workspaces.get` on load, so
// the slot is populated long before an agent edits anything.

export type WorkspaceBroadcast = (event: string, payload: unknown) => void;

let handle: WorkspaceBroadcast | undefined;

/** Called by every workspace gateway method; idempotent after the first call. */
export function rememberWorkspaceBroadcast(broadcast: WorkspaceBroadcast): void {
  handle = broadcast;
}

/** The remembered broadcast, or undefined before any gateway method has run. */
export function workspaceBroadcast(): WorkspaceBroadcast | undefined {
  return handle;
}

/** Test-only: clear the remembered handle between cases. */
export function resetWorkspaceBroadcastForTest(): void {
  handle = undefined;
}
