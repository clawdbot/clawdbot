import type { QQBotDmPolicy, QQBotGroupPolicy } from "./types.js";

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
  return !list.every((entry) => String(entry).trim() === "*");
}

export function resolveQQBotEffectivePolicies(input: EffectivePolicyInput): {
  dmPolicy: QQBotDmPolicy;
  groupPolicy: QQBotGroupPolicy;
} {
  const allowFromRestricted = hasRealRestriction(input.allowFrom);
  const groupAllowFromRestricted = hasRealRestriction(input.groupAllowFrom);

  const dmPolicy: QQBotDmPolicy = input.dmPolicy ?? (allowFromRestricted ? "allowlist" : "open");

  const groupPolicy: QQBotGroupPolicy =
    input.groupPolicy ?? (groupAllowFromRestricted || allowFromRestricted ? "allowlist" : "open");

  return { dmPolicy, groupPolicy };
}
