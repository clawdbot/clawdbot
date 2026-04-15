import { resolveChannelGroupRequireMention } from "openclaw/plugin-sdk/channel-policy";
import { resolveExactLineGroupConfigKey, type OpenClawConfig } from "./channel-api.js";

type LineGroupContext = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  groupId?: string | null;
};

export function resolveLineGroupRequireMention(params: LineGroupContext): boolean {
  const exactGroupId = resolveExactLineGroupConfigKey({
    cfg: params.cfg,
    accountId: params.accountId,
    groupId: params.groupId,
  });
  return resolveChannelGroupRequireMention({
    cfg: params.cfg,
    channel: "line",
    groupId: exactGroupId ?? params.groupId,
    accountId: params.accountId,
  });
}
