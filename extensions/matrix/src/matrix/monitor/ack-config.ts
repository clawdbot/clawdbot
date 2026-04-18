import { resolveAckReaction } from "openclaw/plugin-sdk/channel-feedback";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { CoreConfig } from "../../types.js";
import { resolveMatrixAccountConfig } from "../account-config.js";

type MatrixAckReactionScope = "group-mentions" | "group-all" | "direct" | "all" | "none" | "off";

export function resolveMatrixAckReactionConfig(params: {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
}): { ackReaction: string; ackReactionScope: MatrixAckReactionScope } {
  const matrixConfig = params.cfg.channels?.matrix;
  const accountConfig = resolveMatrixAccountConfig({
    cfg: params.cfg as CoreConfig,
    accountId: params.accountId,
  });
  const ackReaction = resolveAckReaction(params.cfg, params.agentId, {
    channel: "matrix",
    accountId: params.accountId ?? undefined,
  }).trim();
  const ackReactionScope = (accountConfig.ackReactionScope ??
    matrixConfig?.ackReactionScope ??
    params.cfg.messages?.ackReactionScope ??
    "group-mentions") as MatrixAckReactionScope;
  return { ackReaction, ackReactionScope };
}
