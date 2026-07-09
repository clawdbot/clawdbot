/** Build the Browser tool guidance shared by lazy registration and runtime execution. */
export function describeBrowserTool(opts: {
  targetDefault: "sandbox" | "host";
  hostHint: string;
}): string {
  return [
    "Control the browser via OpenClaw's browser control server (status/start/stop/profiles/tabs/open/snapshot/screenshot/download/actions).",
    "Browser choice: omit profile to use the configured default (normally the isolated OpenClaw-managed `openclaw` browser).",
    "When existing logins/cookies matter, use action=profiles to inspect available profiles, then select the appropriate profile by name. Do not assume a profile name. Use only when the task requires an existing session and the user has authorized it.",
    "For Chrome MCP existing-session profiles, omit timeoutMs on act:type, evaluate, hover, scrollIntoView, drag, select, and fill; that driver rejects per-call timeout overrides for those actions.",
    'When a node-hosted browser proxy is available, the tool may auto-route to it. Pin a node with node=<id|name> or target="node".',
    "When using refs from snapshot (e.g. e12), keep the same tab: prefer passing targetId from the snapshot response into subsequent actions (act/click/type/etc). For tab operations, targetId also accepts tabId handles (t1) and labels from action=tabs.",
    "For multi-step browser work, login checks, stale refs, duplicate tabs, or Google Meet flows, use the bundled browser-automation skill when it is available.",
    'For stable, self-resolving refs across calls, use snapshot with refs="aria" (Playwright aria-ref ids). Default refs="role" are role+name-based.',
    "Use snapshot+act for UI automation. Avoid act:wait by default; use only in exceptional cases when no reliable UI state exists.",
    "For file chooser uploads, pass the trigger ref with paths in the same upload call when available; use paths-only arming only when a later trigger is intentional. Use inputRef or element to set a file input directly.",
    `target selects browser location (sandbox|host|node). Default: ${opts.targetDefault}.`,
    opts.hostHint,
  ].join(" ");
}
