// Leaf contract for the config hot-reload watcher's terminal status.
// Kept separate from config-reload.ts so callers that only need the status
// shape (health summaries, request context, runtime handles) do not pull in
// the full config-reload implementation.

// Hot-reload stays "active" while a watcher is live. It flips to "disabled" only
// after watcher re-creation fails past the retry budget, so operators/callers
// can detect silent degradation instead of assuming reloads still fire.
export type GatewayHotReloadStatus = "active" | "disabled";
