import { resolveChannelMediaMaxBytes, type OpenClawConfig } from "../runtime-api.js";
import { resolveMSTeamsAccountConfig } from "./accounts.js";

export function resolveMSTeamsReplyLimits(cfg: OpenClawConfig, accountId?: string | null) {
  const config = resolveMSTeamsAccountConfig(cfg, accountId);
  const scopedCfg = {
    ...cfg,
    channels: {
      ...cfg.channels,
      msteams: config,
    },
  };
  return {
    config,
    feedbackLoopEnabled: config.feedbackEnabled !== false,
    mediaMaxBytes: resolveChannelMediaMaxBytes({
      cfg: scopedCfg,
      resolveChannelLimitMb: ({ cfg: currentCfg }) => currentCfg.channels?.msteams?.mediaMaxMb,
    }),
  };
}
