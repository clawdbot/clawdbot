import type { MoltbotConfig } from "../config/config.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { formatLinkUnderstandingBody } from "./format.js";
import { runLinkUnderstanding } from "./runner.js";

export type ApplyLinkUnderstandingResult = {
  outputs: string[];
  urls: string[];
};

export async function applyLinkUnderstanding(params: {
  ctx: MsgContext;
  cfg: MoltbotConfig;
}): Promise<ApplyLinkUnderstandingResult> {
  const result = await runLinkUnderstanding({
    cfg: params.cfg,
    ctx: params.ctx,
  });

  if (result.outputs.length === 0) {
    return result;
  }

  params.ctx.LinkUnderstanding = [...(params.ctx.LinkUnderstanding ?? []), ...result.outputs];
  params.ctx.Body = formatLinkUnderstandingBody({
    body: params.ctx.Body,
    outputs: result.outputs,
  });

  finalizeInboundContext(params.ctx, {
    forceBodyForAgent: true,
    forceBodyForCommands: true,
  });

  return result;
}
