import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getChannelPlugin } from "./plugins/registry.js";
import type { ChannelId } from "./plugins/types.public.js";

export type ReadOnlyInspectedAccount = Record<string, unknown>;

export async function inspectReadOnlyChannelAccount(params: {
  channelId: ChannelId;
  cfg: OpenClawConfig;
  accountId?: string | null;
}): Promise<ReadOnlyInspectedAccount | null> {
  const inspectAccount = getChannelPlugin(params.channelId)?.config.inspectAccount;
  if (!inspectAccount) {
    return null;
  }
  return (await Promise.resolve(
    inspectAccount(params.cfg, params.accountId),
  )) as ReadOnlyInspectedAccount | null;
}
