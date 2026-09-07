// Link-understanding apply step runs configured link processors and folds their output into inbound context.
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatLinkUnderstandingBody } from "./format.js";
import { runLinkUnderstanding } from "./runner.js";

/** Runs link understanding and folds successful outputs into the inbound context. */
export async function applyLinkUnderstanding(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  signal?: AbortSignal;
}): Promise<void> {
  const outputs = await runLinkUnderstanding({
    cfg: params.cfg,
    ctx: params.ctx,
    signal: params.signal,
  });

  if (outputs.length === 0 || params.signal?.aborted) {
    return;
  }

  params.ctx.LinkUnderstanding = [...(params.ctx.LinkUnderstanding ?? []), ...outputs];
  const enrich = (body?: string) => formatLinkUnderstandingBody({ body, outputs });
  // Preserve channel/media preparation independently from the transport body.
  params.ctx.agentText = enrich(params.ctx.agentText ?? params.ctx.BodyForAgent ?? params.ctx.Body);
  params.ctx.Body = enrich(params.ctx.Body);
  finalizeInboundContext(params.ctx, { forceBodyForCommands: true });
}
