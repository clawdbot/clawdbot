import { normalizeChatChannelId } from "../../../channels/ids.js";
import { setCanonicalDmAllowFrom } from "../../../channels/plugins/dm-access.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { readChannelAllowFromStore } from "../../../pairing/pairing-store.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../routing/session-key.js";
import { normalizeOptionalLowercaseString } from "../../../shared/string-coerce.js";
import { normalizeStringEntries } from "../../../shared/string-normalization.js";
import { resolveAllowFromMode, type AllowFromMode } from "./allow-from-mode.js";
import { hasAllowFromEntries } from "./allowlist.js";
import { asObjectRecord } from "./object.js";

export async function maybeRepairAllowlistPolicyAllowFrom(cfg: OpenClawConfig): Promise<{
  config: OpenClawConfig;
  changes: string[];
}> {
  const channels = cfg.channels;
  if (!channels || typeof channels !== "object") {
    return { config: cfg, changes: [] };
  }

  const next = structuredClone(cfg);
  const changes: string[] = [];

  const applyRecoveredAllowFrom = (params: {
    account: Record<string, unknown>;
    allowFrom: string[];
    mode: AllowFromMode;
    prefix: string;
  }) => {
    const count = params.allowFrom.length;
    const noun = count === 1 ? "entry" : "entries";
    setCanonicalDmAllowFrom({
      entry: params.account,
      mode: params.mode,
      allowFrom: params.allowFrom,
      pathPrefix: params.prefix,
      changes,
      reason: `restored ${count} sender ${noun} from pairing store (dmPolicy="allowlist").`,
    });
  };

  const recoverAllowFromForAccount = async (params: {
    channelName: string;
    account: Record<string, unknown>;
    accountId?: string;
    prefix: string;
  }) => {
    const dmEntry = params.account.dm;
    const dm =
      dmEntry && typeof dmEntry === "object" && !Array.isArray(dmEntry)
        ? (dmEntry as Record<string, unknown>)
        : undefined;
    const dmPolicy =
      (params.account.dmPolicy as string | undefined) ?? (dm?.policy as string | undefined);
    if (dmPolicy !== "allowlist") {
      return;
    }

    const topAllowFrom = params.account.allowFrom as Array<string | number> | undefined;
    const nestedAllowFrom = dm?.allowFrom as Array<string | number> | undefined;
    if (hasAllowFromEntries(topAllowFrom) || hasAllowFromEntries(nestedAllowFrom)) {
      return;
    }

    const normalizedChannelId = normalizeOptionalLowercaseString(
      normalizeChatChannelId(params.channelName) ?? params.channelName,
    );
    if (!normalizedChannelId) {
      return;
    }
    const normalizedAccountId = normalizeAccountId(params.accountId) || DEFAULT_ACCOUNT_ID;
    const fromStore = await readChannelAllowFromStore(
      normalizedChannelId,
      process.env,
      normalizedAccountId,
    ).catch(() => []);
    const recovered = Array.from(new Set(normalizeStringEntries(fromStore)));
    if (recovered.length === 0) {
      return;
    }

    applyRecoveredAllowFrom({
      account: params.account,
      allowFrom: recovered,
      mode: resolveAllowFromMode(params.channelName),
      prefix: params.prefix,
    });
  };

  const nextChannels = next.channels as Record<string, Record<string, unknown>>;
  for (const [channelName, channelConfig] of Object.entries(nextChannels)) {
    if (!channelConfig || typeof channelConfig !== "object") {
      continue;
    }
    if (channelConfig.enabled === false) {
      continue;
    }
    await recoverAllowFromForAccount({
      channelName,
      account: channelConfig,
      prefix: `channels.${channelName}`,
    });

    const accounts = asObjectRecord(channelConfig.accounts);
    if (!accounts) {
      continue;
    }
    for (const [accountId, accountConfig] of Object.entries(accounts)) {
      if (!accountConfig || typeof accountConfig !== "object") {
        continue;
      }
      if ((accountConfig as { enabled?: unknown }).enabled === false) {
        continue;
      }
      await recoverAllowFromForAccount({
        channelName,
        account: accountConfig as Record<string, unknown>,
        accountId,
        prefix: `channels.${channelName}.accounts.${accountId}`,
      });
    }
  }

  if (changes.length === 0) {
    return { config: cfg, changes: [] };
  }
  return { config: next, changes };
}
