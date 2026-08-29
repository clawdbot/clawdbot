import path from "node:path";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isPathInside } from "../../infra/path-guards.js";
import { resolveOutboundMediaMaxBytes } from "../../media/configured-max-bytes.js";
import type { OutboundMediaAccess } from "../../media/load-options.js";
import { resolveLocalMediaPath } from "../../media/local-media-path.js";
import { resolveOutboundAttachmentFromUrl } from "../../media/outbound-attachment.js";

export async function stageGatewayWorkspaceMedia(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  accountId?: string | null;
  payload: ReplyPayload;
  mediaUrls?: string[];
  mediaAccess: OutboundMediaAccess;
  workspaceMediaAccess?: OutboundMediaAccess;
}): Promise<ReplyPayload> {
  const mediaUrls = params.mediaUrls;
  const workspaceRoots = params.workspaceMediaAccess?.localRoots ?? [];
  if (!mediaUrls?.length || workspaceRoots.length === 0) {
    return params.payload;
  }
  const maxBytes = resolveOutboundMediaMaxBytes({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
  });
  const stagedMediaUrls = await Promise.all(
    mediaUrls.map(async (mediaUrl) => {
      const localPath = resolveLocalMediaPath(mediaUrl);
      if (
        !localPath ||
        !workspaceRoots.some((root) => isPathInside(path.resolve(root), path.resolve(localPath)))
      ) {
        return mediaUrl;
      }
      return (
        await resolveOutboundAttachmentFromUrl(mediaUrl, maxBytes, {
          mediaAccess: params.mediaAccess,
        })
      ).path;
    }),
  );
  if (stagedMediaUrls.every((mediaUrl, index) => mediaUrl === mediaUrls[index])) {
    return params.payload;
  }
  const stagedAttachments = params.payload.attachments?.map((attachment, index) => {
    const stagedAttachment = { ...attachment, path: stagedMediaUrls[index] };
    delete stagedAttachment.url;
    delete stagedAttachment.mediaUrl;
    delete stagedAttachment.filePath;
    return stagedAttachment;
  });
  return {
    ...params.payload,
    mediaUrl: stagedMediaUrls[0],
    mediaUrls: stagedMediaUrls,
    ...(stagedAttachments ? { attachments: stagedAttachments } : {}),
  };
}
