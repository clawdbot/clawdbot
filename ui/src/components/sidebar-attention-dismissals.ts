// Per-gateway, per-browser snooze state for the sidebar attention chips.
// Deliberately client-side chrome (like nav width / dock layout), not gateway
// state: dismissing a nag on one device should not acknowledge it everywhere.
import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";
import type { ScopeUpgradeState } from "../app/device-scope-upgrade-availability.ts";
import { getSafeLocalStorage } from "../local-storage.ts";

const SIDEBAR_ATTENTION_DISMISSAL_KINDS = [
  "cronFailed",
  "cronOverdue",
  "modelAuthExpired",
  "scopeUpgrade",
  "updateAvailable",
] as const;

export type SidebarAttentionKind = (typeof SIDEBAR_ATTENTION_DISMISSAL_KINDS)[number];
export type SidebarAttentionDismissal = { kind: SidebarAttentionKind; signature: string };

export type SidebarAttentionDismissals = Partial<Record<SidebarAttentionKind, string[]>>;

const DISMISSED_STORE_PREFIX = "openclaw.control.sidebarAttention.v1:";

export function dismissalStoreKey(gatewayUrl: string): string {
  return `${DISMISSED_STORE_PREFIX}${gatewayOriginScope(gatewayUrl)}`;
}

export function loadDismissals(gatewayUrl: string): SidebarAttentionDismissals {
  const storage = getSafeLocalStorage();
  if (!storage) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(storage.getItem(dismissalStoreKey(gatewayUrl)) ?? "null");
    const record = asNullableRecord(parsed);
    if (!record) {
      return {};
    }
    const result: SidebarAttentionDismissals = {};
    for (const kind of SIDEBAR_ATTENTION_DISMISSAL_KINDS) {
      const value = record[kind];
      const signatures = Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : typeof value === "string"
          ? [value]
          : [];
      if (signatures.length > 0) {
        result[kind] = [...new Set(signatures)];
      }
    }
    return result;
  } catch {
    return {};
  }
}

function saveDismissals(gatewayUrl: string, dismissals: SidebarAttentionDismissals) {
  const storage = getSafeLocalStorage();
  if (!storage) {
    return;
  }
  try {
    if (Object.keys(dismissals).length === 0) {
      storage.removeItem(dismissalStoreKey(gatewayUrl));
    } else {
      storage.setItem(dismissalStoreKey(gatewayUrl), JSON.stringify(dismissals));
    }
  } catch {
    // Quota/privacy-mode failures just lose the snooze; chips reappear.
  }
}

/**
 * Record one dismissal via read-merge-write against the persisted map, not a
 * caller-held snapshot: another tab may have dismissed a different chip since
 * this tab last loaded, and a blind write would drop that entry.
 */
export function dismissSidebarAttention(
  gatewayUrl: string,
  dismissal: SidebarAttentionDismissal,
): SidebarAttentionDismissals {
  const stored = loadDismissals(gatewayUrl);
  const next = {
    ...stored,
    [dismissal.kind]: [...new Set([...(stored[dismissal.kind] ?? []), dismissal.signature])],
  };
  saveDismissals(gatewayUrl, next);
  return next;
}

export function resolveScopeUpgradeDismissal(params: {
  scopes: readonly string[] | undefined;
  state: ScopeUpgradeState;
}): SidebarAttentionDismissal | null {
  // Manual repair and an actionable upgrade are distinct incidents.
  return (params.state.phase === "guidance" || params.state.phase === "available") && params.scopes
    ? {
        kind: "scopeUpgrade",
        signature: JSON.stringify([params.state.phase, ...params.scopes.toSorted()]),
      }
    : null;
}

export function resolveUpdateAttentionDismissal(params: {
  gatewayBootId?: string | null;
  updateAvailable?: UpdateAvailable | null;
  updateSchedule?: UpdateScheduleState | null;
}): SidebarAttentionDismissal | null {
  const target = params.updateSchedule?.target;
  const version =
    (target?.kind === "package" ? target.version : target?.upstreamSha) ??
    params.updateAvailable?.upstreamSha ??
    params.updateAvailable?.latestVersion;
  const gatewayBootId = params.gatewayBootId?.trim();
  const normalizedVersion = version?.trim();
  return gatewayBootId && normalizedVersion
    ? {
        kind: "updateAvailable",
        signature: JSON.stringify([normalizedVersion, gatewayBootId]),
      }
    : null;
}

export function isUpdateAttentionForced(tone: "danger" | "info" | "warn" | null | undefined) {
  return tone === "warn" || tone === "danger";
}

export function isSidebarAttentionDismissed(
  dismissals: SidebarAttentionDismissals,
  dismissal: SidebarAttentionDismissal,
): boolean {
  return dismissals[dismissal.kind]?.includes(dismissal.signature) === true;
}

/**
 * Drop dismissals whose chip is gone or whose entity set changed, so a state
 * that clears and later recurs surfaces again instead of staying hidden by a
 * stale snooze. Returns the input object when nothing changed.
 */
function pruneDismissals(
  dismissals: SidebarAttentionDismissals,
  active: readonly SidebarAttentionDismissal[],
  scope?: { cronInventoryComplete: boolean; modelAuthAgentId: string | null },
): SidebarAttentionDismissals {
  const next: SidebarAttentionDismissals = {};
  let changed = false;
  for (const kind of SIDEBAR_ATTENTION_DISMISSAL_KINDS) {
    const stored = dismissals[kind];
    if (!stored) {
      continue;
    }
    const current = stored.filter((signature) => {
      // Selected-agent responses are partial: they may re-arm their own auth
      // warning, but only an all-agent cron inventory may re-arm cron entries.
      const authoritative =
        !scope ||
        (kind === "modelAuthExpired"
          ? Boolean(
              scope.modelAuthAgentId &&
              (!signature.startsWith("agent:") ||
                signature.startsWith(`agent:${scope.modelAuthAgentId}\n`)),
            )
          : kind === "cronFailed" || kind === "cronOverdue"
            ? scope.cronInventoryComplete
            : true);
      return (
        !authoritative ||
        active.some((dismissal) => dismissal.kind === kind && dismissal.signature === signature)
      );
    });
    if (current.length > 0) {
      next[kind] = current;
    }
    if (current.length !== stored.length) {
      changed = true;
    }
  }
  return changed ? next : dismissals;
}

export function reconcileSidebarAttentionDismissals(params: {
  active: readonly SidebarAttentionDismissal[];
  gatewayUrl: string;
  scope?: { cronInventoryComplete: boolean; modelAuthAgentId: string | null };
}): SidebarAttentionDismissals {
  const stored = loadDismissals(params.gatewayUrl);
  const pruned = pruneDismissals(stored, params.active, params.scope);
  if (pruned !== stored) {
    saveDismissals(params.gatewayUrl, pruned);
  }
  return pruned;
}

export function clearSidebarAttentionDismissal(
  gatewayUrl: string,
  kind: SidebarAttentionKind,
): SidebarAttentionDismissals {
  const stored = loadDismissals(gatewayUrl);
  if (!stored[kind]) {
    return stored;
  }
  const next = { ...stored };
  delete next[kind];
  saveDismissals(gatewayUrl, next);
  return next;
}
