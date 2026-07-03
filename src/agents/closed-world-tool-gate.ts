// WS-A: closed-world fail-closed tool-gate (the gateway twin of the BFF-side
// core.openclaw.control_plane.gate_tool_call).
//
// The BFF gate (gate_tool_call) only runs at the phone-home boundary for tools
// that call back into propfirm_manager. It does NOT cover non-phone-home
// built-ins (exec/bash/write/...). #896's terraform `tools.deny` list denies the
// known-dangerous built-ins (enumerate-the-bad); THIS gate is the authoritative
// default-deny complement: the admitted set is materialized from
// core/openclaw/allowlist.py (injected as an env-var snapshot by the roll) and
// ANY resolved tool not in it is refused (fail-closed) -- catching a NEW/unknown
// built-in a fork upgrade might add that the deny-list does not enumerate.
//
// Runs POST-deny-filter, PRE-hook-wrap in createOpenClawCodingTools, so the
// resolved tool set is final + concrete (exact-string match, no globs needed).
//
// MODES (OPENCLAW_CLOSED_WORLD_MODE, default "report"):
//   report  -> log the resolved set + any would-deny, pass ALL tools through
//              unchanged (zero risk; used to CAPTURE the true admitted set,
//              incl. the safe gateway built-ins, before enforcing).
//   enforce -> additionally FILTER OUT any resolved tool not in the snapshot.
// When the snapshot env is ABSENT, the gate degrades to log-only (never filters).

import { createSubsystemLogger } from "../logging/subsystem.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { normalizeToolName } from "./tool-policy.js";

const log = createSubsystemLogger("gateway/closed-world-gate");

export const CLOSED_WORLD_ALLOWLIST_ENV = "OPENCLAW_CLOSED_WORLD_ALLOWLIST_JSON";
export const CLOSED_WORLD_MODE_ENV = "OPENCLAW_CLOSED_WORLD_MODE";

export type ClosedWorldMode = "report" | "enforce";

export type ClosedWorldGateResult = {
  mode: ClosedWorldMode;
  snapshotPresent: boolean;
  resolved: string[];
  wouldDeny: string[];
  tools: AnyAgentTool[];
};

function parseSnapshot(raw: string | undefined): Set<string> | null {
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { tool_names?: unknown };
    const names = Array.isArray(parsed?.tool_names) ? parsed.tool_names : [];
    return new Set(names.map((n) => normalizeToolName(String(n))));
  } catch (error) {
    log.warn("closed_world.snapshot_parse_error", { error: String(error) });
    return null;
  }
}

function resolveMode(raw: string | undefined): ClosedWorldMode {
  return String(raw || "")
    .trim()
    .toLowerCase() === "enforce"
    ? "enforce"
    : "report";
}

// Process-lifetime dedup so a per-turn call does not spam identical lines.
let loggedResolvedSignature: string | null = null;
const loggedWouldDeny = new Set<string>();

/**
 * Apply the closed-world gate to a resolved (post-deny) tool set. Pure over the
 * env inputs so it is unit-testable; `deps` overrides env for tests.
 */
export function applyClosedWorldToolGate(
  tools: AnyAgentTool[],
  deps: { snapshotJson?: string; modeRaw?: string; emit?: boolean } = {},
): ClosedWorldGateResult {
  const emit = deps.emit !== false;
  const snapshot = parseSnapshot(deps.snapshotJson ?? process.env[CLOSED_WORLD_ALLOWLIST_ENV]);
  const mode = resolveMode(deps.modeRaw ?? process.env[CLOSED_WORLD_MODE_ENV]);
  const resolved = tools.map((tool) => normalizeToolName(tool.name || "tool"));

  if (emit) {
    const signature = [...resolved].sort().join(",");
    if (signature !== loggedResolvedSignature) {
      loggedResolvedSignature = signature;
      log.info("closed_world.resolved_set", {
        mode,
        snapshot_present: snapshot !== null,
        tool_count: resolved.length,
        tools: [...resolved].sort(),
      });
    }
  }

  // No snapshot -> cannot gate; log-only, pass everything through (zero risk).
  if (snapshot === null) {
    return { mode, snapshotPresent: false, resolved, wouldDeny: [], tools };
  }

  const wouldDeny = resolved.filter((name) => !snapshot.has(name));
  if (emit) {
    for (const name of wouldDeny) {
      if (!loggedWouldDeny.has(name)) {
        loggedWouldDeny.add(name);
        log.warn("closed_world.would_deny", { mode, tool: name });
      }
    }
  }

  if (mode === "enforce" && wouldDeny.length > 0) {
    const deniedSet = new Set(wouldDeny);
    const kept = tools.filter((tool) => !deniedSet.has(normalizeToolName(tool.name || "tool")));
    return { mode, snapshotPresent: true, resolved, wouldDeny, tools: kept };
  }

  return { mode, snapshotPresent: true, resolved, wouldDeny, tools };
}

/** Test seam: reset the process-lifetime dedup caches. */
export function __resetClosedWorldGateDedupForTests(): void {
  loggedResolvedSignature = null;
  loggedWouldDeny.clear();
}
