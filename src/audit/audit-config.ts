/** Resolves whether the metadata-only audit ledger records new events. */
import type { OpenClawConfig } from "../config/types.openclaw.js";

export type AuditMessageMode = "off" | "direct" | "all";

/**
 * The ledger is on by default: an audit trail enabled only after an incident
 * cannot explain the incident. `logging.audit.enabled: false` stops new event inserts after
 * restart; audit queries still serve retained rows until they expire.
 */
export function isAuditLedgerEnabled(cfg: OpenClawConfig | undefined): boolean {
  return cfg?.logging?.audit?.enabled !== false;
}

/** Message metadata remains an explicit opt-in inside the default-on ledger. */
export function resolveAuditMessageMode(cfg: OpenClawConfig | undefined): AuditMessageMode {
  return cfg?.logging?.audit?.messages ?? "off";
}
