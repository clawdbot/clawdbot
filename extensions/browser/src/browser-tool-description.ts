import type { BrowserToolCapabilities } from "./browser-tool.schema.js";

/** Build the Browser tool guidance shared by lazy registration and runtime execution. */
export function describeBrowserTool(opts: {
  targetDefault: "sandbox" | "host";
  hostHint: string;
  capabilities: BrowserToolCapabilities;
}): string {
  const actions = new Set(opts.capabilities.actions);
  const evaluateEnabled = opts.capabilities.actKinds.includes("evaluate");
  const lines = [
    `Control the browser via OpenClaw's browser control server. Available actions: ${opts.capabilities.actions.join(", ")}.`,
    ...(actions.has("profiles")
      ? [
          "Browser choice: omit profile to use the configured default (normally the isolated OpenClaw-managed `openclaw` browser).",
          "When existing logins/cookies matter, use action=profiles to inspect available profiles, then select the appropriate profile by name. Do not assume a profile name. Use only when the task requires an existing session and the user has authorized it.",
        ]
      : []),
    ...(actions.has("importprofile")
      ? [
          "Use action=importprofile on macOS to copy cookies from an authorized Chrome-family system profile into a fresh managed profile; this may show a Keychain consent prompt.",
        ]
      : []),
    `For Chrome MCP existing-session profiles, omit timeoutMs on act:type, hover, scrollIntoView, drag, select, and fill; that driver rejects per-call timeout overrides for those actions.${evaluateEnabled ? " act:evaluate supports timeoutMs." : ""}`,
    ...(!opts.capabilities.tabBound
      ? [
          'When a node-hosted browser proxy is available, the tool may auto-route to it. Pin a node with node=<id|name> or target="node".',
        ]
      : []),
    "When using refs from snapshot (e.g. e12), keep the same tab: prefer passing targetId from the snapshot response into subsequent actions (act/click/type/etc). For tab operations, targetId also accepts tabId handles (t1) and labels from action=tabs.",
    "For multi-step browser work, login checks, stale refs, duplicate tabs, or Google Meet flows, use the bundled browser-automation skill when it is available.",
    'For stable, self-resolving refs across calls, use snapshot with refs="aria" (Playwright aria-ref ids). Default refs="role" are role+name-based.',
    "Repeated compatible snapshots with stable document identity mark newly appeared ref-bearing elements with [new].",
    `navigate returns the loaded page's compact snapshot inline (efficient interactive tier; use action=snapshot for a full snapshot); do not call snapshot after navigate.${opts.capabilities.actKinds.includes("batch") ? " Batch act results that report a cross-document navigation also include fresh page state;" : ""} After a single act that triggers navigation, snapshot before using refs.`,
    "Use snapshot+act for UI automation. Avoid act:wait by default; use only in exceptional cases when no reliable UI state exists.",
    actions.has("text")
      ? "For page prose, use action=text with optional selector and maxChars; it reads the first selector match, else article, main, or body. Use efficient snapshots for controls; they omit most prose."
      : `For page text, use snapshot${evaluateEnabled ? " or a bounded act:evaluate" : ""}; efficient snapshots omit most prose.`,
    "Use snapshot query to keep lines matching all whitespace-separated tokens, case-insensitively; matching lines retain element refs.",
    ...(actions.has("requests")
      ? [
          "Use requests for the recent network log; filter matches URL/type, limit defaults to 50, and clear=true clears the collected log after reading.",
        ]
      : []),
    ...(actions.has("errors")
      ? ["Use errors for page errors; limit defaults to 50, clear=true clears after reading."]
      : []),
    ...(actions.has("emulate")
      ? [
          "Use emulate with device, colorScheme, timezoneId, or locale; at least one setting is required.",
        ]
      : []),
    ...(actions.has("upload")
      ? [
          "For file chooser uploads, pass the trigger ref with paths in the same upload call when available; use paths-only arming only when a later trigger is intentional. Use inputRef or element to set a file input directly.",
        ]
      : []),
    ...(!opts.capabilities.tabBound
      ? [
          `target selects browser location (sandbox|host|node). Default: ${opts.targetDefault}.`,
          opts.hostHint,
        ]
      : []),
  ];
  return lines.join(" ");
}
