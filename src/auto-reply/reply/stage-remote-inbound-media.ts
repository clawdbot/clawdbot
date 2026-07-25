/** Shared guard for staging remote inbound media into the local cache. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/config.js";
import { hasStagedMediaProjection } from "../../media/media-facts.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { RuntimeMsgContext as MsgContext } from "../templating.js";
import { hasInboundMedia } from "./inbound-media.js";

const stageSandboxMediaRuntimeLoader = createLazyImportLoader(
  () => import("./stage-sandbox-media.runtime.js"),
);

/**
 * Stage remote (SCP) inbound media before downstream consumers read the media
 * facts into the local cache. Staged facts carry their workspace so later
 * staging sites preserve the single-stage contract. Both the dispatch plugin-claim path and get-reply's
 * media-understanding path rely on this rewrite to expose the local cache path
 * instead of the unreachable remote host path; returns whether staging ran.
 */
export async function stageRemoteInboundMediaIfNeeded(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  sessionKey?: string;
  workspaceDir: string;
  remoteMediaMode?: "sandbox-or-cache" | "cache";
}): Promise<boolean> {
  if (
    !params.sessionKey ||
    hasStagedMediaProjection(params.ctx) ||
    !normalizeOptionalString(params.ctx.MediaRemoteHost) ||
    !hasInboundMedia(params.ctx)
  ) {
    return false;
  }

  const { stageSandboxMedia } = await stageSandboxMediaRuntimeLoader.load();
  const result = await stageSandboxMedia({
    ctx: params.ctx,
    sessionCtx: params.ctx,
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    remoteMediaMode: params.remoteMediaMode,
  });
  if (result.staged.size === 0) {
    return false;
  }
  return true;
}
