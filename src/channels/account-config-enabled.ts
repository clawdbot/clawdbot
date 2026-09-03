import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAccountEntry } from "../routing/account-lookup.js";

/** Reads an operator's explicit disable without resolving an operational account. */
export function isChannelAccountExplicitlyDisabled(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId: string;
}): boolean {
  const channel = asOptionalRecord(params.cfg.channels?.[params.channel]);
  const account = asOptionalRecord(
    resolveAccountEntry(asOptionalRecord(channel?.accounts), params.accountId),
  );
  return channel?.enabled === false || account?.enabled === false;
}
