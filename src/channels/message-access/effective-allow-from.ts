import { mergeDmAllowFromSources, resolveGroupAllowFromSources } from "../allow-from.js";

/**
 * Merge configured direct, group, and pairing-store allowlists into the
 * effective lists consumed by sender and context-visibility checks.
 */
export function resolveChannelIngressEffectiveAllowFromLists(params: {
  allowFrom?: Array<string | number> | null;
  groupAllowFrom?: Array<string | number> | null;
  storeAllowFrom?: Array<string | number> | null;
  dmPolicy?: string | null;
  groupAllowFromFallbackToAllowFrom?: boolean | null;
}): {
  effectiveAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
} {
  const allowFrom = Array.isArray(params.allowFrom) ? params.allowFrom : undefined;
  const groupAllowFrom = Array.isArray(params.groupAllowFrom) ? params.groupAllowFrom : undefined;
  const storeAllowFrom = Array.isArray(params.storeAllowFrom) ? params.storeAllowFrom : undefined;
  const effectiveAllowFrom = mergeDmAllowFromSources({
    allowFrom,
    storeAllowFrom,
    dmPolicy: params.dmPolicy ?? undefined,
  });
  const effectiveGroupAllowFrom = resolveGroupAllowFromSources({
    allowFrom,
    groupAllowFrom,
    fallbackToAllowFrom: params.groupAllowFromFallbackToAllowFrom ?? undefined,
  });
  return { effectiveAllowFrom, effectiveGroupAllowFrom };
}
