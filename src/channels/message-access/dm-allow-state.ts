import { normalizeStringEntries } from "../../shared/string-normalization.js";
import type { ChannelId } from "../plugins/types.public.js";
import { readChannelIngressStoreAllowFromForDmPolicy } from "./runtime.js";

export async function resolveDmAllowAuditState(params: {
  provider: ChannelId;
  accountId: string;
  allowFrom?: Array<string | number> | null;
  dmPolicy?: string | null;
  normalizeEntry?: (raw: string) => string;
  readStore?: (provider: ChannelId, accountId: string) => Promise<string[]>;
}): Promise<{
  configAllowFrom: string[];
  hasWildcard: boolean;
  allowCount: number;
  isMultiUserDm: boolean;
}> {
  const configAllowFrom = normalizeStringEntries(
    Array.isArray(params.allowFrom) ? params.allowFrom : undefined,
  );
  const hasWildcard = configAllowFrom.includes("*");
  const storeAllowFrom = await readChannelIngressStoreAllowFromForDmPolicy({
    provider: params.provider,
    accountId: params.accountId,
    dmPolicy: params.dmPolicy,
    readStore: params.readStore,
  });
  const normalizeEntry = params.normalizeEntry ?? ((value: string) => value);
  const normalizedCfg = configAllowFrom
    .filter((value) => value !== "*")
    .map((value) => normalizeEntry(value))
    .map((value) => value.trim())
    .filter(Boolean);
  const normalizedStore = storeAllowFrom
    .map((value) => normalizeEntry(value))
    .map((value) => value.trim())
    .filter(Boolean);
  const allowCount = new Set([...normalizedCfg, ...normalizedStore]).size;
  return {
    configAllowFrom,
    hasWildcard,
    allowCount,
    isMultiUserDm: hasWildcard || allowCount > 1,
  };
}
