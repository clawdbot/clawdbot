/**
 * Effective-policy resolver.
 *
 * Maps a raw `QQBotAccountConfig` to the concrete `dmPolicy`/`groupPolicy`
 * values that the access engine consumes. Provides backwards-compatible
 * defaults for accounts that only have the legacy `allowFrom` field:
 *
 *   - Empty `allowFrom` or containing `"*"` → `"open"` (the historical
 *     behaviour before P0/P1 landed).
 *   - Non-empty `allowFrom` without `"*"`   → `"allowlist"` (what a
 *     security-conscious operator almost certainly meant).
 *
 * An explicit `dmPolicy`/`groupPolicy` always wins over the inference.
 */

import type { QQBotDmPolicy, QQBotGroupPolicy } from "./types.js";

/** Subset of the account config fields this resolver actually reads. */
export interface EffectivePolicyInput {
  allowFrom?: Array<string | number> | null;
  groupAllowFrom?: Array<string | number> | null;
  dmPolicy?: QQBotDmPolicy | null;
  groupPolicy?: QQBotGroupPolicy | null;
}

function hasRealRestriction(list: Array<string | number> | null | undefined): boolean {
  if (!list || list.length === 0) {
    return false;
  }
  // A list that only contains `"*"` is logically equivalent to open.
  return !list.every((entry) => String(entry).trim() === "*");
}

/**
 * Derive the effective dmPolicy and groupPolicy applied at runtime.
 *
 * Caller should pass the raw `QQBotAccountConfig`. The resolver does
 * not look at `groups[id]` overrides — per-group overrides are layered
 * on top elsewhere (see `inbound-pipeline` mention gating).
 */
export function resolveQQBotEffectivePolicies(input: EffectivePolicyInput): {
  dmPolicy: QQBotDmPolicy;
  groupPolicy: QQBotGroupPolicy;
} {
  const allowFromRestricted = hasRealRestriction(input.allowFrom);
  const groupAllowFromRestricted = hasRealRestriction(input.groupAllowFrom);

  const dmPolicy: QQBotDmPolicy = input.dmPolicy ?? (allowFromRestricted ? "allowlist" : "open");

  // groupPolicy defaults: if an explicit groupAllowFrom is provided and
  // restricts, enforce allowlist. Otherwise fall back to the same rule
  // as DM (so a single `allowFrom` entry locks down both DM and group).
  const groupPolicy: QQBotGroupPolicy =
    input.groupPolicy ?? (groupAllowFromRestricted || allowFromRestricted ? "allowlist" : "open");

  return { dmPolicy, groupPolicy };
}
